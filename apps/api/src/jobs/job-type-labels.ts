// =============================================================================
// Job type display labels (issue #259, epic #254)
// =============================================================================
//
// A `Job.type` is a machine key (`'example.echo'`), chosen for dispatch and
// for stability across renames. The admin dashboard shows it to a person, and
// a person reading a queue at 2am should see a phrase, not a dotted
// identifier. This file is the one map between the two.
//
// -----------------------------------------------------------------------------
// A MAP PLUS A FALLBACK, NOT A REQUIRED FIELD ON `JobHandler`
// -----------------------------------------------------------------------------
//
// The obvious alternative is a `readonly label: string` on the handler
// interface, so a type cannot exist without a label. Rejected: it makes the
// contract bigger for a presentation concern, and the contract's smallness is
// the thing epic #254 is actually selling ("one class, no queue wiring"). The
// interface's job is to be the minimum a worker needs to run a job; nothing a
// worker does requires a display string.
//
// -----------------------------------------------------------------------------
// AN UNMAPPED TYPE RENDERS AS ITSELF, NEVER BLANK
// -----------------------------------------------------------------------------
//
// THIS IS THE POINT OF THE HELPER BELOW. A fork adds handlers this repository
// has never heard of — that is the whole promise — so this map is
// structurally incomplete at all times, and a lookup that returned
// `undefined` would render an empty cell in the dashboard for exactly the
// types a fork cares most about. Falling back to the raw type string means an
// unlabelled type is merely less pretty ("my-feature.do-the-thing") rather
// than invisible, and adding a label stays optional polish instead of a step
// a fork can forget and be punished for.
//
// A second reason the fallback is not optional: a `jobs` row can name a type
// no handler registers any more (rows outlive handlers — see the `Job` model
// comment). The dashboard still has to render that historical row.
// =============================================================================

/**
 * Display labels for the job types this repository ships.
 *
 * A fork adds its own entries here. Keys are `Job.type` values; values are
 * short human phrases in sentence case, sized for a table cell.
 *
 * Deliberately NOT exhaustive over anything — see the header: an unmapped
 * type is a supported, expected state, not a bug.
 */
export const JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  // The template's demonstration handler
  // (`handlers/example-echo.handler.ts`). Delete the handler and you may
  // delete this line; neither is load-bearing.
  'example.echo': 'Example echo',
  // The template's NODE-ELIGIBLE demonstration handler
  // (`handlers/example-checksum.handler.ts`, #269) — the type that makes a
  // worker node's claim return anything at all. Delete the handler and you
  // may delete this line.
  'example.checksum': 'Example checksum',
  // The queue's own housekeeping (`handlers/job-history-purge.handler.ts`,
  // #263) — the first real job type this template ships, and one a fork
  // should keep: deleting it stops history being trimmed.
  'job.history.purge': 'Job history purge',
  // The two halves of an admin broadcast fan-out (#323, epic #319). Labelled
  // as a PAIR because that is how they appear in the dashboard: one start row
  // per broadcast followed by a chain of chunk rows, all sharing the
  // `notification_broadcast` subject. The phrasing keeps them adjacent when
  // the type column is sorted, and says which end of the fan-out a row is —
  // the distinction an operator actually needs at 2am, since a failed start
  // means nobody was reached and a failed chunk means the send stopped part
  // way and will resume from its cursor.
  'admin.broadcast.start': 'Broadcast start',
  'admin.broadcast.chunk': 'Broadcast delivery',
  // The database dump itself (`db-backup/handlers/db-backup-run.handler.ts`,
  // #351, epic #345) — a job whose lifetime IS a `pg_dump`'s lifetime, and
  // the one type in this table an operator is most likely to be reading the
  // dashboard because of. "Database backup" and not "Database backup run":
  // the row is the run, so the noun is already carried by the table.
  'db.backup.run': 'Database backup',
  // -------------------------------------------------------------------------
  // #353 (epic #345): the rest of "all long-running work is a job". Eight types
  // that were `@Cron` bodies or detached promises until this issue, labelled as
  // groups because that is how they read in a dashboard filtered by type.
  // -------------------------------------------------------------------------
  // The restore. The one row in this table an operator is reading the dashboard
  // at 3am BECAUSE of, so it says what it does rather than naming a subsystem:
  // this job replaces the live database.
  'db.restore.run': 'Database restore',
  // The backup subsystem's two housekeeping sweeps. Phrased so they sort
  // adjacent to `db.backup.run` and to each other, and so the difference is
  // legible: one tidies RUNS AND ARCHIVES, the other drops a DATABASE a restore
  // displaced.
  'db.backup.sweep': 'Backup sweep',
  'db.restore.old-db-drop': 'Restore cleanup',
  // The three oldest cleanup crons in this repository, converted together.
  'storage.cleanup.stale-uploads': 'Stale upload cleanup',
  'auth.token.cleanup': 'Token cleanup',
  'device-auth.code.cleanup': 'Device code cleanup',
  // The fleet's own lifecycle, in the order it happens: a silent node is marked
  // offline, and an offline node is eventually forgotten. "Sweep" and "prune"
  // are the words the handlers, the settings and the runbook already use.
  'nodes.fleet.sweep': 'Fleet sweep',
  'nodes.fleet.prune': 'Fleet prune',
};

/**
 * The display label for `type`, falling back to `type` itself.
 *
 * Total by construction: every string in, a non-empty string out. Callers
 * never have to write their own `?? type`, which is what keeps the fallback
 * from being applied in some views and forgotten in others.
 */
export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? type;
}
