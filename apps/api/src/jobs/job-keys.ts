// =============================================================================
// Job dedup key format (issue #255, epic #254)
// =============================================================================
//
// THE SINGLE DEFINITION of how a job's `dedup_key` column is built. The
// enqueue path (arriving with the claim query in #260) and the partial unique
// index `jobs_active_dedup_uniq_idx` (see the block comment above the `Job`
// model in prisma/schema.prisma, and the hand-written index in
// prisma/migrations/20260906120000_add_jobs/migration.sql) both point back to
// this function rather than each re-deriving the format — the index enforces
// uniqueness on whatever string ends up in the column, but it has no opinion
// on how that string is built, and there must be exactly one opinion or two
// call sites can produce different keys for what should be the same job.
//
// -----------------------------------------------------------------------------
// Format: `${type}:${subjectType ?? ''}:${subjectId ?? ''}`
// -----------------------------------------------------------------------------
// Deliberately the simplest thing that is still collision-resistant for this
// table's real shape:
//
//   - `type` is a small, code-owned set of handler keys (never user input),
//     so it never itself contains a `:` in practice — but even if it did,
//     the worst case is two DIFFERENT types producing the same combined
//     string, which is a false-positive dedup (two logically different jobs
//     briefly treated as one), never a false negative (missing a real
//     duplicate). That failure mode is acceptable for a dedup key whose job
//     is to collapse retries/re-triggers, not to be a cryptographic
//     identity.
//   - The two `?? ''` coalesces are what let a single format cover all three
//     subject shapes this table supports: a real (subjectType, subjectId)
//     pair, a global/system job with both null, and — in principle — one
//     side set without the other (not currently produced by any caller, but
//     the format does not break if it happens).
//
// This is intentionally NOT a hash. A hash would obscure the key in logs and
// in `SELECT * FROM jobs WHERE dedup_key = ...` debugging for no benefit: the
// three inputs are already short, non-secret, code- or database-controlled
// strings, and the partial unique index compares the plain text anyway.
// =============================================================================

/**
 * Builds the value that belongs in `Job.dedupKey` for a job of the given
 * `type` against the given optional subject. Two calls with the same three
 * inputs always produce the same string; that string is what
 * `jobs_active_dedup_uniq_idx` enforces uniqueness over among jobs whose
 * `status` is `pending` or `running`.
 *
 * `subjectType` / `subjectId` follow `Job`'s own nullability: pass both as
 * `null` (or omit them) for a global/system job with no subject.
 */
export function buildDedupKey(
  type: string,
  subjectType?: string | null,
  subjectId?: string | null,
): string {
  return `${type}:${subjectType ?? ''}:${subjectId ?? ''}`;
}
