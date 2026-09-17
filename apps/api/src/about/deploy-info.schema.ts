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

/**
 * How the deploy run that wrote this document ended (issue #283).
 *
 * WRITTEN FROM THE CLI's `health` STEP ONWARD, on the failure path as well as
 * on success: once the API has answered, the deployment demonstrably exists,
 * and a missing record makes About say "this instance was not deployed with
 * the deploy CLI" about a server the CLI plainly deployed.
 *
 * OPTIONAL, LIKE EVERY FIELD HERE, AND ABSENT MEANS THE RUN COMPLETED. A
 * document from a CLI before #283 has no `run` at all, and it was only ever
 * written after a pipeline finished — so absence is information, not a gap.
 * A consumer must test `completed === false` and never `!== true`. `schema`
 * stays `1`: the CLI added an optional field, which is exactly the change
 * `.passthrough()` and the optional-and-nullable rule above exist to absorb
 * without anything answering `invalid`.
 */
export const deployInfoRunSchema = z
  .object({
    completed: z.boolean().nullable().optional(),
    /** The step id that stopped it; absent when the run completed. */
    failedStep: text,
    /** ISO-8601 UTC; absent when the run completed (`updatedAt` is that instant). */
    attemptedAt: timestamp,
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
    /** Absent on a document written before #283, which means the run completed. */
    run: deployInfoRunSchema.nullable().optional(),
    /**
     * When the CLI ADOPTED this deployment — rebuilt its own state file from
     * the clone, the `.env` and the proxy because the file was missing
     * (issue #285).
     *
     * ABSENT MEANS THE RECORD CAME FROM A RUN THE CLI PERFORMED, which is
     * every document written before #285 — the same absent-is-the-ordinary-
     * case convention `run` above uses. It is also the explanation for a null
     * `installedAt`: an adopted deployment's install instant is on no disk
     * anywhere, so the CLI writes null rather than this run's own clock.
     *
     * Optional and nullable here, optional on the CLI side, and `schema`
     * stays `1` — the change `.passthrough()` and rule 2 above exist to
     * absorb without anything answering `invalid`.
     */
    adoptedAt: timestamp,
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
