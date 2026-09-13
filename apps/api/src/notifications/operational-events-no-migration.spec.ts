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
