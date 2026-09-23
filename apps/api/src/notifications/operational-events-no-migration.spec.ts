import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NOTIFICATION_EVENTS } from './notification-events';

// =============================================================================
// The four operational events add NO SCHEMA (issue #288, epic #254)
// =============================================================================
//
// #288 is the issue that proves epic #109's central promise on a new axis:
// ADDING A NOTIFICATION COSTS ONE REGISTRY ENTRY, a template and a call site —
// no table, no column, no migration, no endpoint.
//
// That is not a nice-to-have. `notification_deliveries`, `notifications` and
// the sparse `user_settings.notifications` blob are DELIBERATELY keyed by an
// opaque event-key STRING rather than by a foreign key into an events table, so
// a new event is data and not DDL. A migration filed for these four would mean
// somebody had reached for a per-event table or a per-event column, and the very
// next event would need one too.
//
// The guard is a pinned list rather than a count, so the failure message names
// the migration that was added rather than saying "expected 11, got 12".
// =============================================================================

/**
 * Every migration in the repository at the time #288 landed.
 *
 * ⚠ ADDING TO THIS LIST IS FINE — later issues legitimately add migrations, and
 * this list is expected to grow. What it must never do is grow FOR THESE FOUR
 * EVENTS. If you are extending it, the question to answer in review is "what
 * schema does my change need, and is it about notifications?".
 */
const MIGRATIONS_AT_288 = [
  '20260124223146_initial',
  '20260329151231_add_personal_access_tokens',
  '20260830211041_add_credentials',
  '20260831010356_add_notification_deliveries',
  '20260831014110_drop_stale_uuid_defaults',
  '20260831030721_add_notifications',
  '20260905182958_add_push_subscriptions',
  '20260906120000_add_jobs',
  '20260906190000_add_worker_nodes',
  '20260907120000_add_database_backup_runs',
  '20260907130000_add_notification_broadcasts',
  '20260907140000_add_backup_run_job_link',
  // #349 (epic #345): the per-job secret broker's handle ledger. A schema
  // change, and deliberately not one about notifications — see the ⚠ above.
  '20260907150000_add_job_node_secrets',
  // #352 (epic #345): `database_backup_runs.pg_dump_version` — which client
  // wrote the archive, which only matters once a machine this API cannot
  // inspect can be the one that wrote it. Also not about notifications.
  '20260907160000_add_backup_run_pg_dump_version',
  // #21: `storage_objects.part_size` / `managed_by` — the part size an upload
  // was sliced with, and the module that owns the object. Multi-GB resumable
  // uploads, and equally not about notifications.
  '20260914120000_add_storage_part_size_and_managed_by',
  // #24 (epic #19): the six transcript tables (transcripts,
  // transcript_speakers, transcript_segments, transcript_versions,
  // transcript_shares, transcript_exports). A data model for audio
  // transcription, and equally not about notifications.
  '20260914130000_add_transcripts',
  // #48 (epic #45): the five note tables (notes, note_templates,
  // note_generations, note_versions, note_exports) and their RBAC/built-in
  // template seed. A data model for AI-generated notes, and equally not
  // about notifications — the three notification events this feature adds
  // later (notes.note_ready, notes.note_failed, notes.preview_failed,
  // docs/specs/notes.md's own "Notifying somebody about a note" section)
  // follow the identical registry-entry-only recipe #288 exists to prove,
  // with no schema of their own either.
  '20260914140000_add_notes',
  // #47 (epic #45): `user_ai_credentials`, the first PER-USER secret in this
  // schema — an encrypted AI provider key behind a cascading foreign key,
  // which is the one thing the shared `credentials` table structurally could
  // not offer. A credential store, and equally not about notifications.
  '20260914150000_add_user_ai_credentials',
  // #174 (epic #164): the generated `tsvector` columns and GIN indexes that
  // make full-text search over transcript and note CONTENT possible. Three
  // `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (...) STORED`
  // statements and three indexes — a search index, and equally not about
  // notifications.
  '20260915120000_add_search_vectors',
  // #181 (epic #165): the pgvector storage for semantic search
  // (search_chunks, search_embeddings, search_index_state) — the CREATE
  // EXTENSION and the vector(1536)/HNSW schema that layer 2 of search needs.
  // A data model for embeddings, and equally not about notifications.
  '20260915130000_add_search_embeddings',
  // #180 (epic #163): `notes.title_source`, one enum column recording where a
  // note's title came from so an AI titling pass can tell a name a person
  // chose from one it may improve on. A provenance column, and equally not
  // about notifications.
  '20260915210000_add_note_title_source',
  // #301 (epic #271): `allowed_emails.reminder_count` and `.last_reminder_at`,
  // the bookkeeping behind an administrator pressing "send reminder" on an
  // invitation nobody has claimed yet.
  //
  // ⚠ THE CLOSEST CALL IN THIS LIST, AND IT STILL BELONGS HERE. A reminder IS
  // delivered as a notification, so unlike every entry above it this migration
  // is adjacent to the subject. What this file actually forbids is a migration
  // that makes the DATABASE the source of truth for events — a table of event
  // keys, a seeded row per event, a preference the registry would then be a
  // cache of. These two columns are neither: they record how many times a
  // human pressed a button and when, about one allowlist row, and they name no
  // event key. `allowlist.invitation_reminder` is declared in
  // `notification-events.ts` like every other event, with no migration and no
  // row anywhere, which is precisely the property this spec exists to keep.
  '20260918120000_add_allowlist_reminder_tracking',
  // #307 (epic #306): four nullable snapshot columns on `note_generations`
  // recording the assembled prompt a generation sent. Nothing to do with
  // notifications.
  '20260923120000_add_note_generation_context_snapshot',
  // #310 (epic #306): `user_hidden_note_templates`, a per-user "don't show me
  // this template" LISTING preference over note templates. A join table, and
  // equally not about notifications.
  '20260923130000_add_user_hidden_note_templates',
];

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('#288 adds no migration', () => {
  it('the migrations directory is unchanged by this issue', () => {
    expect(migrationDirectories()).toEqual([...MIGRATIONS_AT_288].sort());
  });

  it('no migration mentions any of the four event keys', () => {
    // The other shape this failure takes: a migration that seeds the events
    // into a table, which would make the registry a cache of the database
    // rather than the source of truth `notification-events.ts` says it is.
    const names = migrationDirectories().join(' ');

    for (const fragment of ['job_failed', 'node_offline', 'backup_failed', 'restore_completed']) {
      expect(names).not.toContain(fragment);
    }
  });

  it('the four events are declared in code, which is the whole point', () => {
    // The positive half: they exist, and they exist in the registry file.
    const keys = NOTIFICATION_EVENTS.map((event) => event.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        'jobs.job_failed',
        'nodes.node_offline',
        'db_backup.backup_failed',
        'db_backup.restore_completed',
      ]),
    );
  });
});
