// =============================================================================
// Platform conformance (issues #465, #464, #468, #469, #470, #471 and #480, epics #462, #467 and #478)
// =============================================================================
import '../src/kvox.manifest';
import '../src/app-registrations/registrations';

import { Module } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildPermissionCatalog, catalogGrants, permissionRegistry, roleRegistry, userOwnedModelRegistry } from '@marinoscar/platform-api/core';
import '@marinoscar/platform-api/ai/testing';
import '@marinoscar/platform-api/credentials/testing';
import '@marinoscar/platform-api/db-backup/testing';
import '@marinoscar/platform-api/doctor/testing';
import '@marinoscar/platform-api/email/testing';
import '@marinoscar/platform-api/exports/testing';
import '@marinoscar/platform-api/host/testing';
import '@marinoscar/platform-api/identity/testing';
import '@marinoscar/platform-api/jobs/testing';
import '@marinoscar/platform-api/notifications/testing';
import '@marinoscar/platform-api/onboarding/testing';
import '@marinoscar/platform-api/settings/testing';
import '@marinoscar/platform-api/sharing/testing';
import '@marinoscar/platform-api/storage/testing';
import '@marinoscar/platform-api/telemetry/testing';
import '@marinoscar/platform-api/user-data/testing';
import type { DoctorConformanceFixture } from '@marinoscar/platform-api/doctor/testing';
import { discoverControllers } from '@marinoscar/platform-api/identity/testing';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';

import {
  KVOX_AUTH_PERMISSIONS,
  KVOX_PERMISSIONS_KEY,
  KVOX_PERMISSION_KEYS_KEY,
  KvoxAuthGuard,
} from '@marinoscar/kvox-api/core';
import {
  SearchIndexHandler,
  SearchIndexService,
  SearchQueryEmbedder,
  SearchService,
  type ResolvedSearchOptions,
} from '@marinoscar/kvox-api/search';
import { describeSearchConformance } from '@marinoscar/kvox-api/search/testing';
import { createFakeKvoxJobs } from '@marinoscar/kvox-api/testing';
import {
  MediaAudioTranscodeHandler,
  TRANSCRIPTS_MODULE_OPTIONS,
  TranscriptExportHandler,
  TranscriptImportService,
  TranscriptNameCheckHandler,
  TranscriptObjectsService,
  TranscriptPipelineService,
  TranscriptPurgeHandler,
  TranscriptSnapshotHandler,
  TranscriptionIngestHandler,
  TranscriptionPollHandler,
  TranscriptionSubmitHandler,
  TranscriptsHousekeepingHandler,
  JsonTranscriptExporter,
  MarkdownTranscriptExporter,
  PdfTranscriptExporter,
  TranscriptExporterRegistry,
  parseTranscriptImport,
  type ResolvedTranscriptsOptions,
} from '@marinoscar/kvox-api/transcripts';
import {
  describeTranscriptExporterConformance,
  describeTranscriptsConformance,
} from '@marinoscar/kvox-api/transcripts/testing';
import {
  MarkdownNoteExporter,
  NoteExportHandler,
  NoteExporterRegistry,
  NoteGenerateHandler,
  NoteImportFormatHandler,
  NoteLibraryImportHandler,
  NotePurgeHandler,
  NoteRetitleHandler,
  NoteSourceExtractHandler,
  NotesHousekeepingHandler,
  PdfNoteExporter,
} from '@marinoscar/kvox-api/notes';
import {
  WordNoteExporter,
  describeNoteExporterConformance,
  describeNotesConformance,
} from '@marinoscar/kvox-api/notes/testing';
import { AssemblyAiProvider, TranscriptionProviderRegistry } from '@marinoscar/kvox-api/transcription';
import { describeTranscriptionProviderConformance } from '@marinoscar/kvox-api/transcription/testing';

import { AppModule } from '../src/app.module';
import { SharedTranscriptVisibility } from '../src/kvox/search/shared-transcript-visibility';
import { TranscriptionConfig } from '../src/kvox/transcription/transcription.config';
import { KVOX_EMBEDDING } from '@marinoscar/kvox-ai';
import { PERMISSIONS } from '../src/common/constants/roles.constants';
// The notification and email registries are filled by this import (it is also reached through
// AppModule); the suites below read them, so name the dependency.
import '../src/platform/notifications/notification.manifest';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';
import { composedSchemaDatamodel } from '@marinoscar/platform-api/user-data';
import { Prisma } from '@prisma/client';
import { IS_PUBLIC_KEY } from '@marinoscar/platform-api/identity';
// The user-data registries (this app's categories, scopes and hints, then the platform's); also
// reached through AppModule, named here because the `userData` suite reads them.
import '../src/platform/user-data/user-data.manifest';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaSystemService } from '../src/prisma/prisma-system.service';
import { closeTestApp, createTestApp, type TestContext } from './helpers/test-app.helper';
import { describeGraphConformance } from '@marinoscar/kvox-api/graph/testing';
import { describeGraphExtractionConformance } from '@marinoscar/kvox-api/graph-extraction/testing';
import { describeGraphRdfConformance } from '@marinoscar/kvox-api/graph-rdf/testing';
import { KgExtractHandler, KgResolveHandler, KgEmbedHandler, KgTopicsPromoteHandler, KgLibraryReconcileHandler, KgAutocommitHandler } from '@marinoscar/kvox-api/graph-extraction';
import { KgExportHandler, KgImportHandler } from '@marinoscar/kvox-api/graph-rdf';
import { KgSpeakerLinkHandler, KgPurgeHandler, KgGraphLayoutHandler, KgMigrateHandler, EntityDigestHandler } from './graph/package-internals';

/** Nest's metadata key for the guards a controller or handler declares. */
const GUARDS_METADATA = '__guards__';

/**
 * The root the platform's identity suite walks: every controller reachable from `AppModule` EXCEPT the
 * ones the `@marinoscar/kvox-api` slices guard with `KvoxAuth` / `KvoxAuthFromOptions`.
 *
 * The suite's route-access rule asks for the platform's `JwtAuthGuard` on the route, and a packaged
 * slice cannot name that class (the host-neutral rule): its guard authenticates through the identity
 * port, whose web-edition adapter delegates to `JwtAuthGuard`. Those routes are held to the same two
 * rules by `kvox-guarded routes` below instead, so no route leaves the identity checks unproven.
 */
function isKvoxGuarded(controller: Function): boolean {
  const handlers = Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => controller.prototype[name] as unknown)
    .filter((handler): handler is Function => typeof handler === 'function');

  return [controller, ...handlers].some((target) =>
    ((Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[]).includes(KvoxAuthGuard),
  );
}

const IDENTITY_CONTROLLERS = discoverControllers(AppModule).filter((controller) => !isKvoxGuarded(controller));
const KVOX_CONTROLLERS = discoverControllers(AppModule).filter(isKvoxGuarded);
@Module({ controllers: IDENTITY_CONTROLLERS })
class IdentityConformanceRoot {}

const API_DIR = join(__dirname, '..');
const REPO_DIR = join(API_DIR, '..', '..');

/** The one statement core's `runAsSystem` sends before the callback: a session setting, not a data write. */
function isBypassSetConfig(strings: TemplateStringsArray | string): boolean {
  const text = typeof strings === 'string' ? strings : strings.join('?');
  return /^\s*SELECT\s+set_config\('app\.rls_bypass',\s*'on',\s*true\)\s*$/i.test(text);
}

/**
 * The separate system client (`PrismaSystemService`, the bypass pool) over the suite's recording
 * double. Core's `runAsSystem` opens a transaction on it and sends `SELECT set_config('app.rls_bypass',
 * 'on', true)` through `$executeRaw`, which the recorder would count as a write (it counts every
 * `$executeRaw` as one). That single statement changes no data, so it is answered here and nothing else
 * is: every other statement, read or write, still reaches the recorder, so a Doctor check that writes
 * through the system client is still caught.
 */
function systemClientOver(recording: unknown) {
  const client = recording as Record<string, (...args: unknown[]) => unknown>;
  const transactionClient = new Proxy(client, {
    get(target, property, receiver) {
      if (property === '$executeRaw') {
        return (strings: TemplateStringsArray, ...values: unknown[]) =>
          isBypassSetConfig(strings) ? Promise.resolve(0) : target.$executeRaw(strings, ...values);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    forSystem: () => transactionClient,
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    $transaction: async (work: (tx: unknown) => unknown) => work(transactionClient),
  };
}

/**
 * How the app boots for the `doctor-read-only` suite: the full `AppModule` with the Prisma
 * client, the system (bypass) client and the storage provider replaced by the suite's recording,
 * write-refusing doubles. `PLATFORM_PRISMA` is bound `useExisting: PrismaService`, so overriding
 * `PrismaService` covers every Prisma token the app has except the separate system client
 * (`PrismaSystemService`), which the backup slice's `backup.rls-bypass` check reads through
 * `runAsSystem`.
 */
const doctorConformanceFixture: DoctorConformanceFixture = {
  createContext: (doubles) =>
    createTestApp({
      overrideProviders: [
        { provide: PrismaService, useValue: doubles.prisma.client },
        { provide: PrismaSystemService, useValue: systemClientOver(doubles.prisma.client) },
        { provide: STORAGE_PROVIDER, useValue: doubles.storage.provider },
      ],
    }),
  closeContext: (context) => closeTestApp(context as TestContext),
};

function readCatalog(): string | undefined {
  try {
    return readFileSync(join(API_DIR, 'prisma', 'catalog', 'system-settings-defaults.json'), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Files that issue raw SQL. Each is argued: the Prisma client cannot express the statement
 * (pgvector, trigram, tstzrange, recursive CTEs, advisory locks, SKIP LOCKED, `SET LOCAL`,
 * catalog reads) and every statement is scoped by a bound owner id taken from the authenticated
 * principal or from a row the caller was already authorised to read, never from a raw request id.
 */
const RAW_SQL_ALLOWLIST = [
  { file: 'ai-port/migrate/ai-legacy-migrate.ts', why: 'One-off operator command (issue #474): reads the database clock and counts platform key-import audit rows; no user-owned rows, no request input, and it runs from the command line only.' },
  { file: 'allowlist-reminders/allowlist-reminders.service.ts', why: 'The kvox_allowlist_reminders side table: atomic INSERT .. ON CONFLICT counter, a join to allowed_emails and a bounded orphan DELETE. Allowlist bookkeeping, no user-owned rows; ids are bound uuid parameters.' },
  { file: 'doctor/checks/db-extensions.doctor-check.ts', why: 'Doctor check: one read-only `SELECT` on the `pg_extension` catalog (are `vector` and `pg_trgm` installed); no user data, no request input.' },
  { file: 'app-sharing/transcript-visibility.ts', why: 'Reads the ids of the transcripts shared with the caller through the platform\'s accessibleWhere EXISTS form, past 1,000 shares (issue #485); the statement is built by the platform and bound to the caller and their organization.' },
  { file: 'platform/onboarding/onboarding-data.adapter.ts', why: 'The onboarding activation metrics (issue #481): the platform builds one aggregate statement over the registered funnel and milestone expressions and this port runs it in a READ ONLY transaction. It returns counts only, every value is a bound parameter, and the expressions are developer-authored (refused at registration if they contain a semicolon).' },
  { file: 'prisma/prisma.service.ts', why: 'Test-only table truncation and connection housekeeping; refused outside the test environment.' },
] as const;

const HOSTILE = '<script>alert(1)</script>';

/**
 * One sample per template this app registers or overrides. Text fields carry markup so the suite's
 * escaping check (the HTML must not contain the raw string) has something to catch. Shapes follow
 * the `EmailTemplateDataMap` augmentations in `src/email-templates/*.email.ts`.
 */
const EMAIL_TEMPLATE_SAMPLES: Record<string, unknown> = {
  'allowlist-invitation-reminder': {
    recipientEmail: 'guest@example.test',
    invitedAt: new Date('2026-01-15T10:00:00.000Z'),
    invitedBy: HOSTILE,
    signInUrl: 'https://app.example.test/login',
  },
  'transcript-ready': {
    transcriptId: 'transcript-1',
    title: HOSTILE,
    durationMs: 3_725_000,
    speakerCount: 4,
    wordCount: 18_402,
    providerLabel: HOSTILE,
    appUrl: 'https://app.example.test',
  },
  'transcript-failed': {
    transcriptId: 'transcript-1',
    title: HOSTILE,
    reason: HOSTILE,
    stage: HOSTILE,
    retryable: true,
    appUrl: 'https://app.example.test',
  },
  'shared-with-you': {
    resourceType: 'transcript',
    resourceId: 'transcript-1',
    role: 'editor',
    title: HOSTILE,
    path: '/transcripts/transcript-1',
    sharedBy: HOSTILE,
    openUrl: 'https://app.example.test/transcripts/transcript-1',
    signInUrl: 'https://app.example.test',
  },
  'note-ready': {
    noteId: 'note-1',
    title: HOSTILE,
    templateName: HOSTILE,
    providerLabel: HOSTILE,
    model: HOSTILE,
    wordCount: 412,
    appUrl: 'https://app.example.test',
  },
  'note-failed': {
    noteId: 'note-1',
    title: HOSTILE,
    reason: HOSTILE,
    category: HOSTILE,
    appUrl: 'https://app.example.test',
  },
  'user-welcome': {
    recipientEmail: 'new@example.test',
    recipientName: HOSTILE,
    roles: ['viewer'],
    appUrl: 'https://app.example.test',
  },
  'allowlist-invitation': {
    recipientEmail: 'guest@example.test',
    invitedBy: HOSTILE,
    signInUrl: 'https://app.example.test/login',
  },
};

runPlatformConformance({
  sourceRoots: [join(API_DIR, 'src')],
  suites: {
    // The three permanent exemptions (lease reaper, temp-file janitor, node secret sweep) live in
    // the package, outside this source root, and run from it: KVox has none of its own.
    // This source root holds NO @Cron any more: the housekeeping crons moved into the packages
    // (`@marinoscar/kvox-api/transcripts` #493, `/notes` #495, `/graph` and `/graph-rdf` #496), and
    // each package folder is scanned by an extra run below. (The storage cleanup cron is the
    // platform's since #469; the backup schedule and the telemetry retention crons since #471.)
    // The listener half of queue rule 1 (no @OnEvent body downloads, uploads or calls the storage
    // provider). One file holds a listener in this source root now: the forwarder that turns the
    // platform's settings-change announcement into the graph slice's event (one dispatch, no I/O).
    // The graph's own subscriptions go through the event port, not `@OnEvent`, and the job-failure and
    // node-offline notifiers are the platform's since #470 (outside this root, scanned by the package's
    // own run). The two transcript upload listeners and storage/processing/object-processing.service.ts
    // are gone (#469); the transcript job-failure listener moved into the slice with #493.
    onEventNoIo: {
      minListenerFiles: 1,
      minListenerBodies: 1,
      mustScan: ['kvox/graph/graph-preferences-change.forwarder.ts'],
    },
    userOwnedData: {
      schemaPath: join(API_DIR, 'prisma', 'schema'),
      policies: userOwnedModelRegistry.list(),
      rawSqlAllowlist: RAW_SQL_ALLOWLIST,
      registerIn: 'src/app-registrations/user-owned-models.ts',
    },
    identity: {
      rootModule: IdentityConformanceRoot,
      permissions: permissionRegistry.list(),
      roles: roleRegistry.list(),
      grants: catalogGrants(buildPermissionCatalog()),
    },
    // MaintenanceGuard is the only global guard; the app registers none of its own.
    host: { rootModule: AppModule },
    doctorReadOnly: { fixture: doctorConformanceFixture },
    settings: {
      permissions: permissionRegistry.list(),
      catalog: {
        contents: readCatalog(),
        staleMessage: 'prisma/catalog/system-settings-defaults.json is stale. Run `npm run catalog:settings` in apps/api and commit the result.',
      },
      // notifications, jobs, nodes, databaseBackup, maintenance, storage, telemetry (platform declarations) + transcription, ai (KVox).
      minSystemNamespaces: 9,
    },
    // Key prefixes (#469): the slice's own four plus db-backup are registered by the platform; the
    // three below are this app's writers (platform/storage/storage-key-prefix.manifest.ts, deployment scope).
    // The suite fails on a malformed or overlapping prefix, a missing id, an org-scoped prefix that
    // builds a key without an organization, and a secret-named field in the storage settings schemas.
    storage: { requiredPrefixIds: ['transcripts', 'notes', 'graph', 'exports-users', 'exports-orgs'] },
    // The email slice (#470): the platform templates are registered, every sampled template renders a
    // complete document and escapes markup in its data, and no email settings shape carries a secret.
    // The platform's own templates are sampled by the suite; these are this app's six plus its two
    // overrides of platform names (`user-welcome`, `allowlist-invitation`).
    email: { samples: EMAIL_TEMPLATE_SAMPLES },
    // The notifications slice (#470): the platform channels and events are registered, every event that
    // declares `email` has a template, every other channel has a template or renders raw data, no
    // `notify*` call sits inside a `$transaction` callback, and the Web Push shapes carry no secret.
    // The after-commit allowlist is EMPTY on purpose: this app has no argued exception.
    notifications: { afterCommitAllowlist: [] },
    // The db-backup slice (#471): every dump and restore carries `--enable-row-security` together with
    // `PGOPTIONS=-c app.rls_bypass=on` (in the child env, never argv), `db.restore.run` is server-only and
    // `db.backup.run` node-eligible, every `db_backup:*` permission is system scope, the `database-backups/`
    // key prefix is registered at deployment scope, and every restore carry-over binds its row. This app
    // registers NO carry-over (every table, `kvox_object_ownership` and `kvox_allowlist_reminders` included,
    // is inside the dump; the reason is a comment in app-registrations/db-backup.ts), so none is required.
    dbBackup: { requiredCarryOverIds: [] },
    // The telemetry slice (#471): metric groups are well formed and compute against an empty schema, every
    // `/api/admin/telemetry/*` and `/api/telemetry/*` route carries exactly the permissions its shape needs,
    // the Doctor checks are read-only, no response carries a stored GreptimeDB password, the module boots
    // with telemetry off, and the extension registries (panels, assistant tools) are well formed. This app
    // adds no metric group yet (optional follow-up work), so the default (every registered group) applies.
    // The slice's retention cron lives in the package, outside this source root; its own run scans it.
    telemetry: {},
    // The AI slice's two source scans (#477, epic #472); the five that boot the app run in
    // `ai-conformance.spec.ts`. No provider SDK is imported anywhere this app ships: the API,
    // the web and the CLI reach a model through the platform AI slice only, and its adapters
    // (with their SDKs) live in the package, outside these trees. The manifests below declare
    // none either. `minFiles` stops a mistyped root from passing on an empty tree.
    aiNoSdkLeak: {
      apiTrees: [{ name: 'apps/api/src', root: join(API_DIR, 'src'), minFiles: 100 }],
      webTrees: [{ name: 'apps/web/src', root: join(REPO_DIR, 'apps', 'web', 'src'), minFiles: 50 }],
      noSdkManifests: [
        join(REPO_DIR, 'package.json'),
        join(API_DIR, 'package.json'),
        join(REPO_DIR, 'apps', 'web', 'package.json'),
        join(REPO_DIR, 'apps', 'cli', 'package.json'),
        join(REPO_DIR, 'packages', 'shared', 'package.json'),
      ],
    },
    // No agent-orchestration framework (LangChain, LangGraph, and the like) anywhere: the Ask tool
    // loop and the graph tasks run on the platform stream, and `allowedRoots` is EMPTY on purpose.
    aiOrchestrationBoundary: {
      apiSourceRoots: [join(API_DIR, 'src')],
      webSourceRoots: [join(REPO_DIR, 'apps', 'web', 'src')],
      packageJsonPaths: [
        join(REPO_DIR, 'package.json'),
        join(API_DIR, 'package.json'),
        join(REPO_DIR, 'apps', 'web', 'package.json'),
        join(REPO_DIR, 'apps', 'cli', 'package.json'),
        join(REPO_DIR, 'packages', 'shared', 'package.json'),
      ],
      allowedRoots: {},
    },
    // The onboarding slice (#481): the registries are well formed, every step's permission is one the
    // app's RBAC grants, and one derivation, for a caller holding every permission against a spied data
    // port, resolves each fact once and reads nothing while evaluating. The samples stand in for the five
    // facts that need an app provider (the transcription probe, the Prisma counts, the AI readiness).
    onboarding: {
      permissions: permissionRegistry.list(),
      factSamples: {
        'app.ownTranscriptCount': 0,
        'app.ownReadyTranscriptCount': 0,
        'app.ownNoteCount': 0,
        'app.transcriptionAvailable': false,
        'app.aiReadiness': { available: false, hasKey: false, providerSet: false },
      },
      minSteps: 5,
    },
    // Owners besides the platform's: `transcription` is KVox's own purpose (the speech-to-text provider key).
    credentials: { appOwners: ['app', 'transcription'] },
    // The user-data slice (#480): every owner model has a keep-or-delete decision (deleted in a
    // registered category that `everything` reaches, or kept with a reason), every hint and scope
    // names a model, column and category that exist, and a delete order exists. The datamodel is the
    // composed schema folder the module itself plans from (the generated client's DMMF lacks `onDelete`).
    userData: { datamodel: composedSchemaDatamodel(__dirname)() },
    // The sharing slice (#485): nothing in this app reads or writes the sharing tables directly (every
    // grant goes through `GrantsService`, `AccessPolicy` and the platform's `accessibleSql`), no model
    // with an `owner_group_id` column is left unregistered (this app has none), the link routes are
    // guarded, the slice's partial unique indexes exist in the migrations, and the registered resource
    // type ids equal the committed snapshot: a type id is PERMANENT once grants of it exist.
    sharing: {
      schemaPath: join(API_DIR, 'prisma', 'schema'),
      migrationsDir: join(API_DIR, 'prisma', 'migrations'),
      rootModule: AppModule,
      isPublic: (target) => Reflect.getMetadata(IS_PUBLIC_KEY, target) === true,
      resourceTypeIds: ['transcript'],
    },
    // The exports slice (#532, Part B of #479): every source names a registered permission and offers a
    // registered writer, the user-owned registry agrees with the datamodel (`exportOmit` names real
    // fields), and no secret, hash, omitted column or excluded model reaches an export file with any
    // writer. The datamodel is the generated client's, the one `exports.config.ts` mounts the slice with.
    // The sentinel run covers the platform sources; the `kvox-content` source is held to the same rules
    // by `test/exports/kvox-export-policy.spec.ts`.
    exports: { datamodel: Prisma.dmmf.datamodel, permissions: permissionRegistry.list() },
  },
});

// The transcription slice's provider conformance suite (`@marinoscar/kvox-api/transcription/testing`,
// #492): the built-in provider the application registers, held to the same contract an extra provider
// is. Static rules only here (identity, capabilities, the admin form carries no secret, the context
// never serialises its key); the upstream-failure rules run in the package against a fake transport.
describeTranscriptionProviderConformance(
  'assemblyai as the application registers it',
  () => new AssemblyAiProvider(new TranscriptionProviderRegistry()),
  { describe, it, expect },
  { settings: { region: 'us', speechModel: 'universal-3-5-pro, universal-2' } },
);

// The search slice's conformance suite (`@marinoscar/kvox-api/search/testing`, #494), over the web
// edition's binding: the real service and embedder with the sharing-aware visibility rule
// (`kvox/search/shared-transcript-visibility.ts`) and the permission strings the application
// configures (`kvox/search/search.config.ts`). The database is the suite's statement-answering
// double, given the two things the visibility rule asks of the application's client: the default
// organization and `runInOrg`. The real-database proof (shared transcripts through platform grants,
// row-level security) is the application's own `test/integration/search.db.spec.ts`.
describeSearchConformance(
  'the web edition binding',
  () => {
    const jobs = createFakeKvoxJobs();
    const unusedDb = {} as never;
    const indexOptions = { batchSize: KVOX_EMBEDDING.maxBatchSize };

    return {
      indexHandler: new SearchIndexHandler(
        jobs,
        unusedDb,
        {} as never,
        new SearchIndexService(unusedDb, jobs),
        indexOptions,
      ),
      serviceFor: ({ ai, db }) => {
        const options: ResolvedSearchOptions = {
          semanticEnabled: true,
          provider: KVOX_EMBEDDING.provider,
          typePermissions: { transcript: PERMISSIONS.TRANSCRIPTS_READ, note: PERMISSIONS.NOTES_READ },
        };
        // What the sharing helpers ask of the client: the default organization and `runInOrg`.
        const prisma = Object.assign(Object.create(db as object), {
          $queryRaw: (db as { $queryRaw: unknown }).$queryRaw,
          organization: { findFirst: async () => ({ id: '33333333-3333-4333-8333-333333333333' }) },
          runInOrg: async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
        });

        return new SearchService(
          db,
          new SearchQueryEmbedder(ai, options),
          new SharedTranscriptVisibility(prisma as never),
          options,
        );
      },
    };
  },
  { describe, it, expect },
  { permissions: { transcript: PERMISSIONS.TRANSCRIPTS_READ, note: PERMISSIONS.NOTES_READ } },
);

// The transcripts slice's conformance suites (`@marinoscar/kvox-api/transcripts/testing`, #493), over the
// web edition's binding: the nine handlers as the application's module built them (the real DI wiring
// over the platform adapters), and the three built-in exporters. The pipeline invariants (the poll
// re-enqueue passes `skipDedup`, name_check is server-only and tried once, only the transcode is node
// eligible, the three provider types share one bucket) are held here exactly as the package holds
// them over its fakes.
let transcriptsContext: TestContext | undefined;

afterAll(async () => {
  if (transcriptsContext) await closeTestApp(transcriptsContext);
});

describeTranscriptsConformance(
  'the web edition binding',
  async () => {
    transcriptsContext = await createTestApp();
    const app = transcriptsContext.module;
    const options = app.get<ResolvedTranscriptsOptions>(TRANSCRIPTS_MODULE_OPTIONS, { strict: false });

    return {
      handlers: [
        MediaAudioTranscodeHandler,
        TranscriptExportHandler,
        TranscriptNameCheckHandler,
        TranscriptPurgeHandler,
        TranscriptSnapshotHandler,
        TranscriptionIngestHandler,
        TranscriptionPollHandler,
        TranscriptionSubmitHandler,
        TranscriptsHousekeepingHandler,
      ].map((handler) => app.get(handler, { strict: false })),
      // The slice's service over the given queue and the application's own resolved options.
      pipelineFor: (jobs) =>
        new TranscriptPipelineService({} as never, jobs, {} as never, options, {} as never, {} as never),
      // The JSON import (#571): the slice's parser, and its service over the kit's in-memory
      // ports with the application's own resolved options.
      importer: {
        parse: parseTranscriptImport,
        serviceFor: (ports) =>
          new TranscriptImportService(
            ports.prisma,
            ports.events,
            ports.audit,
            new TranscriptObjectsService(ports.objectStore, options),
            new TranscriptPipelineService(
              {} as never,
              ports.jobs,
              {} as never,
              options,
              {} as never,
              // The search index is a peer slice's; the kit asserts on the job port only.
              { enqueue: async () => undefined } as never,
            ),
          ),
      },
    };
  },
  { describe, it, expect },
);

for (const exporter of [
  new JsonTranscriptExporter(new TranscriptExporterRegistry()),
  new MarkdownTranscriptExporter(new TranscriptExporterRegistry()),
  new PdfTranscriptExporter(new TranscriptExporterRegistry()),
]) {
  describeTranscriptExporterConformance(exporter, { describe, it, expect }, { minBytes: exporter.format === 'pdf' ? 500 : 1 });
}

// The transcripts housekeeping cron lives in the package, outside `apps/api/src`; the queue rule that a
// `@Cron` only enqueues (CLAUDE.md rule 1) is held for it by scanning its folder with the same suite.
runPlatformConformance({
  sourceRoots: [join(REPO_DIR, 'packages', 'kvox-api', 'src', 'transcripts', 'tasks')],
  suites: { cronEnqueueOnly: { exempt: [], minCronFiles: 1 } },
});

// The notes slice's conformance suites (`@marinoscar/kvox-api/notes/testing`, #495), over the web edition's
// binding: the six handlers as the application's module built them, and the three built-in exporters. The
// pipeline invariants (six pinned job types; note.generate and note.retitle server-only and tried once;
// only note.source.extract node-eligible; the ready event after the commit) are held here exactly as the
// package holds them over its fakes.
let notesContext: TestContext | undefined;

afterAll(async () => {
  if (notesContext) await closeTestApp(notesContext);
});

describeNotesConformance(
  'the web edition binding',
  async () => {
    notesContext = await createTestApp();
    const app = notesContext.module;

    return {
      handlers: [
        NoteExportHandler,
        NoteGenerateHandler,
        NoteImportFormatHandler,
        NoteLibraryImportHandler,
        NotePurgeHandler,
        NoteRetitleHandler,
        NoteSourceExtractHandler,
        NotesHousekeepingHandler,
      ].map((handler) => app.get(handler, { strict: false })),
    };
  },
  { describe, it, expect },
);

for (const exporter of [
  new MarkdownNoteExporter(new NoteExporterRegistry()),
  new PdfNoteExporter(new NoteExporterRegistry()),
  new WordNoteExporter(new NoteExporterRegistry()),
]) {
  describeNoteExporterConformance(exporter, { describe, it, expect }, { minBytes: exporter.format === 'markdown' ? 1 : 500 });
}

// The notes housekeeping cron lives in the package too; the same queue rule holds for its folder.
runPlatformConformance({
  sourceRoots: [join(REPO_DIR, 'packages', 'kvox-api', 'src', 'notes', 'tasks')],
  suites: { cronEnqueueOnly: { exempt: [], minCronFiles: 1 } },
});

// The graph slices' housekeeping crons (`kg.migrate`'s hourly tick and the export expiry sweep) live in the
// packages, outside `apps/api/src`; the queue rule that a `@Cron` only enqueues (CLAUDE.md rule 1) is held
// for them by scanning their folders with the same suite.
runPlatformConformance({
  sourceRoots: [join(REPO_DIR, 'packages', 'kvox-api', 'src', 'graph', 'migrate')],
  suites: { cronEnqueueOnly: { exempt: [], minCronFiles: 1 } },
});
runPlatformConformance({
  sourceRoots: [join(REPO_DIR, 'packages', 'kvox-api', 'src', 'graph-rdf', 'export')],
  suites: { cronEnqueueOnly: { exempt: [], minCronFiles: 1 } },
});

// The graph slices' conformance suites (`@marinoscar/kvox-api/graph/testing`, `/graph-extraction/testing`
// and `/graph-rdf/testing`, #496), over the web edition's binding: the ten `kg.*` handlers as the
// application's modules built them (the real DI wiring over the platform adapters). The invariants (every
// type server-only with its pinned profile, only the entity digest, extract, resolve and embed spending the
// owner's key, only `GraphWriteService` creating a graph row, a sensitive PersonFact never reaching a model
// or an embedder, no access answering 403) are held here exactly as the package holds them over its fakes.
// The source scan reads the package's compiled files from `node_modules`.
let graphContext: TestContext | undefined;

afterAll(async () => {
  if (graphContext) await closeTestApp(graphContext);
});

async function graphHandlers() {
  graphContext ??= await createTestApp();
  const app = graphContext.module;

  return {
    core: [KgSpeakerLinkHandler, KgPurgeHandler, KgGraphLayoutHandler, KgMigrateHandler, EntityDigestHandler].map((handler) =>
      app.get(handler, { strict: false }),
    ),
    extraction: [KgExtractHandler, KgResolveHandler, KgEmbedHandler, KgTopicsPromoteHandler, KgLibraryReconcileHandler, KgAutocommitHandler].map((handler) => app.get(handler, { strict: false })),
    rdf: [KgExportHandler, KgImportHandler].map((handler) => app.get(handler, { strict: false })),
  };
}

describeGraphConformance('the web edition binding', async () => ({ handlers: (await graphHandlers()).core }), { describe, it, expect }, {
  sourceRoot: join(REPO_DIR, 'packages', 'kvox-api', 'src'),
});
describeGraphExtractionConformance('the web edition binding', async () => ({ handlers: (await graphHandlers()).extraction }), {
  describe,
  it,
  expect,
});
describeGraphRdfConformance('the web edition binding', async () => ({ handlers: (await graphHandlers()).rdf }), { describe, it, expect });

// kvox-guarded routes: the identity suite's two route rules, for the controllers it cannot see (see
// `isKvoxGuarded`). Every route of a controller the `@marinoscar/kvox-api` slices guard is authenticated
// through `KvoxAuthGuard`, and every permission it enforces (the option names resolved through the
// slice's configured map) is a registered permission.
describe('kvox-guarded routes', () => {
  const handlers = (controller: Function) =>
    Object.getOwnPropertyNames(controller.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => ({ name, handler: controller.prototype[name] as Function }))
      .filter(({ handler }) => typeof handler === 'function' && Reflect.getMetadata('path', handler) !== undefined);

  it('finds the transcription, transcripts, search, notes, graph and Ask controllers (a path mistake must not make this vacuous)', () => {
    expect(KVOX_CONTROLLERS.map((controller) => controller.name).sort()).toEqual([
      'AskConversationsController',
      'AskMessageStreamController',
      'AskMessagesController',
      'EntityBriefController',
      'GraphAttributeDefsController',
      'GraphController',
      'GraphEntitiesController',
      'GraphExportController',
      'GraphExtractionController',
      'GraphImportBatchesController',
      'GraphImportController',
      'GraphInsightsController',
      'GraphOverviewController',
      'GraphProposalsController',
      'GraphRdfController',
      'GraphReadController',
      'GraphResolutionController',
      'GraphReviewQueueController',
      'GraphTopicsPromoteController',
      'NoteGenerationStreamController',
      'NoteImportController',
      'NoteLibrariesController',
      'NoteLibraryUploadController',
      'NoteSourcesController',
      'NoteTemplatesController',
      'NotesController',
      'SearchController',
      'SearchIndexController',
      'TranscriptNameChecksController',
      'TranscriptionConfigController',
      'TranscriptionSettingsController',
      'TranscriptsController',
    ]);
  });

  it.each(KVOX_CONTROLLERS.map((controller) => [controller.name, controller] as const))(
    '%s: every route is behind KvoxAuthGuard and names only registered permissions',
    (_name, controller) => {
      const registered = new Set(permissionRegistry.list().map((entry: { id: string }) => entry.id));
      const map = TranscriptionConfig.providers
        ?.map((provider) => provider as { provide?: unknown; useValue?: Record<string, string> })
        .find((provider) => provider.provide === KVOX_AUTH_PERMISSIONS)?.useValue as Record<string, string>;
      const problems: string[] = [];

      for (const { name, handler } of handlers(controller)) {
        const guards = [...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])];
        if (!guards.includes(KvoxAuthGuard)) problems.push(`${controller.name}#${name} is not behind KvoxAuthGuard`);

        const keys = (Reflect.getMetadata(KVOX_PERMISSION_KEYS_KEY, handler) ?? []) as string[];
        const direct = (Reflect.getMetadata(KVOX_PERMISSIONS_KEY, handler) ?? []) as string[];
        for (const permission of [...direct, ...keys.map((key) => map[key])]) {
          if (!registered.has(permission)) problems.push(`${controller.name}#${name} names the unregistered permission "${permission}"`);
        }
      }

      expect(problems).toEqual([]);
    },
  );
});
