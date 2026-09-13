// =============================================================================
// The broadcast audience: ONE predicate, two readers (issue #323, epic #319)
// =============================================================================
//
// A broadcast is counted once (`recipientsTargeted`, by the start handler) and
// then paged through many times (by the chunk handler). Those are two
// different queries against the same population, and this file exists so they
// cannot be two different POPULATIONS.
//
// THE BUG THIS PREVENTS, stated concretely because it is the whole reason for
// the indirection: if the count says `isActive: true` and the paging says
// `isActive: true AND createdAt <= cutoff`, the progress bar in the admin UI
// climbs to 940/1000 and stops there forever, with every job row `succeeded`
// and no error anywhere. Nothing is broken except the number, and the number
// is the only thing an operator has to tell them whether the send finished.
// The inverse drift is worse: a count NARROWER than the paging reports 1200 of
// 1000 sent. Both are the same class of bug — two hand-written `where` clauses
// that agreed on the day they were written — and one exported function is the
// only fix that stays true when somebody later adds a third reader.
//
// REJECTED: inlining the clause in both handlers with a comment saying "keep
// these in sync". Comments do not fail a build. This does, the moment the
// shape changes.
//
// REJECTED: a `BroadcastAudienceService` with a `count()` and a `page()`. It
// would be a class holding no state whose two methods each take a Prisma
// client — a namespace with extra ceremony. The thing that must be shared is
// the PREDICATE, not the queries around it, and a `Prisma.UserWhereInput` is
// composable (the chunk handler spreads a cursor into it) in a way that a
// wrapped query is not.
// =============================================================================

import { Prisma } from '@prisma/client';

/**
 * `Job.subjectType` for BOTH broadcast job types.
 *
 * Snake-cased to match the table it names (`notification_broadcasts`), like
 * every other subject string in this repository. Shared, so the admin Jobs
 * dashboard can filter a whole fan-out — the start job and every one of its
 * chunks — by one subject.
 *
 * IT LIVES HERE RATHER THAN IN EITHER HANDLER, and that is the only reason
 * this file has a constant that is not about the audience. The start handler
 * must know the chunk handler's `type` (it enqueues the first chunk) and the
 * chunk handler must know this subject string (it enqueues its successor); put
 * this in the start handler and those two imports form a cycle between the two
 * files. A cycle whose members are only read inside methods happens to resolve
 * under CommonJS, which is precisely what makes it a bad thing to leave lying
 * around — it works until someone moves one of them to a class-property
 * initializer and gets `undefined` at boot. One shared module, imported by
 * both, has no such failure mode.
 */
export const BROADCAST_SUBJECT_TYPE = 'notification_broadcast';

/**
 * Recipients dispatched per `admin.broadcast.chunk` job.
 *
 * A LOCK-AND-LATENCY BOUND, not a throughput knob — the same argument
 * `PURGE_BATCH_SIZE` makes in `job-history-purge.handler.ts`. Each chunk holds
 * a worker slot for as long as it takes to dispatch this many notifications,
 * so a large value starves a queue sized for human-triggered work while a tiny
 * one turns a 50k-user broadcast into a flood of `jobs` rows that the admin
 * dashboard and `job-history-purge` both have to grind through.
 *
 * ⚠ IT IS ALSO THE DUPLICATE BOUND. The cursor is committed AFTER a page is
 * dispatched, so a process killed mid-chunk re-sends AT MOST THIS MANY
 * recipients on the retry. See the chunk handler's header for why duplicate
 * beats drop, and for the seam that lets this bound be tightened without
 * restructuring anything.
 */
export const BROADCAST_CHUNK_SIZE = 200;

/**
 * How many recipients inside one chunk are dispatched concurrently.
 *
 * BOUNDED, and small. `notifyNow` awaits a real mail transport, so an
 * unbounded `Promise.all` over a page would open 200 concurrent SMTP
 * conversations — enough to trip a provider's per-connection limits and to
 * make one broadcast the noisiest thing in the process — in exchange for
 * latency nobody is waiting on. A broadcast has no deadline; it has a
 * throughput floor, and five in flight clears it.
 *
 * The epic names the follow-up explicitly: making the email channel
 * participate in `provider-throttle.service.ts` is out of scope for #319,
 * because that throttle is tripped only by a handler throwing `RateLimitError`
 * and the email channel is contracted never to throw. Until then, THIS
 * CONSTANT IS THE ONLY BACKPRESSURE the fan-out has, which is why it lives
 * beside the predicate rather than inline in a loop.
 */
export const BROADCAST_SEND_CONCURRENCY = 5;

/**
 * The users a broadcast goes to: ACTIVE, and existing as of the frozen cutoff.
 *
 * Used by BOTH the count that fills `recipientsTargeted` and the paging query
 * that walks the audience — see the file header for the progress-bar bug that
 * makes sharing this non-negotiable.
 *
 * The two halves answer two different questions:
 *
 *   - `isActive: true` is evaluated LIVE, on every page. A user deactivated
 *     mid-fan-out stops receiving the broadcast from the next chunk onwards,
 *     which is the correct reading of deactivation — it is a statement about
 *     now, not about the moment the send began. That is also why
 *     `recipientsTargeted` can legitimately exceed `recipientsDispatched`, and
 *     why the schema's own comment calls it "targeted at send time" rather
 *     than "should have received it".
 *   - `createdAt <= cutoff` is FROZEN, from the single `audienceCutoff` the
 *     start handler stamps. Without it the fan-out chases a moving target: on
 *     a busy deployment new users keep arriving behind the cursor, so the
 *     send may never terminate and "who got this?" stops being answerable.
 *     With it, membership is deterministic and reproducible by re-running this
 *     one query, and the two boundary windows are decided explicitly — a user
 *     created between compose and start IS included, one created between start
 *     and the last chunk is NOT.
 *
 * `lte`, not `lt`: the cutoff is a timestamp the start handler generates, so
 * the interval is closed at the boundary it owns. Nothing hinges on it beyond
 * being stated once rather than guessed at each call site.
 *
 * NOTE WHAT IS ABSENT: there is no role filter, no segment and no user picker.
 * "All active users" is the entire targeting model of epic #319 and is listed
 * in its out-of-scope section. When targeting arrives, it arrives as extra
 * clauses HERE — one edit, and the count and the paging move together by
 * construction.
 */
export function audienceWhere(cutoff: Date): Prisma.UserWhereInput {
  return {
    isActive: true,
    createdAt: { lte: cutoff },
  };
}
