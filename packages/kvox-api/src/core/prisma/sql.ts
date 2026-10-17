import type { KvoxSql } from '../../ports/index.js';

// =============================================================================
// Structural Prisma helpers (issue 5.4, epic 486)
// =============================================================================
//
// A slice builds raw SQL with `Prisma.sql`, `Prisma.raw` and `Prisma.join`
// without importing a generated client. They come from
// `@prisma/client-runtime-utils`, the package every Prisma 7 client builds its own
// `Sql` on, so a fragment built here is accepted by the host's `$queryRaw`.
//
// THE PEER IS OPTIONAL AND LOADED LAZILY. A host that never builds raw SQL does
// not install it, and merely importing this slice must not fail. The module name
// is held in a variable so the load happens on first use, with a clear message
// when the package is missing.
// =============================================================================

const RUNTIME_UTILS = '@prisma/client-runtime-utils';

interface RuntimeUtils {
  sql(strings: readonly string[], ...values: readonly unknown[]): KvoxSql;
  raw(value: string): KvoxSql;
  join(values: readonly unknown[], separator?: string, prefix?: string, suffix?: string): KvoxSql;
  empty: KvoxSql;
  DbNull: unknown;
}

let loaded: RuntimeUtils | undefined;

function runtimeUtils(): RuntimeUtils {
  if (loaded === undefined) {
    try {
      loaded = require(RUNTIME_UTILS) as RuntimeUtils;
    } catch (error) {
      throw new Error(
        `Building raw SQL needs the optional peer dependency ${RUNTIME_UTILS}; install it next to @prisma/client. (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  return loaded;
}

/**
 * The raw-SQL helpers, shaped like the `Prisma` namespace of a generated client.
 *
 * @example
 * ```ts
 * const rows = await prisma.$queryRaw(Prisma.sql`SELECT id FROM notes WHERE owner_id = ${ownerId}`);
 * ```
 *
 * @stability experimental
 */
export const Prisma = Object.freeze({
  /**
   * A parameterised SQL template; every `${value}` becomes a bound parameter.
   *
   * @param strings - the template pieces.
   * @param values - the bound values.
   */
  sql: (strings: TemplateStringsArray, ...values: unknown[]): KvoxSql =>
    runtimeUtils().sql(strings, ...values),

  /**
   * A raw SQL fragment inserted verbatim. Never pass user input.
   *
   * @param value - trusted SQL text.
   */
  raw: (value: string): KvoxSql => runtimeUtils().raw(value),

  /**
   * Joins values into a comma-separated (or custom-separated) fragment.
   *
   * @param values - the values or fragments.
   * @param separator - what goes between them; a comma by default.
   * @param prefix - what goes before the first.
   * @param suffix - what goes after the last.
   */
  join: (
    values: readonly unknown[],
    separator?: string,
    prefix?: string,
    suffix?: string,
  ): KvoxSql => runtimeUtils().join(values, separator, prefix, suffix),

  /** An empty fragment. */
  get empty(): KvoxSql {
    return runtimeUtils().empty;
  },

  /**
   * The value that writes SQL `NULL` into a nullable `jsonb` column (a bare `null` would be
   * the JSON value `null`). The very object the generated client's own `Prisma.DbNull` is.
   */
  get DbNull(): unknown {
    return runtimeUtils().DbNull;
  },
});
