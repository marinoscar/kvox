// =============================================================================
// Platform conformance (issue #465, epic #462)
// =============================================================================
import '../src/kvox.manifest';
import '../src/app-registrations/registrations';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildPermissionCatalog, catalogGrants, permissionRegistry, roleRegistry, userOwnedModelRegistry } from '@marinoscar/platform-api/core';
import '@marinoscar/platform-api/credentials/testing';
import '@marinoscar/platform-api/doctor/testing';
import '@marinoscar/platform-api/host/testing';
import '@marinoscar/platform-api/identity/testing';
import '@marinoscar/platform-api/settings/testing';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';

import { AppModule } from '../src/app.module';

const API_DIR = join(__dirname, '..');

function readCatalog(): string | undefined {
  try {
    return readFileSync(join(API_DIR, 'prisma', 'catalog', 'system-settings-defaults.json'), 'utf8');
  } catch {
    return undefined;
  }
}

const CRON_EXEMPT = [
  {
    file: 'jobs/tasks/job-stuck-reset.task.ts',
    why:
      'The lease reaper is what recovers abandoned jobs. Recovery that depends on the ' +
      'queue it recovers is not recovery: a queue wedged enough to strand a reaper job needs reaping.',
  },
  {
    file: 'jobs/tasks/temp-file-janitor.task.ts',
    why:
      "It sweeps THIS PROCESS'S local disk after a SIGKILLed worker. A node or another replica " +
      'claiming that job would sweep the wrong filesystem and leave the full one untouched.',
  },
  {
    file: 'nodes/tasks/node-secret-sweep.task.ts',
    why:
      'It revokes the short-lived database roles brokered to worker nodes, including for jobs settled by the ' +
      'reaper. Making revocation depend on the queue leaks live credentials while the queue is wedged.',
  },
] as const;

/**
 * Files that issue raw SQL. Each is argued: the Prisma client cannot express the statement
 * (pgvector, trigram, tstzrange, recursive CTEs, advisory locks, SKIP LOCKED, `SET LOCAL`,
 * catalog reads) and every statement is scoped by a bound owner id taken from the authenticated
 * principal or from a row the caller was already authorised to read, never from a raw request id.
 */
const RAW_SQL_ALLOWLIST = [
  { file: 'about/about.service.ts', why: 'Reads `server_version()` and `_prisma_migrations` for the About page; no user data, no request input.' },
  { file: 'allowlist-reminders/allowlist-reminders.service.ts', why: 'The kvox_allowlist_reminders side table: atomic INSERT .. ON CONFLICT counter, a join to allowed_emails and a bounded orphan DELETE. Allowlist bookkeeping, no user-owned rows; ids are bound uuid parameters.' },
  { file: 'ask/ask-conversations.service.ts', why: 'Conversation summaries and the running-turn partial-unique-index paths Prisma cannot express; every statement filters on the authenticated owner_id.' },
  { file: 'ask/citations.ts', why: 'Resolves citation sources across transcripts and notes with a join Prisma cannot express; bound by the owner id of the conversation.' },
  { file: 'db-backup/db-backup-runner.service.ts', why: 'Reads the server version for the backup record; instance-wide metadata, no user data.' },
  { file: 'db-backup/migration-state.util.ts', why: 'Reads `_prisma_migrations` to compare migration state; no user data.' },
  { file: 'db-backup/restore-preflight.service.ts', why: 'Reads pg_extension for the restore pre-flight; catalog metadata, creates and drops nothing.' },
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
  { file: 'graph/resolution/distinct-pair.service.ts', why: 'Distinct-pair lookups with ordered-pair predicates; scoped by owner_id.' },
  { file: 'graph/resolution/merge.service.ts', why: 'Entity merge with row locks across several tables; scoped by owner_id.' },
  { file: 'graph/speaker-link/speaker-link.reconciler.ts', why: 'Takes a per-transcript advisory lock (`pg_advisory_xact_lock`); touches no rows.' },
  { file: 'graph/write/graph-write.service.ts', why: 'GraphWriteService is the single graph write path; its raw statements use the live-statement and speaker-link partial unique indexes and are scoped by owner_id.' },
  { file: 'health/indicators/database.indicator.ts', why: 'Health probe: `SELECT 1`.' },
  { file: 'jobs/job-claim.service.ts', why: 'Atomic claim with `FOR UPDATE SKIP LOCKED`; no user-owned rows.' },
  { file: 'jobs/job-insights.service.ts', why: 'Read-only aggregates over the jobs table for the admin console; no user-owned rows.' },
  { file: 'prisma/prisma.service.ts', why: 'Test-only table truncation and connection housekeeping; refused outside the test environment.' },
  { file: 'search/indexing/search-index.handler.ts', why: 'Writes pgvector embeddings and chunk rows for the owner of the job; owner id bound from the job.' },
  { file: 'search/search.service.ts', why: 'Full-text, trigram and pgvector search; every statement filters on the authenticated owner_id.' },
  { file: 'storage/legacy-object-ownership.store.ts', why: 'Temporary storage_objects.managed_by deviation (#469) that the platform schema does not declare; keyed by storage object id.' },
  { file: 'transcripts/transcript-editing.service.ts', why: 'Row locks and ordered segment rewrites inside the edit transaction; scoped to a transcript the caller owns.' },
] as const;

runPlatformConformance({
  sourceRoots: [join(API_DIR, 'src')],
  suites: {
    cronEnqueueOnly: { exempt: CRON_EXEMPT, minCronFiles: 8 },
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
    host: { skip: 'adopted in #464' },
    doctorReadOnly: { skip: 'adopted in #464' },
    settings: {
      permissions: permissionRegistry.list(),
      catalog: {
        contents: readCatalog(),
        staleMessage: 'prisma/catalog/system-settings-defaults.json is stale. Run `npm run catalog:settings` in apps/api and commit the result.',
      },
      // notifications, jobs, nodes, databaseBackup, maintenance (platform declarations) + transcription, ai (KVox).
      minSystemNamespaces: 7,
    },
    // Owners besides the platform's: `transcription` is KVox's own purpose (the speech-to-text provider key).
    credentials: { appOwners: ['app', 'transcription'] },
  },
});
