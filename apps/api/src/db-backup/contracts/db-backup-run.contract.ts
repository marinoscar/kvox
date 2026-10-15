// =============================================================================
// `db.backup.run` — the result a node posts back (issue #352, epic #345)
// =============================================================================
//
// THE TRUST BOUNDARY FOR THE FIRST JOB TYPE THAT LEAVES THE API SERVER WITH A
// CREDENTIAL. Every field below arrives from a machine this deployment may not
// own, over HTTP, from a `pg_dump` this process never saw run. Nothing here is
// a formality: `NodesService.submitResult` parses against this schema and
// `DatabaseBackupRunHandler.persistNodeResult` writes whatever survives onto a
// `database_backup_runs` row — the row a restore later reads to find the
// archive.
//
// -----------------------------------------------------------------------------
// ⚠ `bytes` IS A DECIMAL STRING, AND THAT IS LOAD-BEARING
// -----------------------------------------------------------------------------
//
// `database_backup_runs.bytes_written` and `.size_bytes` are `BigInt` columns
// for a stated reason (see the model's own comment): a PostgreSQL dump past
// 2 GiB is ordinary. JSON has no integers — it has doubles — so a size sent as
// a JSON NUMBER is exact only below 2^53 and silently rounds above it. The
// corruption would therefore land on the LARGEST backups: precisely the
// deployments node offload exists for, and precisely the rows an operator is
// least able to sanity-check by eye.
//
// So the wire type is a decimal string, validated by shape (`^\d{1,20}$` — 20
// digits covers the whole unsigned 64-bit range with room to spare) and
// converted with `BigInt()` exactly once, in the handler. This is the same
// direction `db-backup-run.dto.ts` already travels on the way OUT (it
// stringifies both `BigInt` columns because `JSON.stringify` refuses them);
// this is that rule applied on the way IN, and the two together mean the byte
// count that reaches the database is the byte count the dumping process
// counted, digit for digit.
//
// CONTRAST `example-checksum.contract.ts`, which deliberately makes its
// `bytes` a plain bounded `number`. That is not an inconsistency: it hashes a
// stored object whose size cannot exceed `Number.MAX_SAFE_INTEGER` in any
// realistic deployment, and it writes to a JSONB blob rather than to a
// `BigInt` column. The two contracts differ because the two destinations
// differ — copy whichever one matches the column you are writing.
//
// -----------------------------------------------------------------------------
// WHAT IS *NOT* IN THIS CONTRACT, AND WHY
// -----------------------------------------------------------------------------
//
// NO `verified` FLAG, and no field a node could set to assert that its own
// archive is good. §6 of `docs/specs/database-backup.md` already settled what
// verification means here — "read back what the BUCKET holds and parse its
// table of contents" — and `persistNodeResult` does exactly that, server-side,
// before it writes `verified_at`. A node vouching for its own upload is not
// evidence; it is the machine with the least reason to be trusted attesting to
// the one fact the whole subsystem rests on.
//
// `sha256` is therefore recorded as THE NODE'S CLAIM about the bytes it
// streamed, not as proof. It is worth having — it is what an operator compares
// against a `sha256sum` of a downloaded archive when a restore looks wrong —
// but it is not what makes the run `completed`.
//
// NO `bucket`, NO `storageProvider`, NO `format`. All three are the SERVER's
// choice, already on the run row, and a node repeating them would create a
// second place for them to disagree. `storageKey` is in the contract for the
// opposite reason: it is not the node telling us where it wrote, it is the
// node NAMING BACK the key the server handed it (`deriveOutputKey`), so the
// handler can refuse a result that is about some other key.
// =============================================================================

import { z } from 'zod';

/** Canonical spelling of a SHA-256 digest: 64 lower-case hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A non-negative integer as a decimal string, up to 20 digits.
 *
 * Anchored, digits only, no sign, no exponent, no leading `+`: `BigInt()`
 * accepts a good deal more than this (whitespace, `0x` forms, `-0`) and every
 * extra spelling it accepts is a value two implementations could round-trip
 * differently. 20 digits is the width of `18446744073709551615`, so nothing a
 * 64-bit counter can produce is refused, and nothing wider can be smuggled in.
 */
const DECIMAL_UINT = /^\d{1,20}$/;

/**
 * What a worker node reports after taking a `pg_dump` and uploading it.
 *
 * The eight fields are three different KINDS of fact and it is worth keeping
 * them apart when reading this:
 *
 *   - `storageKey` — the server's own key, echoed back so a mismatch can be
 *     refused. Not information; a checksum on the conversation.
 *   - `bytes` / `sha256` — what the node observed about the archive it wrote.
 *   - `pgDumpVersion` / `dbVersion` / `migrationName` — provenance the node is
 *     the ONLY party that can report, because it is the only party that ran
 *     the client and held the connection.
 *   - `startedAt` / `finishedAt` — the dump's own window on the node's clock.
 */
export const dbBackupRunResultSchema = z.object({
  /**
   * The key the SERVER handed this job through `deriveOutputKey`, repeated.
   *
   * ⚠ THE HANDLER REFUSES ANYTHING ELSE. A node may only report the key it was
   * given: it does not choose where a backup lands (§15 and
   * `job-handler.interface.ts`), and a result naming a different key is either
   * a confused executor or an attempt to point this deployment's restore path
   * at bytes of somebody else's choosing. Both are refusals, not corrections.
   */
  storageKey: z.string().min(1).max(1024),

  /**
   * The archive's size in bytes, as a DECIMAL STRING. See the file header —
   * this is the field that must not be a JSON number.
   */
  bytes: z
    .string()
    .regex(DECIMAL_UINT, 'bytes must be a decimal string of up to 20 digits'),

  /**
   * Lower-case hex SHA-256 of the archive as the node streamed it.
   *
   * Recorded as the node's claim (see the file header). The pattern is
   * enforced for the reason `example-checksum.contract.ts` spells out at
   * length: a digest is only useful if everybody spells it the same way, and
   * `"E3B0…"`, `"sha256:e3b0…"` and a truncated digest all store perfectly
   * well while breaking the single operation anybody performs on one.
   */
  sha256: z
    .string()
    .regex(SHA256_HEX, 'sha256 must be 64 lower-case hexadecimal characters'),

  /**
   * The `pg_dump --version` banner on the machine that produced the archive.
   *
   * NULLABLE, because an unreadable version string must never be the reason a
   * backup is refused — the same "warn and proceed" rule `pg-version.util.ts`
   * states for the server's own client check. It is worth carrying because on
   * the node path it is the ONLY record of which client wrote the archive, and
   * a `pg_restore` older than the `pg_dump` that produced a file cannot read
   * it. The server path records its own image's client in the same column, so
   * the row means the same thing whichever executor produced it.
   */
  pgDumpVersion: z.string().max(128).nullable(),

  /** The PostgreSQL server version the node dumped FROM. Same nullability rule. */
  dbVersion: z.string().max(128).nullable(),

  /**
   * The newest applied `_prisma_migrations` row the node could see.
   *
   * The most important of the three for a restore: it says which SCHEMA the
   * archive contains. The node can read it because its minted role has
   * `SELECT` (see `pg-job-role.broker.ts`); it is nullable because a role
   * without that visibility, or a database mid-migration, must still be able
   * to produce a backup.
   */
  migrationName: z.string().max(255).nullable(),

  /**
   * When the dump started and finished, on the NODE's clock.
   *
   * ⚠ NOT WRITTEN TO `started_at`/`finished_at`. Those two columns are the
   * SERVER's record of the run's lifetime and stay on the server's clock — see
   * `DatabaseBackupRunnerService.completeNodeRun`, which uses these two to log
   * the executor-reported dump window and to warn when a node's clock is far
   * enough out that its future lease arithmetic is worth looking at. They are
   * in the contract because the node is the only party that knows how long the
   * dump itself took: the server sees the claim and the settle, and everything
   * interesting happens in between.
   */
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});

/** The parsed, trusted result — the only shape `persistNodeResult` may write. */
export type DbBackupRunResult = z.infer<typeof dbBackupRunResultSchema>;
