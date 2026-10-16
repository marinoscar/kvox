// =============================================================================
// KVOX_PRISMA: the database port (issue 5.4, epic 486)
// =============================================================================
//
// The host's Prisma client, seen structurally. A slice never imports a generated
// client; it narrows this one with the delegates it uses (`Pick`-style row types)
// and builds raw SQL with the `Prisma` helper of `@marinoscar/kvox-api/core`.
// Both hosts run PostgreSQL, so the slices keep their Postgres SQL (`tsvector`,
// `pg_trgm`, `vector`).
// =============================================================================

/**
 * Injection token of the host's Prisma client. The description string is
 * permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_PRISMA = Symbol.for('@marinoscar/kvox/KVOX_PRISMA');

/**
 * A SQL fragment built by the `Prisma.sql` helper. Structural: any
 * `sql-template-tag` value (the one Prisma builds) satisfies it.
 *
 * @stability experimental
 */
export interface KvoxSql {
  /** The static pieces between the values. */
  readonly strings: ReadonlyArray<string>;
  /** The bound values, in order. */
  readonly values: ReadonlyArray<unknown>;
}

/**
 * The part of a Prisma client every slice may rely on. Narrow it further with
 * the model delegates a slice uses.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxPrismaClientLike {
  /**
   * Runs a raw query and returns its rows.
   *
   * @param query - a template literal or a {@link KvoxSql}.
   * @param values - the bound values of a template literal.
   */
  $queryRaw<T = unknown>(query: TemplateStringsArray | KvoxSql, ...values: unknown[]): Promise<T>;

  /**
   * Runs a raw statement and returns the affected row count.
   *
   * @param query - a template literal or a {@link KvoxSql}.
   * @param values - the bound values of a template literal.
   */
  $executeRaw(query: TemplateStringsArray | KvoxSql, ...values: unknown[]): Promise<number>;

  /**
   * Runs a callback in a transaction.
   *
   * @param fn - receives the transaction client.
   * @param options - an optional timeout, in milliseconds.
   */
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}
