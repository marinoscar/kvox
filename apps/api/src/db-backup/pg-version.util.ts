import { Client } from 'pg';

import { buildDatabaseUrl, type DatabaseEnv } from '../common/database-url';
import { PG_DUMP_COMMAND, PgSpawnFn, spawnPgProcess } from './pg-dump.util';

// =============================================================================
// The client/server version guard (issue #280, epic #254)
// =============================================================================
//
// `pg_dump` REFUSES to dump a server newer than itself. That is not a warning
// and not a degraded mode — it is a hard error, on every invocation, forever,
// and the deployment that hits it is a deployment whose backups all fail
// silently from the day someone upgraded the server.
//
// This template is unusually exposed to it. `infra/compose/base.compose.yml`
// declares NO `db` service: the application's PostgreSQL is EXTERNAL, managed
// by the operator or by a cloud provider, and the client lives in the API
// image (`apps/api/Dockerfile`). Those two things are upgraded by different
// people, on different schedules, through different mechanisms. A managed
// provider can move a server's major in a maintenance window nobody in this
// repository hears about.
//
// So the version pair is checked BEFORE a dump starts, and the check has two
// deliberately asymmetric outcomes:
//
//   - `client < server`  → BLOCK. The dump cannot succeed; running it would
//     produce a failed run whose error message is `pg_dump`'s rather than one
//     that says what to do. Blocking early is how the operator gets told to
//     rebuild the image with a newer client instead of being told "server
//     version 18.1; pg_dump version 17.4".
//   - ANYTHING UNREADABLE → WARN AND PROCEED. An unparseable `--version`
//     banner, a `server_version_num` that comes back as something unexpected,
//     a query that fails: none of these are evidence that the backup would
//     fail, and AN UNPARSEABLE VERSION STRING MUST NEVER BE THE REASON A
//     BACKUP DID NOT HAPPEN. The check is a guard rail, not a gate; failing
//     open here costs a confusing error later, while failing closed costs
//     every backup from now on.
//
// The client's own major is also compared against {@link MIN_PG_CLIENT_MAJOR},
// which `test/pg-client-version.spec.ts` holds equal to the pin in the
// Dockerfile. See docs/runbooks/postgres-client-version.md.
// =============================================================================

/**
 * The PostgreSQL client major this image is built with.
 *
 * ⚠ THIS NUMBER AND THE `postgresql<N>-client` PIN IN `apps/api/Dockerfile`
 * ARE ONE DECISION. `test/pg-client-version.spec.ts` asserts they are equal,
 * so changing either alone fails the suite — which is the whole guard: the
 * Dockerfile line is edited by whoever is fixing an image, this constant is
 * read by whoever is debugging a backup, and nothing else would ever bring the
 * two people together.
 */
export const MIN_PG_CLIENT_MAJOR = 17;

/** What the check concluded, and what the caller should do about it. */
export type PgVersionStatus =
  /** Client can dump this server. Proceed. */
  | 'ok'
  /** Client is older than the server. Do NOT start a dump. */
  | 'blocked'
  /** One side could not be read. Log the message and proceed anyway. */
  | 'unknown';

export interface PgVersionCheck {
  status: PgVersionStatus;
  clientMajor: number | null;
  serverMajor: number | null;
  /**
   * The RAW `pg_dump --version` banner, e.g. `pg_dump (PostgreSQL) 17.2`, or
   * `null` when it could not be read.
   *
   * Added by #352 so a completed backup can record WHICH client wrote its
   * archive (`database_backup_runs.pg_dump_version`). The parsed
   * `clientMajor` above is what this module reasons with and is deliberately
   * lossy — `17` says nothing about which 17.x, and a `pg_restore` failing on
   * an archive written by a slightly newer point release is exactly the
   * situation where the full banner is what an operator needs. Optional so
   * every existing constructor of this shape (the specs' fakes included)
   * still compiles; absent and `null` mean the same thing.
   */
  client?: string | null;
  /** Ready to log or to store as a run's error; names both versions whenever they are known. */
  message: string;
  /** Set when the pair works but something else deserves a log line. */
  warning?: string;
}

/** Reads `pg_dump --version` output. Returns `null` when it cannot be read at all. */
export type ClientVersionReader = () => Promise<string | null>;

/**
 * Reads the server's `server_version_num` (e.g. `170004`).
 *
 * INJECTED, ALWAYS. The natural implementation is a Prisma
 * `$queryRaw<{ server_version_num: string }[]>` or a `pg` client, and either
 * one would make every test in this file need a database. The parser
 * ({@link parseServerVersionNum}) is exported separately so the call site can
 * stay a one-liner.
 */
export type ServerVersionNumReader = () => Promise<number | null>;

/**
 * Pulls the major out of a `pg_dump --version` banner.
 *
 * The banner has been `pg_dump (PostgreSQL) <version>` for the whole of the
 * period this code can encounter, but packagers append to it freely
 * (`pg_dump (PostgreSQL) 17.4 (Ubuntu 17.4-1.pgdg24.04+2)`), so this takes the
 * FIRST version-looking number rather than trying to match the whole line.
 * Both the modern `17.4` and the pre-10 `9.6.24` shapes reduce to their major
 * correctly.
 *
 * Returns `null` for anything it cannot read, which the caller turns into
 * "warn and proceed" — never into a failure.
 */
export function parsePgClientMajor(output: string | null | undefined): number | null {
  if (output === null || output === undefined) return null;

  const match = /(\d+)(?:\.\d+)*/.exec(output);
  if (match === null) return null;

  const major = Number.parseInt(match[1], 10);
  // A sanity bound, not a policy: `pg_dump 0` or `pg_dump 4200` means this
  // parsed something that was not a version, and reporting a nonsense major
  // would produce a nonsense block.
  if (!Number.isInteger(major) || major < 1 || major > 999) return null;

  return major;
}

/**
 * Normalises whatever a raw query returned into a `server_version_num` integer.
 *
 * Accepts a string, a number or a bigint because all three genuinely occur:
 * `server_version_num` is a `text` setting in `pg_settings`,
 * `SHOW server_version_num` returns text, and drivers differ on what they do
 * with `current_setting(...)::int`. Handling the union here is what keeps the
 * call site from having to know which it got.
 */
export function parseServerVersionNum(value: unknown): number | null {
  const numeric =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseInt(value, 10)
          : Number.NaN;

  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  return Math.trunc(numeric);
}

/**
 * Converts `server_version_num` to a major.
 *
 * PostgreSQL packs the number as `major * 10000 + minor` from 10 onwards
 * (`170004` → 17) and as `major * 10000 + minor * 100 + patch` before it
 * (`90624` → 9). Integer division by 10000 is correct for both, which is why
 * there is no special case here for the older shape.
 */
export function serverMajorFromVersionNum(versionNum: number | null): number | null {
  if (versionNum === null || !Number.isFinite(versionNum) || versionNum <= 0) return null;

  const major = Math.floor(versionNum / 10000);

  return major >= 1 && major <= 999 ? major : null;
}

export interface ReadPgClientVersionOptions {
  command?: string;
  timeoutMs?: number;
  spawnFn?: PgSpawnFn;
}

/**
 * How long `pg_dump --version` is given.
 *
 * It prints a line and exits; it opens no socket and reads no file. Anything
 * that takes longer than a few seconds is a broken or missing binary, and the
 * whole point of this reader is to answer quickly and never to be the thing
 * that hangs a backup.
 */
export const CLIENT_VERSION_TIMEOUT_MS = 10_000;

/**
 * Runs `pg_dump --version` and returns its output, or `null` if it could not
 * be run.
 *
 * NEVER THROWS, deliberately. Every failure — the binary is missing, it is not
 * executable, it timed out — becomes `null`, which becomes the `unknown`
 * status, which proceeds. The output is bounded because the reader only ever
 * needs the first line and a wedged binary streaming megabytes at us is not a
 * reason to grow the heap.
 */
export async function readPgClientVersion(
  options: ReadPgClientVersionOptions = {}
): Promise<string | null> {
  const child = spawnPgProcess({
    command: options.command ?? PG_DUMP_COMMAND,
    args: ['--version'],
    timeoutMs: options.timeoutMs ?? CLIENT_VERSION_TIMEOUT_MS,
    spawnFn: options.spawnFn,
  });

  let output = '';
  try {
    for await (const chunk of child.stdout) {
      output += String(chunk);
      if (output.length >= 1024) {
        child.kill('SIGKILL');
        break;
      }
    }

    await child.done;
  } catch {
    // A non-zero exit with usable output on stdout is still an answer; an
    // empty one is `null` by the return below.
  }

  return output === '' ? null : output;
}

// -----------------------------------------------------------------------------
// The `pg` seam
// -----------------------------------------------------------------------------
//
// WHY THIS SUBSYSTEM CARRIES A RAW `pg` DEPENDENCY AT ALL, next to a perfectly
// good Prisma client. Prisma is bound to ONE database - the application's, by
// URL, at startup. The restore in #285 has to connect to a DIFFERENT database
// (the `postgres` maintenance database) in order to `CREATE DATABASE`, rename
// the restored copy into place and rename the displaced one away; none of
// those statements can run from inside the database they are renaming, and
// Prisma has no way to point at another one. The version read below is the
// first, smallest use of that same seam: it answers "what major is the server"
// without going through the ORM, so it still works while the application
// database is mid-swap.

/** The subset of a `pg` client this module uses. Keeps the tests free of a database. */
export interface PgQueryClient {
  // `Promise<unknown>` rather than `Promise<void>`: `pg`'s own `connect()`
  // resolves with the client, and narrowing it here would make the real driver
  // fail to satisfy the seam it exists to describe.
  connect(): Promise<unknown>;
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

/** Test seam: builds a client from a connection string. */
export type PgClientFactory = (connectionString: string) => PgQueryClient;

const defaultPgClientFactory: PgClientFactory = (connectionString) =>
  new Client({ connectionString });

/**
 * Reads `server_version_num` over a short-lived connection of its own.
 *
 * A {@link ServerVersionNumReader} for callers that do not want to spend a
 * Prisma query on it (or cannot - see the note above). It always closes the
 * connection, including on failure: a version probe that leaks a connection
 * every night is a slow way to exhaust `max_connections` on the very server
 * the backups are protecting.
 *
 * Returns `null` rather than throwing on any failure, because its one consumer
 * ({@link checkPgClientVersion}) treats an unreadable version as "warn and
 * proceed" and nothing else should be able to turn it into a blocked backup.
 */
export async function readServerVersionNumWithPgClient(
  options: { env?: DatabaseEnv; clientFactory?: PgClientFactory } = {}
): Promise<number | null> {
  const factory = options.clientFactory ?? defaultPgClientFactory;
  const client = factory(buildDatabaseUrl(options.env ?? process.env));

  try {
    await client.connect();
    const result = await client.query('SHOW server_version_num');

    return parseServerVersionNum(result.rows[0]?.server_version_num);
  } catch {
    return null;
  } finally {
    // `end()` on a client that never connected rejects in some versions; this
    // probe's whole contract is that it cannot throw.
    await client.end().catch(() => undefined);
  }
}

export interface CheckPgClientVersionOptions {
  /** Defaults to running `pg_dump --version`. */
  readClientVersion?: ClientVersionReader;
  /** No default — the database seam is always supplied by the caller. */
  readServerVersionNum: ServerVersionNumReader;
}

/**
 * Compares the installed client against the server it would have to dump.
 *
 * @returns `blocked` only when BOTH majors are known and the client is the
 * older one. Every other uncertainty is `unknown`, which the caller logs and
 * ignores — see the module header for why this fails open.
 */
export async function checkPgClientVersion(
  options: CheckPgClientVersionOptions
): Promise<PgVersionCheck> {
  const readClient = options.readClientVersion ?? (() => readPgClientVersion());
  // KEPT, not just parsed. The banner is the part a human reads; the major is
  // the part this function compares. Reading it twice would run `pg_dump
  // --version` twice for one backup, and the second read could disagree with
  // the first on a host mid-upgrade.
  const client = normaliseBanner(await readSafely(readClient));
  const clientMajor = parsePgClientMajor(client);
  const serverMajor = serverMajorFromVersionNum(await readSafely(options.readServerVersionNum));

  if (clientMajor === null || serverMajor === null) {
    return {
      status: 'unknown',
      client,
      clientMajor,
      serverMajor,
      message:
        'Could not determine the PostgreSQL version pair ' +
        `(client: ${describe(clientMajor)}, server: ${describe(serverMajor)}). ` +
        'Proceeding without the client/server compatibility check; if the backup then fails ' +
        'with a version error, see docs/runbooks/postgres-client-version.md.',
    };
  }

  if (clientMajor < serverMajor) {
    return {
      status: 'blocked',
      client,
      clientMajor,
      serverMajor,
      message:
        `The PostgreSQL client in this image is major ${clientMajor}, but the server is major ` +
        `${serverMajor}. pg_dump refuses to dump a server newer than itself, so no backup can ` +
        `succeed until the image is rebuilt with a postgresql${serverMajor}-client (or newer) ` +
        'package: update the apk pin in apps/api/Dockerfile and MIN_PG_CLIENT_MAJOR in ' +
        'apps/api/src/db-backup/pg-version.util.ts together, then redeploy. See ' +
        'docs/runbooks/postgres-client-version.md.',
    };
  }

  return {
    status: 'ok',
    client,
    clientMajor,
    serverMajor,
    message: `PostgreSQL client major ${clientMajor} can dump server major ${serverMajor}.`,
    // Not a block: a client older than the pin still dumps this server
    // correctly. It does mean the running image is not the one this build
    // expects — an old image left behind by a partial deploy, or a `command`
    // override pointing at a system binary — which is worth one log line.
    ...(clientMajor < MIN_PG_CLIENT_MAJOR
      ? {
          warning:
            `The PostgreSQL client is major ${clientMajor}, older than the ${MIN_PG_CLIENT_MAJOR} ` +
            'this build pins in apps/api/Dockerfile. The current server is dumpable, but the ' +
            'image is not the one this build expects.',
        }
      : {}),
  };
}

/**
 * One trimmed line, bounded — or `null`.
 *
 * BOUNDED AT 128 CHARACTERS because this string is written to a database
 * column and, on the node path, arrives from off-machine (the result contract
 * caps it at the same width). `pg_dump --version` prints one short line; a
 * wrapper script that prints a page of banner must not be able to put a page
 * in every backup row.
 */
function normaliseBanner(value: string | null): string | null {
  if (value === null) return null;

  const line = value.split('\n')[0]?.trim() ?? '';

  return line === '' ? null : line.slice(0, 128);
}

/** `17`, or `unknown` — used only to build messages. */
function describe(major: number | null): string {
  return major === null ? 'unknown' : String(major);
}

/**
 * Runs a reader, turning any rejection into `null`.
 *
 * The server reader is a database call made by a backup that is about to
 * happen; a transient failure of that ONE query must not be what stops it. The
 * `unknown` path it falls into already says so in its message.
 */
async function readSafely<T>(reader: (() => Promise<T | null>) | undefined): Promise<T | null> {
  if (reader === undefined) return null;

  try {
    return await reader();
  } catch {
    return null;
  }
}
