// =============================================================================
// This app's database restore registrations (issue #471, epic #467)
// =============================================================================
//
// Imported by `app-registrations/registrations.ts`, so it runs before the
// registries freeze when the application bootstraps.
//
// RESTORE GATE `<APP_SLUG>-extensions`
// -----------------------------------------------------------------------------
// This app's schema needs the `vector` (pgvector) and `pg_trgm` extensions: the
// embedding columns, the HNSW indexes and the trigram indexes cannot be restored
// onto a cluster that cannot install them. The gate id is `${APP_SLUG}-extensions`
// (the registry accepts lowercase letters, digits, `_` and `-` only, so the dotted
// `<slug>.extensions` the issue sketched is refused with INVALID_ID; the Doctor
// check of this app, `<slug>.db.extensions`, follows the same slug rule). The
// platform's built-in `extensions`
// gate compares the extensions the LIVE database already has with what the
// cluster offers; this gate states the application's own requirement outright, by
// name, so the restore dialog shows it even on a database that has lost one.
//
// The check is READ-ONLY: one `SELECT` on `pg_available_extensions` over a
// short-lived connection to the cluster's maintenance database. It never creates,
// drops or renames anything (the restore pre-flight invariant). The extensions
// themselves are created by the bootstrap superuser only
// (`infra/compose/postgres-init/20-kvox-extensions.sh`), never by the API's role.
//
// RESTORE CARRY-OVER: NONE
// -----------------------------------------------------------------------------
// A restore carries over the rows that must survive it (the platform carries the
// backup catalog, its self-links, the restore's own job row and the completion
// audit row). This app registers no extra carry: every table it owns, including
// `kvox_object_ownership` and `kvox_allowlist_reminders`, is inside the dump, and
// nothing it stores records a fact OUTSIDE the database (no table points at state
// that the archive does not also contain), so restoring an older archive leaves
// the application consistent with itself. If a table ever records an outside fact
// (a remote object that exists only because a row says so), add a
// `registerRestoreCarryOver` here with the reason.
// =============================================================================

import { Client } from 'pg';
import { APP_SLUG } from '@app/shared';
import { registerRestoreGate } from '@marinoscar/platform-api/db-backup';
import type { RestoreGateContext, RestoreGateOutcome } from '@marinoscar/platform-api/db-backup';

import { buildDatabaseUrl } from '../common/database-url';

/** The extensions this app's schema needs; both are created by the bootstrap superuser. */
export const KVOX_REQUIRED_EXTENSIONS = ['vector', 'pg_trgm'] as const;

/** Upper bound on the connection and the query. The pre-flight bounds the gate at 10 s as well. */
const PROBE_TIMEOUT_MS = 5_000;

/** Which of `names` the cluster cannot offer, read from `pg_available_extensions`. */
async function readUnavailableExtensions(ctx: RestoreGateContext): Promise<string[]> {
  // Coordinates come from the pre-flight's own admin connection (host, port, user,
  // the maintenance database it attached to); the password and the TLS mode come
  // from the same connection string the API itself uses, decoded by the URL parser.
  const url = new URL(buildDatabaseUrl());
  const sslMode = url.searchParams.get('sslmode');
  const ssl =
    sslMode === null || sslMode === 'disable' || sslMode === 'allow' || sslMode === 'prefer'
      ? false
      : { rejectUnauthorized: sslMode === 'verify-ca' || sslMode === 'verify-full' };
  const { connection } = ctx.facts;

  const client = new Client({
    host: connection.host,
    port: Number.parseInt(connection.port, 10),
    user: connection.user,
    password: decodeURIComponent(url.password),
    database: connection.database,
    ssl,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    query_timeout: PROBE_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>(
      'SELECT name FROM pg_available_extensions WHERE name = ANY($1::text[])',
      [[...KVOX_REQUIRED_EXTENSIONS]],
    );
    const offered = new Set(result.rows.map((row) => row.name));
    return KVOX_REQUIRED_EXTENSIONS.filter((name) => !offered.has(name));
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The gate's check, exported for its unit test. */
export async function checkKvoxExtensions(ctx: RestoreGateContext): Promise<RestoreGateOutcome> {
  const missing = await readUnavailableExtensions(ctx);
  if (missing.length === 0) {
    return {
      status: 'pass',
      message: `${KVOX_REQUIRED_EXTENSIONS.join(' and ')} are installable on the target cluster.`,
    };
  }
  return {
    status: 'fail',
    message: `The target cluster cannot offer ${missing.join(' and ')}, which this application's schema requires.`,
    action:
      `Install the PostgreSQL package that provides ${missing.join(' and ')} on the database server ` +
      '(for pgvector: the postgresql-<major>-pgvector package, or an image that bundles it), then retry. ' +
      'The restore creates nothing itself.',
  };
}

/** The gate's registry id. */
export const KVOX_EXTENSIONS_GATE_ID = `${APP_SLUG}-extensions`;

registerRestoreGate({
  id: KVOX_EXTENSIONS_GATE_ID,
  label: 'pgvector and pg_trgm are available on the target cluster',
  async check(ctx) {
    return checkKvoxExtensions(ctx);
  },
});
