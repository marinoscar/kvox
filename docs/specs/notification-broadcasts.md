# Admin Notification Broadcasts

> Epic #319, issues #320–#325 (#320 the `NotificationBroadcast` schema and the
> `broadcasts:*` permission pair, #321 the two registry events plus
> narrowing-only channel selection and `notifyNow()`, #322 the broadcast email
> and browser templates, #323 the `admin.broadcast.start` /
> `admin.broadcast.chunk` fan-out handlers, #324 the admin API, #325 the
> admin page, composer and visual baselines). Database-level tests for the
> claim compare-and-swap and the audience under concurrency are tracked
> separately as #326 — see [Verification](#verification).
>
> Implemented in `apps/api/prisma/schema.prisma` (the `NotificationBroadcast`
> model and `NotificationBroadcastStatus` enum),
> `apps/api/src/notifications/notification-events.ts` (`admin.broadcast`,
> `admin.broadcast_critical`),
> `apps/api/src/notifications/notification.types.ts` (`NotifyOptions`),
> `apps/api/src/notifications/notifications.service.ts` (`notifyNow`, the
> narrowing intersection in `dispatch()`),
> `apps/api/src/notifications/broadcasts/` (`broadcast-audience.ts`,
> `broadcasts.controller.ts`, `broadcasts.service.ts`, `broadcasts.module.ts`,
> `dto/`, `handlers/broadcast-start.handler.ts`,
> `handlers/broadcast-chunk.handler.ts`),
> `apps/api/src/email/templates/broadcast.email.ts`,
> `apps/api/src/notifications/channels/email-notification.channel.ts` and
> `browser-notification.channel.ts` (the `EVENT_EMAIL_TEMPLATES` /
> `EVENT_BROWSER_TEMPLATES` registrations), and `.github/workflows/
> visual-baselines.yml`. The admin page (`apps/web/src/pages/Admin/
> BroadcastsPage.tsx`, `components/admin/BroadcastComposer.tsx`,
> `services/broadcasts.ts`) is #325's slice of this epic and is described here
> at the level of what the API contract requires of it; it is being built in
> parallel with this document and is not asserted as merged in this checkout.

## 1. What this is, and what it is not

A broadcast is a message an administrator composes once, in the app, and
that reaches **every active user** in the deployment — over whatever
channels that deployment already supports (email, the in-app bell, Web
Push) — sent immediately or scheduled for a future time.

It is deliberately narrow, and the boundary is worth stating before anything
else because most of the rejected-alternatives section (§10) is this
boundary being asked to move and declining to:

- **Not marketing.** There is no template library, no HTML body, no rich
  media, no click-tracking. One plain-text message, rendered the same way
  every time.
- **Not segmented.** Every broadcast goes to all active users. No role
  filter, no user picker, no saved audience. "All active users" is the
  entire targeting model.
- **Not templated at read time.** The composed `title` and `body` are frozen
  into the row at create time, exactly as `Notification.title`/`.body`
  freeze what a triggered event said. A later rename of a product or a
  rewording of house style does not retroactively change what a past
  broadcast is remembered as having announced.
- **Not editable after creation.** There is no `PATCH /:id`. Content is
  frozen at compose time; cancel-and-recreate expresses "I want to say this
  differently" without an edit path that could race the fan-out mid-flight.

What it reuses, deliberately, is everything else: the existing job queue
(epic #254) for the fan-out, the existing per-user dispatcher
(`notifications.service.ts`) for delivery, the existing preference matrix and
admin kill switch for what a recipient actually receives, and the existing
email/browser channel implementations for rendering. This epic adds a
one-way, all-users trigger onto that stack; it does not stand up a second
notification system beside it.

## 2. Two registry events, not one flag

`NOTIFICATION_EVENTS` gains two entries:

```ts
{ key: 'admin.broadcast',          label: 'Announcements',
  channels: ['email', 'browser', 'push'], defaultEnabled: true }
{ key: 'admin.broadcast_critical', label: 'Important announcements',
  channels: ['email', 'browser', 'push'], defaultEnabled: true, mandatory: true }
```

The obvious-looking alternative — one `admin.broadcast` event with a
per-send "important" boolean — was rejected, and the reason is structural
rather than stylistic.

`NotificationEventDef.mandatory` is a **static registry property**, and it
is not decoration: `isChannelEnabled` (notification-preferences.ts) and
`policyChannels` (notification-policy.ts) both branch on it, and each branch
is a security gate — the first decides whether a *stored user preference*
may mute this event at all, the second whether an *operator's deployment-wide
kill switch* may. Making the flag dynamic (readable per send) would push a
value the composer chooses into the gate that decides whether a recipient
may mute an event at all — the exact coupling `mandatory` exists to keep out
of reach of anything but the registry file.

Two keys is also **the only representation** under which
`/settings/notifications`' preferences matrix can show both things at once: a
muteable row the user may switch off (`admin.broadcast`), and an unmuteable
one rendered disabled with its reason (`admin.broadcast_critical`). A single
event carrying a per-send flag has exactly one row on that matrix, and that
row has to lie in one direction or the other — either it offers a toggle
some sends will ignore, or it hides a toggle most sends would honour. Because
the matrix is registry-driven (one declaration, three consumers — see that
file's own header), both keys appear there automatically with no separate
edit.

The pair is otherwise identical: same channels, same default. The only
difference is who may mute them.

## 3. The audience

Every broadcast targets the same population, defined by one function used by
every reader:

```ts
// apps/api/src/notifications/broadcasts/broadcast-audience.ts
export function audienceWhere(cutoff: Date): Prisma.UserWhereInput {
  return {
    isActive: true,
    createdAt: { lte: cutoff },
  };
}
```

`GET /admin/broadcasts/audience`, the start handler's `recipientsTargeted`
count, and the chunk handler's keyset paging **all call this one function**.
That is the entire point of factoring it out: a count taken against a
different predicate than the pages actually walk is what makes a progress
bar lie. Concretely, if the count used `isActive: true` alone while the
paging added `createdAt <= cutoff`, the admin UI would show a progress bar
climbing to 940/1000 and stopping there forever, with every job row
`succeeded` and no error anywhere — nothing broken except the number, and the
number is the only thing an operator has to go on. The inverse drift (a
count *narrower* than the paging) is worse, reporting more delivered than
were ever targeted.

The two clauses answer two different questions, one live and one frozen:

- `isActive: true` is evaluated **live, on every page**. A user deactivated
  mid-fan-out stops receiving the broadcast from the next chunk onward —
  deactivation is a statement about *now*. This is also why
  `recipientsTargeted` can legitimately exceed `recipientsDispatched`: the
  schema's own comment calls the former "targeted at send time," never
  "should have received it."
- `createdAt <= audienceCutoff` is **frozen**, stamped once by the start
  handler's compare-and-swap (§4) at the moment sending begins. Without it a
  fan-out on a busy deployment would keep discovering newly-created rows to
  page through as it walks — the query changes under it, so the run may
  never terminate, and "who got this?" stops being an answerable question
  after the fact.

That freeze defines two windows explicitly, and both are intentional rather
than edge cases discovered later:

- A user created **between `create` and `start`** (i.e. before the fan-out
  claims the broadcast and stamps the cutoff) **is included** — the rule is
  "everyone who exists once sending starts," not "everyone who existed when
  an admin clicked compose."
- A user created **between `start` and the last chunk** **is excluded** —
  they signed up after the audience was frozen, and by definition are not
  behind the cursor a resumed run would ever revisit.

## 4. Lifecycle and the state machine

```
draft --(unreachable in this epic)--> …
scheduled --[start handler CAS]--> sending --[chunk handler, empty page]--> sent
   |                                  |
   +--[cancel: status in (scheduled,sending)]--> canceled
                                       |
                                  (a handler error sets `failed` via the
                                   job queue's own retry/terminal path,
                                   not a broadcast-specific write)
```

Six statuses (`NotificationBroadcastStatus`): `draft`, `scheduled`,
`sending`, `sent`, `canceled`, `failed`. `draft` is unreachable by any route
this epic ships — no compose endpoint writes it, no handler reads it — and it
stays in the Postgres enum on purpose: adding a value to a live enum later is
a migration, and `ALTER TYPE … ADD VALUE` cannot run inside the same
transaction Prisma wraps a migration in. Paying for the slot now, while it
costs nothing, buys the escape hatch for a future "save and finish composing
later" feature without a migration on a table that by then holds real data.
Do not remove it as dead code — it is deliberately dead, not left over.

**Every transition that matters is a compare-and-swap, never a
read-then-write**, because a read-then-write has a real window a concurrent
actor can land in:

```ts
// admin.broadcast.start — the claim
await prisma.notificationBroadcast.updateMany({
  where: { id, status: 'scheduled' },
  data: { status: 'sending', startedAt: now, audienceCutoff: now },
});
// count === 0 => somebody else already decided this broadcast's fate; no-op.
```

```ts
// POST /:id/cancel — the recall
await prisma.notificationBroadcast.updateMany({
  where: { id, status: { in: ['scheduled', 'sending'] } },
  data: { status: 'canceled', canceledAt: new Date() },
});
```

```ts
// the chunk handler's terminal write, on an exhausted audience
await prisma.notificationBroadcast.updateMany({
  where: { id, status: 'sending' },
  data: { status: 'sent', finishedAt: new Date() },
});
```

Why `updateMany` with the status **in the `WHERE`**, rather than a
`findUnique` followed by an `if` and an `update`: consider the read-then-write
shape spelled out concretely —

```ts
const b = await findUnique(...);          // status: 'scheduled'
if (b.status !== 'scheduled') return;     // ← passes
// ... an admin cancels here: status := 'canceled' ...
await update({ data: { status: 'sending' } });   // ← resurrects it
```

The window between the read and the write is small and it is real, and what
falls into it is a cancelled announcement going out to everybody anyway.
Putting the status in the `WHERE` instead makes the claim and the cancel race
**inside the database**, where Postgres guarantees exactly one of two
concurrent statements against the same row wins. `updateMany` rather than
`update` is deliberate too: `update` requires a unique match and throws
`P2025` when it finds none, which would turn "somebody already claimed this"
into a failed job and a retry; `updateMany` reports `count: 0`, a fact to
branch on rather than an exception to interpret.

This is also what makes an operator's manual rerun of an already-succeeded
start job (available from the admin Jobs dashboard) harmless: on rerun the
broadcast is `sending`, `sent`, or `canceled` — never `scheduled` — so the
swap matches nothing and re-stamps nothing. That matters specifically for
`audienceCutoff`, which is written in the same statement that consumes the
only status a claim can happen from, so no second execution can move it —
a rerun cannot silently redefine who the broadcast was for while chunks are
already walking the original population.

**What cancel can and cannot un-send.** Cancel is the only recall mechanism
this feature has, and it is honest about its limits. It flips the status
(above); it does **not** delete queued `jobs` rows — deleting one would race
a worker claiming it, whereas the status guard is durable, and letting a
stale job run to a no-op keeps the `jobs` table's audit trail of what the
fan-out actually did intact. Both handlers re-check status (`process()`'s
first real branch in the chunk handler; every claim in the start handler) and
return without sending anything once it no longer reads `sending`. But the
chunk handler also re-checks status **mid-page**, every
`STATUS_RECHECK_INTERVAL` (25) recipients, specifically so a cancel does not
have to wait out an entire 200-recipient chunk before it takes effect. The
consequence stated plainly, because both the API description and the admin
UI's confirm dialog must say it too: **cancelling a `sending` broadcast may
still let up to one sub-group's worth of recipients already dispatched or
mid-dispatch go out** before the next status check lands. Cancel stops
everything after that point; it cannot recall what already left.

## 5. Fan-out

Two job types under `apps/api/src/notifications/broadcasts/handlers/`, each
self-registering from its own `onModuleInit()` per the job queue's
`handlers/README.md` convention — no migration, no enum arm, no worker
change, and both appear in the admin Jobs dashboard automatically once
labelled (`job-type-labels.ts`: `admin.broadcast.start` → "Broadcast start",
`admin.broadcast.chunk` → "Broadcast delivery"). Neither declares
`nodeResultSchema` or `persistNodeResult`, so both are **server-only** —
correct, since a remote worker node has no database access and no mail
credentials.

**`Job.scheduledFor` is the scheduler.** `POST /` enqueues the start job with
`scheduledFor: broadcast.scheduledFor ?? undefined`. A deferred job is
invisible to every replica's claim query until its time arrives, using the
`[status, scheduledFor, priority, createdAt]` index already built for exactly
this. "Send this Friday at 09:00" is therefore a `jobs` row that survives
every restart and redeploy between now and Friday, with no second scheduler
introduced (§10 covers the rejected `@Cron` sweeper).

**`admin.broadcast.start`** — dedup **left on** (the queue's default), so a
double-clicked "Send now" cannot enqueue two start jobs for the same subject
while one is pending or running. It loads the broadcast (a missing row is a
no-op, not a failure — the admin may have deleted it while the job sat
queued), performs the compare-and-swap in §4, counts the frozen audience with
`audienceWhere()` into `recipientsTargeted`, and enqueues the first chunk.

**`admin.broadcast.chunk`** — enqueued with **`skipDedup: true`**, and this
is load-bearing in a way that fails **silently** if it is ever dropped.
Chunk *n* enqueues chunk *n+1* from inside its own `process()`, while chunk
*n* is itself still `running`. With dedup on (the default), `buildDedupKey`
computes the identical key for two jobs sharing a `type`/`subjectType`/
`subjectId`, the active-dedup unique index rejects the second insert, and
`JobsService.enqueue` resolves the conflict by handing back **the job already
in flight — chunk n, the one doing the enqueueing.** Nothing throws. Chunk n
returns normally and its row goes `succeeded`. The observable result: the
broadcast stops dead after one page (up to 200 recipients out of however many
were targeted), every job row reports `succeeded`, `lastError` is empty, and
there is no exception anywhere to point at — the only visible symptom is a
progress counter that stopped, indistinguishable from a send that finished.
Both enqueue sites (the start handler's first chunk, and the chunk handler's
own successor) pass `skipDedup: true`, and the handler spec asserts it
explicitly on both, because this is exactly the class of failure no other
test would notice.

Each chunk pages `users` with `audienceWhere(audienceCutoff)` plus
`id > cursorUserId`, `orderBy: { id: 'asc' }`, `take: 200`
(`BROADCAST_CHUNK_SIZE`) — keyset pagination on the primary key because it is
unique, immutable, and already indexed, so a page boundary is stable under
concurrent inserts and deletes; `createdAt` is deliberately not the paging
column because two rows can share a timestamp and a boundary drawn on it can
silently skip or repeat a user. Dispatch inside a page runs at a bounded
concurrency of 5 (`BROADCAST_SEND_CONCURRENCY`) through `notifyNow` (§7), not
`Promise.all` over the whole page — an unbounded pool would open as many
concurrent SMTP conversations as the page has members, trading a mail
provider's patience for latency nobody is waiting on.

**Duplicate over drop, and the bound is a number.** The cursor
(`cursorUserId`) and the dispatched counter are advanced in **one update,
after** a page (or sub-group) has actually been dispatched — never before.
Under the job queue's at-least-once contract, a process killed mid-chunk
therefore re-sends **at most `BROADCAST_CHUNK_SIZE` (200) recipients** on
retry, because the cursor still points at the start of the page that was
interrupted. The reverse ordering — advancing the cursor first, then
dispatching — was considered and rejected: the identical crash would instead
**skip** up to 200 people, and that failure is strictly worse on every axis
that matters. The duplicate is bounded, visible (two `notification_deliveries`
rows for the same recipient), and self-correcting (the send simply
completes). The drop is bounded by the same number but **invisible and
permanent** — nothing records who was skipped, the cursor moved, the job
succeeded, the counters look plausible, and the only evidence is 200 people
who never heard about the maintenance window. It cannot be detected after the
fact and cannot be repaired without re-sending to everyone. Tightening the
bound (flushing the cursor every 25 recipients instead of every 200) is a
constant change — the outer loop already walks in `STATUS_RECHECK_INTERVAL`
sub-groups for cancel latency — not a restructuring; it is not done today
because 200 duplicate notifications on a crash whose rate is "a deploy" is an
acceptable worst case against the cost of a round trip per 25 recipients.

## 6. Per-broadcast channel selection

An admin composing a broadcast picks a medium ("email only for this one").
That choice reaches the dispatcher as `NotifyOptions.channels` (a new,
optional fourth parameter on `notify`/`notifyNow`/`notifyAddress`) and is
applied as a **set intersection immediately after** the existing
`resolveChannels(event, preferences, policy)` call inside `dispatch()`, and
**before** the "every channel muted" empty-array check:

```ts
let channels = resolveChannels(event, recipient.preferences, policy);

if (options?.channels) {
  const requested = new Set(options.channels);
  channels = channels.filter((channel) => requested.has(channel));
}
```

**Why the intersection sits here and never inside `resolveChannels` itself**
is the load-bearing decision. `resolveChannels` is a pure function shared
with `GET /api/notifications/events`, the endpoint that builds the per-user
preferences matrix — an endpoint with no notion of a per-dispatch subset and
no reason to ever gain one. Adding the parameter there would push a
dispatch-time concept into the function the preferences page calls, and would
invite some future caller to pass it from the wrong side of that seam.
Intersecting an **already-resolved** list, instead, makes "this can only ever
narrow" **structurally true** rather than a property that has to be
re-verified on every change to this file: there is no path by which a
channel `resolveChannels` did not return can survive the filter. A channel
the event doesn't declare, one the admin kill switch dropped, one the
recipient muted — each is simply an element with nothing to intersect
against. Omitting `options` entirely reproduces pre-#321 behaviour exactly,
which is why the three pre-existing `notify()` call sites (`auth.service.ts`,
`users.service.ts`, `allowlist.service.ts`) are untouched.

**Interaction with `mandatory` and the kill switch.** The intersection is
permitted to narrow a `mandatory` event — that looks like a hole in the flag
and is not. The ruling: **`mandatory` binds the recipient, not the sender.**
It means "the user may not mute this," never "the sender may not choose a
medium" — an admin picking email-only for an announcement is not a user
opting out of it. See `docs/specs/browser-notifications.md` §5 for the
kill-switch/inbox-row split this composes with (`policyChannels` exempts
mandatory events from the deployment-wide switch; `isChannelEnabled` exempts
them from stored user preferences) — that mechanism is unchanged by this
epic and is not restated here.

**Where the `critical ⇒ browser` rule actually lives.** The one composition
rule this application needs — a broadcast marked critical must include the
`browser` channel, because the durable `notifications` row *is* the in-app
delivery in this application, and a critical announcement that skips it
leaves no record a recipient can ever go back and read — is **not** enforced
in the dispatcher. It lives in `CreateBroadcastDto`'s `superRefine` (#324):
`critical && !channels.includes('browser')` is a 400. This is deliberately a
policy about what one product surface (the admin composer) may compose, not
a mechanism inside the gate that decides what a `mandatory` event's
intersection may drop — folding it into `dispatch()` would make `mandatory`
mean two different things in two files. **The honest caveat, stated in the
DTO's own comment and repeated here:** a future call site that reaches
`notifyNow('admin.broadcast_critical', …)` without passing through this DTO
could still narrow to `['email']` alone, and nothing in the dispatcher would
stop it. If that becomes a real risk, the fix is a check at that new entry
point, not a special case inside the shared intersection.

## 7. Why `notifyNow` exists

This is the decision in this epic most likely to be looked at later and
"simplified" back out — so the case for it is made in full, once, here.

`notify()` is detached by design (see `notifications.service.ts`'s own
header): it schedules the dispatch on a microtask via `schedule()` and
returns immediately, before any channel has run. A chunk handler built on
`notify()` would violate the job queue's own contract three ways at once:

1. It would leave up to 200 dispatches in flight **after** `process()`
   returned to the worker.
2. The worker would then mark the job row `succeeded` for work that had not
   happened yet — the queue's record would assert something false, which is
   worse than a recorded failure, because a failure retries and a lie does
   not.
3. A SIGTERM moments later would drop everything past `notifications.
   service.ts`'s 5-second shutdown drain (`SHUTDOWN_DRAIN_MS`), with no job
   row left claiming responsibility for any of it.

`notifyNow(eventKey, userId, data, options?)` is the awaited sibling that
closes all three gaps: identical registry lookup, identical recipient
resolution, identical single gate in `dispatch()`, identical never-rejects
containment (both route through the same `runContained` helper) — the one
difference is that it does not detach. When the promise resolves, every
channel has been attempted and every delivery row has been written. It is
for background workers that own their own concurrency and need backpressure;
**never from a request path** — it puts a mail transport's latency inside
whatever awaits it, and a controller awaiting it would hold a Fastify request
open for as long as the transport takes to answer.

**`flush()` is not a substitute, and this is the other reflex worth heading
off explicitly.** `flush()` awaits *every* dispatch currently in
`NotificationsService`'s in-flight set — including every unrelated one raised
by any concurrent request in the process — and it **loops** until that set
drains completely. Under a broadcast the set is being refilled continuously
by the fan-out itself (and by anything else the process happens to be
notifying at the same time), so the loop has no bound: a handler awaiting
`flush()` would be waiting on other people's work, for an unbounded time,
with no per-dispatch outcome to report even once it returned. `notifyNow` is
deliberately **not** tracked in the `inFlight` set `flush()` drains — that
set exists so an orderly shutdown can drain work *nobody is awaiting*; a
`notifyNow` call already has an awaiting owner (the chunk handler), and that
owner, not the notifications service, decides what happens to it on
shutdown.

## 8. Content model

The body a recipient reads is **plain text**, split into paragraphs on blank
lines (`\r?\n\s*\r?\n`); a single newline inside one paragraph is treated as
a soft wrap from the composer's textarea and joined with a space, because
mail clients reflow to the reader's window width and a hard-wrapped paragraph
would otherwise double-wrap into a ragged column on a phone. Empty
paragraphs are dropped.

**The escaping guarantee is structural, not a habit to remember.** This is
the first template in the codebase rendering content the codebase did not
write — every other template (`role-changed.email.ts`, for instance) knows
exactly what it is saying; this one renders a title and body an administrator
typed minutes earlier, and has no idea what is in them. `broadcast.email.ts`
splits the body into paragraphs and interpolates each one as a *value* into
the `html` tagged literal (`safe-html.ts`), which escapes it by construction.
The result is an array of `SafeHtml` fragments concatenated by the tag
system, so there is no point in the file where markup is assembled by string
concatenation — and therefore no point at which `SafeHtml.
unsafeFromTrustedString` (the one escape hatch `safe-html.ts` exposes) would
even be reachable. It occurs in the file's own header exactly once, in a
sentence stating that it is never called; a reviewer greps for a call site
and finds none. Raw HTML bodies and a markdown subset were both rejected for
the same reason: either requires that escape hatch on admin-supplied input,
turning a compromised admin account into stored XSS in every recipient's
mailbox and in `notifications.body` — which the bell renders as text, so the
two channels would additionally disagree about what the message even was.

**The browser/push template is a projection with a shape guard, not a second
renderer.** `EVENT_BROWSER_TEMPLATES`'s `broadcastBrowserTemplate` does not
truncate and does not sanitize a link — `browser-notification.channel.ts`
already applies `MAX_TITLE_LENGTH`/`MAX_BODY_LENGTH` truncation and
`sanitizeLink` once, to the values it both stores and streams, so doing
either again here would be a second chance for the stored row and the toast
to disagree about what the message said. What the projection *does* do,
because it is the one thing a pure projection still must do itself, is
validate its input's shape (`typeof title === 'string' && typeof body ===
'string'`) and throw inside the try/catch `render()` wraps it in — a
malformed payload becomes a recorded delivery failure, never an unhandled
exception reaching a broadcast recipient's chunk. One entry in the map serves
**both** browser and push: `push-notification.channel.ts` imports
`EVENT_BROWSER_TEMPLATES` and `sanitizeLink` from the browser channel rather
than declaring its own, so `admin.broadcast`/`admin.broadcast_critical` need
no third registration — a one-line comment in that file exists specifically
so nobody adds one.

## 9. Operational limits

**Email provider rate limits, and why `provider-throttle.service.ts` does not
currently apply.** That throttle is tripped only by a channel handler
throwing `RateLimitError`, and the email channel's contract is to **never
throw** — a send failure becomes `{ success: false }` and a failed
`notification_deliveries` row, not an exception. So a broadcast fanning out
to a large audience gets no automatic backpressure from the provider-throttle
mechanism at all today. `BROADCAST_SEND_CONCURRENCY` (5, §5) is the first-order
defence in its place — a small, fixed concurrency bound inside each chunk.
Wiring the email channel into the throttle (having it classify a 429-shaped
provider response and throw `RateLimitError` instead of swallowing it) is a
named follow-up, out of scope for this epic.

**The SSE per-process boundary matters more here than for a single-recipient
event.** `notification-stream.service.ts`'s per-process fan-out (no replay,
no `Last-Event-ID`, one process's open connections only) is a property this
codebase already lived with for ordinary single-user notifications, where it
is invisible — one user, one process, usually one open tab. A broadcast makes
the same boundary visible at scale: across a multi-instance deployment, each
process only streams live-toast updates to the browser tabs connected to
*it*, so "did everyone's bell update instantly" is a per-process question,
not a deployment-wide guarantee — the durable `GET /api/notifications` read
and the row in Postgres are still the source of truth regardless of which
process handled a given recipient's dispatch.

**A `notification_deliveries` row cannot be attributed to a specific
broadcast**, and the detail view is honest about the resulting
approximation rather than pretending otherwise. `NotificationDelivery`
carries no broadcast id — adding one would mean a migration on the
fastest-growing table in the schema, plus threading a broadcast id from this
feature through `notifyNow` and into a dispatcher deliberately ignorant of
who is calling it, purely to make one admin screen's number exact (§10 has
the full rejection). Instead, `GET /:id` computes
`approximateDeliveryAttempts` as `groupBy(['channel', 'status'])` over
`notification_deliveries` filtered by this broadcast's `eventKey` and by
`createdAt` between `startedAt` and `finishedAt ?? now`. That window can
**over-count**: a second broadcast raised under the same event key while this
one is still sending contributes its rows to the same total, and nothing in
the schema can separate them. The field name says so on purpose
(`approximateDeliveryAttempts`, not `deliveries` or `stats`) and the UI
labels it "delivery attempts during this broadcast" for the same reason — a
shorter name would be read as exact by the next person who touches the
screen.

## 10. Rejected alternatives

- **A `notification_broadcast_recipients` join table**, tracking exact
  per-recipient delivery outcome. Rejected: one row per (broadcast, user)
  pair is unbounded growth keyed to user-base size on *every* broadcast sent
  — a 50,000-user deployment sending one broadcast a week is 2.6 million new
  rows a year for this feature alone — for a marginal gain over what
  `cursorUserId`/`audienceCutoff` plus the two counters already give: the
  queue's own at-least-once contract already bounds a replay to at most one
  chunk, so re-processing is inherently limited to users near the resume
  boundary, not the whole broadcast.
- **A `broadcastId` column on `notification_deliveries`**, for exact
  attribution in the detail view. Rejected: a migration on the
  fastest-growing table in the schema, plus threading a broadcast id through
  a dispatcher (`notify`/`notifyNow`) deliberately ignorant of its callers,
  to make one screen's number exact instead of approximate. See §9.
- **One job per recipient.** Right at a different scale, wrong here:
  thousands of `jobs` rows per broadcast make the admin dashboard unusable,
  give `job-history-purge` thousands of rows per send to grind through,
  render `job_stats_rollup`'s per-type averages meaningless (an "average
  broadcast job" would measure one email), and turn a single "Send now" into
  thousands of inserts.
- **One long-running job with an in-memory loop.** Resumes correctly enough
  and fails on everything around it: it holds a worker slot for the entire
  broadcast, starving a queue sized for human-triggered work; the
  lease-expiry sweep would need tuning to a runtime nobody can predict; and
  the Jobs page would show one perpetually-`running` row with no visible
  progress in it.
- **A `@Cron` scheduler instead of `Job.scheduledFor`.** Would duplicate
  what the queue's own `scheduledFor` column and its
  `[status, scheduledFor, priority, createdAt]` index already do durably,
  and would add a second place where "is it time yet?" is decided.
- **Widening `resolveChannels` to accept the per-dispatch subset.** Rejected
  — see §6. `resolveChannels` is shared with `GET /api/notifications/events`,
  which has no per-dispatch concept and should never grow one.
- **A `broadcast` value on `JobReason`.** `JobReason` is a three-member
  Prisma enum (`upload | rerun | backfill`); adding a fourth for a display
  string is a migration plus web-side `JOB_REASONS` array churn plus OpenAPI
  churn, for something the friendly label in `job-type-labels.ts` already
  carries to a human reading the dashboard. Both broadcast job types reuse
  `backfill`, exactly as `job-history-purge.task.ts` already does.
- **Markdown or raw HTML bodies.** Both require the `unsafeFromTrustedString`
  escape hatch on admin-supplied input somewhere, turning a compromised admin
  account into stored XSS in every recipient's mailbox (raw HTML) or
  requiring a hand-rolled inline-HTML emitter that is itself a new injection
  surface (a markdown subset) — and either has no meaning at all on the
  browser/push channels, whose content is plain strings. See §8.
- **`@mui/x-date-pickers`** for the schedule field. Rejected: a new
  dependency plus a locale adapter for one field, in a repo that has shipped
  none; a native `TextField type="datetime-local"` with `slotProps={{
  inputLabel: { shrink: true } }}` (the `FilterEditor.tsx` precedent) does
  the job.
- **Role targeting** (send to Admins only, Contributors only, …). Out of
  scope for this epic by design — "all active users" is the entire targeting
  model; a role filter is a real feature that would need its own audience
  predicate, its own UI, and its own answer to "what does the audience count
  mean now."
- **Reusing `system_settings:read`/`:write`** as the broadcast permission.
  Rejected: that pair is the kill switch's permission — configuring whether
  browser notifications are allowed at all — and mirroring it on the
  broadcasts settings card would advertise a permission the broadcasts
  controller never actually checks. `broadcasts:read`/`broadcasts:write` are
  their own pair, seeded to Admin only, matching the `jobs:*`/`nodes:*`/
  `users:*` convention for a collection resource.

## 11. Verification

| Claim | Covered by |
|---|---|
| `NotificationBroadcast`'s generated field set and `NotificationBroadcastStatus`'s enum members match the schema | `apps/api/test/broadcasts/broadcast-model.db.spec.ts` (asserted against `Prisma.NotificationBroadcastScalarFieldEnum`, generated from `schema.prisma`) |
| The `[status, scheduledFor]` and `[createdAt desc]` indexes and column defaults exist on the real table | `apps/api/test/broadcasts/broadcast-model.db.spec.ts` (the `resolveDbSuite`-gated half, real Postgres only) |
| Both event keys satisfy the registry's structural invariants (unique key, non-empty channels, `mandatory` implies `defaultEnabled`, `<area>.<event>` key shape) with **no edit** to the generic test | `apps/api/src/notifications/notification-events.spec.ts` — its loops iterate `NOTIFICATION_EVENTS`, so the two new entries are covered automatically |
| `NotifyOptions.channels` narrows a three-channel event to the requested subset, cannot resurrect a policy-dropped or user-muted channel, and an explicit `[]` means no channels | `apps/api/src/notifications/notifications.service.spec.ts`, `describe('NotifyOptions.channels')` |
| A mandatory event is still narrowable by `options.channels` (the recipient-vs-sender ruling) | `apps/api/src/notifications/notifications.service.spec.ts`, `'a mandatory event still ignores stored preferences, and is still narrowable'` |
| `notifyNow()` resolves only after every channel has been attempted and every delivery row written, and shares `notify()`'s narrowing | `apps/api/src/notifications/notifications.service.spec.ts`, `describe('notifyNow()')` |
| The email template escapes every paragraph by construction and never calls `unsafeFromTrustedString` | `apps/api/src/email/templates/broadcast.email.spec.ts` |
| Both event keys map to the one `'broadcast'` email template and the one shared browser/push renderer | `email-notification.channel.ts` / `browser-notification.channel.ts` registrations, exercised via the handler specs' dispatch assertions |
| The start handler's claim puts `status` in the `WHERE`, stamps `startedAt`/`audienceCutoff` from one instant, counts with `audienceWhere()`, and enqueues the first chunk with `skipDedup: true` | `apps/api/src/notifications/broadcasts/handlers/broadcast-start.handler.spec.ts` |
| A compare-and-swap that claims nothing (already `sending`/`sent`/`canceled`) re-stamps nothing and enqueues nothing | `broadcast-start.handler.spec.ts`, `describe('when the compare-and-swap claims nothing')` |
| The chunk handler's status guard neutralises a cancelled, finished, deleted, or cutoff-less broadcast | `apps/api/src/notifications/broadcasts/handlers/broadcast-chunk.handler.spec.ts`, `describe('the status guard')` |
| Paging is keyset (`id > cursor`, `orderBy: id asc`), frozen at the cutoff, and skips inactive users | `broadcast-chunk.handler.spec.ts`, `describe('paging')` |
| Dispatch uses `notifyNow` (never the detached `notify`) with the broadcast's stored channels | `broadcast-chunk.handler.spec.ts`, `describe('dispatch')` |
| The cursor and dispatched counter advance together, in one update, after sends — never before | `broadcast-chunk.handler.spec.ts`, `describe('progress')` |
| A chunk enqueues its successor **only** with `skipDedup: true`, on a full page only, and finishes the broadcast on a short page | `broadcast-chunk.handler.spec.ts`, `describe('the chain')` |
| A cancel landing mid-page stops the chunk without waiting out the remainder and queues no successor | `broadcast-chunk.handler.spec.ts`, `describe('cancellation mid-page')` |
| A retried chunk resumes from the persisted cursor rather than replaying earlier pages | `broadcast-chunk.handler.spec.ts`, `describe('idempotence under at-least-once delivery')` |
| Every database error in either handler propagates (throws to fail) rather than being swallowed | Both handler specs, `describe('throw to fail')` |
| Literal routes (`/audience`, `/test`) resolve ahead of `/:id` through the real Nest router | `apps/api/test/broadcasts/broadcasts.integration.spec.ts`, `describe('literal routes resolve before :id')` |
| All seven routes require Admin + the correct `broadcasts:read`/`broadcasts:write` permission | `broadcasts.integration.spec.ts`, `describe('authorization')` |
| `critical: true` without `browser` in `channels` is a 400; the event key is derived and a client-supplied `eventKey` is ignored | `broadcasts.integration.spec.ts`, `describe('POST /admin/broadcasts validation')` |
| Cancel is a conditional `updateMany` (status in `WHERE`), 404 for a missing row vs. 409 for a wrong-status row, and deletes no queued job row | `apps/api/src/notifications/broadcasts/broadcasts.service.spec.ts`, `describe('cancel')` |
| Delete refuses with 409 while `sending`; a cancelled or sent broadcast can be deleted | `broadcasts.service.spec.ts`, `describe('remove')`; `broadcasts.integration.spec.ts`'s 409-on-cancel-of-sent case |
| `sendTest` dispatches to the caller only, writes no row, queues no job | `broadcasts.service.spec.ts`, `describe('sendTest')` |
| `audience()` counts with the same `audienceWhere()` the fan-out pages with | `broadcasts.service.spec.ts`, `describe('audience')` |
| The approximate delivery breakdown windows by event key and `[startedAt, finishedAt ?? now]`, and is empty before `startedAt` exists | `broadcasts.service.spec.ts`, `describe('get')` |
| Every state-changing route writes an audit event with identifiers and shape, **never the composed body** | `broadcasts.service.spec.ts` — each of `create`/`cancel`/`remove`/`sendTest`'s `'audits … without the body'` cases |

**What is not yet proven, honestly.** The compare-and-swap's *atomicity* —
that two concurrent `start` executions against the same broadcast really do
resolve to exactly one winner, that a chunk racing a cancel really cannot
flip `canceled` back to `sent` — is a property of Postgres row locking, not
of the handler code. Every spec listed above runs against a **mocked**
Prisma client, which can only show that the correct statement (status in the
`WHERE`) was constructed; it cannot demonstrate that the statement is
atomic under real concurrency, because a mock has no locking to observe.
Issue #326 tracks the database-level suite
(`apps/api/test/notifications/broadcasts/broadcast-fanout.db.spec.ts`, not
yet written) that seeds real rows, runs two overlapping `start` executions
and a cancel racing a chunk against a real Postgres instance, and asserts on
the outcome rather than the SQL shape. Until #326 lands, that specific
claim — the one whose failure mode is a duplicated announcement in every
user's inbox — rests on the reasoning in §4, not on an executed test.
