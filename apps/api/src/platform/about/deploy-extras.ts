import { readFile } from 'node:fs/promises';

import { resolveDeployInfoPath } from '@marinoscar/platform-api/host';

// =============================================================================
// The deploy-info fields the platform About report drops (issue #464)
// =============================================================================
//
// The deploy CLI writes `deploy-info/info.json`. The platform's reader keeps a
// documented subset of it (`app`, `installedAt`, `updatedAt`, `deployedBy`,
// `domain`, `remote.commitsBehind|checkedAt`, `run.failedStep`, `lastCommand`,
// `bindPort`, `host`, ...) and drops what this app's CLI writes beyond it. This
// file recovers those fields for the "Deployment" About group, through
// `registerAboutContributor` (`app-registrations/host.ts`), rather than forking
// the platform reader.
//
// What the platform drops, and what this reads instead:
//
//   app.repoUrl                      -> `repoUrl`
//   remote.sha                       -> `remoteSha`
//   run.completed (a BOOLEAN here;   -> `runCompleted`, `runAttemptedAt`
//     the platform reads an array)      (the platform's `run.outcome` is never set)
//   adoptedAt                        -> `adoptedAt`
//   host.cpuModel|diskBytes|         -> `hostCpuModel`, `hostDiskBytes`,
//     nodeVersion                       `hostNodeVersion`
//
// `run.completed` follows the CLI's own convention: ABSENT MEANS THE RUN
// COMPLETED, so only an explicit `false` reports an incomplete run.
//
// NO NETWORK I/O, NO CACHING (the CLI rewrites the file in place), AND NEVER
// THROWS: a missing, unreadable or malformed file yields no facts. The facts are
// also bounded and secret-filtered by the platform before they are served.
// =============================================================================

type Facts = Record<string, string | number | boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function put(facts: Facts, key: string, value: string | number | boolean | undefined): void {
  if (value !== undefined) facts[key] = value;
}

/** Picks the dropped fields out of a parsed `info.json`. Pure. */
export function deployExtrasFrom(parsed: unknown): Facts {
  const facts: Facts = {};
  if (!isRecord(parsed) || parsed.schema !== 1) return facts;

  const app = isRecord(parsed.app) ? parsed.app : {};
  const remote = isRecord(parsed.remote) ? parsed.remote : {};
  const run = isRecord(parsed.run) ? parsed.run : {};
  const host = isRecord(parsed.host) ? parsed.host : {};

  put(facts, 'repoUrl', text(app.repoUrl));
  put(facts, 'remoteSha', text(remote.sha));

  const incomplete = run.completed === false;
  facts.runCompleted = !incomplete;
  if (incomplete) put(facts, 'runAttemptedAt', text(run.attemptedAt));

  put(facts, 'adoptedAt', text(parsed.adoptedAt));
  put(facts, 'hostCpuModel', text(host.cpuModel));
  put(facts, 'hostDiskBytes', count(host.diskBytes));
  put(facts, 'hostNodeVersion', text(host.nodeVersion));
  return facts;
}

/** Reads `DEPLOY_INFO_PATH` fresh and returns the dropped fields; `{}` on any failure. */
export async function readDeployExtras(path: string = resolveDeployInfoPath()): Promise<Facts> {
  try {
    return deployExtrasFrom(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return {};
  }
}
