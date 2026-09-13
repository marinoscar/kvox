import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { describeThrown } from './describe-thrown';
import { NotificationDeliveryService } from './notification-delivery.service';
import {
  findEvent,
  type NotificationChannel,
  type NotificationEventDef,
} from './notification-events';
import { NotificationPolicyService } from './notification-policy.service';
import {
  readNotificationPreferences,
  resolveChannels,
} from './notification-preferences';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type ChannelDeliveryResult,
  type NotificationChannelSender,
  type NotificationDispatchContext,
  type NotificationRecipient,
  type NotifyOptions,
  type NotifyPermissionHoldersOptions,
} from './notification.types';

// =============================================================================
// NotificationsService — the dispatcher (issue #125, epic #109)
// =============================================================================
//
// ONE ENTRY POINT: `notify(eventKey, userId, data)`. It resolves the event
// from the registry (#121), resolves the user's per-channel preference, and
// fans out to each enabled channel, recording what happened.
//
// Five public methods now share that ONE resolution point rather than
// multiplying it: `notify` (the detached default), `notifyAddress` (#128 — a
// second way of BUILDING a recipient, for somebody with no account yet),
// `notifyNow` (#321 — the same dispatch, awaited, for a job handler that must
// not return before its work has committed), and the pair added by #288 (epic
// #254) — `notifyPermissionHolders` and `notifyPermissionHoldersNow`, a third
// way of building recipients, for an OPERATIONAL event whose audience is
// "whoever can act on this" rather than any one user. All five converge on the
// private `dispatch()`, which is the only place a preference or a policy is
// consulted.
//
// The alternative — emit an event and let each channel subscribe — is more
// decoupled and scatters the preference gate across subscribers, where one of
// them can forget it. `mandatory` is a security gate; there is ONE resolution
// point and ONE gate.
//
// -----------------------------------------------------------------------------
// INLINE, NOT QUEUED — AND THE TRADE-OFF THAT BUYS
// -----------------------------------------------------------------------------
//
// DECISION: dispatch happens in this process, immediately, and is DETACHED
// from the caller. `notify` schedules the work on a later microtask and
// returns; it never awaits a settings read, a render, or a socket to an SMTP
// server.
//
// WHY NOT A QUEUE. A durable queue (BullMQ + Redis, or a `jobs` table with a
// poller) is real machinery: a broker or a table, a worker process, its own
// deployment unit, its own failure modes, its own dashboard. This baseline has
// none of that anywhere — no Redis, no background worker, no job table — and
// introducing the first one to send three emails puts the ops cost of a job
// system into an epic about notifications. #125 says as much.
//
// WHY NOT PLAIN INLINE-AND-AWAITED. Because then a slow SMTP server is a slow
// request: the admin who changed a user's roles waits on the mail server
// before their PATCH returns, and a hung connection holds a Fastify request
// open for the transport's full timeout. The action and its notification have
// no reason to share a latency budget.
//
// THE TRADE-OFF ACCEPTED, STATED PLAINLY: there is NO DURABILITY AND NO RETRY.
// If this process dies between the schedule and the send — a deploy, an OOM
// kill, a crash — that notification is gone and nothing will try again. Two
// things bound the damage, and neither eliminates it:
//
//   * The `queued` delivery row is written BEFORE the attempt (see
//     notification-delivery.service.ts), so a lost send leaves evidence: a row
//     stuck at `queued`, findable through an index built for that query. The
//     notification is lost; the KNOWLEDGE that it was lost is not.
//   * `onModuleDestroy` drains in-flight dispatches, so an ORDERLY shutdown
//     (the common case — a rolling deploy, `docker compose down`) finishes
//     what it started instead of dropping it.
//
// There is also no backpressure: a burst of events becomes a burst of
// concurrent sends. Acceptable at this baseline's scale — notifications here
// are triggered by human actions, not by a firehose — and it is the first
// thing to revisit if that changes. When a queue is eventually justified, the
// seam is `schedule()` below and nothing above it moves.
//
// -----------------------------------------------------------------------------
// HOW `notify` IS GUARANTEED NOT TO THROW
// -----------------------------------------------------------------------------
//
// Structurally, not by inspection. `notify` itself does exactly two things
// that could fail — a synchronous map lookup, and handing a closure to
// `schedule` — and `schedule` routes it through `runContained`, which attaches
// a `.catch()` before the promise can reject. `notifyNow` (#321, below) makes
// the same promise by calling the SAME `runContained`, not a second try/catch
// of its own: one guarantee, one implementation, so it cannot be weakened on
// one path only. Every layer below it is separately defensive: the channel contract
// returns failures instead of throwing, the delivery service swallows its own
// database errors, and `deliverOne` wraps every channel call in a `try`/`catch`
// regardless. The point of the redundancy is that the guarantee must survive a
// channel added by somebody who did not read the contract.
//
// It also never participates in the caller's transaction: the dispatch runs
// after the caller's turn ends, on this service's own `PrismaService` calls,
// outside any `$transaction` the caller may be holding. A notification cannot
// roll back a role change, and a role change's rollback cannot un-send mail.
// =============================================================================

/**
 * How long an orderly shutdown waits for in-flight dispatches.
 *
 * BOUNDED, because the thing being waited on is a network call to a mail
 * server: an unbounded drain lets one hung SMTP connection hold a container in
 * `stopping` until the orchestrator SIGKILLs it, which loses the same work
 * AND makes the deploy slow. Five seconds is enough for a send already in
 * flight and short enough to stay well inside a typical 10s stop grace period.
 */
const SHUTDOWN_DRAIN_MS = 5_000;

@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Channel -> sender, built once from whatever the module registered.
   *
   * A Map rather than a `switch` or a chain of `if`s: the dispatcher iterates
   * the channels the event and the user's preferences agree on, and asks this
   * for each. A channel the registry declares but nothing implements —
   * `browser`, until #127 — is simply absent, and absent is handled in one
   * place.
   */
  private readonly senders: Map<NotificationChannel, NotificationChannelSender>;

  /**
   * Dispatches that have been scheduled and have not finished.
   *
   * Tracked ONLY so shutdown can drain them (and so tests can await them —
   * see {@link flush}). Nothing reads it to make a delivery decision.
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveries: NotificationDeliveryService,
    // The deployment-wide gate (#226). Injected rather than read inline so the
    // never-throw guarantee lives in one place; see the service's own header.
    private readonly policy: NotificationPolicyService,
    @Inject(NOTIFICATION_CHANNEL_SENDERS)
    senders: NotificationChannelSender[],
  ) {
    this.senders = new Map();

    for (const sender of senders) {
      if (this.senders.has(sender.channel)) {
        // FAIL AT BOOT, LOUDLY. Two senders claiming one channel means the
        // second silently shadows the first, and the symptom is "some
        // notifications go out over the wrong transport", which is close to
        // undiagnosable from a delivery record. This is the one place in this
        // file that is allowed to throw: it runs at module construction, not
        // on a business action, and a misconfigured graph should not start.
        throw new Error(
          `Duplicate notification channel sender registered for '${sender.channel}'.`,
        );
      }

      this.senders.set(sender.channel, sender);
    }
  }

  /**
   * Raise a notification for one user.
   *
   * THE ONLY PUBLIC ENTRY POINT, and deliberately the whole API: a call site
   * needs an event key, a user id and a payload, and nothing about channels,
   * templates, transports or preferences. That is what makes "adding a
   * notification costs one registry entry" (epic #109) true at the call site
   * as well as in the registry.
   *
   * RETURNS AS SOON AS THE WORK IS SCHEDULED. The returned promise resolves
   * before anything is rendered or sent — see the header. Awaiting it is
   * correct and cheap; it just does not mean "delivered". Callers that need to
   * know what happened read `notification_deliveries`.
   *
   * NEVER REJECTS. Not for a database failure, not for a mail server, not for
   * a template bug, not for an event key that does not exist.
   *
   * @param eventKey a key from `NOTIFICATION_EVENTS`. An UNKNOWN KEY IS A
   *        NO-OP THAT RECORDS NOTHING — not a throw, and not a delivery row.
   *        Both matter: a throw would fail the action that raised the stale
   *        event (the exact coupling this issue exists to prevent), and a row
   *        for a non-existent event would put a key in
   *        `notification_deliveries` that no registry entry explains, poisoning
   *        the table that answers "what did we send?".
   * @param userId the recipient's account.
   * @param data the event's payload, passed to the channel's template
   *        untouched. Never logged.
   * @param options per-dispatch options (#321). Today that is a
   *        NARROWING-ONLY channel subset — see {@link NotifyOptions}, which
   *        states at length what it cannot do. OMITTING IT REPRODUCES THE
   *        PRE-#321 BEHAVIOUR EXACTLY, which is why the existing call sites
   *        did not move.
   */
  async notify(
    eventKey: string,
    userId: string,
    data: unknown,
    options?: NotifyOptions,
  ): Promise<void> {
    const event = findEvent(eventKey);

    if (!event) {
      // `debug`, not `warn`: the overwhelmingly likely cause is a key that
      // was legitimately retired, raised by a code path nobody updated, and
      // an unknown event is defined to be harmless. A `warn` here would train
      // operators to ignore this logger.
      this.logger.debug(
        `Ignoring notification for unknown event '${eventKey}'.`,
      );
      return;
    }

    this.schedule(() =>
      this.dispatchToUser(event, userId, data, options),
    );
  }

  /**
   * Raise a notification for one user and AWAIT ITS DELIVERY.
   *
   * The awaited sibling of {@link notify}: same registry lookup, same recipient
   * resolution, same single gate in `dispatch()`, same never-rejects
   * containment. The ONE difference is that it does not detach — when this
   * promise resolves, every channel has been attempted and every delivery row
   * has been written.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS EXISTS, BECAUSE IT IS THE DECISION MOST LIKELY TO BE UNDONE
   * ---------------------------------------------------------------------------
   *
   * A reader who has just absorbed this file's header — which argues at length
   * that dispatch SHOULD be detached — will reasonably ask why there is now a
   * method that isn't, and be tempted to delete it in favour of `notify`. Here
   * is the answer, so that deletion is at least an informed one.
   *
   * The caller this exists for is a JOB HANDLER (epic #254; the broadcast
   * fan-out of epic #319 is the first). `JobHandler.process` is contracted so
   * that "returning normally means the work is done and durable; do not return
   * before the writes this job is responsible for have committed"
   * (`apps/api/src/jobs/job-handler.interface.ts`). A handler built on
   * `notify()` would violate that contract three ways at once:
   *
   *   1. It would leave N dispatches in flight AFTER `process()` returned.
   *   2. The worker would then mark the job row `succeeded` for work that had
   *      not happened — the queue's record would assert a lie, which is worse
   *      than a failure, because a failure retries and a lie does not.
   *   3. A SIGTERM would drop everything past the {@link SHUTDOWN_DRAIN_MS}
   *      5 s drain, with no job row left claiming responsibility for it.
   *
   * AND `flush()` IS NOT A SUBSTITUTE, which is the other reflex worth heading
   * off. `flush()` awaits every dispatch in flight — including every unrelated
   * one raised by any concurrent request — and it LOOPS until the set drains.
   * Under a broadcast that set is being refilled continuously, so the loop has
   * no bound: a handler awaiting it would be waiting on other people's work,
   * for an unbounded time, and would still have no per-dispatch outcome.
   *
   * ---------------------------------------------------------------------------
   * WHEN NOT TO USE IT
   * ---------------------------------------------------------------------------
   *
   * NEVER FROM A REQUEST PATH. This is the "plain inline-and-awaited" shape the
   * header rejects: it puts a mail server's latency inside an HTTP request, and
   * a hung transport holds a Fastify request open for its full timeout. It is
   * for BACKGROUND WORKERS that own their own concurrency and need backpressure
   * — which is exactly the property a chunked fan-out wants and a controller
   * does not. If you are in a controller or a service called by one, use
   * {@link notify}.
   *
   * NEVER REJECTS, by the same mechanism as `notify`: both route their work
   * through {@link runContained}. A dispatch failure is a log line and, where
   * one could be written, a `notification_deliveries` row — never an exception
   * reaching the job handler, which would fail and retry the whole job over one
   * recipient's bad mailbox.
   *
   * It is deliberately NOT tracked in {@link inFlight}: that set exists so an
   * orderly shutdown can drain work NOBODY IS AWAITING. This work has an
   * awaiting owner by definition, and that owner — not this service — decides
   * what to do about it on shutdown.
   *
   * @param eventKey a key from `NOTIFICATION_EVENTS`. Unknown is a no-op that
   *        records nothing, exactly as in `notify`.
   * @param userId the recipient's account.
   * @param data the event's payload, passed to the template untouched.
   * @param options the narrowing-only per-dispatch options; see
   *        {@link NotifyOptions}.
   */
  async notifyNow(
    eventKey: string,
    userId: string,
    data: unknown,
    options?: NotifyOptions,
  ): Promise<void> {
    const event = findEvent(eventKey);

    if (!event) {
      this.logger.debug(
        `Ignoring notification for unknown event '${eventKey}'.`,
      );
      return;
    }

    await this.runContained(() =>
      this.dispatchToUser(event, userId, data, options),
    );
  }

  /**
   * Raise a notification for an EMAIL ADDRESS THAT MAY HAVE NO ACCOUNT.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS EXISTS AT ALL (#128, and the design problem of that issue)
   * ---------------------------------------------------------------------------
   *
   * `allowlist.invitation` is sent to somebody an administrator has just
   * authorised to sign in. By definition they have no user row, no
   * `user_settings` row and no open tab — that is what being newly allowlisted
   * MEANS — so `notify(eventKey, userId, data)` has nothing to pass as
   * `userId`, and there are no stored preferences to resolve.
   *
   * Two ways to handle that were on the table:
   *
   *   1. **REJECTED — let the event bypass preference resolution.** A flag on
   *      the registry entry, or a branch in `dispatch`, saying "this one skips
   *      the gate". That puts a documented hole in the ONE place the
   *      `mandatory` override and the sparse absent-key contract are enforced,
   *      and the hole is selected by a string. Every future event is then one
   *      copied line away from silently opting out of preferences for
   *      recipients who DO have them. The gate is only a gate if there is no
   *      way around it.
   *
   *   2. **CHOSEN — a second way to BUILD a recipient, feeding the same gate.**
   *      This method resolves a `NotificationRecipient` and hands it to the
   *      identical `dispatch`. Nothing about resolution changes: preferences
   *      are still read, `resolveChannels` still runs, `mandatory` still
   *      overrides. For a recipient with no account the preferences are simply
   *      empty — and empty resolves to the registry's `defaultEnabled`, which
   *      is the correct answer for somebody who has never had a settings row
   *      to express an opinion in. That is not a bypass; it is the sparse
   *      contract's own definition of "absent".
   *
   * ---------------------------------------------------------------------------
   * AND IT LOOKS THE ADDRESS UP FIRST, WHICH IS THE PART THAT MATTERS
   * ---------------------------------------------------------------------------
   *
   * The danger in (2) is not the no-account case, which has no preferences to
   * ignore. It is the case where the address TURNS OUT to belong to an
   * account: an admin re-adds an address that already has a user (the initial
   * admin bypasses the allowlist entirely and can be allowlisted afterwards;
   * an entry can be removed and added again). Dispatching that as an
   * account-less recipient would deliver to a real user while ignoring the
   * preferences they actually set — exactly the weakening #128 forbids.
   *
   * So this looks the address up, and if it resolves to an account it hands
   * off to the ordinary user path. Preference resolution is therefore never
   * skipped for anybody who has preferences. The cost is one indexed query on
   * a path that is already detached from the caller.
   *
   * NEVER REJECTS, and never joins the caller's transaction — same guarantees
   * as {@link notify}, by the same mechanism (`schedule`).
   *
   * @param eventKey a key from `NOTIFICATION_EVENTS`. Unknown is a no-op.
   * @param email the recipient's address. Matched case-insensitively, because
   *        the allowlist stores addresses lower-cased while `users.email`
   *        holds whatever the OAuth provider returned.
   * @param data the event's payload, passed to the template untouched.
   * @param options the narrowing-only per-dispatch options (#321), carried
   *        here as well as on {@link notify} so the two public paths cannot
   *        end up with different capabilities — the divergence this method's
   *        whole design (one gate, two ways of building a recipient) exists to
   *        avoid. See {@link NotifyOptions}.
   */
  async notifyAddress(
    eventKey: string,
    email: string,
    data: unknown,
    options?: NotifyOptions,
  ): Promise<void> {
    const event = findEvent(eventKey);

    if (!event) {
      this.logger.debug(
        `Ignoring notification for unknown event '${eventKey}'.`,
      );
      return;
    }

    this.schedule(() => this.dispatchToAddress(event, email, data, options));
  }

  /**
   * Raise a notification for EVERYBODY WHO CAN ACT ON IT — issue #288, epic
   * #254.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS EXISTS: AN OPERATIONAL FAILURE HAS NO USER ID
   * ---------------------------------------------------------------------------
   *
   * Every entry point above resolves ONE recipient the caller already knows:
   * `notify` is handed a user id, `notifyAddress` an address. That works
   * because the events they were built for are facts ABOUT a person — you
   * signed in, you were invited, your roles changed.
   *
   * `jobs.job_failed`, `nodes.node_offline` and `db_backup.backup_failed` are
   * not. A job that exhausted its retries, a worker that stopped heartbeating
   * and a backup that never finished are facts about the DEPLOYMENT, and the
   * question "who should hear about this?" has no user id in it. The honest
   * answer is WHOEVER CAN ACT ON IT — and in this application, "can act on it"
   * is spelled as a permission.
   *
   * ---------------------------------------------------------------------------
   * WHY A PERMISSION AND NOT A ROLE
   * ---------------------------------------------------------------------------
   *
   * The alternative — "send it to the Admin role" — is one string shorter and
   * wrong for the same reason the Settings UI Pattern (CLAUDE.md, rule 3)
   * insists a card's `permission` field be the exact string the controller
   * enforces rather than an approximation of it.
   *
   *   * A ROLE IS A BUNDLE SOMEBODY ELSE OWNS. A deployment that adds an
   *     `Operator` role holding `db_backup:read`, or splits `Admin` in two, has
   *     changed who can act on a failed backup — and a role-addressed
   *     notification would keep mailing the old bundle, silently, with nothing
   *     to fail and nothing to notice. Roles are seeded data a fork edits;
   *     permission strings are the contract the API is written against.
   *
   *   * THE PERMISSION IS ALREADY THE ANSWER TO THIS EXACT QUESTION. Passing
   *     `PERMISSIONS.DB_BACKUP_READ` here means the audience for "your backup
   *     failed" is, BY CONSTRUCTION, the set of people
   *     `db-backup.controller.ts` would let look at the backup. There is no
   *     second definition of that audience to drift from the first.
   *
   *   * IT COMPOSES WITH RBAC RATHER THAN AROUND IT. Grant a role the
   *     permission and its holders start receiving the event; revoke it and
   *     they stop. Nothing in this file, and no notification-specific list,
   *     has to be edited for either.
   *
   * ---------------------------------------------------------------------------
   * WHAT IT IS NOT: A SECOND DISPATCH PATH
   * ---------------------------------------------------------------------------
   *
   * This resolves a SET OF USER IDS and then fans out through
   * {@link dispatchToUser} — the identical method `notify` uses. The preference
   * gate, the `mandatory` override, the admin policy, the delivery rows and the
   * per-channel containment are therefore the SAME CODE, not a parallel
   * implementation of it. That is the same argument `notifyAddress` makes: a
   * new way of BUILDING a recipient is safe; a new way of DELIVERING to one is
   * a second place the gate can be forgotten.
   *
   * ONLY ACTIVE USERS. `isActive: false` is a deactivated account — somebody
   * who cannot sign in and therefore cannot act on any of this. Note this is a
   * DIFFERENT question from the one {@link loadRecipient} deliberately refuses
   * to answer: there, dropping an inactive recipient would silently defeat a
   * `mandatory` event aimed AT that account. Here the account is not the
   * subject of the event at all, it is a candidate audience for somebody else's
   * incident, and an audience of people who cannot log in is not an audience.
   *
   * ZERO RECIPIENTS IS A `debug` LOG AND A NO-OP, not a warning. A template
   * deployment can perfectly legitimately have nobody holding `nodes:read`
   * because it runs no worker nodes; warning about that on every sweep would
   * train operators to ignore the log line that matters.
   *
   * NEVER REJECTS — including when the RECIPIENT QUERY ITSELF THROWS, which is
   * the failure mode unique to this method. The whole body runs inside
   * {@link runContained} via {@link schedule}, and the query has its own
   * try/catch so a database blip is one log line rather than an unresolvable
   * dispatch. Every call site of this method is a failure path already (a
   * backup that failed, a sweep that found a dead node); a throw from here
   * would turn one failure into two.
   *
   * @param eventKey a key from `NOTIFICATION_EVENTS`. Unknown is a no-op that
   *        records nothing, exactly as in `notify`.
   * @param permission the permission string — use `PERMISSIONS` from
   *        `common/constants/roles.constants.ts`, never a literal, and use THE
   *        SAME ONE the controller for this area enforces.
   * @param data the event's payload, passed to the template untouched.
   * @param options narrowing-only channels, plus `alsoNotifyUserIds` for an
   *        audience that is "the permission holders AND this specific person".
   *        See {@link NotifyPermissionHoldersOptions}.
   */
  async notifyPermissionHolders(
    eventKey: string,
    permission: string,
    data: unknown,
    options?: NotifyPermissionHoldersOptions,
  ): Promise<void> {
    const event = findEvent(eventKey);

    if (!event) {
      this.logger.debug(
        `Ignoring notification for unknown event '${eventKey}'.`,
      );
      return;
    }

    this.schedule(() =>
      this.dispatchToPermissionHolders(event, permission, data, options),
    );
  }

  /**
   * {@link notifyPermissionHolders}, AWAITED — issue #288, epic #254.
   *
   * Stands to `notifyPermissionHolders` exactly as {@link notifyNow} stands to
   * {@link notify}: same registry lookup, same recipient resolution, same fan
   * out through `dispatchToUser`, same never-rejects containment. The ONE
   * difference is that it does not detach — when this promise resolves, every
   * recipient's channels have been attempted and every delivery row written.
   *
   * ---------------------------------------------------------------------------
   * ⚠ IT EXISTS FOR EXACTLY ONE CALLER, AND THAT CALLER IS A `process.exit(0)`
   * ---------------------------------------------------------------------------
   *
   * `DatabaseRestoreService.swap()` finishes a restore by exiting, so that a
   * supervisor can start a process whose connection pool is built against the
   * promoted database. A DETACHED dispatch raised just before that exit is
   * simply dropped: `schedule()` puts the work on a microtask, `exitProcess`
   * tears the process down, and the shutdown drain in {@link onModuleDestroy}
   * never runs because nothing is shutting Nest down — the process is ending.
   *
   * The result would be the worst possible failure for a `mandatory` event:
   * `db_backup.restore_completed` would appear to be wired, would pass every
   * unit test of the registry and the templates, and would deliver nothing at
   * all, in production, only on the path that matters.
   *
   * So the restore AWAITS this, and the ordering — swap, then notify, then exit
   * — is spelled out at that call site as well as here, because it is the thing
   * a later refactor will silently break.
   *
   * LEGITIMATE HERE, AND STILL FORBIDDEN IN A REQUEST PATH, for the reason
   * {@link notifyNow} gives: this is a background path that owns its own
   * lifetime, not a controller with a client waiting on a socket.
   *
   * Like `notifyNow`, deliberately NOT tracked in {@link inFlight}: that set
   * exists to drain work nobody is awaiting, and this work has an awaiting
   * owner by definition.
   */
  async notifyPermissionHoldersNow(
    eventKey: string,
    permission: string,
    data: unknown,
    options?: NotifyPermissionHoldersOptions,
  ): Promise<void> {
    const event = findEvent(eventKey);

    if (!event) {
      this.logger.debug(
        `Ignoring notification for unknown event '${eventKey}'.`,
      );
      return;
    }

    await this.runContained(() =>
      this.dispatchToPermissionHolders(event, permission, data, options),
    );
  }

  /**
   * Wait for every scheduled dispatch to finish.
   *
   * The shutdown drain, and the seam tests use to assert on what a
   * fire-and-forget `notify` eventually did — without it, a test would be
   * reduced to polling or to an arbitrary `setTimeout`, which is how a suite
   * acquires flakes.
   *
   * Loops rather than awaiting the set once, because a dispatch may schedule
   * further work; awaiting a snapshot would return while that work is still
   * running.
   */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /**
   * Finish what has been started, within a bound.
   *
   * Without this, an orderly shutdown drops every in-flight notification —
   * and an orderly shutdown is the COMMON case (a rolling deploy), so the
   * fire-and-forget model would lose notifications routinely rather than only
   * on a crash.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.inFlight.size === 0) return;

    this.logger.log(
      `Draining ${this.inFlight.size} in-flight notification dispatch(es).`,
    );

    let timer: NodeJS.Timeout | undefined;

    // The timer is `unref`'d so it can never be the reason the process stays
    // alive, and cleared in `finally` so a fast drain does not leave a pending
    // handle behind for a test runner to complain about.
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
      timer.unref?.();
    });

    try {
      await Promise.race([this.flush(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (this.inFlight.size > 0) {
      // Their `queued` rows stay `queued`, which is the evidence trail
      // described in notification-delivery.service.ts.
      this.logger.warn(
        `Shutdown drain timed out with ${this.inFlight.size} dispatch(es) ` +
          `unfinished; their delivery records remain 'queued'.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Detach a unit of work from the caller.
   *
   * THE SINGLE PLACE THE INLINE/QUEUED DECISION LIVES. Swapping this body for
   * an enqueue is the entire change if a durable queue is ever justified;
   * `notify` and `dispatchToUser` do not move.
   *
   * The deferral and the never-throws containment both live in
   * {@link runContained}, which this shares with the awaited `notifyNow` path
   * (#321) so the two cannot drift apart. What is left HERE is the part that
   * is genuinely about detaching: the promise is stored in `inFlight` — the
   * already-contained one, so there is no window in which an unhandled
   * rejection can escape — and removed when it settles, which is what lets the
   * shutdown drain finish work whose caller is long gone.
   */
  private schedule(work: () => Promise<void>): void {
    const task = this.runContained(work);

    this.inFlight.add(task);
    void task.finally(() => {
      this.inFlight.delete(task);
    });
  }

  /**
   * Run a unit of work such that its promise CANNOT REJECT.
   *
   * ONE COPY OF THE NEVER-THROWS GUARANTEE, shared by the detached path
   * ({@link schedule}, and so `notify`/`notifyAddress`) and the awaited one
   * ({@link notifyNow}). Both make the identical promise to their callers, and
   * a promise made in two places is a promise that can be weakened in one of
   * them — a `catch` narrowed here, a rethrow added there — with the two
   * entry points then differing in a way no test of either would notice. So
   * they share this rather than each holding a try/catch of their own.
   *
   * Note what is NOT here: `inFlight` bookkeeping. Whether a dispatch is
   * tracked for the shutdown drain depends on whether anybody is awaiting it,
   * which is the caller's question, not this function's — see `notifyNow` for
   * why it opts out.
   *
   * `Promise.resolve().then(work)` rather than calling `work()` here for the
   * reason {@link schedule} gives: it keeps the deferral independent of what
   * the work happens to do synchronously first. For `notifyNow`, where the
   * caller is awaiting anyway, the extra microtask is invisible.
   */
  private runContained(work: () => Promise<void>): Promise<void> {
    return Promise.resolve()
      .then(work)
      .catch((err: unknown) => {
        // Reaching here means something below threw despite every layer being
        // written not to. That is a bug worth an `error`, and it is still
        // contained: on the detached path the caller returned long ago, and on
        // the awaited path the caller gets a resolved promise rather than a
        // rejection that would fail an entire job over one recipient.
        this.logger.error(
          `Notification dispatch failed unexpectedly: ${describeThrown(err)}`,
        );
      });
  }

  /**
   * Resolve the recipient from their account, then dispatch.
   *
   * SPLIT FROM {@link dispatch} so the no-account case (#128's
   * `allowlist.invitation`, where there is no user row and `userId` is null on
   * the delivery record) is a different way of BUILDING a
   * `NotificationRecipient` rather than a second copy of the fan-out, the
   * preference gate and the containment rules.
   */
  private async dispatchToUser(
    event: NotificationEventDef,
    userId: string,
    data: unknown,
    options?: NotifyOptions,
  ): Promise<void> {
    const user = await this.loadRecipient(userId);

    if (!user) {
      // No user, no address, no delivery row: `recipient` is NOT NULL and
      // there is nothing truthful to put in it. Logged because a notification
      // raised for a user id that does not exist is a caller bug (or a user
      // deleted between the action and this dispatch — a real race, given the
      // dispatch is detached).
      this.logger.warn(
        `Cannot dispatch '${event.key}': user ${userId} was not found.`,
      );
      return;
    }

    await this.dispatch(event, user, data, options);
  }

  /**
   * Resolve the audience from a permission, then fan out to it.
   *
   * SPLIT FROM the two public entry points for the same reason
   * {@link dispatchToUser} is split from `notify`/`notifyNow`: the detached and
   * the awaited callers must share ONE body, or the day somebody fixes a
   * de-duplication bug in one of them the other keeps it.
   *
   * ⚠ EVERY RECIPIENT IS DISPATCHED INDEPENDENTLY. `dispatchToUser` can throw
   * — `loadRecipient` issues a query, and a query can fail — and one recipient
   * whose row could not be read must not silence the notification for everybody
   * after them in the set. The outer `runContained` would catch it, but it would
   * catch it by ABANDONING THE LOOP, which is the wrong containment boundary for
   * a fan-out. Hence the per-recipient try/catch.
   *
   * SEQUENTIAL, like `dispatch`'s channel loop and for the same reason: the
   * audiences here are administrators of one deployment (single digits, in
   * practice), so there is no latency worth parallelising for, and sequencing
   * keeps one event's log lines adjacent. The bounded-pool fan-out in
   * `broadcast-chunk.handler.ts` exists because a BROADCAST addresses every
   * user in the database; this does not.
   */
  private async dispatchToPermissionHolders(
    event: NotificationEventDef,
    permission: string,
    data: unknown,
    options?: NotifyPermissionHoldersOptions,
  ): Promise<void> {
    const holders = await this.resolvePermissionHolders(event, permission);

    if (holders === null) return;

    // THE UNION AND THE DE-DUPLICATION, in one place and before anything is
    // dispatched. A `Set` keyed on the user id is the whole mechanism: the
    // actor who triggered a restore AND holds `db_backup:read` is one
    // recipient, not two. See `NotifyPermissionHoldersOptions`.
    const recipients = new Set(holders);

    for (const extra of options?.alsoNotifyUserIds ?? []) {
      recipients.add(extra);
    }

    if (recipients.size === 0) {
      // `debug`, NOT `warn`. A deployment running no worker nodes legitimately
      // has nobody holding `nodes:read`, and a warning on every ten-minute
      // sweep is how a log stops being read. See the public method's header.
      this.logger.debug(
        `'${event.key}' has no recipient: no active user holds '${permission}'.`,
      );
      return;
    }

    for (const userId of recipients) {
      try {
        await this.dispatchToUser(event, userId, data, options);
      } catch (err) {
        this.logger.error(
          `Dispatching '${event.key}' to ${userId} failed; the remaining ` +
            `recipient(s) are unaffected: ${describeThrown(err)}`,
        );
      }
    }
  }

  /**
   * The user ids of every ACTIVE account holding `permission` through any role.
   *
   * ONE INDEXED QUERY, not a role lookup followed by a user lookup: the join
   * runs in the database, where `user_roles`, `role_permissions` and the unique
   * index on `permissions.name` already are. Selecting ONLY `id` matters as
   * much as the join does — this is a failure path, and pulling settings blobs
   * or profile rows for an audience the caller may not even dispatch to would
   * make an incident more expensive to report than to have.
   *
   * Returns `null` — not `[]` — WHEN THE QUERY ITSELF FAILED, and the
   * distinction is load-bearing: `[]` means "nobody holds this permission",
   * which is an ordinary, silent outcome, while `null` means "we do not know
   * who holds it", which is a logged failure and must not be mistaken for an
   * empty audience.
   */
  private async resolvePermissionHolders(
    event: NotificationEventDef,
    permission: string,
  ): Promise<string[] | null> {
    try {
      const holders = await this.prisma.user.findMany({
        where: {
          isActive: true,
          userRoles: {
            some: {
              role: {
                rolePermissions: { some: { permission: { name: permission } } },
              },
            },
          },
        },
        select: { id: true },
      });

      return holders.map((holder) => holder.id);
    } catch (err) {
      // A LOG LINE, NEVER AN EXCEPTION. The caller is already reporting a
      // failure; a throw here would replace their failure with this one.
      this.logger.error(
        `Cannot dispatch '${event.key}': resolving the holders of ` +
          `'${permission}' failed: ${describeThrown(err)}`,
      );

      return null;
    }
  }

  /**
   * Resolve an email address to a recipient, preferring the account behind it.
   *
   * THE ORDER IS THE SECURITY PROPERTY. The account lookup happens FIRST, and
   * an address with an account is dispatched as that account — with its stored
   * preferences — rather than as an anonymous address. See {@link
   * notifyAddress} for why the reverse would be a hole in the preference gate.
   */
  private async dispatchToAddress(
    event: NotificationEventDef,
    email: string,
    data: unknown,
    options?: NotifyOptions,
  ): Promise<void> {
    let existing: { id: string } | null;

    try {
      // `findFirst` with a case-insensitive `equals` rather than `findUnique`:
      // `users.email` is unique but stored with the provider's casing, while
      // the caller's address (an allowlist entry) is lower-cased. A
      // case-sensitive miss here would silently produce the anonymous path for
      // a user who does have preferences, which is the one outcome this lookup
      // exists to prevent.
      existing = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: { id: true },
      });
    } catch (err) {
      // ABORT, DO NOT FALL BACK. Falling through to the anonymous path here
      // would mean a transient database error downgrades a preference-checked
      // send into an unchecked one — a gate that fails OPEN. Failing closed
      // costs at most one undelivered notification, and the database is also
      // where the delivery record would have gone, so nothing is being
      // silently lost that would otherwise have been recorded.
      this.logger.error(
        `Cannot dispatch '${event.key}': resolving the recipient address ` +
          `failed: ${describeThrown(err)}`,
      );
      return;
    }

    if (existing) {
      // A real account. Ordinary path, ordinary preference resolution.
      await this.dispatchToUser(event, existing.id, data, options);
      return;
    }

    // Genuinely no account. `preferences: {}` is not a bypass: under the
    // sparse absent-key contract an absent preference resolves to the event's
    // `defaultEnabled`, which is precisely the right answer for somebody who
    // has never had a settings row. `mandatory` still applies, and a channel
    // that cannot reach an account-less recipient — the browser channel, whose
    // `resolveTo` returns the user id — skips itself.
    await this.dispatch(
      event,
      { userId: null, email, preferences: {} },
      data,
      options,
    );
  }

  /**
   * Read the recipient's address and preferences in ONE query.
   *
   * The settings blob is read RAW, through `user_settings.value`, and
   * deliberately NOT through `UserSettingsService.getSettings`, for three
   * independent reasons — any one of which would be disqualifying:
   *
   *   1. `getSettings` CREATES A ROW when none exists. A read on a
   *      fire-and-forget send path must not write, and materialising a
   *      settings row as a side effect of sending an email is precisely the
   *      "silently materialises preference blobs" failure #125 warns about.
   *   2. Its response projection lists the namespaces it knows and would drop
   *      `notifications` entirely.
   *   3. `userSettingsSchema.parse` STRIPS unknown keys, so the namespace
   *      would not survive the parse even if the projection kept it. (That
   *      schema is #126's to widen, on the write side; resolution does not
   *      depend on it, which is why preference READING works today with no
   *      change to the settings module.)
   *
   * Returns `null` when there is no such user.
   */
  private async loadRecipient(
    userId: string,
  ): Promise<NotificationRecipient | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        userSettings: { select: { value: true } },
      },
    });

    if (!user) return null;

    // NO `isActive` GATE, DELIBERATELY. Skipping deactivated accounts is a
    // POLICY, it is not stated anywhere in #109/#125, and putting it here
    // would make it a hidden one: `security.role_changed` is mandatory
    // precisely so that a privilege change is never silent, and a silent drop
    // in the dispatcher would defeat that for the accounts an incident review
    // is most likely to care about. If an offboarded mailbox is gone, the send
    // bounces and the delivery record says so — which is a visible answer
    // rather than an invisible one. Whoever raises an event decides whether it
    // applies (#128).
    return {
      userId: user.id,
      email: user.email,
      preferences: readNotificationPreferences(user.userSettings?.value),
    };
  }

  /**
   * Fan one event out to a resolved recipient's enabled channels.
   *
   * Channel-agnostic and recipient-agnostic: this is the method #128's
   * no-account path will call with `{ userId: null, ... }`.
   */
  private async dispatch(
    event: NotificationEventDef,
    recipient: NotificationRecipient,
    data: unknown,
    options?: NotifyOptions,
  ): Promise<void> {
    // THE ADMIN GATE (#226), read ONCE per dispatch and carried in the context
    // below. Both halves of the browser decision — which channels to fan out to,
    // and whether the streamed event may raise an OS toast — are then derived
    // from the SAME snapshot, so a policy change mid-dispatch cannot produce a
    // row whose `toast` flag disagrees with the decision that wrote it.
    //
    // `getPolicy` never throws and degrades to the permissive default; see its
    // own comment for why that direction, on a path whose whole purpose is to
    // make sure a privilege change is not silent.
    const policy = await this.policy.getPolicy();

    // THE GATE. `resolveChannels` applies the admin policy, then the sparse
    // absent-key contract and the `mandatory` override; nothing else in this
    // file consults a preference or a policy. One resolution point, one gate.
    let channels = resolveChannels(event, recipient.preferences, policy);

    // -------------------------------------------------------------------------
    // THE PER-DISPATCH NARROWING (#321, epic #319) — AND WHY IT IS *HERE*
    // -------------------------------------------------------------------------
    //
    // An admin composing a broadcast picks the medium ("email only"), and that
    // choice has to reach the dispatcher somehow. It arrives as
    // `NotifyOptions.channels` and is applied RIGHT HERE: as a set intersection
    // against the list the gate above already produced, and before the
    // every-channel-muted check below.
    //
    // NOT BY WIDENING `resolveChannels`, WHICH IS THE LOAD-BEARING PART.
    // `resolveChannels` is a PURE FUNCTION SHARED WITH
    // `GET /api/notifications/events` — the endpoint that builds the per-user
    // preferences matrix, which has no per-dispatch subset and never will.
    // Adding the parameter there would put a dispatch-time concept into the
    // function the preferences page calls, and would invite the next caller to
    // pass it from the wrong side of that seam.
    //
    // Intersecting an ALREADY-RESOLVED list is also what makes "this can only
    // ever narrow" STRUCTURALLY TRUE rather than a property someone has to
    // re-verify every time this file changes: there is no path from here by
    // which a channel `resolveChannels` did not return can be delivered over.
    // A requested channel the event does not declare, one the admin policy
    // dropped, one the user muted — each is simply an element with nothing to
    // intersect with.
    //
    // AND IT PERMITS NARROWING A `mandatory` EVENT, DELIBERATELY. That looks
    // like a hole in the flag and is not: `mandatory` binds the RECIPIENT, not
    // the sender. It means "the user may not mute this", not "the sender may
    // not choose a medium" — an admin picking email for an announcement is not
    // a user opting out of it. The rule that a CRITICAL broadcast must include
    // the in-app channel is a composition rule about one product surface, so it
    // is enforced in the admin API's DTO (#324), not here.
    //
    // Say the consequence plainly rather than leaving it implied: a future call
    // site that bypasses that DTO could send `admin.broadcast_critical`
    // email-only, and no durable in-app record of it would exist. If that
    // becomes a real risk — a second composer, a scripted sender — the answer
    // is a check at THAT entry point, not a special case in this intersection,
    // which would make `mandatory` mean two different things in two files.
    if (options?.channels) {
      const requested = new Set(options.channels);
      channels = channels.filter((channel) => requested.has(channel));
    }

    if (channels.length === 0) {
      // Every channel muted — or narrowed away to nothing by `options.channels`
      // above, which lands here on purpose rather than in a branch of its own:
      // "nothing left to deliver over" is one outcome however it was reached.
      // No rows: nothing was attempted, and recording a "we did not try" row
      // per muted event would fill the table with the absence of activity.
      this.logger.debug(
        `'${event.key}' resolved to no enabled channel for user ` +
          `${recipient.userId ?? '(no account)'}.`,
      );
      return;
    }

    const context: NotificationDispatchContext = {
      event,
      recipient,
      data,
      policy,
    };

    // SEQUENTIAL, not `Promise.all`. Two channels at most today, so there is
    // no latency worth parallelising for, and sequencing keeps the log lines
    // for one notification adjacent and ordered — which matters when the
    // question being answered is "what happened to this one event?". Failure
    // containment does not depend on it either way: each iteration is
    // independently wrapped below.
    for (const channel of channels) {
      await this.deliverOne(context, channel);
    }
  }

  /**
   * One (event, recipient, channel) attempt, with its delivery record.
   *
   * EVERY EXIT FROM THIS METHOD IS NORMAL. It has no throwing path, so one
   * channel's failure can never prevent the next channel's attempt.
   */
  private async deliverOne(
    context: NotificationDispatchContext,
    channel: NotificationChannel,
  ): Promise<void> {
    const { event, recipient } = context;
    const sender = this.senders.get(channel);

    if (!sender) {
      // A channel the registry declares with no transport implemented —
      // `browser` on `security.role_changed`, until #127. NO DELIVERY ROW, and
      // `debug` not `warn`: this is the documented, expected state
      // (notification-events.ts: "declaring a channel before its
      // implementation lands is safe — it simply has nowhere to go"). A failed
      // row per event would fill the table with a known, deliberate gap and
      // bury the real failures an operator is looking for.
      this.logger.debug(
        `No transport registered for channel '${channel}'; ` +
          `skipping '${event.key}'.`,
      );
      return;
    }

    const to = sender.resolveTo(recipient);

    if (!to) {
      // The channel cannot reach this recipient at all. Still no row:
      // `NotificationDelivery.recipient` is NOT NULL and exists to answer
      // "where did this go?", so filling it with a placeholder to record a
      // non-attempt corrupts the one column that must stay literal.
      this.logger.warn(
        `No '${channel}' address for user ${recipient.userId ?? '(no account)'}; ` +
          `skipping '${event.key}'.`,
      );
      return;
    }

    // Written BEFORE the attempt. See notification-delivery.service.ts for why
    // the extra write is worth it. `null` means the row could not be written;
    // the send proceeds anyway and the mark* calls below become no-ops.
    const deliveryId = await this.deliveries.queue({
      eventKey: event.key,
      userId: recipient.userId,
      recipient: to,
      channel,
    });

    // Declared with its type rather than left to inference from the assignment
    // inside the `try`: a bare `let result;` is an evolving `any`, which would
    // silently stop typechecking `result.messageId` below.
    let result: ChannelDeliveryResult;

    try {
      result = await sender.deliver(context, to);
    } catch (err) {
      // BELT AND BRACES. `NotificationChannelSender.deliver` is contracted not
      // to throw and today's one implementation does not — but #125's
      // never-throws guarantee has to hold for a channel written later by
      // somebody who did not read that contract, and this is where that is
      // enforced rather than assumed.
      const error = `Channel '${channel}' threw: ${describeThrown(err)}`;
      this.logger.error(`Delivery of '${event.key}' failed: ${error}`);
      await this.deliveries.markFailed(deliveryId, error);
      return;
    }

    if (!result.success) {
      const error =
        result.error ?? `Channel '${channel}' reported a failure with no message.`;

      // `warn`, not `error`: a refused send is usually an operator-side
      // configuration or mailbox problem, not a fault in this service. The
      // event key and channel are here; the address, the subject and the body
      // are not — they belong in the delivery record, which is the controlled
      // place for them.
      this.logger.warn(
        `Delivery of '${event.key}' over '${channel}' failed: ${error}`,
      );

      await this.deliveries.markFailed(deliveryId, error);
      return;
    }

    await this.deliveries.markSent(deliveryId, result.messageId);
  }
}
