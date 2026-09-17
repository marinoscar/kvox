import {
  databaseSettings,
  runPsql,
  type DatabaseSettings,
} from './checks/database.js';
import type { CheckContext, CompletedCheck } from './checks/types.js';

// =============================================================================
// Creating the database, once and only when asked  (issue #238)
// =============================================================================
//
// WHY THIS IS NOT A CHECK, AND MUST NEVER BECOME ONE
//
// `checks/types.ts` rule 4 is binding: checks are READ-ONLY. `doctor` never
// installs, never writes, never starts anything, and that is the entire
// reason it is safe to point at a production server at any hour. A
// `database-exists` check that quietly created the database it could not find
// would destroy that guarantee for every other check in the registry, because
// an operator can no longer reason about the command as a whole - only about
// which checks they happen to remember are harmless.
//
// So the check keeps reporting, unchanged, and this module is a SEPARATE
// action the install wizard offers afterwards, against an explicit yes. The
// operator sees the failure first and decides second. `doctor` does not call
// this file at all.
//
// WHY ONLY `CREATE DATABASE`
//
// `docs/specs/vps-deploy.md` puts external PostgreSQL in the operator's hands:
// this deployment validates it rather than managing it. That stays true of
// roles, extensions, tuning, backups and anything destructive. The one
// exception is this statement, for a specific reason: by the time it is
// offered, the credentials have ALREADY authenticated against the cluster
// (`database-credentials` passed against the `postgres` database), so the
// operator is not being asked to grant anything new - they are being asked
// whether to spend one round trip on a statement they were otherwise told to
// go and type by hand, in another terminal, before re-entering the whole step.
//
// There is no DROP here and there never will be. Creating an empty database
// is recoverable by deleting it; the inverse is not.
//
// WHY THE NAME IS VALIDATED RATHER THAN ONLY QUOTED
//
// A database name arrives from POSTGRES_DB, which is operator input, and it
// is the one value here that has to be interpolated into SQL - `CREATE
// DATABASE` takes no parameters, so a bind is not available. Quoting alone
// would be correct, and correct-looking quoting is exactly the kind of thing
// that decays when someone later builds a second statement beside it. So the
// name must ALSO look like an ordinary identifier before anything is built,
// and a name that does not is refused with the `createdb` remedy the check
// already prints rather than being cleverly escaped.
// =============================================================================

/** The check whose failure this action answers. */
export const DATABASE_EXISTS_CHECK_ID = 'database-exists';

/** PostgreSQL's `invalid_catalog_name`, plus the English it comes wrapped in. */
const MISSING_DATABASE_PATTERN = /3D000|database ".*" does not exist/i;

/** PostgreSQL's own limit; a longer name is silently truncated, not rejected. */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * An ordinary, unquoted-safe identifier: a letter or underscore, then letters,
 * digits, underscores or dollar signs. Deliberately narrower than what
 * PostgreSQL would accept inside quotes — see the header.
 */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export interface DatabaseCreationTarget {
  settings: DatabaseSettings;
  /** One line naming what would be created and where, for the confirmation. */
  description: string;
}

/**
 * The database this run could create, or `undefined`.
 *
 * Answers `undefined` unless `database-exists` failed *specifically* because
 * the database is absent. Any other failure — a typo'd POSTGRES_DB that
 * resolved to something the user cannot see, a server that dropped the
 * connection mid-query — is not a thing to fix by creating a database, and
 * offering to would be the wrong remedy stated confidently.
 */
export function creatableDatabase(
  results: readonly CompletedCheck[],
  env: ReadonlyMap<string, string> | undefined,
): DatabaseCreationTarget | undefined {
  const failure = results.find(
    (result) => result.id === DATABASE_EXISTS_CHECK_ID && result.status === 'fail',
  );
  if (failure === undefined) return undefined;
  if (!MISSING_DATABASE_PATTERN.test(failure.detail)) return undefined;

  const settings = databaseSettings(env);
  if (settings === undefined) return undefined;
  if (settings.database === '') return undefined;

  return {
    settings,
    description: `${settings.database} on ${settings.host}:${settings.port} as ${settings.user}`,
  };
}

/** Why a name cannot be used, or `undefined` when it can. */
export function databaseNameProblem(name: string): string | undefined {
  if (name === '') return 'POSTGRES_DB is empty';
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    return `PostgreSQL truncates names over ${MAX_IDENTIFIER_LENGTH} characters, so this one would not be the database you asked for`;
  }
  if (!PLAIN_IDENTIFIER.test(name)) {
    return 'it is not a plain identifier (a letter or underscore, then letters, digits, underscores or $)';
  }
  return undefined;
}

/** `"name"`, with any embedded quote doubled. Belt and braces over the above. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export type DatabaseCreationOutcome =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly detail: string; readonly remedy: string };

/**
 * Creates the database, against the `postgres` maintenance database.
 *
 * `postgres` rather than the target: the target is precisely what does not
 * exist yet, and `CREATE DATABASE` cannot run from inside it. This is the same
 * database `database-credentials` already authenticated against, so no new
 * reachability assumption is introduced by connecting there.
 */
export async function createDatabase(
  context: CheckContext,
  settings: DatabaseSettings,
): Promise<DatabaseCreationOutcome> {
  const manual = `createdb -h ${settings.host} -p ${settings.port} -U ${settings.user} ${settings.database}`;

  const problem = databaseNameProblem(settings.database);
  if (problem !== undefined) {
    return {
      ok: false,
      detail: `cannot create "${settings.database}": ${problem}`,
      remedy: `Change POSTGRES_DB, or create it yourself: ${manual}`,
    };
  }

  const result = await runPsql(
    context,
    settings,
    'postgres',
    `CREATE DATABASE ${quoteIdentifier(settings.database)}`,
  );

  if (result.ok) {
    return { ok: true, detail: `created ${settings.database}` };
  }

  // Someone else won the race, or it was there all along and the check saw a
  // transient error. Either way the database now exists, which is what was
  // asked for — reporting a failure here would send the operator to fix
  // something that is already right.
  if (/42P04|already exists/i.test(result.stderr)) {
    return { ok: true, detail: `${settings.database} already exists` };
  }

  if (/permission denied|must be (a )?(superuser|member)|42501/i.test(result.stderr)) {
    return {
      ok: false,
      detail: `${settings.user} may not create databases on this server`,
      remedy: `Grant it (ALTER ROLE ${settings.user} CREATEDB;) or have an administrator run: ${manual}`,
    };
  }

  return {
    ok: false,
    detail: firstLine(result.stderr),
    remedy: `Create it yourself: ${manual}`,
  };
}

function firstLine(value: string): string {
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.slice(0, 200);
  }
  return 'no output';
}
