// =============================================================================
// Broadcast chunk: one cursor-paged page of the fan-out (issue #323, epic #319)
// =============================================================================
//
// The half that actually sends. One `admin.broadcast.chunk` job dispatches at
// most `BROADCAST_CHUNK_SIZE` recipients, commits its progress, and enqueues
// its own successor — so a broadcast of any size is a CHAIN of small, bounded,
// individually retryable jobs rather than one long-running one.
//
// WHY A CHAIN AND NOT THE TWO OBVIOUS ALTERNATIVES:
//
//   - ONE JOB PER RECIPIENT is genuinely right at a different scale, and wrong
//     here. Thousands of `jobs` rows per broadcast make the admin dashboard
//     unusable, give `job-history-purge` thousands of rows per send to grind
//     through, render `job_stats_rollup`'s per-type averages meaningless (an
//     "average broadcast job" would measure one email), and turn a single
//     "Send now" into thousands of inserts.
//   - ONE LONG-RUNNING JOB WITH AN IN-MEMORY LOOP resumes correctly enough,
//     and still fails on everything around it: it holds a worker slot for the
//     entire broadcast, starving a queue sized for human-triggered work; the
//     lease-expiry sweep would have to be tuned to a runtime nobody can
//     predict; and the Jobs page shows one perpetually-`running` row with no
//     progress in it.
//
// SERVER-ONLY — neither `nodeResultSchema` nor `persistNodeResult`, the
// default. A worker node has no database access and no mail credentials, and
// this handler needs both on every page.
//
// =============================================================================
// ⚠ THIS JOB TYPE MUST BE ENQUEUED WITH `skipDedup: true`. ALWAYS.
// =============================================================================
//
// Not a preference. Omitting it does not raise an error, fail a job, or log a
// warning — IT ENDS THE BROADCAST SILENTLY, and this is what that looks like:
//
//   1. Chunk n is claimed and its `jobs` row moves to `running`.
//   2. From inside its own `process()` — while it is still `running` — chunk n
//      enqueues chunk n+1 for the SAME `subjectType`/`subjectId`.
//   3. With dedup on, `buildDedupKey(type, subjectType, subjectId)` produces
//      the identical key, the active-dedup unique index rejects the insert,
//      and `JobsService.enqueue` resolves it by RETURNING THE JOB ALREADY IN
//      FLIGHT — which is chunk n, the job doing the enqueueing.
//   4. `enqueue` returned a job. Nothing threw. Chunk n returns normally and
//      its row goes `succeeded`.
//
// The broadcast stops dead after one page — 200 recipients out of however many
// — with every job row `succeeded`, `lastError` empty, and no exception
// anywhere to point at. The only visible symptom is a progress counter that
// stopped, which is indistinguishable from a send that finished.
//
// Chunks of one broadcast are the textbook case `skipDedup` exists for:
// several jobs of the same type against the same subject that are genuinely
// distinct work. Both enqueue sites pass it (here, and the first chunk in
// `broadcast-start.handler.ts`), and `broadcast-chunk.handler.spec.ts` asserts
// it explicitly on both — because the failure mode above is exactly the kind
// that no other test would notice.
//
// -----------------------------------------------------------------------------
// ORDERING AND IDEMPOTENCE: DUPLICATE OVER DROP, BOUNDED AT 200
// -----------------------------------------------------------------------------
//
// The queue is AT-LEAST-ONCE, never exactly-once: a job can run twice after a
// retry, or after a lease expired because the process executing it was killed
// mid-run. So the question is not whether a chunk can run twice — it is what
// happens when it does.
//
// THE CURSOR IS COMMITTED AFTER THE PAGE IS DISPATCHED, never before. A
// process killed halfway through a page therefore re-sends AT MOST
// `BROADCAST_CHUNK_SIZE` (200) recipients when the job is retried, because the
// cursor still points at the start of that page.
//
// That is a deliberate choice, and the alternative is strictly worse.
// Advancing the cursor FIRST would make the same crash SKIP up to 200 people:
//
//   - The duplicate is bounded (200), visible (recipients say so, and
//     `notification_deliveries` has two rows), and self-correcting (the send
//     completes).
//   - The drop is bounded by the same number but INVISIBLE and PERMANENT.
//     Nothing records who was skipped: the cursor moved, the job succeeded,
//     the counters look plausible, and the only evidence is 200 people who
//     never heard about the maintenance window. It cannot be detected after
//     the fact and it cannot be repaired without re-sending to everybody.
//
// TIGHTENING THE BOUND IS A CONSTANT CHANGE, on purpose. The dispatch loop is
// already written as an outer walk over sub-groups of
// `STATUS_RECHECK_INTERVAL` recipients (that walk exists for cancel latency),
// so flushing the cursor at the end of each group instead of at the end of the
// page moves the duplicate bound from 200 to 25 without restructuring
// anything — one update call relocated inside the existing loop. It is not
// done today because each flush is a round trip per group, and 200 duplicate
// notifications on a crash is an acceptable worst case for a feature whose
// crash rate is a deploy.
//
// -----------------------------------------------------------------------------
// THROW TO FAIL — AND WHAT CANNOT FAIL
// -----------------------------------------------------------------------------
//
// Every database call here is unguarded: the page read, the progress update,
// the terminal write and the successor enqueue all propagate. That is the
// point of "throw to fail" — the worker records the message in `Job.lastError`
// and retries, and the retry resumes FROM THE PERSISTED CURSOR rather than
// from the beginning, because the cursor is durable state and not a loop
// variable. A `try/catch` that swallowed here would produce a `succeeded` job
// for a broadcast that stopped, which is the same silent failure the dedup
// warning above describes, arrived at a different way.
//
// `notifyNow` is the exception, and it is an exception BY CONSTRUCTION rather
// than by our catching it: it routes its work through `runContained`, which
// attaches a `.catch()` before the promise can reject, and every layer beneath
// it (the channel contract returns `{ success: false }`, the delivery service
// swallows its own database errors, `deliverOne` wraps every channel call
// anyway) is separately defensive. One recipient's dead mailbox therefore
// cannot fail a chunk, which is the property that matters: without it, a
// single unroutable address would burn the job's whole attempt budget and take
// the other 199 recipients of that page with it, over and over.
//
// -----------------------------------------------------------------------------
// CANCEL IS A STATUS, NOT A DELETION
// -----------------------------------------------------------------------------
//
// #324's cancel flips the status with `updateMany({ where: { id, status: { in:
// ['scheduled','sending'] } } })` and does NOT delete pending `jobs` rows —
// deleting one races with a claim, and letting the row run and no-op keeps the
// audit trail in `jobs` intact. This handler is the other side of that
// contract, in two places:
//
//   1. The status guard at the top: a chunk that finds anything other than
//      `sending` returns immediately, having sent nothing. That is also what
//      neutralises a replayed or stale chunk from a broadcast that has since
//      finished.
//   2. The mid-page re-read every `STATUS_RECHECK_INTERVAL` recipients, so a
//      cancel does not have to wait out a whole page of sends before it takes
//      effect.
//
// Worst case one in-flight sub-group still goes out after the click. #324's
// API description and #325's confirm dialog both have to say so; there is no
// implementation that makes an already-issued send un-happen.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, NotificationBroadcast } from '@prisma/client';

import type { BroadcastEmailData } from '../../../email/templates/broadcast.email';
import { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { JobsService } from '../../../jobs/jobs.service';
import { PrismaService } from '../../../prisma/prisma.service';
import type { NotificationChannel } from '../../notification-events';
import type { NotifyOptions } from '../../notification.types';
import { NotificationsService } from '../../notifications.service';
import {
  BROADCAST_CHUNK_SIZE,
  BROADCAST_SEND_CONCURRENCY,
  BROADCAST_SUBJECT_TYPE,
  audienceWhere,
} from '../broadcast-audience';

/**
 * The handler key, and therefore the `Job.type` every chunk row carries.
 *
 * Dotted, lowercase and PERMANENT, per `JobHandler.type` — renaming it strands
 * every chunk already queued for a broadcast mid-flight, which is the one
 * moment a broadcast cannot survive losing its successor.
 *
 * Exported because `broadcast-start.handler.ts` enqueues the first chunk by
 * name and this file enqueues every later one; two literals is one typo away
 * from a fan-out that stops after the start job.
 */
export const BROADCAST_CHUNK_TYPE = 'admin.broadcast.chunk';

/**
 * How many recipients are dispatched between status re-reads.
 *
 * A CANCEL-LATENCY BOUND. Without it, "Cancel" clicked one recipient into a
 * page still sends the remaining 199 — technically correct (the guard at the
 * top of the next chunk stops the broadcast) and indefensible to the operator
 * watching it happen. With it, an admin waits for at most this many sends.
 *
 * Also the seam the file header names for tightening the duplicate bound: the
 * outer loop this constant drives is where a per-group cursor flush would go.
 *
 * 25 is one extra `SELECT status` per 25 sends — negligible next to the
 * network calls those sends make — and small enough that cancel feels
 * immediate at any realistic send rate.
 */
const STATUS_RECHECK_INTERVAL = 25;

/** The columns a chunk reads. Everything the page, the payload and the guard need. */
const BROADCAST_SELECT = {
  id: true,
  title: true,
  body: true,
  link: true,
  ctaLabel: true,
  eventKey: true,
  channels: true,
  status: true,
  audienceCutoff: true,
  cursorUserId: true,
} as const;

type ChunkBroadcast = Pick<NotificationBroadcast, keyof typeof BROADCAST_SELECT>;

@Injectable()
export class BroadcastChunkHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(BroadcastChunkHandler.name);

  readonly type = BROADCAST_CHUNK_TYPE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobsService,
    private readonly config: ConfigService,
    private readonly registry: JobHandlerRegistry
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Dispatches one page of the audience, commits progress, and either
   * enqueues the successor or finishes the broadcast.
   *
   * THROWS TO FAIL on every database error; see the file header for why the
   * `notifyNow` calls cannot fail it, and for the ordering that makes a retry
   * resume from the persisted cursor.
   */
  async process(job: Job): Promise<void> {
    const broadcastId = job.subjectId;

    if (!broadcastId) {
      this.logger.warn(`Broadcast chunk job ${job.id} carries no subjectId; nothing to send`);

      return;
    }

    const broadcast = await this.prisma.notificationBroadcast.findUnique({
      where: { id: broadcastId },
      select: BROADCAST_SELECT,
    });

    if (!broadcast) {
      // Deleted mid-fan-out. A no-op, for the same reason the start handler
      // gives: there is nothing to send and no retry can bring the row back.
      this.logger.log(
        `Broadcast ${broadcastId} no longer exists; chunk job ${job.id} is a no-op`
      );

      return;
    }

    // THE GUARD THAT MAKES CANCEL WORK, and the one that neutralises a
    // replayed or stale chunk. `sending` is the ONLY status a chunk may act
    // on: `canceled` means an admin stopped it, `sent` means a duplicate
    // chunk from a lease expiry arrived after the fan-out finished, and
    // `scheduled` means this chunk somehow outran its own start job. All four
    // wrong answers have the same right response — send nothing, return
    // normally, leave the status alone.
    if (broadcast.status !== 'sending') {
      this.logger.log(
        `Broadcast ${broadcastId} is '${broadcast.status}', not 'sending'; ` +
          `chunk job ${job.id} sent nothing`
      );

      return;
    }

    if (!broadcast.audienceCutoff) {
      // Structurally impossible — the start handler's compare-and-swap writes
      // `audienceCutoff` in the same statement that sets `sending`, so the two
      // cannot disagree. Handled anyway rather than asserted with a `!`,
      // because paging without a cutoff would silently widen the audience to
      // every user who exists at page time, which is the one failure this
      // column exists to prevent. A no-op is the safe reading.
      this.logger.error(
        `Broadcast ${broadcastId} is 'sending' with no audienceCutoff; ` +
          `chunk job ${job.id} refuses to page an unfrozen audience`
      );

      return;
    }

    // KEYSET PAGINATION on the primary key, not `skip`/`take`. An OFFSET grows
    // linearly more expensive with every page and — worse — SHIFTS when a row
    // ahead of the cursor is deleted, which silently skips a recipient. `id >
    // cursor` with `ORDER BY id ASC` is stable under concurrent inserts and
    // deletes, costs the same on page 1 and page 500, and is the reason the
    // cursor is a durable column rather than an in-memory index.
    const users = await this.prisma.user.findMany({
      where: {
        ...audienceWhere(broadcast.audienceCutoff),
        ...(broadcast.cursorUserId ? { id: { gt: broadcast.cursorUserId } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BROADCAST_CHUNK_SIZE,
    });

    if (users.length === 0) {
      // The audience is exhausted. Reached when the previous chunk's page was
      // exactly full — it enqueued a successor because it could not know it
      // was the last — and also when every remaining candidate was deactivated
      // since the count.
      await this.finish(broadcast.id, job.id);

      return;
    }

    const payload = this.buildPayload(broadcast);
    const options: NotifyOptions = {
      // NARROWING ONLY, and that is the entire contract of this option — see
      // `NotifyOptions`. It is intersected AFTER the admin policy filter and
      // AFTER the user-preference filter, so passing the broadcast's stored
      // channels cannot resurrect a channel the kill switch dropped or the
      // recipient muted; it can only remove ones the admin did not choose for
      // this send. The cast is to the union the column is constrained to by
      // #324's DTO — `channels` is `String[]` in Postgres because Prisma has
      // no array-of-enum ergonomics worth the migration, and an unrecognised
      // string here is simply an element the intersection drops.
      channels: broadcast.channels as NotificationChannel[],
    };

    let dispatched = 0;
    let lastDispatchedId: string | null = null;
    let canceledMidPage = false;

    // The outer walk over sub-groups exists for cancel latency (see
    // `STATUS_RECHECK_INTERVAL`) and is also the seam for tightening the
    // duplicate bound; the inner pool bounds concurrency.
    for (let offset = 0; offset < users.length; offset += STATUS_RECHECK_INTERVAL) {
      if (offset > 0 && !(await this.stillSending(broadcast.id))) {
        canceledMidPage = true;
        break;
      }

      const group = users.slice(offset, offset + STATUS_RECHECK_INTERVAL);

      await this.dispatchGroup(
        group.map((user) => user.id),
        broadcast.eventKey,
        payload,
        options
      );

      dispatched += group.length;
      lastDispatchedId = group[group.length - 1].id;
    }

    if (lastDispatchedId) {
      // ONE UPDATE, AFTER THE SENDS. The cursor and the counter describe the
      // same event ("these recipients have been dispatched") and are written
      // together so no reader can see one without the other — a cursor ahead
      // of its counter reports progress that did not happen, and a counter
      // ahead of its cursor double-counts on the next page.
      //
      // `increment`, not an absolute value: this handler is not the only
      // possible writer of the column over the life of a broadcast (a retry of
      // a partially-dispatched chunk is the ordinary case), and an absolute
      // write would need a read first — reintroducing the read-then-write race
      // the start handler's compare-and-swap exists to avoid.
      //
      // Deliberately NOT conditioned on `status: 'sending'`. If a cancel
      // landed mid-page, these notifications were still sent, and the counter
      // must say so — suppressing the write would leave `recipientsDispatched`
      // understating what recipients actually received, which is the number an
      // operator reaches for first when asking "how far did it get before I
      // stopped it?".
      await this.prisma.notificationBroadcast.update({
        where: { id: broadcast.id },
        data: {
          cursorUserId: lastDispatchedId,
          recipientsDispatched: { increment: dispatched },
        },
      });
    }

    if (canceledMidPage) {
      // The status was changed out from under us. Do NOT enqueue a successor
      // and do NOT mark the broadcast `sent` — whoever changed it owns the
      // terminal state now.
      this.logger.log(
        `Broadcast ${broadcast.id} stopped mid-chunk after ${dispatched} recipient(s) ` +
          `in job ${job.id}; no successor queued`
      );

      return;
    }

    if (users.length < BROADCAST_CHUNK_SIZE) {
      // A SHORT PAGE MEANS THE AUDIENCE IS EXHAUSTED — `take` returned fewer
      // rows than it was allowed to, so there is nothing after the cursor.
      // Finishing here rather than enqueueing one more chunk to discover an
      // empty page saves a whole round trip through the queue on every
      // broadcast.
      await this.finish(broadcast.id, job.id);

      return;
    }

    const nextJob = await this.jobs.enqueue({
      type: BROADCAST_CHUNK_TYPE,
      // `backfill` — see the note in `broadcast-start.handler.ts`. `JobReason`
      // is a Prisma enum with three values and adding a fourth is a migration
      // plus web and OpenAPI churn for a display string.
      reason: 'backfill',
      subjectType: BROADCAST_SUBJECT_TYPE,
      subjectId: broadcast.id,
      // ⚠ LOAD-BEARING. Without it this enqueue returns the job that is
      // calling it — see the file header. The broadcast would stop here, with
      // every job row `succeeded` and no error anywhere.
      skipDedup: true,
    });

    this.logger.log(
      `Broadcast ${broadcast.id} chunk job ${job.id} dispatched ${dispatched} recipient(s) ` +
        `up to user ${lastDispatchedId}; next chunk queued as job ${nextJob.id}`
    );
  }

  /**
   * Dispatches one sub-group through a bounded pool.
   *
   * A FIXED NUMBER OF WORKERS PULLING FROM A SHARED INDEX, not
   * `Promise.all(group.map(...))`. The `Promise.all` version is shorter and
   * opens as many concurrent transports as the group has members, which is the
   * thing `BROADCAST_SEND_CONCURRENCY` exists to prevent; it is rejected for
   * the same reason the dispatcher's own per-recipient work is sequential —
   * multiplying concurrent load on the mail provider wins latency nobody is
   * waiting for.
   *
   * `Promise.all` over the WORKERS is safe and is not the same thing: there
   * are exactly `BROADCAST_SEND_CONCURRENCY` of them regardless of group size,
   * and none of them can reject, because `notifyNow` never rejects.
   */
  private async dispatchGroup(
    userIds: string[],
    eventKey: string,
    payload: BroadcastEmailData,
    options: NotifyOptions
  ): Promise<void> {
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;

        if (index >= userIds.length) {
          return;
        }

        // AWAITED — this is `notifyNow`, not `notify`. `notify` is detached:
        // it schedules the send on a microtask and returns, which inside a job
        // handler means the job reports `succeeded` for work that has not
        // happened and that a restart moments later would lose with no record
        // of who was missed. `notifyNow` is the same dispatch — same
        // preference gate, same policy filter, same delivery rows — with the
        // promise handed back, which is the only shape a fan-out can apply
        // backpressure to.
        await this.notifications.notifyNow(eventKey, userIds[index], payload, options);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(BROADCAST_SEND_CONCURRENCY, userIds.length) }, () => worker())
    );
  }

  /**
   * The payload every channel renders this broadcast from.
   *
   * ANNOTATED WITH THE TEMPLATE'S OWN TYPE ON PURPOSE. `notifyNow` takes `data:
   * unknown` — one untyped entry point for every event, so no call site has to
   * import a per-event payload type — which means THIS IS THE ONLY PLACE the
   * shape is checked at all. Drop the annotation and a renamed field in
   * `broadcast.email.ts` becomes a runtime render failure recorded as a failed
   * delivery for every recipient, with nothing red in a build anywhere.
   *
   * One payload serves every channel: email uses `ctaUrl`, browser and push
   * use the root-relative `link`, and both are carried rather than split
   * per-channel — see `BroadcastEmailData.link` for why splitting would put
   * the burden of building both on every call site and let the two drift.
   */
  private buildPayload(broadcast: ChunkBroadcast): BroadcastEmailData {
    const ctaUrl = this.ctaUrl(broadcast.link);

    return {
      title: broadcast.title,
      body: broadcast.body,
      // Spread-if-present rather than `?? undefined`: these are optional
      // fields on the template's interface, and an explicit `undefined` and an
      // absent key are the same to the template but not to a test asserting on
      // the payload.
      ...(broadcast.link ? { link: broadcast.link } : {}),
      ...(broadcast.ctaLabel ? { ctaLabel: broadcast.ctaLabel } : {}),
      ...(ctaUrl ? { ctaUrl } : {}),
      // The registry key is what makes a broadcast critical — `mandatory: true`
      // lives on `admin.broadcast_critical` in `NOTIFICATION_EVENTS` and
      // nowhere else, so this flag is derived from it rather than stored
      // alongside it. A stored copy is a second source of truth that can
      // disagree with the gate that actually decides whether a recipient may
      // mute this.
      critical: broadcast.eventKey === 'admin.broadcast_critical',
    };
  }

  /**
   * The absolute CTA URL, or `undefined` when there is nothing to link to.
   *
   * ABSOLUTE, because `safeUrl` in the email layout rejects anything else —
   * mail clients have no origin to resolve `/settings` against. Built HERE
   * rather than in the template for the reason `users.service.ts`'s private
   * `appUrl()` gives: a template is a pure function of its input and has no
   * business reading configuration.
   *
   * Trailing slashes are stripped exactly as that method does, so a configured
   * `http://localhost:3535/` and the stored root-relative `/settings` cannot
   * produce `http://localhost:3535//settings`.
   *
   * `undefined` when either half is missing — no link, or an unconfigured
   * `APP_URL`. The layout then omits the button entirely rather than rendering
   * one that goes nowhere, and `BroadcastEmailData.ctaLabel` is dropped with
   * it because a label with no destination is worse than no button.
   */
  private ctaUrl(link: string | null): string | undefined {
    if (!link) {
      return undefined;
    }

    const appUrl = this.config.get<string>('appUrl');

    if (!appUrl) {
      return undefined;
    }

    return `${appUrl.replace(/\/+$/, '')}${link}`;
  }

  /** Whether the broadcast is still `sending`. The mid-page cancel check. */
  private async stillSending(broadcastId: string): Promise<boolean> {
    const current = await this.prisma.notificationBroadcast.findUnique({
      where: { id: broadcastId },
      select: { status: true },
    });

    return current?.status === 'sending';
  }

  /**
   * Marks the broadcast finished.
   *
   * CONDITIONAL ON `sending`, like the start handler's claim and for the same
   * reason: an unconditional `update` would let a chunk that raced a cancel
   * overwrite `canceled` with `sent`, reporting a completed send for a
   * broadcast an admin stopped. `count === 0` means somebody else already
   * decided how this broadcast ends, which is not an error.
   */
  private async finish(broadcastId: string, jobId: string): Promise<void> {
    const finished = await this.prisma.notificationBroadcast.updateMany({
      where: { id: broadcastId, status: 'sending' },
      data: { status: 'sent', finishedAt: new Date() },
    });

    if (finished.count === 0) {
      this.logger.log(
        `Broadcast ${broadcastId} was no longer 'sending' when chunk job ${jobId} ` +
          `tried to finish it; its status was left alone`
      );

      return;
    }

    this.logger.log(`Broadcast ${broadcastId} finished sending (chunk job ${jobId})`);
  }
}
