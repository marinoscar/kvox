
import { Prisma } from '../../core/index.js';

// =============================================================================
// The structural stand-in for the generated client's `Prisma` namespace
// (issue #496, epic #491)
// =============================================================================
//
// The graph slice never imports the generated client. The few pieces of the
// generated `Prisma` namespace it used are restated here: the raw-SQL helpers
// (re-exported from `core`), the JSON value types, and the check for a unique
// violation (Prisma's `P2002`) without the error class.
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
 * A JSON object written to a `jsonb` column.
 *
 * @stability experimental
 */
export type InputJsonObject = { readonly [key: string]: InputJsonValue | undefined };

/**
 * The shape of a `P2002` error as far as the slice reads it.
 *
 * @stability experimental
 */
export interface UniqueViolation {
  /** Always `P2002`. */
  code: 'P2002';
  /** The driver's detail: `target` names the constraint (the field names, or the index name). */
  meta?: Record<string, unknown>;
}

/**
 * Whether `error` is the database refusing a row that repeats a unique value:
 * Prisma's `P2002`. A duck-typed check, so the slice needs no generated client
 * to recognise it.
 *
 * @param error - whatever a statement threw.
 * @returns true for a unique violation.
 * @stability experimental
 */
export function isUniqueViolation(error: unknown): error is UniqueViolation {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
