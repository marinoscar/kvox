import { z } from 'zod';

// =============================================================================
// The `deploy-info/info.json` contract (issue #124, epic #118 decision 7)
// =============================================================================
//
// The one artifact the application reads about its own deployment. The CLI
// writes it on every `deploy install` / `deploy update` and refreshes `remote`
// on every `update --check` / `status` (#120); the API reads it back here. The
// API has no git checkout and no GitHub credential, so everything in this file
// is a FACT CAPTURED ELSEWHERE — host facts in particular, because inside the
// container `os.hostname()` is the container id and `statfs('/app')` is the
// overlay filesystem.
//
// Two rules shape every line below:
//
//   1. `.passthrough()` on every object. A newer CLI adding a field must never
//      make an older API answer `deployInfoStatus: 'invalid'`; the extra field
//      rides through to the client untouched (the About card ignores what it
//      does not know). The reverse — an older CLI omitting a field this build
//      knows — is covered by rule 2.
//
//   2. Every field is optional AND nullable on read. The file is the CLI's
//      best effort at deploy time: `dockerVersion` is null on a host where
//      `docker --version` failed, `remote` is null until the first
//      `update --check`. A missing value is information ("the CLI could not
//      tell"), not a parse failure. Only `schema: 1` is strict — that is the
//      one field whose absence means "this is not the file we think it is".
//
// The fixture at `__fixtures__/deploy-info.json` is the shared test vector:
// this reader and the CLI's writer are both tested against it, so the two
// sides cannot drift without one of the suites noticing.
// =============================================================================

/** ISO-8601 UTC timestamp as the CLI writes it, or null when unknown. */
const timestamp = z.string().nullable().optional();
const text = z.string().nullable().optional();
const integer = z.number().int().nullable().optional();

export const deployInfoAppSchema = z
  .object({
    name: text,
    version: text,
    commitSha: text,
    ref: text,
    repoUrl: text,
  })
  .passthrough();

export const deployInfoDeployedBySchema = z
  .object({
    cli: text,
    version: text,
  })
  .passthrough();

export const deployInfoHostSchema = z
  .object({
    hostname: text,
    os: text,
    kernel: text,
    arch: text,
    cpuModel: text,
    cpus: integer,
    memoryBytes: integer,
    diskBytes: integer,
    dockerVersion: text,
    composeVersion: text,
    nodeVersion: text,
  })
  .passthrough();

export const deployInfoRemoteSchema = z
  .object({
    sha: text,
    commitsBehind: integer,
    checkedAt: timestamp,
  })
  .passthrough();

export const deployInfoSchema = z
  .object({
    /** The only strict field: anything else is not this file. */
    schema: z.literal(1),
    app: deployInfoAppSchema.nullable().optional(),
    installedAt: timestamp,
    updatedAt: timestamp,
    lastCommand: text,
    deployedBy: deployInfoDeployedBySchema.nullable().optional(),
    domain: text,
    bindPort: integer,
    host: deployInfoHostSchema.nullable().optional(),
    /** Null until the first `update --check`; refreshed by `status` too. */
    remote: deployInfoRemoteSchema.nullable().optional(),
  })
  .passthrough();

export type DeployInfo = z.infer<typeof deployInfoSchema>;

/** Where the CLI bind-mounts the directory (read-only) inside the API container. */
export const DEFAULT_DEPLOY_INFO_PATH = '/app/deploy-info/info.json';

/**
 * Resolves the file path on EVERY call rather than once at boot, matching the
 * service's read-per-request contract: the file is tiny, and a test (or an
 * operator) pointing `DEPLOY_INFO_PATH` somewhere else must take effect on the
 * next request, not the next restart.
 */
export function resolveDeployInfoPath(): string {
  const configured = process.env.DEPLOY_INFO_PATH;
  return configured && configured.trim().length > 0
    ? configured
    : DEFAULT_DEPLOY_INFO_PATH;
}
