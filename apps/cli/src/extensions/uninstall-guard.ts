import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedDeployment } from './deployment.js';

// =============================================================================
// Two safety properties of `deploy uninstall` the platform's command lacks
// (issue #482, epic #478)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#482): both go away if the platform's `uninstall` asks
// for the deployment's own name and copies the environment file itself.
//
// 1. THE APP'S OWN NAME IS TYPED, NEVER IMPLIED. The platform asks only for the
//    database's and the bucket's names, and only for the two extras; a plain
//    `uninstall` removes the containers, the clone, the environment file and the
//    record on the strength of the command alone. This CLI's contract was "a
//    destructive default reachable by omission is not a default", so a real
//    (non `--dry-run`) uninstall requires `--confirm <name>` here, compared with
//    the name of the deployment the command resolves to (not with whatever
//    string happens to be typed).
//
// 2. THE ENVIRONMENT FILE IS COPIED BEFORE IT IS DELETED. It holds generated
//    secrets that may exist nowhere else, and the platform deletes it. The copy
//    goes to `<apps-root>/<name>.env.<timestamp>.bak` (mode 0600), a sibling of
//    the deployment folder so it outlives it.
// =============================================================================

/** Filesystem-safe, chronologically sortable timestamp. */
export function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Where a backup of the deployment's environment file lands. */
export function envBackupPath(deployment: ResolvedDeployment, now: Date): string {
  return join(deployment.appsRoot, `${deployment.name}.env.${timestampSlug(now)}.bak`);
}

/**
 * The deployment's `.env` as bytes: the current location first, then the one an
 * older CLI used inside the checkout (only when it is a regular file; on a
 * current layout that path is a symlink back to the first, and following it
 * would back the same file up twice).
 */
function readEnvBytes(deployRoot: string): { source: string; contents: string } | undefined {
  const canonical = join(deployRoot, '.env');
  try {
    return { source: canonical, contents: readFileSync(canonical, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const legacy = join(deployRoot, 'repo', 'infra', 'compose', '.env');
  try {
    if (!lstatSync(legacy).isFile()) return undefined;
    return { source: legacy, contents: readFileSync(legacy, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return undefined;
}

/** What a backup did. */
export interface EnvBackup {
  path: string;
  source: string;
  bytes: number;
}

/**
 * Copies the deployment's `.env` to its backup path, 0600.
 *
 * Written to a temp file and renamed, with an explicit chmod: `writeFileSync`'s
 * `mode` applies only when it creates the file, so a second backup landing on an
 * existing name would otherwise keep that file's permissions.
 *
 * @returns the backup, or `undefined` when there is no `.env` (a half-removed
 *   deployment is an ordinary case, not a failure).
 */
export function backupEnvFile(deployment: ResolvedDeployment, now: Date = new Date()): EnvBackup | undefined {
  const found = readEnvBytes(deployment.deployRoot);
  if (found === undefined) return undefined;

  const target = envBackupPath(deployment, now);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, found.contents, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);

  return { path: target, source: found.source, bytes: Buffer.byteLength(found.contents) };
}

/** The error for a missing or wrong `--confirm`, or `undefined` when it matches. */
export function confirmationProblem(cli: string, name: string, typed: string | undefined): string | undefined {
  if (typed === undefined || typed.trim() === '') {
    return (
      `${cli} deploy uninstall removes the deployment "${name}" and needs its own name to authorise that: ` +
      `pass --confirm ${name}. Run it with --dry-run first to see what would go.`
    );
  }
  if (typed.trim() !== name) {
    return `--confirm "${typed.trim()}" is not this deployment's name. Expected "${name}".`;
  }
  return undefined;
}
