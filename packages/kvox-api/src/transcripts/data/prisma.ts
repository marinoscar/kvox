import { Prisma } from '../../core/index.js';

// =============================================================================
// The structural stand-in for the generated client's `Prisma` namespace
// (issue #493, epic #491)
// =============================================================================
//
// The transcripts slice never imports the generated client. The few pieces of the
// generated `Prisma` namespace it used are restated here:
//
//   • `Prisma.sql`, `Prisma.raw`, `Prisma.join`: the VALUES, re-exported from
//     `core` (they come from `@prisma/client-runtime-utils`, the package every
//     Prisma 7 client builds its own `Sql` on).
//   • `JsonValue` and `InputJsonValue`: the TYPES of a JSON column read and
//     written.
//   • `isUniqueViolation`: what `error instanceof Prisma.PrismaClientKnownRequestError
//     && error.code === 'P2002'` meant, without the class.
// =============================================================================

export { Prisma };

/**
 * A JSON value read from a `jsonb` column.
 *
 * @stability experimental
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

/**
 * A JSON value written to a `jsonb` column.
 *
 * @stability experimental
 */
export type InputJsonValue = JsonValue | { readonly [key: string]: InputJsonValue | undefined };

/**
 * The transaction client an interactive transaction hands its callback: the
 * delegates and raw methods of {@link KvoxTranscriptsDb}.
 *
 * @stability experimental
 */
export type { KvoxTranscriptsTx as TransactionClient } from './transcripts-db.js';

/** The Prisma error code of a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Whether `error` is the database refusing a row that repeats a unique value:
 * Prisma's `P2002`. A duck-typed check, so the slice needs no generated client
 * to recognise it.
 *
 * @param error - whatever a statement threw.
 * @returns true for a unique violation.
 * @stability experimental
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
