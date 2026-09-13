// =============================================================================
// The one place a PostgreSQL connection string is built (issue #172)
// =============================================================================
//
// DATABASE_URL is not a primary input in this codebase — it is derived from the
// individual POSTGRES_* variables. That derivation used to exist in three
// places that disagreed with each other:
//
//   - scripts/prisma-env.js  encoded the password, ignored DATABASE_URL
//   - src/prisma/prisma.service.ts  encoded the password, honoured DATABASE_URL
//   - src/config/configuration.ts  did NEITHER
//
// The consequence was specific and expensive. `configuration.ts` ASSIGNS its
// result to process.env.DATABASE_URL, and `prisma.service.ts` returns
// process.env.DATABASE_URL when it is set — so the unencoded string overwrote
// the encoded one, and the careful encoding in the service was defeated at
// runtime by the module that ran first. Migrations, which go through
// prisma-env.js, kept working. That is the worst shape a bug can have: the
// schema applies cleanly, and the application then cannot connect.
//
// A password containing `@` is the clearest case — it introduces a second `@`
// into the authority section and the host is parsed as whatever follows the
// last one — but `: / # ? %` and a space are all equally capable of it. This
// matters more than it looks: `openssl rand -base64 32`, which the deployment
// wizard offers, routinely produces `/` and `+`.
//
// SCRIPTS/PRISMA-ENV.JS NECESSARILY KEEPS ITS OWN COPY. It is CommonJS, runs
// under plain `node` before anything is compiled, and tsconfig.build.json sets
// rootDir to ./src, so it cannot import this module. The two are held together
// by src/common/database-url.spec.ts, which requires that file directly and
// asserts both produce identical output over a table of awkward inputs. If you
// change the rules here, that test fails until you change them there too.
// =============================================================================

/** The subset of the environment this builder reads. */
export interface DatabaseEnv {
  DATABASE_URL?: string | undefined;
  POSTGRES_HOST?: string | undefined;
  POSTGRES_PORT?: string | undefined;
  POSTGRES_USER?: string | undefined;
  POSTGRES_PASSWORD?: string | undefined;
  POSTGRES_DB?: string | undefined;
  POSTGRES_SSL?: string | undefined;
}

/**
 * Builds the PostgreSQL connection string.
 *
 * Two rules, both of which every caller now shares:
 *
 *  1. An already-set DATABASE_URL WINS and is returned untouched. It is the
 *     escape hatch for a connection this formula cannot express — a socket
 *     path, a pgbouncer URL, extra query parameters — and re-deriving over the
 *     top of it would silently discard the operator's intent.
 *  2. The user and the password are BOTH percent-encoded. The password is the
 *     one that bites in practice, but a username can contain `@` too, and
 *     encoding only one of them is how this class of bug comes back.
 */
export function buildDatabaseUrl(env: DatabaseEnv = process.env): string {
  const existing = env.DATABASE_URL;
  if (existing !== undefined && existing !== '') {
    return existing;
  }

  const host = env.POSTGRES_HOST || 'localhost';
  const port = env.POSTGRES_PORT || '5432';
  const user = env.POSTGRES_USER || 'postgres';
  const password = env.POSTGRES_PASSWORD || 'postgres';
  const database = env.POSTGRES_DB || 'appdb';

  // Exact string comparison, deliberately: 'TRUE', '1' and 'yes' are NOT true
  // here, because that is the rule the other two builders already used and
  // widening it would change the meaning of existing .env files.
  const ssl = env.POSTGRES_SSL === 'true';
  const sslParam = ssl ? '?sslmode=require' : '';

  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);

  return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${database}${sslParam}`;
}
