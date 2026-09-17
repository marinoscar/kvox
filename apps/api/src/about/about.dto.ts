import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { deployInfoSchema } from './deploy-info.schema';

// =============================================================================
// GET /api/admin/about — response body (issue #124, epic #118)
// =============================================================================
//
// Three sources, three provenances, published side by side so a client (the
// web About card, #126; the deploy CLI `about` command, #128) never has to guess where a
// number came from:
//
//   * `deployInfo` — the CLI's `deploy-info/info.json`, read from disk on every
//     request. May be null; `deployInfoStatus` says why, and `detail` carries
//     the parse message when there is one. The dev stack and CI have no such
//     file and answer `absent` with a 200 — About must render on a deployment
//     that has never been deployed by the CLI, or the card would be unusable
//     in exactly the environment a contributor first opens it in.
//
//   * `runtime` — what only this running process knows: its own version, its
//     Node, when it started, and the clock it is answering from.
//
//   * `database` — what only a live connection can answer. May be null with
//     `databaseError` set; the route still answers 200, because an operator
//     diagnosing a broken database is the one person who most needs the rest
//     of this page.
//
// `updateAvailable` and `checkedAt` are DERIVED HERE from `deployInfo.remote`
// rather than left to each client, so the web card and the terminal cannot
// disagree about whether an update exists. Both are null when `remote` is null
// (no `update --check` has ever run) — "unknown", not "no".
//
// `deployRunComplete`, `deployFailedStep` and `deployAttemptedAt` (#283) are
// derived from `deployInfo.run` for exactly that reason. They are ADDITIONAL
// to `deployInfoStatus`, not a fifth value of it: the four statuses answer
// "could the record be read", and an incomplete run is a record that was read
// perfectly well — `ok`, every field accurate, written after the API had
// already started answering. Folding "incomplete" into that enum would make a
// client choose between rendering the deployment facts and reporting the
// failure, when the whole point of the record is that both are true at once.
//
// The API performs no network I/O to answer this. `remote` is whatever the
// CLI last recorded; the container has neither the git checkout nor a GitHub
// credential, and an admin page must not make outbound calls on every load.
// =============================================================================

export const deployInfoStatusSchema = z.enum([
  /** The file was read and matched the schema. */
  'ok',
  /** No file at `DEPLOY_INFO_PATH` — the ordinary state outside a CLI deploy. */
  'absent',
  /** The file exists but could not be read or was not JSON (a torn write). */
  'unreadable',
  /** The file parsed as JSON but did not match `deployInfoSchema`. */
  'invalid',
]);

export type DeployInfoStatus = z.infer<typeof deployInfoStatusSchema>;

export const aboutRuntimeSchema = z.object({
  /** `resolveApiVersion()`: `APP_VERSION`, else the npm version, else package.json. */
  apiVersion: z.string(),
  /** `process.version`, e.g. `v22.11.0`. */
  nodeVersion: z.string(),
  /** ISO-8601 UTC; derived from `process.uptime()`. */
  processStartedAt: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  /** ISO-8601 UTC, always with a `Z` suffix — the clock every timestamp on the page is compared against. */
  serverTimeUtc: z.string(),
  /** `NODE_ENV` as this process sees it. */
  environment: z.string(),
});

export const aboutDatabaseSchema = z.object({
  /** `SELECT version()`, verbatim. */
  serverVersion: z.string(),
  /** Rows in `_prisma_migrations` with `finished_at` set. */
  appliedMigrations: z.number().int().nonnegative(),
  /** Name of the most recently finished migration; null when none has. */
  lastMigrationName: z.string().nullable(),
  /** ISO-8601 UTC; null when no migration has finished. */
  lastMigrationAt: z.string().nullable(),
});

export const aboutResponseSchema = z.object({
  deployInfo: deployInfoSchema.nullable(),
  deployInfoStatus: deployInfoStatusSchema,
  /** The read/parse message when `deployInfoStatus` is not `ok`; otherwise null. */
  detail: z.string().nullable(),
  runtime: aboutRuntimeSchema,
  database: aboutDatabaseSchema.nullable(),
  /** Why `database` is null, when it is. */
  databaseError: z.string().nullable(),
  /** `remote.commitsBehind > 0`; null when the CLI has never checked. */
  updateAvailable: z.boolean().nullable(),
  /** `remote.checkedAt`, passed through; null when the CLI has never checked. */
  checkedAt: z.string().nullable(),
  /**
   * Did the deploy run that wrote the record run to the end? (issue #283)
   *
   * Derived here from `deployInfo.run` for the same reason `updateAvailable`
   * is derived from `deployInfo.remote`: the convention that an ABSENT `run`
   * means a COMPLETED run is written once, on the server, so the web About
   * card (#126) and the CLI's `deploy about` (#128) cannot disagree about a
   * deployment installed by a CLI from before #283.
   *
   *   * `null`  — there is no record at all (`deployInfoStatus` is not `ok`).
   *   * `true`  — the record says the run completed, or predates the field.
   *   * `false` — the run wrote this record and then failed a later step.
   *               `deployFailedStep` names that step; the rest of the record
   *               is still accurate, because it was written after the API
   *               had already answered.
   */
  deployRunComplete: z.boolean().nullable(),
  /** The step that stopped the run; null unless `deployRunComplete` is false. */
  deployFailedStep: z.string().nullable(),
  /** ISO-8601 UTC of that run's ending; null unless `deployRunComplete` is false. */
  deployAttemptedAt: z.string().nullable(),
});

export type AboutResponse = z.infer<typeof aboutResponseSchema>;
export type AboutRuntime = z.infer<typeof aboutRuntimeSchema>;
export type AboutDatabase = z.infer<typeof aboutDatabaseSchema>;

export class AboutResponseDto extends createZodDto(aboutResponseSchema) {}

/**
 * The documented example, ALREADY ENVELOPED. `openapi/data-envelope.ts` wraps
 * every 2xx JSON schema in `{ data, meta }` to match `TransformInterceptor`,
 * but it does not touch a media-level `example` — so an example written bare
 * would be published beside a schema it no longer validates against.
 */
export const ABOUT_RESPONSE_EXAMPLE = {
  data: {
    deployInfo: {
      schema: 1,
      app: {
        name: 'example-app',
        version: '1.4.0',
        commitSha: '3f2a9c1d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b',
        ref: 'main',
        repoUrl: 'https://github.com/example-org/example-app',
      },
      installedAt: '2026-08-01T09:15:00.000Z',
      updatedAt: '2026-09-14T22:41:07.000Z',
      lastCommand: 'update',
      deployedBy: { cli: 'example-cli', version: '1.4.0' },
      domain: 'app.example.com',
      bindPort: 3535,
      host: {
        hostname: 'vps-01',
        os: 'Ubuntu 24.04.1 LTS',
        kernel: '6.8.0-45-generic',
        arch: 'x64',
        cpuModel: 'AMD EPYC 7B13',
        cpus: 4,
        memoryBytes: 8323072000,
        diskBytes: 80530636800,
        dockerVersion: '27.1.1',
        composeVersion: '2.29.1',
        nodeVersion: '22.11.0',
      },
      remote: {
        sha: '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c',
        commitsBehind: 2,
        checkedAt: '2026-09-15T06:00:00.000Z',
      },
      run: { completed: true },
    },
    deployInfoStatus: 'ok',
    detail: null,
    runtime: {
      apiVersion: '1.4.0',
      nodeVersion: 'v22.11.0',
      processStartedAt: '2026-09-14T22:41:30.000Z',
      uptimeSeconds: 43110,
      serverTimeUtc: '2026-09-15T10:40:00.000Z',
      environment: 'production',
    },
    database: {
      serverVersion:
        'PostgreSQL 16.4 (Debian 16.4-1.pgdg120+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14) 12.2.0, 64-bit',
      appliedMigrations: 42,
      lastMigrationName: '20260901120000_add_note_exports',
      lastMigrationAt: '2026-09-14T22:41:12.000Z',
    },
    databaseError: null,
    updateAvailable: true,
    checkedAt: '2026-09-15T06:00:00.000Z',
    deployRunComplete: true,
    deployFailedStep: null,
    deployAttemptedAt: null,
  },
  meta: { timestamp: '2026-09-15T10:40:00.000Z' },
} as const;
