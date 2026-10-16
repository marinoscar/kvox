// =============================================================================
// One broadcast, as the admin API publishes it (issue #324, epic #319)
// =============================================================================
//
// These schemas describe the JSON an administrator receives, NOT the Prisma
// model — the same split, and for the same reasons, as
// `jobs/dto/job-response.dto.ts`:
//
//   1. TIMESTAMPS ARE ISO STRINGS. The service hands the controller the Prisma
//      row and the global serializer turns every `Date` into ISO-8601 on the
//      way out. Documenting `z.date()` would publish a type no HTTP client can
//      ever receive.
//   2. THESE CLASSES ARE DOCUMENTATION, NOT RUNTIME VALIDATION. Nothing parses
//      a response through them; `createZodDto` is used because it is how every
//      schema in this API reaches the OpenAPI document.
//
// What is NOT hidden here, deliberately: the composed `title` and `body` are
// published in full. They are the thing being administered — a list that
// showed only ids would make "which announcement was that?" unanswerable —
// and every route that returns them requires `broadcasts:read`, which is
// seeded to Admin only.
// =============================================================================

import { NotificationBroadcastStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The six `NotificationBroadcastStatus` values, as a tuple Zod can build an
 * enum from.
 *
 * Hand-copied for the reason `JOB_STATUSES` gives — `z.enum` needs literal
 * types and Prisma's generated enum object widens to `string` — and safe only
 * because drift in EITHER direction is a compile error: `satisfies` catches a
 * value listed here that the schema does not have, and `Exhaustive` below
 * catches one the schema has that this file forgot.
 *
 * `draft` is included even though no route in #319 can produce it: it is a
 * real enum member, and a filter that could not express a row's actual status
 * would be a filter that lies.
 */
export const BROADCAST_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'canceled',
  'failed',
] as const satisfies readonly NotificationBroadcastStatus[];

export type BroadcastStatusName = (typeof BROADCAST_STATUSES)[number];

type Exhaustive<Enum extends string, Listed extends string> = [
  Exclude<Enum, Listed>,
] extends [never]
  ? true
  : never;

/** Fails to compile if `schema.prisma` gains a status this file does not list. */
export type BroadcastStatusesAreExhaustive = Exhaustive<
  NotificationBroadcastStatus,
  BroadcastStatusName
>;

export const broadcastSchema = z.object({
  id: z.uuid(),

  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  ctaLabel: z.string().nullable(),

  /**
   * The registry event this broadcast was raised as — `admin.broadcast` or
   * `admin.broadcast_critical`.
   *
   * DERIVED SERVER-SIDE from the composer's `critical` flag and never accepted
   * from a client; published because it is what a recipient's preferences are
   * matched against, so "why did a muted user still get this?" is answerable
   * from the row.
   */
  eventKey: z.string(),

  /**
   * The channels this send was narrowed to. `String[]` in Postgres (Prisma has
   * no array-of-enum ergonomics worth a migration), constrained to the known
   * channel names by `CreateBroadcastDto` on the way in.
   */
  channels: z.array(z.string()),

  status: z.enum(BROADCAST_STATUSES),

  scheduledFor: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  canceledAt: z.iso.datetime().nullable(),

  /**
   * The frozen audience boundary, stamped once when the fan-out was claimed.
   * Null until then — a scheduled broadcast has no audience yet.
   */
  audienceCutoff: z.iso.datetime().nullable(),

  /** How many users matched the cutoff when sending began. Null until then. */
  recipientsTargeted: z.number().int().nullable(),

  /**
   * How many recipients the fan-out has ATTEMPTED. Incremented per dispatch,
   * not per success, and it can legitimately finish below `recipientsTargeted`
   * when users are deactivated mid-flight.
   */
  recipientsDispatched: z.number().int(),

  lastError: z.string().nullable(),

  createdById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class BroadcastDto extends createZodDto(broadcastSchema) {}

/**
 * One cell of the detail view's delivery breakdown.
 *
 * ⚠ APPROXIMATE, AND THE FIELD NAME ON `BroadcastDetailDto` SAYS SO. See that
 * type for the whole argument; this shape is just `(channel, status) -> count`.
 */
export const broadcastDeliveryCountSchema = z.object({
  /** `email`, `browser` or `push`. A string, because the column is one. */
  channel: z.string(),
  /** `queued`, `sent` or `failed`. */
  status: z.string(),
  count: z.number().int(),
});

export class BroadcastDeliveryCountDto extends createZodDto(broadcastDeliveryCountSchema) {}

export const broadcastDetailSchema = broadcastSchema.extend({
  /**
   * Delivery attempts recorded WHILE THIS BROADCAST WAS SENDING — a
   * time-windowed approximation, never an exact attribution.
   *
   * ---------------------------------------------------------------------------
   * WHY THE NAME IS THIS LONG, AND WHY IT MUST STAY THAT WAY
   * ---------------------------------------------------------------------------
   *
   * It is computed as `groupBy(['channel','status'])` over
   * `notification_deliveries` filtered by this broadcast's `eventKey` and by
   * `createdAt` between `startedAt` and `finishedAt ?? now`. That window can
   * over-count: a SECOND broadcast raised under the same event key while this
   * one was still sending contributes its rows to this total, and there is no
   * column to tell them apart.
   *
   * `NotificationDelivery` carries no broadcast id, and #319 decided it will
   * not gain one. Adding it would mean a migration on the fastest-growing
   * table in the schema, plus threading a broadcast id from this feature
   * through `notifyNow` and into a dispatcher that is deliberately ignorant of
   * WHO called it — a coupling that would exist solely to make one admin
   * screen's number exact.
   *
   * So the number is honest about being an approximation, starting with what
   * it is called. A field named `deliveries` or `stats` would be read as exact
   * by the next person to touch the UI, and an operator would then reconcile
   * it against `recipientsDispatched` and file a bug about a discrepancy that
   * is working as designed. The UI labels it "delivery attempts during this
   * broadcast" for the same reason.
   *
   * Empty for a broadcast that has not started: there is no window yet.
   */
  approximateDeliveryAttempts: z.array(broadcastDeliveryCountSchema),
});

export class BroadcastDetailDto extends createZodDto(broadcastDetailSchema) {}

export const broadcastCreateResultSchema = z.object({
  broadcast: broadcastSchema,

  /**
   * NON-FATAL problems with a broadcast that was nonetheless created.
   *
   * The only current member: `browser` was selected while the deployment-wide
   * browser kill switch is off. That is a warning rather than a 400 because it
   * is legitimately what an admin may want — scheduling an announcement for
   * after the switch is flipped back is a real workflow, and the switch may be
   * flipped by somebody else between compose and send. Refusing the request
   * would make a transient operational setting block a future-dated write.
   *
   * Always present, empty when there is nothing to say, so a client renders
   * `warnings.length` rather than testing for undefined.
   */
  warnings: z.array(z.string()),
});

export class BroadcastCreateResultDto extends createZodDto(broadcastCreateResultSchema) {}

export const broadcastAudienceSchema = z.object({
  /**
   * How many users a broadcast created right now would target.
   *
   * COUNTED WITH `audienceWhere()`, the one predicate the fan-out itself pages
   * with, so the "this goes to 1,284 people" in the composer cannot disagree
   * with the number the send later reports. An ESTIMATE all the same: the real
   * audience is frozen at a cutoff stamped when sending begins, so a
   * scheduled broadcast's actual audience is whoever exists then.
   */
  activeUsers: z.number().int(),
});

export class BroadcastAudienceDto extends createZodDto(broadcastAudienceSchema) {}

export const broadcastTestResultSchema = z.object({
  /** The event key the test was dispatched under, derived exactly as a real send derives it. */
  eventKey: z.string(),
  /** The channels it was narrowed to. Which of them actually delivered is in the delivery log. */
  channels: z.array(z.string()),
  /**
   * Who it went to. The CALLER, always — a test send has no recipient
   * parameter, because an endpoint that could send an arbitrary composition to
   * an arbitrary address is a spam relay with an audit trail.
   */
  sentToUserId: z.uuid(),
});

export class BroadcastTestResultDto extends createZodDto(broadcastTestResultSchema) {}
