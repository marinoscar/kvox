// =============================================================================
// `example.checksum` — the result a node posts back (issue #269, epic #254)
// =============================================================================
//
// THE TRUST BOUNDARY FOR THE TEMPLATE'S ONE NODE-ELIGIBLE JOB TYPE. Every
// field below arrives from a machine this deployment may not own, over HTTP,
// from a process whose build may be older than this server's. Nothing here is
// a formality: `NodesService.submitResult` parses against this schema and
// `ExampleChecksumHandler.persistNodeResult` writes whatever survives, so a
// field this schema accepts is a field that lands in the database.
//
// -----------------------------------------------------------------------------
// WHY `sha256` IS A PATTERN AND NOT JUST `z.string()`
// -----------------------------------------------------------------------------
//
// Because a checksum's whole value is that two people can compare it, and a
// string is comparable only if everybody agrees on its spelling. Without the
// pattern this schema accepts `"E3B0C442…"` (upper case), `"sha256:e3b0…"`
// (prefixed), `"e3b0…"` truncated to 32 characters, and `""`. All four store
// fine and all four silently break the one operation anybody performs on a
// checksum — comparing it to another one. A node built by a fork, in another
// language, with a hash library that upper-cases by default, would produce
// rows that never match the server's own, and nothing would report an error.
//
// Sixty-four lower-case hex characters, exactly, is the canonical spelling of
// a SHA-256 digest. Enforcing it here means the node is told at submission
// time — with the issue list in `details` — rather than a person discovering
// it months later in a comparison that never matches.
//
// -----------------------------------------------------------------------------
// WHY `bytes` IS A `number` AND NOT A STRING-ENCODED `bigint`
// -----------------------------------------------------------------------------
//
// `StorageObject.size` is a `BigInt` column, so the temptation is symmetry.
// Rejected: this value arrives as JSON, where there are no bigints — it would
// have to be a decimal string, which then needs its own format validation,
// its own parse on the way in, and its own conversion at every read. All to
// carry a value that cannot exceed `Number.MAX_SAFE_INTEGER` (9 PB) in any
// object a worker node streamed and hashed end to end.
//
// So it is a bounded integer, and the bound is stated rather than assumed:
// `.max(Number.MAX_SAFE_INTEGER)` refuses a value that would have lost
// precision before it ever reached us, instead of storing a number that is
// quietly wrong in its last digits.
// =============================================================================

import { z } from 'zod';

/** Canonical spelling of a SHA-256 digest: 64 lower-case hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * What a node reports after streaming a storage object and hashing it.
 *
 * DELIBERATELY TWO FIELDS. The pair is the smallest thing that is still a
 * real, checkable claim: the digest identifies the bytes, and the count is an
 * independent fact about the same stream that a corrupted or truncated read
 * usually gets wrong. A digest alone would be unfalsifiable — any 64 hex
 * characters look like a valid answer.
 */
export const exampleChecksumResultSchema = z.object({
  /** Lower-case hex SHA-256 of the object's bytes, exactly as streamed. */
  sha256: z
    .string()
    .regex(SHA256_HEX, 'sha256 must be 64 lower-case hexadecimal characters'),

  /**
   * How many bytes were hashed.
   *
   * This is what the node ACTUALLY READ, which is not necessarily
   * `StorageObject.size` — that column is `0` for a simple upload until
   * post-processing fills it in (see `ObjectsService.simpleUpload`). Storing
   * the observed count is therefore worth more than re-deriving it, and the
   * handler compares the two rather than trusting either blindly.
   */
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/** The parsed, trusted result — the only shape `persistNodeResult` may write. */
export type ExampleChecksumResult = z.infer<typeof exampleChecksumResultSchema>;
