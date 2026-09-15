import {
  describeRelative,
  formatBytes,
  formatUtc,
  type AboutReport,
} from '../../../deploy/about.js';
import type { ServerFacts } from '../../../deploy/server-facts.js';
import type { KeyValueRow } from '../../components/index.js';
import { shortSha } from './update-model.js';

// =============================================================================
// The about screen, as data  (issue #132, epic #118)
// =============================================================================
//
// `collectAbout` (#128) already assembles the four sources with four different
// provenances; this turns its report into the three `KeyValue` blocks the web
// Console's About card (#126) shows, and it is the ONLY thing between the
// report and the frame.
//
// EVERY TIMESTAMP IS SPLIT ACROSS `value` AND `note`, not formatted into one
// string. `renderAbout` prints `2026-09-15 18:02:11 UTC (3 hours ago)` because
// a terminal line has nowhere else to put the age; `KeyValueRow` has a dim
// `note` column that exists for exactly this. So the value ends in ` UTC` —
// which is the invariant this issue asks for and which the test asserts on
// every row — and the relative age is beside it in the colour it deserves.
//
// THE REPORT IS BEST-EFFORT AND SO IS THIS. A stopped API, a missing deploy
// record, an unreachable remote and an unprobeable host are all FACTS, not
// errors: each becomes a row naming why. `collectAbout` throws only when
// nothing is installed, and that is the screen's one error state.
// =============================================================================

export interface AboutModel {
  /** Name, version, and what the running process answered — or why it did not. */
  application: KeyValueRow[];
  /** Revision, repository, domain, the timestamps, and the Update pair. */
  deployment: KeyValueRow[];
  /** The machine, as recorded and (where it differs) as it is now. */
  server: KeyValueRow[];
  /** True when the API block is a reason rather than an answer. */
  apiUnavailable: boolean;
  /** `null` = nothing has ever checked, which is not the same as "current". */
  updateAvailable: boolean | null;
}

export interface AboutModelOptions {
  /** The clock the relative ages are measured against. */
  now?: number | undefined;
}

/** A timestamp row: `2026-09-15 18:02:11 UTC` plus a dim `(3 hours ago)`. */
export function instantRow(key: string, iso: string, now: number): KeyValueRow {
  return { key, value: formatUtc(iso), note: `(${describeRelative(iso, now)})` };
}

export function aboutModel(report: AboutReport, options: AboutModelOptions = {}): AboutModel {
  const generated = Date.parse(report.generatedAt);
  const now = options.now ?? (Number.isNaN(generated) ? Date.now() : generated);

  return {
    application: applicationRows(report, now),
    deployment: deploymentRows(report, now),
    server: serverRows(report),
    apiUnavailable: report.api === null,
    updateAvailable: report.updateAvailable,
  };
}

function applicationRows(report: AboutReport, now: number): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { key: 'Name', value: report.deployment?.name ?? report.name },
    { key: 'Version', value: report.deployment?.version ?? 'unknown' },
  ];

  const api = report.api;
  if (api === null) {
    // "not logged in" and an unreachable API are different problems with
    // different fixes, so the reason is carried rather than collapsed into
    // one word.
    rows.push({ key: 'API', value: `unavailable (${report.apiReason ?? 'unknown'})` });
    return rows;
  }

  rows.push({ key: 'API version', value: api.runtime.apiVersion });
  rows.push({ key: 'Environment', value: api.runtime.environment });
  rows.push({ key: 'Node', value: api.runtime.nodeVersion });
  rows.push(instantRow('Process started', api.runtime.processStartedAt, now));
  rows.push({ key: 'Server time', value: formatUtc(api.runtime.serverTimeUtc) });

  if (api.database === null) {
    rows.push({ key: 'Database', value: `unavailable (${api.databaseError ?? 'unknown'})` });
    return rows;
  }

  rows.push({
    key: 'Database',
    value: api.database.serverVersion.split(' ').slice(0, 2).join(' '),
  });
  rows.push({
    key: 'Migrations',
    value: `${api.database.appliedMigrations} applied`,
    ...(api.database.lastMigrationName === null
      ? {}
      : { note: `(last ${api.database.lastMigrationName})` }),
  });

  return rows;
}

function deploymentRows(report: AboutReport, now: number): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  const deployment = report.deployment;

  if (deployment === null) {
    rows.push({
      key: 'Record',
      value: `unavailable (${report.deploymentReason ?? 'unknown'})`,
    });
    rows.push({ key: 'Root', value: report.deployRoot });
  } else {
    rows.push({
      key: 'Revision',
      value: shortSha(deployment.commitSha),
      note: `(${deployment.ref})`,
    });
    rows.push({ key: 'Repository', value: deployment.repoUrl });
    rows.push({ key: 'Domain', value: deployment.domain ?? 'not published' });
    rows.push(instantRow('Installed', deployment.installedAt, now));
    rows.push(instantRow('Last updated', deployment.updatedAt, now));
    rows.push({ key: 'Last command', value: deployment.lastCommand });
    if (deployment.lastAttemptAt !== null && deployment.lastAttemptAt > deployment.updatedAt) {
      rows.push({
        ...instantRow('Last attempt', deployment.lastAttemptAt, now),
        note: '(did not complete)',
      });
    }
    if (deployment.previousSha !== null) {
      rows.push({ key: 'Previous revision', value: shortSha(deployment.previousSha) });
    }
    rows.push({ key: 'Root', value: deployment.deployRoot });
  }

  rows.push(...updateRows(report, now));
  return rows;
}

/** The Update pair, in `renderAbout`'s three shapes. */
function updateRows(report: AboutReport, now: number): KeyValueRow[] {
  if (report.remoteError !== null) {
    return [{ key: 'Update', value: `unavailable (${report.remoteError})` }];
  }
  if (report.remote === null) {
    // NOT "up to date": nothing has ever asked, and saying otherwise would be
    // the one thing this page must never get wrong.
    return [{ key: 'Update', value: 'never checked' }];
  }

  const { commitsBehind, sha, checkedAt } = report.remote;
  return [
    {
      key: 'Update',
      value:
        commitsBehind === 0
          ? `up to date (${shortSha(sha)})`
          : `${commitsBehind} commit${commitsBehind === 1 ? '' : 's'} behind`,
      ...(commitsBehind === 0 ? {} : { note: `(latest ${shortSha(sha)})` }),
    },
    instantRow('Checked', checkedAt, now),
  ];
}

const FACTS: ReadonlyArray<{
  label: string;
  key: keyof ServerFacts;
  bytes?: boolean | undefined;
}> = [
  { label: 'Hostname', key: 'hostname' },
  { label: 'Operating system', key: 'os' },
  { label: 'Kernel', key: 'kernel' },
  { label: 'Architecture', key: 'arch' },
  { label: 'CPU', key: 'cpuModel' },
  { label: 'CPU cores', key: 'cpus' },
  { label: 'Memory', key: 'memoryBytes', bytes: true },
  { label: 'Disk', key: 'diskBytes', bytes: true },
  { label: 'Docker', key: 'dockerVersion' },
  { label: 'Compose', key: 'composeVersion' },
  { label: 'Node', key: 'nodeVersion' },
];

/**
 * The machine block.
 *
 * A live value that DIFFERS from the recorded one rides along as a dim note —
 * `AboutHost.now` only ever holds differences, and a probe that could not
 * answer is deliberately not one of them (a `df` that failed must not read as
 * "this server lost its disk").
 */
function serverRows(report: AboutReport): KeyValueRow[] {
  const { deployed, now: live } = report.host;
  if (deployed === null && Object.keys(live).length === 0) {
    return [{ key: 'Facts', value: 'unavailable' }];
  }

  const show = (value: string | number | null | undefined, bytes: boolean): string => {
    if (value === null || value === undefined) return 'unknown';
    return bytes ? formatBytes(typeof value === 'number' ? value : null) : String(value);
  };

  return FACTS.map(({ label, key, bytes }) => {
    const recorded = deployed === null ? undefined : deployed[key];
    const current = key in live ? (live[key] ?? null) : undefined;

    if (recorded === undefined) {
      return { key: label, value: show(current, bytes === true) };
    }
    return {
      key: label,
      value: show(recorded, bytes === true),
      ...(current === undefined ? {} : { note: `(now ${show(current, bytes === true)})` }),
    };
  });
}

/**
 * The keys this screen binds.
 *
 * Bare, because About has no editable field (see `update-model.ts` for the
 * rule #131 set). `c` runs the remote check — the one action on this screen
 * that touches the network, which is why it is a separate key from `r` rather
 * than folded into the refresh: a refresh must stay usable with no network.
 */
export function aboutHints(busy: boolean, checking: boolean): string[] {
  if (checking) return ['checking for an update…', 'esc back'];
  if (busy) return ['reading…', 'esc back'];
  return ['r refresh', 'c check for an update', 'esc back'];
}
