import { Client } from 'pg';

import type { DatabaseEnv } from '../common/database-url';
import { compactTimestamp } from './db-backup-storage';
import { resolvePgConnection, type PgConnection } from './pg-dump.util';

// =============================================================================
// The cluster admin connection (issue #284, epic #254)
// =============================================================================
//
// A short-lived `pg.Client` to the MAINTENANCE DATABASE (`postgres`), opened
// for one unit of work and closed in a `finally`. It exists next to a
// perfectly good Prisma client, and next to `pg-version.util.ts`'s own probe
// connection, for two STRUCTURAL reasons — neither of which is a preference:
//
//   1. THE POOLED CONNECTIONS ARE THE PROBLEM. `ALTER DATABASE ... RENAME TO`
//      fails while ANY session is connected to the database being renamed, and
//      Prisma holds a pool of exactly those sessions open for the lifetime of
//      the process. A restore that borrowed a Prisma connection to do its
//      renaming would be holding open the one thing it first has to get rid
//      of. So the admin work happens on a connection Prisma does not know
//      about, and the pooled ones are terminated (see
//      {@link terminateConnections}) rather than reused.
//   2. A DATABASE CANNOT BE RENAMED FROM A SESSION CONNECTED TO IT. Prisma is
//      bound to ONE database, by URL, at startup — the application's, which is
//      precisely the one a restore renames away. There is no Prisma API that
//      points it somewhere else, so `CREATE DATABASE`, `DROP DATABASE` and
//      both halves of the swap have to be issued from a session attached to a
//      DIFFERENT database. That is what the maintenance database is for.
//
// Both reasons are about the swap in #285. NOTHING IN THIS ISSUE'S PRE-FLIGHT
// PATH CREATES, DROPS OR RENAMES ANYTHING — the four mutating operations at
// the bottom of this file are exported for #285 alone, and
// `restore-preflight.service.spec.ts` asserts with spies that pre-flight never
// calls them. Knowing whether a restore can work must never be a step that
// changes anything, because the answer is frequently "no".
//
// -----------------------------------------------------------------------------
// `statement_timeout` IS DELIBERATELY 0
// -----------------------------------------------------------------------------
//
// Not "left at the default" — SET to zero, explicitly, on every admin session,
// so that a server-side default (a managed provider's, a `postgresql.conf`, an
// `ALTER ROLE ... SET statement_timeout`) cannot apply to this one. A timeout
// firing part-way through `CREATE DATABASE` or `ALTER DATABASE ... RENAME`
// does not undo the statement; it cancels the client's wait for it. What the
// caller then holds is AMBIGUITY — a rename that may or may not have happened,
// on the database the application is about to be pointed at — and there is no
// safe automated response to that. An unbounded wait is the better failure: it
// is visible, it is interruptible by a human, and the cluster's own state
// stays knowable.
//
// The bound that DOES exist is a wall-clock one on the whole callback
// ({@link WithAdminConnectionOptions.timeoutMs}), defaulting to OFF. Pre-flight
// passes a short one because it runs inside an HTTP request and every query it
// issues is a trivial read; #285's swap passes none, for the reason above.
// =============================================================================

/**
 * The database an admin session attaches to when it needs to act on another
 * one.
 *
 * `postgres` exists on every cluster initdb has ever created and is the
 * conventional maintenance database — it is what `createdb`, `dropdb` and
 * `psql -l` connect to for exactly this reason.
 */
export const DEFAULT_MAINTENANCE_DATABASE = 'postgres';

/**
 * Where the maintenance connection goes when the application's own database is
 * called `postgres`.
 *
 * ⚠ NOT A CURIOSITY. A deployment whose `POSTGRES_DB` is `postgres` is
 * ordinary (it is the default database name of several hosted images), and
 * attaching to it would put the admin session INSIDE the database the swap has
 * to rename — the one thing this whole file exists to avoid. `template1` is
 * the other database initdb always creates.
 */
export const FALLBACK_MAINTENANCE_DATABASE = 'template1';

/**
 * PostgreSQL's identifier limit, in bytes (`NAMEDATALEN - 1`).
 *
 * ⚠ THE SERVER DOES NOT REFUSE A LONGER NAME — IT TRUNCATES IT, with a notice
 * nobody reads. That is why the name builders below trim the BASE rather than
 * letting the server trim the tail: see {@link buildScratchDatabaseName}.
 *
 * Bytes, not characters — but {@link quoteIdentifier}'s allowlist is ASCII
 * only, so for every name this module can produce the two are the same number.
 */
export const MAX_IDENTIFIER_BYTES = 63;

/** The suffix that marks the database an archive is replayed into. */
export const SCRATCH_SUFFIX = '_restore_';

/** The suffix that marks the database a swap displaced. */
export const OLD_SUFFIX = '_old_';

/**
 * Identifiers this module will quote. ASCII letters, digits, `_` and `$`, not
 * starting with a digit.
 *
 * See {@link quoteIdentifier} for why anything outside it is REJECTED rather
 * than escaped.
 */
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * String literals this module will quote: ASCII letters and digits, nothing
 * else, at least one character.
 *
 * ⚠ THIS IS DELIBERATELY NARROWER THAN "WHAT POSTGRESQL ACCEPTS IN A STRING".
 * It is not a general-purpose escaper and must never become one — see
 * {@link quoteLiteral} for the whole argument. It describes exactly one thing:
 * the alphabet `PgJobRoleBroker` GENERATES its passwords over.
 */
const SAFE_LITERAL_PATTERN = /^[A-Za-z0-9]+$/;

/**
 * The one timestamp shape {@link quoteTimestampLiteral} will emit.
 *
 * `Date.prototype.toISOString`'s output for every year 1000-9999, which is
 * every instant this application can be asked about. A year outside that range
 * renders as `+275760-09-13T00:00:00.000Z`, which this rejects — an expiry a
 * quarter of a million years out is a bug, not a grant.
 */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------
//
// These are NOT in `db-backup.errors.ts`, and the split is deliberate: that
// file enumerates the ways a BACKUP can be refused or fail, each of which some
// caller turns into a status code. None of these is a restore verdict —
// pre-flight reports its refusals as VERDICTS in a result object, never as
// exceptions (that is the whole point of the `guided` outcome), and #350's
// role broker reports its own the same way. These three are what is left over:
// two programming errors and an infrastructure hang.

/**
 * An identifier failed {@link SAFE_IDENTIFIER_PATTERN}.
 *
 * Thrown, not reported: every name this module quotes is either derived here
 * from the configured database name or supplied by our own code, so a rejection
 * means a value reached DDL from somewhere it should not have.
 */
export class InvalidDatabaseIdentifierError extends Error {
  constructor(readonly identifier: string) {
    super(
      `"${identifier}" is not a database identifier this application will put into DDL. ` +
        'Only ASCII letters, digits, "_" and "$" are accepted, the first character may not ' +
        'be a digit, and the name must be 1-' +
        `${MAX_IDENTIFIER_BYTES} bytes long.`
    );
    this.name = 'InvalidDatabaseIdentifierError';
    Object.setPrototypeOf(this, InvalidDatabaseIdentifierError.prototype);
  }
}

/**
 * A value failed {@link SAFE_LITERAL_PATTERN} or {@link ISO_TIMESTAMP_PATTERN}
 * on its way into a SQL string literal.
 *
 * ⚠ THE OFFENDING VALUE IS NOT IN THE MESSAGE, AND MUST NEVER BE. The only
 * literal this application interpolates is a GENERATED DATABASE PASSWORD
 * (`CREATE ROLE ... PASSWORD '<pw>'` cannot be parameterised — see
 * {@link quoteLiteral}), so the one thing a helpful "received: ..." would
 * achieve is putting live credential material into a log line, an error
 * response and every aggregator downstream of both. `what` names the KIND of
 * literal that was rejected and nothing about its contents.
 *
 * Thrown, never reported: a rejection here means the generator produced
 * something outside its own alphabet, which is a programming error and not a
 * condition any operator can act on.
 */
export class InvalidSqlLiteralError extends Error {
  constructor(readonly what: string) {
    super(
      `A ${what} this application was about to put into a SQL string literal is not one it ` +
        'will interpolate. Generated literals are ASCII letters and digits only, and ' +
        'timestamps are ISO-8601 instants; the value itself is deliberately not reported, ' +
        'because the only literal this application interpolates is a credential.'
    );
    this.name = 'InvalidSqlLiteralError';
    Object.setPrototypeOf(this, InvalidSqlLiteralError.prototype);
  }
}

/**
 * A bounded admin callback outlived its budget.
 *
 * Only reachable when the caller asked for a bound — see
 * {@link WithAdminConnectionOptions.timeoutMs}, which is off by default.
 */
export class AdminConnectionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `The PostgreSQL maintenance connection did not finish its work within ${timeoutMs}ms ` +
        'and was closed. Nothing was rolled back: the statements that had already been ' +
        'issued continue on the server.'
    );
    this.name = 'AdminConnectionTimeoutError';
    Object.setPrototypeOf(this, AdminConnectionTimeoutError.prototype);
  }
}

// -----------------------------------------------------------------------------
// Connection configuration
// -----------------------------------------------------------------------------

/**
 * Where the admin session connects, and what it is going to act on.
 *
 * `database` is the MAINTENANCE database (the session's own attachment);
 * `liveDatabase` is the application's, which the session acts ON and never
 * connects to. Keeping both on one object is what stops a caller from
 * accidentally passing the live name where the attachment goes.
 */
export interface AdminConnection extends PgConnection {
  /** The application's database — the one a restore displaces. Never connected to. */
  liveDatabase: string;
}

/**
 * Derives the admin connection from the same environment everything else uses.
 *
 * ⚠ THROUGH `resolvePgConnection`, WHICH GOES THROUGH `buildDatabaseUrl`. That
 * is the one place a PostgreSQL connection string is built (#172), and the
 * reason it is the only place is that three copies of the same derivation once
 * disagreed about percent-encoding — with the symptom that migrations applied
 * cleanly and the application then could not connect. Reading `POSTGRES_*`
 * directly here would be the fourth copy, and it would also silently ignore a
 * `DATABASE_URL` override, which is the documented escape hatch for a
 * connection the `POSTGRES_*` formula cannot express.
 *
 * @param maintenanceDatabase the database to ATTACH to. A parameter rather
 * than a new environment variable, following `PG_DUMP_COMMAND`'s precedent: the
 * deployments that need something other than `postgres` are rare enough that a
 * caller-supplied value is the right seam, and an unused variable in
 * `.env.example` is a knob nobody maintains.
 */
export function resolveAdminConnection(
  env: DatabaseEnv = process.env,
  maintenanceDatabase: string = DEFAULT_MAINTENANCE_DATABASE
): AdminConnection {
  const connection = resolvePgConnection(env);

  // See FALLBACK_MAINTENANCE_DATABASE: attaching to the database we are about
  // to rename is the one arrangement that cannot work.
  const attach =
    maintenanceDatabase === connection.database
      ? FALLBACK_MAINTENANCE_DATABASE
      : maintenanceDatabase;

  return { ...connection, database: attach, liveDatabase: connection.database };
}

/**
 * The subset of `pg.Client` this module uses.
 *
 * A seam, for the same reason `PgQueryClient` in `pg-version.util.ts` is one:
 * a suite that needs a live PostgreSQL is a suite that gets skipped in CI, and
 * a skipped test guards nothing. Unlike that one this seam takes BIND
 * PARAMETERS, because every read below is parameterised — only DDL, which
 * cannot be, goes through {@link quoteIdentifier}.
 */
export interface AdminQueryClient {
  // `Promise<unknown>`, matching `PgQueryClient`: `pg`'s own `connect()`
  // resolves with the client, and narrowing it would make the real driver fail
  // to satisfy the seam that describes it.
  connect(): Promise<unknown>;
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  end(): Promise<void>;
}

/** Test seam: builds an unconnected client for one admin session. */
export type AdminClientFactory = (config: AdminConnection) => AdminQueryClient;

/**
 * Injection token for {@link AdminClientFactory}.
 *
 * OPTIONAL AND DELIBERATELY LEFT UNBOUND in `DbBackupModule`, exactly as
 * `DB_BACKUP_ENGINE` and `JOB_CLOCK` are: the application always runs on the
 * real driver, and only a test that constructs the service directly can
 * substitute one. A binding here would be a seam a fork could fill by
 * accident, and a stubbed cluster connection in production is a restore
 * subsystem that reports a clean pre-flight against nothing.
 */
export const RESTORE_ADMIN_CLIENT_FACTORY = 'RESTORE_ADMIN_CLIENT_FACTORY';

/**
 * The real factory: one `pg.Client`, configured field by field.
 *
 * DISCRETE FIELDS RATHER THAN A CONNECTION STRING, unlike
 * `readServerVersionNumWithPgClient`. `resolvePgConnection` has just
 * percent-DECODED the user and password out of the URL; handing them back to a
 * `connectionString` would require re-encoding them, and a password containing
 * `/` or `+` — which `openssl rand -base64 32` produces routinely — is exactly
 * the round trip #172 exists to stop happening a fourth time.
 */
const defaultAdminClientFactory: AdminClientFactory = (config) =>
  new Client({
    host: config.host,
    port: Number.parseInt(config.port, 10),
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: resolveSslOption(config.sslMode),
  });

/**
 * Translates libpq's `sslmode` into node-postgres's `ssl` option.
 *
 * The two do NOT mean the same thing by default: libpq's `require` encrypts
 * WITHOUT verifying the certificate chain, while node-postgres's `ssl: true`
 * verifies. Mapping `require` to `true` would turn a connection that works for
 * `pg_dump` into a `SELF_SIGNED_CERT_IN_CHAIN` failure here — on a deployment
 * whose backups are fine, which is the most confusing possible place for a
 * restore to stop.
 */
function resolveSslOption(sslMode: string | null): boolean | { rejectUnauthorized: boolean } {
  if (sslMode === null || sslMode === 'disable' || sslMode === 'allow' || sslMode === 'prefer') {
    return false;
  }

  return sslMode === 'verify-ca' || sslMode === 'verify-full'
    ? { rejectUnauthorized: true }
    : { rejectUnauthorized: false };
}

export interface WithAdminConnectionOptions {
  clientFactory?: AdminClientFactory;
  /**
   * Wall-clock bound on the WHOLE callback, in milliseconds. `0` (the default)
   * means unbounded.
   *
   * ⚠ THIS IS NOT `statement_timeout`, WHICH STAYS 0 — see the module header.
   * The difference is who is protected: `statement_timeout` would abandon a
   * `CREATE DATABASE` half way and leave the cluster's state unknowable, while
   * this bound exists so a pre-flight running inside an HTTP request cannot
   * hang forever against a host that completes a TCP connect and then drops
   * every packet (a firewall rule change is the usual cause). Pre-flight passes
   * a short value because every query it issues is a trivial read; #285's swap
   * passes none.
   *
   * When it fires the connection IS closed, but the statements already issued
   * keep running on the server. That is why only read-only callers use it.
   */
  timeoutMs?: number;
}

/**
 * Runs `fn` against a connected maintenance-database session, and ALWAYS
 * closes it.
 *
 * ⚠ THE `finally` IS THE POINT OF THIS FUNCTION. A leaked session to the
 * cluster is what makes a later `ALTER DATABASE ... RENAME` fail — Postgres
 * refuses the rename while anything is connected to the database, and "anything"
 * includes a probe from ten minutes ago that nobody closed. A restore that
 * fails at the swap, after the archive has been replayed and the application
 * has been stopped, is the worst place in this subsystem to discover a leak.
 * So every exit path — return, throw, and the timeout below — goes through one
 * `end()`.
 */
export async function withAdminConnection<T>(
  config: AdminConnection,
  fn: (client: AdminQueryClient) => Promise<T>,
  options: WithAdminConnectionOptions = {}
): Promise<T> {
  const { clientFactory = defaultAdminClientFactory, timeoutMs = 0 } = options;
  const client = clientFactory(config);

  let timer: NodeJS.Timeout | undefined;

  try {
    await client.connect();

    // Explicitly zero, on every session, so that no server-side default can
    // apply to this one. See the module header for why a fired timeout is
    // worse here than an unbounded wait.
    await client.query('SET statement_timeout = 0');

    if (timeoutMs <= 0) return await fn(client);

    // `Promise.race` rather than an abort passed into `fn`: the callback is
    // arbitrary caller code and cannot be assumed to honour cancellation. What
    // this guarantees is the ONE thing that matters — that we stop waiting and
    // reach the `finally`, so the connection is not left open by a callback
    // that never settles.
    return await Promise.race([
      fn(client),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AdminConnectionTimeoutError(timeoutMs)), timeoutMs);
        // Unreferenced so a pending bound never by itself keeps the process
        // (or a Jest worker) alive after everything else has finished.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);

    // `.catch()`, because a client that never connected rejects on `end()` in
    // some driver versions and the ORIGINAL failure — an unreachable host, a
    // refused password — is the one the caller needs to see. A close error
    // masking a connect error would send an operator to the wrong runbook.
    await client.end().catch(() => undefined);
  }
}

// -----------------------------------------------------------------------------
// Identifiers
// -----------------------------------------------------------------------------

/**
 * Quotes a database identifier for DDL, REJECTING anything outside a strict
 * allowlist.
 *
 * ⚠ DDL CANNOT USE BIND PARAMETERS. `CREATE DATABASE $1` is a syntax error —
 * the parameter machinery works on values, and a database name is a name — so
 * every identifier this subsystem puts into a statement is interpolated, which
 * makes this function the only thing between a stored string and arbitrary
 * SQL.
 *
 * IT REJECTS RATHER THAN ESCAPES, and that is the decision worth defending.
 * The standard escape is to double any embedded `"`, and it is correct as far
 * as it goes — but it accepts every name, so the safety of the statement then
 * depends on this implementation being right about every case forever
 * (embedded NULs, invalid UTF-8, a name that is 64 bytes and gets truncated by
 * the server INTO something else). An allowlist has the opposite failure mode:
 * the worst it can do is refuse a legal name, which surfaces immediately as a
 * clear error from a code path an operator is watching. Every name this
 * subsystem uses is either the configured database name or one derived from it
 * by the builders below, so the allowlist costs nothing real.
 */
export function quoteIdentifier(identifier: string): string {
  if (
    !SAFE_IDENTIFIER_PATTERN.test(identifier) ||
    Buffer.byteLength(identifier, 'utf8') > MAX_IDENTIFIER_BYTES
  ) {
    throw new InvalidDatabaseIdentifierError(identifier);
  }

  // Quoted even though the allowlist guarantees it needs no quoting, so that a
  // name which happens to be a reserved word (`user`, `table`) and a name that
  // differs only in case both mean what they say.
  return `"${identifier}"`;
}

/**
 * Quotes a GENERATED string literal for DDL, THROWING on any character outside
 * `[A-Za-z0-9]` rather than escaping it.
 *
 * ⚠ WHY A LITERAL IS INTERPOLATED AT ALL, WHICH IS THE FIRST THING TO CHECK.
 * `CREATE ROLE ... PASSWORD $1` is a syntax error for the same reason
 * `CREATE DATABASE $1` is: bind parameters carry VALUES into a plan, and the
 * `CREATE ROLE` grammar wants an `Sconst` — a literal string in the statement
 * text. There is no `ALTER ROLE` form that takes a parameter either. So a
 * password reaches PostgreSQL by being written into the statement, once, here,
 * and this function is the only thing between the generator and arbitrary SQL.
 *
 * IT REJECTS RATHER THAN ESCAPES, and unlike {@link quoteIdentifier} — where
 * the same argument is about an operator's `POSTGRES_DB` — here it costs
 * literally nothing, because THE ONLY CALLER GENERATES ITS OWN INPUT.
 * `PgJobRoleBroker` builds a password over exactly this alphabet from
 * `randomBytes`; a value that fails this check did not come from that
 * generator, and no amount of correct escaping makes running it a good idea.
 *
 * REJECTED: `value.replace(/'/g, "''")`, the standard doubling escape. It is
 * CORRECT — and that is the problem with it. It accepts every string, so the
 * safety of every statement built with it depends forever on a reader being
 * able to prove the escape function is right about every case: embedded NULs,
 * invalid UTF-8, a backslash under a `standard_conforming_strings` that some
 * managed provider set to `off`, a dollar-quoted tail. An allowlist has the
 * opposite failure mode — the worst it can do is refuse a legal value, loudly,
 * from a code path we own — and it turns a class of injection bug into a state
 * that cannot be represented rather than one that is handled.
 *
 * ⚠ THE REJECTED VALUE IS NEVER NAMED, in the error or in a log. See
 * {@link InvalidSqlLiteralError}: the only literal this application
 * interpolates is a live database password.
 *
 * @param what what KIND of literal this is, for the error message only.
 */
export function quoteLiteral(value: string, what = 'literal'): string {
  if (typeof value !== 'string' || !SAFE_LITERAL_PATTERN.test(value)) {
    throw new InvalidSqlLiteralError(what);
  }

  return `'${value}'`;
}

/**
 * Quotes an instant for `VALID UNTIL`, TAKING A `Date` AND NEVER A STRING.
 *
 * ⚠ THE PARAMETER TYPE IS THE SECURITY PROPERTY. `VALID UNTIL` is another
 * `Sconst` — it cannot be parameterised — so an expiry is interpolated exactly
 * like a password is. But an ISO-8601 instant contains `-`, `:`, `.`, `T` and
 * `Z`, so it cannot go through {@link quoteLiteral}'s alphabet, and widening
 * that alphabet to admit them would weaken the one guard the password depends
 * on. Taking a `Date` instead removes the question: there is no caller-supplied
 * STRING anywhere on this path, the text is produced by
 * `Date.prototype.toISOString`, and the pattern check below is a belt-and-braces
 * assertion about our own formatter rather than a filter on someone's input.
 *
 * REJECTED: a `quoteLiteral(value, PATTERN)` overload taking the caller's own
 * regular expression. That makes the alphabet a parameter — which is to say it
 * makes the guard something each call site re-decides, and the call site that
 * gets it wrong is the one nobody reviews.
 *
 * PostgreSQL parses `2026-09-07T12:00:00.000Z` as a `timestamptz` (ISO 8601,
 * `T` separator, `Z` meaning UTC), so no local-timezone assumption is made
 * anywhere: the grant expires at an instant, not at a wall-clock reading.
 */
export function quoteTimestampLiteral(at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new InvalidSqlLiteralError('timestamp');
  }

  const iso = at.toISOString();

  if (!ISO_TIMESTAMP_PATTERN.test(iso)) {
    throw new InvalidSqlLiteralError('timestamp');
  }

  return `'${iso}'`;
}

/**
 * `<base>_restore_<timestamp>` / `<base>_old_<timestamp>`, TRIMMING THE BASE.
 *
 * ⚠ THE SUFFIX MUST SURVIVE, AND THE SERVER WOULD TRIM THE OTHER END. Postgres
 * does not reject an over-long identifier; it TRUNCATES it to
 * {@link MAX_IDENTIFIER_BYTES} and carries on. So for a database whose name is
 * already near the limit, `<63-char name>_restore_20260907T120000Z` and
 * `<same name>_restore_20260908T120000Z` truncate to the SAME physical name —
 * two restores silently sharing one scratch database, the second finding the
 * first's half-restored contents. Trimming the base instead keeps the
 * disambiguating part, which is the only part that disambiguates.
 *
 * The timestamp is `compactTimestamp` from `db-backup-storage.ts`, the same
 * UTC format the storage keys use: one timestamp format in this subsystem, and
 * one that is alphanumeric by construction so the result still satisfies
 * {@link quoteIdentifier}.
 */
function buildDerivedDatabaseName(base: string, suffix: string, at: Date): string {
  const tail = `${suffix}${compactTimestamp(at)}`;
  const room = MAX_IDENTIFIER_BYTES - tail.length;

  if (room < 1) {
    // Unreachable with the suffixes above (25 and 21 bytes), and asserted
    // rather than silently producing an illegal name if someone adds a longer
    // one later.
    throw new InvalidDatabaseIdentifierError(`${base}${tail}`);
  }

  // Trimming a legal identifier from the tail leaves a legal identifier: the
  // first character — the only position with a stricter rule — is preserved by
  // construction.
  const trimmed = base.slice(0, room);
  const name = `${trimmed}${tail}`;

  // Validated here rather than only at the call site, so an unusable
  // `POSTGRES_DB` is reported when the name is BUILT (during pre-flight, which
  // changes nothing) instead of at the moment #285 tries to create it.
  quoteIdentifier(name);

  return name;
}

/** The database an archive is replayed into. Never the live one. */
export function buildScratchDatabaseName(liveDatabase: string, at: Date): string {
  return buildDerivedDatabaseName(liveDatabase, SCRATCH_SUFFIX, at);
}

/** The name the live database is renamed to when a restore swaps. */
export function buildOldDatabaseName(liveDatabase: string, at: Date): string {
  return buildDerivedDatabaseName(liveDatabase, OLD_SUFFIX, at);
}

// -----------------------------------------------------------------------------
// Cluster reads — safe to call from pre-flight
// -----------------------------------------------------------------------------

/**
 * Whether the connected role may `CREATE DATABASE`.
 *
 * ⚠ PROBED, NEVER ASSUMED. Managed PostgreSQL routinely withholds `CREATEDB`
 * from the role an application connects with (it is not superuser, and the
 * provider owns role management), and the scratch-database restore in #285
 * cannot start without it. Assuming the privilege means finding out at the
 * moment the restore begins — after the operator has committed to it, in an
 * incident — instead of before anything happened.
 *
 * `rolsuper OR rolcreatedb`, because a superuser may create databases without
 * the attribute being set. `current_user` rather than the configured user
 * name: `SET ROLE`, a connection pooler, or a `DATABASE_URL` override can all
 * make the session's role something other than what the environment says.
 */
export async function probeCreateDatabasePrivilege(client: AdminQueryClient): Promise<boolean> {
  const result = await client.query(
    'SELECT (rolsuper OR rolcreatedb) AS can_create FROM pg_roles WHERE rolname = current_user'
  );

  return result.rows[0]?.can_create === true;
}

/**
 * Whether the connected role may `CREATE ROLE` (issue #350, epic #345).
 *
 * THE DIRECT SIBLING OF {@link probeCreateDatabasePrivilege}, and it exists for
 * the same reason one query lower down the same file: managed PostgreSQL
 * withholds role management from application roles as a matter of course,
 * because the provider owns it. `PgJobRoleBroker` mints a per-job login role,
 * so on those platforms it simply cannot — and that is the ORDINARY case, not
 * a fault. Probing turns it into a `guided` verdict an operator can act on
 * before a backup is ever offered to a node, instead of a driver error at 2am
 * on a machine they cannot see.
 *
 * `rolsuper OR rolcreaterole`, because a superuser creates roles without the
 * attribute being set — the same shape, and the same reasoning, as the
 * `CREATEDB` probe. `current_user` rather than the configured user name: `SET
 * ROLE`, a pooler, or a `DATABASE_URL` override can all make the session's role
 * something other than what the environment says.
 *
 * ⚠ A READ. It creates nothing, exactly as `JobSecretBroker.usable()` is
 * contracted to create nothing — asking "could you mint one?" must never be a
 * step that mints one, or every refused request leaves a half-made grant nobody
 * recorded.
 *
 * NOT SUFFICIENT ON ITS OWN, and worth saying because it is easy to read this
 * as the whole gate: `CREATEROLE` lets a role be created, and the grants that
 * follow (`GRANT CONNECT`, `GRANT SELECT ON ALL TABLES`) need the granting role
 * to hold those privileges WITH GRANT OPTION or to own the objects. In the
 * ordinary deployment the application role owns its own schema, so holding
 * `CREATEROLE` is the only part that is ever missing; a deployment where it is
 * not gets a real error from the `GRANT`, which the broker surfaces as a
 * refusal rather than as a half-privileged role.
 */
export async function probeCreateRolePrivilege(client: AdminQueryClient): Promise<boolean> {
  const result = await client.query(
    'SELECT (rolsuper OR rolcreaterole) AS can_create FROM pg_roles WHERE rolname = current_user'
  );

  return result.rows[0]?.can_create === true;
}

/**
 * Whether the cluster can `CREATE EXTENSION <name>` — i.e. whether the
 * extension's control file is installed on the SERVER's filesystem.
 *
 * A restore replays the archive's `CREATE EXTENSION` statements into a fresh
 * database, and an extension the cluster does not offer fails the restore at
 * that statement. `pg_available_extensions` is the only thing that knows;
 * `pg_extension` (what is installed HERE) does not, which is why both are read
 * — see the extensions gate in `restore-preflight.service.ts`.
 */
export async function probePgExtensionAvailable(
  client: AdminQueryClient,
  name: string
): Promise<boolean> {
  const result = await client.query(
    'SELECT 1 FROM pg_available_extensions WHERE name = $1 LIMIT 1',
    [name]
  );

  return result.rows.length > 0;
}

/**
 * On-disk size of one database, in bytes.
 *
 * `bigint`, and cast to `text` in the query first: `pg_database_size` returns
 * `int8`, node-postgres hands `int8` back as a STRING to avoid silently losing
 * precision above 2^53, and parsing it as a `number` here would reintroduce
 * exactly the loss the driver is protecting against. The same reasoning made
 * `database_backup_runs.size_bytes` a `BigInt` column.
 *
 * Takes the name as a BIND PARAMETER — `pg_database_size(name text)` is a
 * function call, not DDL, so nothing here needs {@link quoteIdentifier}.
 */
export async function readDatabaseSizeBytes(
  client: AdminQueryClient,
  database: string
): Promise<bigint> {
  const result = await client.query('SELECT pg_database_size($1)::text AS size', [database]);
  const value = result.rows[0]?.size;

  return typeof value === 'string' ? BigInt(value) : 0n;
}

/**
 * The server's `data_directory`, or `null` when this role may not see it.
 *
 * ⚠ `null` IS THE ORDINARY ANSWER ON MANAGED POSTGRESQL, not an error.
 * `SHOW data_directory` requires superuser or `pg_read_all_settings`, and the
 * whole point of a managed platform is that you have neither. The disk gate
 * therefore treats an invisible data directory as a WARNING and never as a
 * block — refusing a restore because we could not read a path would be a false
 * negative on the platforms where restores are most routine.
 *
 * Swallowing the error is safe here because nothing runs in a transaction: a
 * failed `SHOW` leaves the session perfectly usable for the probes that follow.
 */
export async function readDataDirectory(client: AdminQueryClient): Promise<string | null> {
  try {
    const result = await client.query('SHOW data_directory');
    const value = result.rows[0]?.data_directory;

    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Whether a database of this name exists in the cluster. */
export async function databaseExists(
  client: AdminQueryClient,
  database: string
): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1', [
    database,
  ]);

  return result.rows.length > 0;
}

/**
 * How many DISTINCT client addresses currently hold a session on a database.
 *
 * A HEURISTIC for "is more than one application instance connected", and
 * nothing stronger. It cannot see a replica that is idle at this instant, it
 * counts a bastion host or a `psql` session as an instance, and every replica
 * behind one NAT collapses into one address. That is exactly why the gate
 * built on it is a WARNING and never a block: a heuristic this rough must not
 * be able to refuse a legitimate restore during an incident.
 *
 * `client_addr IS NULL` for connections over a Unix socket, which are on the
 * database host itself; they are excluded rather than counted as a mystery
 * address.
 */
export async function countDistinctClientAddresses(
  client: AdminQueryClient,
  database: string
): Promise<number> {
  const result = await client.query(
    'SELECT COUNT(DISTINCT client_addr)::text AS count FROM pg_stat_activity ' +
      'WHERE datname = $1 AND client_addr IS NOT NULL',
    [database]
  );
  const value = result.rows[0]?.count;
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : 0;
}

// -----------------------------------------------------------------------------
// Cluster mutations — #285 ONLY
// -----------------------------------------------------------------------------
//
// ⚠ NOTHING IN THE PRE-FLIGHT PATH MAY CALL ANYTHING BELOW THIS LINE. They are
// exported here, beside the reads, because they share the connection contract
// and the identifier rules — not because pre-flight has any use for them.
// `restore-preflight.service.spec.ts` spies on all four and asserts they are
// never called, for every outcome the service can produce.

/**
 * `CREATE DATABASE`, optionally from a template.
 *
 * ⚠ CANNOT RUN INSIDE A TRANSACTION BLOCK — Postgres refuses. That is one of
 * the reasons the swap in #285 is not "wrapped in a transaction" and its
 * atomicity comes from restoring into a scratch database and only renaming a
 * restore that exited 0.
 */
export async function createDatabase(
  client: AdminQueryClient,
  database: string,
  options: { template?: string } = {}
): Promise<void> {
  const template =
    options.template === undefined ? '' : ` TEMPLATE ${quoteIdentifier(options.template)}`;

  await client.query(`CREATE DATABASE ${quoteIdentifier(database)}${template}`);
}

/**
 * `DROP DATABASE IF EXISTS`.
 *
 * `IF EXISTS` because the caller that cleans up after a failed restore cannot
 * know how far the failure got, and a cleanup that throws because there was
 * nothing to clean up is a cleanup that leaves everything else undone.
 */
export async function dropDatabase(client: AdminQueryClient, database: string): Promise<void> {
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
}

/**
 * Terminates every other backend attached to a database.
 *
 * THE PRECONDITION FOR A RENAME. `ALTER DATABASE ... RENAME TO` fails while
 * any session is connected — including this application's own Prisma pool,
 * which is the reason the admin connection is outside it (module header,
 * reason 1).
 *
 * `pid <> pg_backend_pid()` is defensive rather than necessary: the admin
 * session is attached to the maintenance database, not this one. It stays
 * because a future caller that gets the attachment wrong would otherwise
 * terminate itself, and the symptom of that is a connection error with no
 * indication of what killed it.
 *
 * @returns how many backends were signalled.
 */
export async function terminateConnections(
  client: AdminQueryClient,
  database: string
): Promise<number> {
  const result = await client.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
      'WHERE datname = $1 AND pid <> pg_backend_pid()',
    [database]
  );

  return result.rows.length;
}

/**
 * `ALTER DATABASE <from> RENAME TO <to>`.
 *
 * The atomic half of the swap: it is a catalog update, so it either happens or
 * it does not, and it is why the restore is "replay somewhere else, then
 * rename" rather than "restore over the top of the live database".
 */
export async function renameDatabase(
  client: AdminQueryClient,
  from: string,
  to: string
): Promise<void> {
  await client.query(
    `ALTER DATABASE ${quoteIdentifier(from)} RENAME TO ${quoteIdentifier(to)}`
  );
}
