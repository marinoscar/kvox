import { formatUtc } from '../../../deploy/about.js';
import type { DeployRemote } from '../../../deploy/deploy-info.js';
import { isHealthy, type HealthReport, type ProbeResult } from '../../../deploy/health.js';
import type { KeyValueRow } from '../../components/index.js';
import { shortSha } from './update-model.js';

// =============================================================================
// The status screen, as data  (issue #132, epic #118)
// =============================================================================
//
// THE OMISSION THIS FIXES. The screen this replaces called `collectHealth`
// WITHOUT `state`, so `HealthReport.deployed` was always undefined and the two
// lines `deploy status` prints first — the revision and when it was last
// deployed — were simply missing from the TUI. They are not decoration: at 2am
// "which revision is this?" is the question asked before any probe result
// means anything. The screen passes `state` now, and `statusModel` fails
// loudly here (a row that says so) rather than silently dropping the block.
//
// THE VERDICT IS THE SCREEN'S TO CARRY. `deploy status` exits 1 when
// unhealthy; the TUI always exits 0 (tui/index.tsx), so `healthy` is rendered
// in colour and the frame names the subcommand for the scripted case.
//
// `Update` is a row of the DEPLOYMENT block rather than a fourth block,
// because it is a fact about the revision named two rows above it.
// =============================================================================

export interface StatusInput {
  report: HealthReport;
  /** The last remote check, when one succeeded. */
  remote?: DeployRemote | null | undefined;
  /** Why there is no remote; a failure here never fails the health verdict. */
  remoteError?: string | null | undefined;
  now?: number | undefined;
}

export interface StatusModel {
  healthy: boolean;
  /** Revision, Last deployed, Last command, Update. */
  deployment: KeyValueRow[];
  /** One row per container; a single row saying so when there are none. */
  containers: KeyValueRow[];
  /** The three (or four) probes, then the schema. */
  probes: KeyValueRow[];
}

/**
 * One health report, as the three blocks the screen draws.
 *
 * `now` defaults to the wall clock rather than to a field of the report:
 * unlike `AboutReport`, `HealthReport` carries no `generatedAt`, and inventing
 * one here would be a second timestamp to keep honest.
 */
export function statusModel(input: StatusInput): StatusModel {
  const { report } = input;
  const now = input.now ?? Date.now();

  return {
    healthy: isHealthy(report),
    deployment: deploymentRows(report, input, now),
    containers: containerRows(report),
    probes: probeRows(report),
  };
}

function deploymentRows(report: HealthReport, input: StatusInput, now: number): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  const deployed = report.deployed;

  if (deployed === undefined) {
    // Never silently absent: this is exactly the bug being fixed, and a
    // regression would otherwise look like a slightly shorter table.
    rows.push({ key: 'Revision', value: 'unknown (no deployment state was read)' });
  } else {
    rows.push({ key: 'Revision', value: shortSha(deployed.commitSha), note: `(${deployed.ref})` });
    rows.push({
      key: 'Last deployed',
      value: formatUtc(deployed.lastDeployedAt),
      note: `(${describeAge(deployed.lastDeployedAt, now)})`,
    });
    if (
      deployed.lastAttemptAt !== undefined &&
      deployed.lastAttemptAt > deployed.lastDeployedAt
    ) {
      // A later attempt than the last success means something failed. The
      // state records both precisely so this cannot be hidden.
      rows.push({
        key: 'Last attempt',
        value: formatUtc(deployed.lastAttemptAt),
        note: '(did not complete)',
      });
    }
    rows.push({ key: 'Last command', value: deployed.lastCommand });
  }

  rows.push(updateRow(input));
  return rows;
}

/** The `Update` line, in the same three shapes `renderHealth` has. */
function updateRow(input: StatusInput): KeyValueRow {
  const error = input.remoteError ?? undefined;
  if (error !== undefined && error !== '') {
    return { key: 'Update', value: `unavailable (${error})` };
  }

  const remote = input.remote ?? undefined;
  if (remote === undefined || remote === null) {
    return { key: 'Update', value: 'never checked' };
  }

  const behind =
    remote.commitsBehind === 0
      ? 'up to date'
      : `${remote.commitsBehind} commit${remote.commitsBehind === 1 ? '' : 's'} behind`;

  return {
    key: 'Update',
    value: `${behind} (latest ${shortSha(remote.sha)})`,
    note: `(checked ${describeAge(remote.checkedAt, input.now ?? Date.now())})`,
  };
}

function containerRows(report: HealthReport): KeyValueRow[] {
  if (report.containers.length === 0) {
    return [{ key: 'Containers', value: 'none reported' }];
  }
  return report.containers.map((container) => ({
    key: container.service,
    value: container.state,
    ...(container.health === undefined ? {} : { note: `(${container.health})` }),
  }));
}

function probeRows(report: HealthReport): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    probeRow('Liveness', report.local.live),
    probeRow('Readiness', report.local.ready),
    probeRow('Frontend', report.local.frontend),
  ];
  if (report.external !== undefined) rows.push(probeRow('External HTTPS', report.external.probe));

  // The schema sits WITH the probes and not above them, because the whole
  // point of `health.ts`'s header is that a green readiness probe is weak
  // evidence — `SELECT 1` passes against an empty database. Reading them
  // apart is how somebody concludes "ready: 200" means the schema is there.
  if (!report.migrations.known) {
    rows.push({ key: 'Migrations', value: 'could not be determined' });
  } else if (report.migrations.pending.length > 0) {
    rows.push({
      key: 'Migrations',
      value: `${report.migrations.pending.length} pending`,
      note: `(${report.migrations.pending.join(', ')})`,
    });
  } else {
    rows.push({ key: 'Migrations', value: 'up to date' });
  }

  return rows;
}

function probeRow(label: string, result: ProbeResult): KeyValueRow {
  return {
    key: label,
    value: result.ok
      ? `${result.status ?? 'ok'}`
      : (result.error ?? `HTTP ${result.status ?? '?'}`),
    ...(result.ok ? { note: `(${result.durationMs}ms)` } : {}),
  };
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" — `describeAge`'s wording. */
export function describeAge(iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 'at an unknown time';
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/**
 * The keys this screen binds.
 *
 * A bare `r` is safe here: status has no editable field, so the constraint
 * #131's header states does not apply (see `update-model.ts` for the same
 * reasoning, stated once).
 */
export function statusHints(refreshing: boolean): string[] {
  return [refreshing ? 'refreshing…' : 'r refresh', 'esc back'];
}
