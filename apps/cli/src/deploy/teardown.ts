import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { composeEnvPath, envFilePath } from './env-file.js';
import { timestampSlug } from './journal.js';
import { deployStatePath } from './state.js';

// =============================================================================
// Taking a deployment apart  (issue #261, epic #168)
// =============================================================================
//
// `install.ts` could create a deployment and `update.ts` could advance one;
// nothing could remove one. So "start over" was improvised as `docker compose
// down` plus `rm -rf repo`, and that is exactly the shape that caused #259:
// `env-file.ts` keeps the `.env` at `<deployRoot>/.env`, OUTSIDE `repo/`, on
// purpose - so a re-clone does not lose the secrets - and a corrupt one
// therefore survived three consecutive install attempts. Surviving a re-clone
// and surviving a start-over are opposite requirements, and until now nothing
// in this CLI could tell the two apart.
//
// WHY THIS IS ITS OWN MODULE rather than living in `uninstall.ts` with the
// rest of the removal: `install --fresh` needs the same two helpers, and
// `uninstall.ts` imports `composeArgv`/`composeCwd` from `install.ts`. Putting
// them in `uninstall.ts` would make install.ts -> uninstall.ts -> install.ts a
// cycle. One small module both sides import is the cheap way out, and it keeps
// the "back it up BEFORE you delete it" rule in exactly one place - which is
// the rule that matters, because a `.env` holds generated secrets that may
// exist nowhere else on earth.
//
// THE BACKUP GOES TO THE APPS ROOT, NOT THE DEPLOY ROOT. The deploy root is
// the thing being deleted; a backup inside it is not a backup. `<appsRoot>/
// <name>.env.<timestamp>.bak` is a sibling of the app folder, so it is still
// there when the folder is not.
// =============================================================================

/** Everything under the deploy root that is this app's LOCAL STATE (not the clone). */
export interface LocalStateTargets {
  envPath: string;
  statePath: string;
  deployInfoDir: string;
}

export function localStateTargets(deployRoot: string): LocalStateTargets {
  return {
    envPath: envFilePath(deployRoot),
    statePath: deployStatePath(deployRoot),
    deployInfoDir: join(deployRoot, 'deploy-info'),
  };
}

/** Where a `.env` backup lands: a sibling of the app folder, so it outlives it. */
export function envBackupPath(appsRoot: string, name: string, now: Date): string {
  return join(appsRoot, `${name}.env.${timestampSlug(now)}.bak`);
}

/**
 * The deployment's `.env` as BYTES, or undefined when there is none.
 *
 * Deliberately not `readEnvFile`: that parses into a Map, and a backup that
 * has been through a parser is not a backup - comments, ordering and any line
 * this build's parser does not understand are exactly what an operator needs
 * when they are recovering from a `.env` this CLI mis-read (#259 again).
 *
 * The pre-#120 fallback location is checked too, but only when it is a REGULAR
 * FILE: on a current layout that path is a symlink pointing back at the
 * canonical one, and following it would back the same file up twice.
 */
export function readEnvBytes(deployRoot: string): { path: string; contents: string } | undefined {
  const canonical = envFilePath(deployRoot);
  try {
    return { path: canonical, contents: readFileSync(canonical, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const legacy = composeEnvPath(deployRoot);
  try {
    if (!lstatSync(legacy).isFile()) return undefined;
    return { path: legacy, contents: readFileSync(legacy, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return undefined;
}

export interface BackupEnvOptions {
  appsRoot: string;
  name: string;
  deployRoot: string;
  now?: (() => Date) | undefined;
  /** List the path instead of writing it; nothing is created. */
  dryRun?: boolean | undefined;
}

export interface EnvBackup {
  /** Where the copy was written (or, under a dry run, would be). */
  path: string;
  /** Where it was read from. */
  source: string;
  bytes: number;
}

/**
 * Copies `<deployRoot>/.env` to `<appsRoot>/<name>.env.<timestamp>.bak`, 0600.
 *
 * Returns undefined when there is no `.env` to copy - a half-removed
 * deployment is an ordinary case here, not a failure.
 *
 * The same temp-file-then-rename discipline as `writeEnvFile`, and for the
 * same reason its comment gives: `writeFileSync(path, data, { mode })` applies
 * the mode ONLY when it creates the file, so a second backup landing on an
 * existing name would silently keep whatever permissions that one had. The
 * timestamp makes a collision nearly impossible, but "nearly" is not the
 * guarantee to make about a file holding every secret this deployment has.
 */
export function backupEnvFile(options: BackupEnvOptions): EnvBackup | undefined {
  const found = readEnvBytes(options.deployRoot);
  if (found === undefined) return undefined;

  const now = (options.now ?? (() => new Date()))();
  const path = envBackupPath(options.appsRoot, options.name, now);
  const backup: EnvBackup = {
    path,
    source: found.path,
    bytes: Buffer.byteLength(found.contents, 'utf8'),
  };

  if (options.dryRun === true) return backup;

  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(options.appsRoot, { recursive: true });
  try {
    writeFileSync(temporary, found.contents, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }

  return backup;
}

export interface RemovalOutcome {
  /** Absolute path acted on. */
  path: string;
  /** False when it was already gone - reported, never an error. */
  existed: boolean;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Removes one path, reporting whether it was there. A dry run only reports. */
export function removePath(path: string, dryRun = false): RemovalOutcome {
  const existed = exists(path);
  if (existed && !dryRun) rmSync(path, { recursive: true, force: true });
  return { path, existed };
}

export interface DiscardLocalStateOptions extends BackupEnvOptions {
  /** `--keep-env`: leave the `.env` where it is. The backup is still taken. */
  keepEnv?: boolean | undefined;
}

export interface DiscardLocalStateResult {
  backup?: EnvBackup | undefined;
  removed: RemovalOutcome[];
  /** Paths deliberately left alone, with the reason. */
  kept: { path: string; reason: string }[];
}

/**
 * Discards this app's own LOCAL state: `.env`, the state file, `deploy-info/`.
 *
 * This is `install --fresh`'s whole job, and `uninstall`'s first move. It
 * touches nothing shared and nothing remote: not the clone (an install
 * re-clones over it), not the proxy, not a certificate, not the database.
 *
 * THE BACKUP IS TAKEN EVEN WITH `--keep-env`. Keeping the file and copying it
 * are not alternatives - the copy costs a few kilobytes and is the only thing
 * standing between a mistyped flag and a set of generated secrets nobody can
 * reconstruct.
 */
export function discardLocalState(options: DiscardLocalStateOptions): DiscardLocalStateResult {
  const dryRun = options.dryRun === true;
  const backup = backupEnvFile(options);
  const targets = localStateTargets(options.deployRoot);

  const removed: RemovalOutcome[] = [];
  const kept: { path: string; reason: string }[] = [];

  if (options.keepEnv === true) {
    kept.push({ path: targets.envPath, reason: 'kept with --keep-env' });
  } else {
    removed.push(removePath(targets.envPath, dryRun));
  }
  removed.push(removePath(targets.statePath, dryRun));
  removed.push(removePath(targets.deployInfoDir, dryRun));

  return { ...(backup === undefined ? {} : { backup }), removed, kept };
}

export interface RemoveDeployRootOptions {
  deployRoot: string;
  /** Names directly under the deploy root to leave behind. */
  keep?: readonly string[] | undefined;
  dryRun?: boolean | undefined;
}

export interface RemoveDeployRootResult {
  removed: RemovalOutcome[];
  kept: string[];
  /** True when the directory itself was removed (nothing was kept inside it). */
  removedRoot: boolean;
  /** False when the deploy root was not there at all. */
  existed: boolean;
}

/**
 * Removes the deploy root ENTRY BY ENTRY, then the directory itself.
 *
 * A single `rm -rf <deployRoot>` would be one line, and `--keep-env` is why it
 * is not: keeping one file means the others have to be named. Enumerating also
 * gives `--dry-run` something true to print - "repo/, .env, logs/, data/,
 * deploy-info/, .appctl-deploy.json" is a list an operator can check against
 * what they believe is there, where "the deploy root" is a claim they have to
 * take on trust.
 *
 * A missing deploy root answers `existed: false` and removes nothing. Half of
 * this command's job is being usable on a deployment somebody already took
 * apart by hand.
 */
export function removeDeployRoot(options: RemoveDeployRootOptions): RemoveDeployRootResult {
  const dryRun = options.dryRun === true;
  const keep = new Set(options.keep ?? []);

  let entries: string[];
  try {
    entries = readdirSync(options.deployRoot).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed: [], kept: [], removedRoot: false, existed: false };
    }
    throw error;
  }

  const removed: RemovalOutcome[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    const path = join(options.deployRoot, entry);
    if (keep.has(entry)) {
      kept.push(path);
      continue;
    }
    removed.push(removePath(path, dryRun));
  }

  // Only when nothing was kept: a deploy root holding the `.env` the operator
  // asked to keep is not an empty directory to tidy away.
  const removedRoot = kept.length === 0;
  if (removedRoot && !dryRun) rmSync(options.deployRoot, { recursive: true, force: true });

  return { removed, kept, removedRoot, existed: true };
}
