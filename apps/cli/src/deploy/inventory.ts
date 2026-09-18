import { basename } from 'node:path';

import { domainFromAppUrl } from './adopt.js';
import { envFacts } from './deployment-evidence.js';
import { listInstalledApps } from './layout.js';
import { DEPLOY_STATE_FILENAME } from './state.js';
import { formatInstant } from './about.js';

// =============================================================================
// Every app on this server  (issue #290, epic #168)
// =============================================================================
//
// THE REGISTRY ALREADY EXISTS, DISTRIBUTED: `<apps-root>/<name>/`, one folder
// per deployment, each holding its own record next to the thing it describes.
// This module is the read of it - the useful half of a central index with
// nothing that can drift. A central registry in `~/.<cli>/` was proposed and
// deliberately rejected: it lists a ghost after `rm -rf`, goes stale after a
// restore from backup, points at nothing after a rename, and differs between
// `sudo` and a user because `sudo` resets HOME. #285 exists precisely because
// this CLI trusted bookkeeping over evidence, and a central index is that
// mistake moved one level further from the thing it describes.
//
// IT RUNS NO SUBPROCESS AND MAKES NO NETWORK CALL. Everything here is read
// from the filesystem - the state file, or the deployment's own `.env` - so
// `deploy list` is instant on a host with a dozen apps and answers the same
// way when Docker is down. That is also why a deployment with no state file
// reports no revision: the commit is in `repo/`'s git history, and reading it
// would mean a `git` process per directory. `deploy update` adopts such a
// deployment and writes the record, after which it reports like any other -
// which is a better answer than this listing quietly running git for it.
// =============================================================================

/** One deployment under the apps root, as the disk describes it. */
export interface InventoryEntry {
  /** The compose project name: the state's, else the `.env`'s, else the folder's. */
  name: string;
  deployRoot: string;
  /**
   * Where this row came from: the CLI's own record, or the evidence on disk
   * when there is no record (#285). Not cosmetic - it is what explains the
   * `null`s below, and it tells an operator that `deploy update` has a record
   * to rebuild here.
   */
  record: 'state' | 'evidence';
  /** Null for an unrecorded deployment: see the header on why git is not run. */
  commitSha: string | null;
  ref: string | null;
  /** The state's, else the `.env`'s `APP_BIND_PORT`; null when neither says. */
  bindPort: number | null;
  /** The state's, else the host of the `.env`'s `APP_URL`; null when unpublished. */
  domain: string | null;
  lastDeployedAt: string | null;
}

export interface InventoryReport {
  appsRoot: string;
  apps: InventoryEntry[];
}

/** Every deployment under `appsRoot`, in directory order. */
export function collectInventory(appsRoot: string): InventoryReport {
  const apps = listInstalledApps(appsRoot).map((app): InventoryEntry => {
    const { state } = app;
    if (state !== undefined) {
      return {
        name: app.name,
        deployRoot: app.deployRoot,
        record: 'state',
        commitSha: state.commitSha,
        ref: state.ref,
        bindPort: state.bindPort,
        domain: state.domain ?? null,
        lastDeployedAt: state.lastDeployedAt ?? null,
      };
    }

    // No record. Everything that can still be read IS read - the same facts
    // `adopt.ts` rebuilds a record from - and everything that cannot is null
    // rather than guessed.
    const facts = envFacts(app.deployRoot);
    return {
      name: app.name,
      deployRoot: app.deployRoot,
      record: 'evidence',
      commitSha: null,
      ref: null,
      bindPort: app.bindPort ?? null,
      domain: domainFromAppUrl(facts.appUrl) ?? null,
      lastDeployedAt: null,
    };
  });

  return { appsRoot, apps };
}

export interface RenderInventoryOptions {
  /** The clock the relative times are measured against. */
  now?: number | undefined;
}

const LABEL_WIDTH = 14;

/** The human report; `--json` gets the object above instead. */
export function renderInventory(
  report: InventoryReport,
  options: RenderInventoryOptions = {},
): string {
  const now = options.now ?? Date.now();
  const lines: string[] = ['', `  Apps under ${report.appsRoot}`, ''];

  for (const app of report.apps) {
    const row = (label: string, value: string): void => {
      lines.push(`    ${label.padEnd(LABEL_WIDTH)}${value}`);
    };

    // The folder is named when it differs from the app: `--name <app>-staging`
    // installs into a directory the project name does not spell.
    const folder = basename(app.deployRoot);
    lines.push(`  ${app.name}${folder === app.name ? '' : `  (in ${folder}/)`}`);
    row('Root', app.deployRoot);
    row(
      'Revision',
      app.commitSha === null
        ? 'unknown (no record here; `deploy update` rebuilds one)'
        : `${app.commitSha.slice(0, 12)}${app.ref === null ? '' : ` (${app.ref})`}`,
    );
    row('Port', app.bindPort === null ? 'unknown' : String(app.bindPort));
    row('Domain', app.domain ?? 'not published');
    row(
      'Last deploy',
      app.lastDeployedAt === null ? 'unknown' : formatInstant(app.lastDeployedAt, now),
    );
    row(
      'Record',
      app.record === 'state'
        ? DEPLOY_STATE_FILENAME
        : 'inferred from repo/ and .env (no state file)',
    );
    lines.push('');
  }

  lines.push(`  ${report.apps.length} app(s).`, '');
  return lines.join('\n');
}
