// =============================================================================
// Platform conformance (issues #465, #464, #468, #469, #470 and #471, epics #462 and #467)
// =============================================================================
import '../src/kvox.manifest';
import '../src/app-registrations/registrations';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildPermissionCatalog, catalogGrants, permissionRegistry, roleRegistry, userOwnedModelRegistry } from '@marinoscar/platform-api/core';
import '@marinoscar/platform-api/ai/testing';
import '@marinoscar/platform-api/credentials/testing';
import '@marinoscar/platform-api/db-backup/testing';
import '@marinoscar/platform-api/doctor/testing';
import '@marinoscar/platform-api/email/testing';
import '@marinoscar/platform-api/host/testing';
import '@marinoscar/platform-api/identity/testing';
import '@marinoscar/platform-api/jobs/testing';
import '@marinoscar/platform-api/notifications/testing';
import '@marinoscar/platform-api/settings/testing';
import '@marinoscar/platform-api/storage/testing';
import '@marinoscar/platform-api/telemetry/testing';
import type { DoctorConformanceFixture } from '@marinoscar/platform-api/doctor/testing';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';

import { AppModule } from '../src/app.module';
// The notification and email registries are filled by this import (it is also reached through
// AppModule); the suites below read them, so name the dependency.
import '../src/platform/notifications/notification.manifest';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaSystemService } from '../src/prisma/prisma-system.service';
import { closeTestApp, createTestApp, type TestContext } from './helpers/test-app.helper';

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
  { file: 'ask/ask-conversations.service.ts', why: 'Conversation summaries and the running-turn partial-unique-index paths Prisma cannot express; every statement filters on the authenticated owner_id.' },
  { file: 'ask/citations.ts', why: 'Resolves citation sources across transcripts and notes with a join Prisma cannot express; bound by the owner id of the conversation.' },
  { file: 'graph/brief/brief-queries.ts', why: 'Entity brief aggregates over the graph (CTEs, tstzrange); every query is bound to the owner id.' },
  { file: 'graph/dedup/item-candidates.service.ts', why: 'pgvector similarity for item deduplication; scoped by owner_id in every statement.' },
  { file: 'graph/dedup/rejection-memory.stage.ts', why: 'Rejected-proposal memory lookup via array and vector operators; scoped by owner_id.' },
  { file: 'graph/export/graph-export.source.ts', why: 'Streams the owner graph for RDF export with keyset pagination; scoped by owner_id.' },
  { file: 'graph/extraction/proposal-writer.service.ts', why: 'Writes proposal rows through the kg_proposals partial unique indexes Prisma cannot declare; owner id bound from the job.' },
  { file: 'graph/handlers/kg-embed.handler.ts', why: 'Reads and writes pgvector embedding columns (Unsupported type) for the owner of the job.' },
  { file: 'graph/layout/graph-overview.service.ts', why: 'Whole-graph overview aggregate for the owner; scoped by owner_id.' },
  { file: 'graph/layout/layout-source.ts', why: 'Reads the owner graph for layout computation; scoped by owner_id.' },
  { file: 'graph/migrate/kg-migrate.repository.ts', why: 'kg.migrate is the one named exception allowed to bypass GraphWriteService; owner id bound from the migration plan.' },
  { file: 'graph/proposals/proposal-commit.service.ts', why: 'Commits a reviewed proposal with row locks and tstzrange validity; filters on the proposal owner.' },
  { file: 'graph/proposals/proposal-revert.service.ts', why: 'Reverts a committed proposal using SAVEPOINTs and tstzrange validity; filters on the proposal owner.' },
  { file: 'graph/proposals/proposals.service.ts', why: 'Proposal queue aggregates and partial-index paths; every statement filters on the owner id.' },
  { file: 'graph/purge/kg-purge.service.ts', why: 'Owner-wide graph purge in dependency order (Danger Zone); the owner id comes from the authenticated principal.' },
  { file: 'graph/read/graph-evidence.service.ts', why: 'Evidence lookups joined to transcript segments; scoped by owner_id.' },
  { file: 'graph/read/graph-neighborhood.service.ts', why: 'Recursive-CTE neighbourhood expansion over the owner graph; scoped by owner_id.' },
  { file: 'graph/read/graph-query-timeout.ts', why: 'Issues `SET LOCAL statement_timeout` with a numeric constant; touches no table, no request input.' },
  { file: 'graph/read/graph-read.service.ts', why: 'Graph reads using trigram and as-of (tstzrange) predicates; scoped by owner_id.' },
  { file: 'graph/resolution/adjudication.service.ts', why: 'Entity-resolution adjudication reads; scoped by owner_id.' },
  { file: 'graph/resolution/candidate.service.ts', why: 'Trigram and pgvector candidate retrieval for entity resolution; scoped by owner_id.' },
  { file: 'doctor/checks/db-extensions.doctor-check.ts', why: 'Doctor check: one read-only `SELECT` on the `pg_extension` catalog (are `vector` and `pg_trgm` installed); no user data, no request input.' },
  { file: 'graph/resolution/distinct-pair.service.ts', why: 'Distinct-pair lookups with ordered-pair predicates; scoped by owner_id.' },
  { file: 'graph/resolution/merge.service.ts', why: 'Entity merge with row locks across several tables; scoped by owner_id.' },
  { file: 'graph/speaker-link/speaker-link.reconciler.ts', why: 'Takes a per-transcript advisory lock (`pg_advisory_xact_lock`); touches no rows.' },
  { file: 'graph/write/graph-write.service.ts', why: 'GraphWriteService is the single graph write path; its raw statements use the live-statement and speaker-link partial unique indexes and are scoped by owner_id.' },
  { file: 'prisma/prisma.service.ts', why: 'Test-only table truncation and connection housekeeping; refused outside the test environment.' },
  { file: 'search/indexing/search-index.handler.ts', why: 'Writes pgvector embeddings and chunk rows for the owner of the job; owner id bound from the job.' },
  { file: 'search/search.service.ts', why: 'Full-text, trigram and pgvector search; every statement filters on the authenticated owner_id.' },
  { file: 'transcripts/transcript-editing.service.ts', why: 'Row locks and ordered segment rewrites inside the edit transaction; scoped to a transcript the caller owns.' },
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
  'transcript-shared': {
    transcriptId: 'transcript-1',
    title: HOSTILE,
    role: 'editor',
    ownerName: HOSTILE,
    appUrl: 'https://app.example.test',
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
    // Four files hold a @Cron: kg-export-expiry, kg-migrate-scheduler, notes-housekeeping,
    // transcripts-housekeeping (the storage cleanup cron is the platform's since #469; the backup
    // schedule and the telemetry retention crons are the platform's since #471).
    cronEnqueueOnly: { exempt: [], minCronFiles: 4 },
    // The listener half of queue rule 1 (no @OnEvent body downloads, uploads or calls the storage
    // provider). Five files hold a listener, one body each, every one a dispatch or one bounded
    // write. The job-failure and node-offline notifiers are the platform's since #470 (outside
    // this source root, scanned by the package's own run). The two transcript upload listeners and storage/processing/object-processing.service.ts
    // are gone (#469): the pipeline starts from transcripts/transcript-upload.processor.ts, a
    // platform ObjectProcessor that runs in the storage.object.process job.
    onEventNoIo: {
      minListenerFiles: 5,
      minListenerBodies: 5,
      mustScan: [
        'graph/layout/graph-layout.listener.ts',
        'graph/listeners/speaker-identified.listener.ts',
        'graph/preferences/graph-preferences-change.forwarder.ts',
        'graph/resolution/listeners/graph-preferences.listener.ts',
        'transcripts/listeners/transcript-job-failure.listener.ts',
      ],
    },
    userOwnedData: {
      schemaPath: join(API_DIR, 'prisma', 'schema'),
      policies: userOwnedModelRegistry.list(),
      rawSqlAllowlist: RAW_SQL_ALLOWLIST,
      registerIn: 'src/app-registrations/user-owned-models.ts',
    },
    identity: {
      rootModule: AppModule,
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
    storage: { requiredPrefixIds: ['transcripts', 'notes', 'graph'] },
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
    // Owners besides the platform's: `transcription` is KVox's own purpose (the speech-to-text provider key).
    credentials: { appOwners: ['app', 'transcription'] },
  },
});
