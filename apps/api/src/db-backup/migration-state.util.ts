import type { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// "Which schema is this?" — asked of the live database, and of an archive
// (issue #284, epic #254)
// =============================================================================
//
// One question, two readers, and they MUST agree on the rule.
//
//   - #281's backup engine records the newest applied migration on every run
//     row (`database_backup_runs.migration_name`). That is what an archive
//     CONTAINS.
//   - #284's restore pre-flight reads the newest applied migration from the
//     database that is running right now. That is what the CODE expects.
//
// The schema gate compares those two strings, and the comparison is only
// meaningful if both sides were computed the same way. Two copies of the query
// — one with `rolled_back_at IS NULL`, one without; one ordering by
// `finished_at`, one by `started_at` — would produce a gate that blocks
// restores of perfectly compatible archives, or worse, passes an incompatible
// one. So there is one query, here, and both callers use it.
// =============================================================================

/** The narrowest slice of Prisma this module needs. Keeps its callers' tests free of a database. */
type MigrationQueryClient = Pick<PrismaService, '$queryRaw'>;

/**
 * The newest applied migration in the connected database, or `null`.
 *
 * `rolled_back_at IS NULL` because a rolled-back migration is one whose schema
 * change is NOT in this database, and naming it would be worse than naming
 * nothing. `finished_at IS NOT NULL` for the same reason applied to a
 * migration that is still running or failed part way.
 *
 * BEST-EFFORT: every failure is `null`, never a throw. Both callers treat an
 * unreadable value as "cannot tell" — the backup still runs (a run that could
 * not read its provenance is still a valid archive) and the restore gate
 * degrades to a warning rather than blocking. A missing `_prisma_migrations`
 * table, or a role without permission to read it, must not be able to stop
 * either operation.
 */
export async function readLatestAppliedMigration(
  prisma: MigrationQueryClient
): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: unknown }>>`
        SELECT migration_name
        FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY finished_at DESC
        LIMIT 1
      `;
    const value = rows[0]?.migration_name;

    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** How an archive's schema relates to the live one. */
export type MigrationComparison =
  /** Same migration. The archive restores into exactly the schema the code expects. */
  | 'match'
  /** The archive predates the live schema: restoring it loses later migrations. */
  | 'archive_older'
  /** The archive is ahead of the live schema: the running code has not seen it. */
  | 'archive_newer'
  /** One side could not be read. A warning, never a block. */
  | 'unknown';

/**
 * Compares an archive's recorded migration against the live one.
 *
 * ⚠ LEXICOGRAPHIC, AND THAT IS CORRECT HERE. Prisma migration directory names
 * begin with a zero-padded `YYYYMMDDHHMMSS`, so string order is chronological
 * order for every name Prisma generates. It is not a general-purpose version
 * compare and must not be reused as one — a hand-renamed migration breaks it,
 * which is a good reason not to hand-rename migrations.
 *
 * BOTH DIRECTIONS ARE A MISMATCH, which is the part people get wrong:
 *
 *   - `archive_older` is the obvious one. The restored database is missing
 *     columns the running code selects, and the first request after the swap
 *     fails.
 *   - `archive_newer` is the dangerous one, because it LOOKS harmless. The
 *     archive has columns the code does not know about — which is fine until
 *     the deployment that produced it also removed something, renamed
 *     something, or changed a constraint the old code violates. Worse, Prisma
 *     will consider the schema up to date and apply nothing, so nobody is ever
 *     told. It is reported and blocked for the same reason: a restore across a
 *     schema boundary is a decision, and it has to be made by a human.
 */
export function compareMigrationNames(
  archiveMigration: string | null,
  liveMigration: string | null
): MigrationComparison {
  if (archiveMigration === null || liveMigration === null) return 'unknown';
  if (archiveMigration === liveMigration) return 'match';

  return archiveMigration < liveMigration ? 'archive_older' : 'archive_newer';
}
