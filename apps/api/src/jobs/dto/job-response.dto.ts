// =============================================================================
// One `jobs` row, as the admin API publishes it (issue #264, epic #254)
// =============================================================================
//
// This schema describes the JSON an operator receives, NOT the Prisma model.
// The two differ in three deliberate ways, and each one is a decision rather
// than an oversight:
//
//   1. TIMESTAMPS ARE ISO STRINGS, not `Date`s. `JobAdminService` hands the
//      controller the Prisma row and the serializer turns every `Date` into an
//      ISO-8601 string on the way out. Documenting `z.date()` here would
//      publish a type no HTTP client can ever receive. This mirrors
//      `allowlist/dto/allowlist-response.dto.ts`, which describes its own
//      response the same way and for the same reason.
//
//   2. `typeLabel` IS ADDED. `type` is a machine key (`'example.echo'`) and is
//      what every filter matches on, so it must stay on the wire verbatim. The
//      label is resolved server-side through `jobTypeLabel()` rather than
//      shipped as a map the client joins against, because that helper's whole
//      contract is "an unmapped type renders as itself, never blank" (see
//      `job-type-labels.ts`) — and a client doing its own lookup is a client
//      that can forget the `?? type` fallback and render an empty cell for
//      exactly the job types a fork cares most about.
//
//   3. `payload` IS OMITTED, and this is the one worth arguing. A job's
//      payload is arbitrary application JSONB with no size bound anywhere in
//      the schema; a hundred rows of it is a response whose size is set by
//      whatever a fork's largest handler input happens to be, on an endpoint
//      that a dashboard polls. The fields an operator actually triages with —
//      `type`, `subjectType`/`subjectId`, `attempts`, `lastError`, the
//      timestamps — are all here, and `subjectType`/`subjectId` exist
//      precisely so that "which thing was this job about" is answerable
//      without reading the payload. A later per-job detail route can publish
//      the payload for ONE row, where its size is bounded by construction;
//      putting it in a paginated list is the shape that cannot be made safe.
//
// These DTO classes are documentation, not runtime validation. Nothing parses
// a response through them — `createZodDto` is used because it is how every
// other schema in this API reaches the OpenAPI document.
// =============================================================================

import { JobReason, JobStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The four `JobStatus` values, as a tuple Zod can build an enum from.
 *
 * Kept as a local literal rather than derived from Prisma's generated enum
 * object: `z.enum` needs a tuple whose members are literal types, and the
 * generated value is a plain object whose keys would widen to `string`.
 *
 * Drift in EITHER direction is a compile error, which is the only reason a
 * hand-copied list is acceptable here. `satisfies` catches a value this file
 * lists that the schema does not have; `Exhaustive` below catches a value the
 * schema has that this file forgot — the direction that would otherwise fail
 * silently, publishing a filter enum that cannot express a real row's status.
 */
export const JOB_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
] as const satisfies readonly JobStatus[];

export type JobStatusName = (typeof JOB_STATUSES)[number];

/** The three `JobReason` values, for the same reason and with the same guards. */
export const JOB_REASONS = [
  'upload',
  'rerun',
  'backfill',
] as const satisfies readonly JobReason[];

/**
 * `never` unless every member of `Enum` appears in `Listed`.
 *
 * Used only as the constraint on the two assertions below; it has no runtime
 * form on purpose, so the check costs nothing at import time.
 */
type Exhaustive<Enum extends string, Listed extends string> = [
  Exclude<Enum, Listed>,
] extends [never]
  ? true
  : never;

// Fails to compile if `schema.prisma` gains a status or a reason that the
// tuples above do not list.
export type JobStatusesAreExhaustive = Exhaustive<JobStatus, JobStatusName>;
export type JobReasonsAreExhaustive = Exhaustive<
  JobReason,
  (typeof JOB_REASONS)[number]
>;

export const jobSchema = z.object({
  id: z.uuid(),

  /** The machine key a handler is registered under; what `type=` filters on. */
  type: z.string(),
  /** `type` run through `jobTypeLabel()`; equal to `type` when unmapped. */
  typeLabel: z.string(),

  /** What this job is about, when the enqueuer said so. */
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),

  /**
   * The active-dedup key. Non-null only when the enqueuer wanted collapsing;
   * see `jobs.service.ts` for why a NULL key can never collide.
   */
  dedupKey: z.string().nullable(),

  status: z.enum(JOB_STATUSES),
  reason: z.enum(JOB_REASONS),
  priority: z.number().int(),

  providerKey: z.string().nullable(),
  modelVersion: z.string().nullable(),

  /** Attempts STARTED, charged at claim time — not attempts that reported back. */
  attempts: z.number().int(),
  lastError: z.string().nullable(),

  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),

  /** When set in the future on a `pending` row, the job is in backoff. */
  scheduledFor: z.iso.datetime().nullable(),

  rateLimitedAt: z.iso.datetime().nullable(),
  rateLimitHits: z.number().int(),

  /** Ownership, while a row is claimed. All three are cleared by a retry. */
  claimedByNodeId: z.uuid().nullable(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  executor: z.string().nullable(),
});

export class JobDto extends createZodDto(jobSchema) {}
