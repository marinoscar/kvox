import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { parseEnvFile } from './env-spec.js';

// =============================================================================
// Where the deployment's .env lives  (issue #120, epic #118)
// =============================================================================
//
// The server's convention is `.env` at the app folder root, next to `repo/`:
//
//   /opt/infra/apps/<name>/
//     .env                          <- the real file, 0600
//     repo/infra/compose/.env       <- a RELATIVE symlink, ../../../.env
//
// Before this module the file was written INSIDE THE CLONE, so `rm -rf repo`
// took the secrets with it and a fresh clone silently started from nothing.
// Compose follows symlinks for both the service `env_file:` and the
// project-directory `.env` it interpolates `${APP_BIND_PORT}` from, so the
// link is all it takes to keep every compose invocation working unchanged.
//
// THE LINK IS RELATIVE ON PURPOSE. An absolute target would break the moment
// the app folder is moved or bind-mounted somewhere else; `../../../.env` is
// correct wherever the folder ends up, because the clone is always exactly
// `repo/infra/compose` below the root.
//
// Rejected: `--env-file` on every compose call (sets interpolation variables
// but does not replace a service's `env_file:`, so two sources of truth);
// copying `.env` into the clone on every run (two files that can disagree).
// =============================================================================

export const ENV_FILENAME = '.env';

/** The canonical environment file: `<root>/.env`. */
export function envFilePath(deployRoot: string): string {
  return join(deployRoot, ENV_FILENAME);
}

/** Where compose looks for it: `<root>/repo/infra/compose/.env`, a symlink. */
export function composeEnvPath(deployRoot: string): string {
  return join(deployRoot, 'repo', 'infra', 'compose', ENV_FILENAME);
}

/** The symlink's target, relative to the compose directory: `../../../.env`. */
export function composeEnvLinkTarget(deployRoot: string): string {
  return relative(dirname(composeEnvPath(deployRoot)), envFilePath(deployRoot));
}

/**
 * Writes `<root>/.env` atomically, 0600.
 *
 * The same temp-file-then-rename discipline as `writeState` and
 * `writeConfigFile`, for the same reason: `writeFileSync(path, data, { mode })`
 * applies the mode ONLY when it creates the file, so rewriting an existing
 * `.env` in place would silently keep whatever permissions it already had.
 * `flag: 'wx'` makes the temp file's creation - and so its mode - unambiguous,
 * and the rename is atomic, so an interrupted write cannot leave a
 * half-written file holding half the secrets.
 */
export function writeEnvFile(deployRoot: string, contents: string): string {
  const path = envFilePath(deployRoot);
  const temporary = `${path}.${process.pid}.tmp`;

  mkdirSync(deployRoot, { recursive: true });

  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }

  return path;
}

/**
 * Reads the deployment's `.env`, or undefined when there is none.
 *
 * Read-only, and so allowed to fall back to a pre-#120 layout: a deployment
 * installed before this module has its file at the compose path and no link.
 * `doctor` and `status` must be able to read that without writing anything
 * (a check never writes - checks/types.ts rule 4); the migration itself
 * happens in `ensureComposeEnvLink`, which install and update call once the
 * clone is in place.
 */
export function readEnvFile(deployRoot: string): Map<string, string> | undefined {
  for (const path of [envFilePath(deployRoot), composeEnvPath(deployRoot)]) {
    try {
      return parseEnvFile(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

export interface EnsureEnvLinkResult {
  /** A regular file at the compose path was moved to the app root. */
  migrated: boolean;
  /** The link was created or repointed (false when it was already right). */
  linked: boolean;
}

/**
 * Makes `repo/infra/compose/.env` a relative symlink to `<root>/.env`.
 *
 * ONLY CALL THIS ONCE THE CLONE EXISTS. Creating the link first would leave a
 * non-empty `repo/` behind, and `git clone` refuses a non-empty directory - a
 * first install would then fail on the very link meant to help it.
 *
 * Migration: a regular file at the compose path is an install made before
 * #120. It is MOVED to the app root (a rename, so the same bytes and no
 * moment where neither exists) and replaced by the link, once. Should both
 * already exist, the app-root file wins - it is the one the wizard reads and
 * rewrites - and the stale copy in the clone is removed, so the deployment
 * cannot carry two files that disagree.
 */
export function ensureComposeEnvLink(deployRoot: string): EnsureEnvLinkResult {
  const link = composeEnvPath(deployRoot);
  const canonical = envFilePath(deployRoot);
  const target = composeEnvLinkTarget(deployRoot);

  mkdirSync(dirname(link), { recursive: true });

  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (existing === undefined) {
    symlinkSync(target, link);
    return { migrated: false, linked: true };
  }

  if (existing.isSymbolicLink()) {
    if (readlinkSync(link) === target) return { migrated: false, linked: false };
    // Pointing somewhere else - an absolute path from a hand-made link, most
    // likely. Repointed rather than trusted.
    unlinkSync(link);
    symlinkSync(target, link);
    return { migrated: false, linked: true };
  }

  if (!existing.isFile()) {
    throw new Error(
      `${link} is neither a file nor a symlink; move it aside so the deployment's .env can be linked there.`,
    );
  }

  let migrated = false;
  let canonicalExists = false;
  try {
    lstatSync(canonical);
    canonicalExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (canonicalExists) {
    unlinkSync(link);
  } else {
    renameSync(link, canonical);
    // The old install created it 0600 too, but a rename keeps whatever the
    // mode was, and this is the one moment to be certain.
    chmodSync(canonical, 0o600);
    migrated = true;
  }

  symlinkSync(target, link);
  return { migrated, linked: true };
}
