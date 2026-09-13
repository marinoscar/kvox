# Browser Notifications & Web Push

> Epic #215, issues #216–#233 (#216 brand icons and theme colours, #217
> manifest generation, #218 service worker with `injectManifest`, #219
> service-worker update prompt and PWA install prompt, #220 nginx caching and
> CSP, #221 the 8-state capability model, #222 `ServiceWorkerRegistration
> .showNotification()` display, #223 `notificationclick` deep-linking and
> mark-read, #224 foreground suppression and cross-tab dedup, #225 the
> notifications system setting and admin page, #226 server-side enforcement
> and non-admin exposure, #227 wiring the toggle into the client, #228
> widening `NOTIFICATION_CHANNELS` to include `push`, #229 push subscription
> storage and endpoints, #230 `PushNotificationChannel` and the SW push
> handler, #231 the iOS Add-to-Home-Screen walkthrough, #232 test hardening,
> #233 this document). Implemented in `apps/web/src/sw.ts`,
> `apps/web/pwa/manifest.ts`, `apps/web/pwa/service-worker.ts`,
> `apps/web/src/hooks/useNotificationCapability.ts`,
> `apps/web/src/services/browserNotifications.ts`,
> `apps/web/src/contexts/NotificationContext.tsx`,
> `apps/web/src/components/settings/NotificationSettings.tsx`,
> `apps/api/src/notifications/notification-policy.ts`,
> `apps/api/src/notifications/channels/push-notification.channel.ts`,
> `apps/api/src/notifications/push-subscription.service.ts`, and
> `apps/api/src/notifications/notifications.module.ts`.
>
> **On issues #219 and #231**: the epic lists them as prerequisites for this
> one ("needs all"), but at the time this document was written they live on
> unmerged branches (`feat/pwa-prompts`, `feat/ios-a2hs`) that this worktree
> does not contain — `apps/web/src/components/pwa/` and the iOS walkthrough
> panel do not exist here. Where this document describes the update handshake
> or the iOS install remedy, it describes the mechanism the merged code
> already exposes for them to attach to (`sw.ts`'s `SKIP_WAITING` listener,
> the `ios-needs-install` capability state), not components verified against
> this checkout. Re-verify those two sections once those branches merge.

> **Section 10 is not part of epic #215.** It documents the four operational
> events and the permission-addressed recipient rule added by issue #288 (epic
> #254). It lives here because this is the document that owns the shared
> notification framework's server side — the event registry, the admin policy,
> and the channel maps — and because the rule it establishes is a dispatcher
> rule rather than a jobs, fleet or backup one.
>
> **Section 11 is not part of epic #215 either.** It documents issue #355 —
> runtime-configurable VAPID keys, generated/rotated/enabled/disabled from the
> admin UI with no restart — which supersedes Section 9's original
> deploy-time-only description of how the push channel becomes active. It
> lives here rather than in a separate spec because it changes nothing about
> the channel itself (fan-out, failure handling, the id it mints all still
> apply unchanged), only how the key pair backing it is sourced.
>
> **Section 12 is not part of epic #215 either.** It documents issue #365 —
> the client actually creating a push subscription, an automatic permission
> prompt, an app-wide banner, and logout cleanup — none of which epic #215
> built, despite `sw.ts`'s own `pushsubscriptionchange` comment promising "the
> page re-syncs idempotently on every boot, which is the real mechanism." It
> reverses Sections 4 and 6's framing of when
> `Notification.requestPermission()` may run; see Section 12 for why, and for
> the gesture caveat that keeps a manual path alive alongside it. Implemented
> in `apps/web/src/services/pushSubscription.ts`,
> `apps/web/src/hooks/usePushSubscriptionSync.ts`,
> `apps/web/src/hooks/useBrowserNotificationPermission.ts`,
> `apps/web/src/components/notifications/NotificationPermissionBanner.tsx`,
> `apps/web/src/components/common/Layout.tsx`,
> `apps/web/src/services/browserNotifications.ts`,
> `apps/web/src/contexts/AuthContext.tsx`,
> `apps/web/src/components/settings/NotificationSettings.tsx`, and
> `apps/web/src/pages/UserNotificationsPage.tsx`.

## Why this shape, and not the obvious one

Three verified facts drive every decision below, and each rules out the
"just call `Notification`" design that would otherwise seem sufficient.

1. **`new Notification(...)` throws on Android Chrome.**
   `apps/web/src/services/browserNotifications.ts:136` is the constructor
   call, and Android requires every web notification to go through a service
   worker registration's `showNotification()` instead — there is no page-level
   path on that platform at all. A design with no service worker gets nothing
   on the single largest mobile browser.
2. **A web app manifest is a prerequisite, not an enhancement, on iOS.**
   Safari on iPhone and iPad grants the Notifications API only to a web app
   added to the Home Screen, which itself requires a manifest with
   `display: 'standalone'` (`apps/web/pwa/manifest.ts:85`). Before this epic
   `apps/web/public/` held no icon, no manifest and no service worker, so the
   entire iOS population got nothing, in a tab or otherwise.
3. **The SSE transport this app already had (epic #109) is liveness, not
   delivery.** `NotificationContext.tsx`'s own header states the ordering
   this design depends on: `GET /api/notifications` is the truth, the stream
   is liveness only ("no replay, no `Last-Event-ID`, per-process fan-out"),
   and `new Notification(...)` is decoration. A closed tab means no
   notification over SSE, and a phone's tab is essentially never open — so
   reaching a phone with the app closed needs a transport that survives the
   tab closing, which is what Web Push is for.

Put together: without a service worker, Android gets nothing; without a
manifest, iOS gets nothing; without Web Push, nobody gets anything with the
app closed. The "obvious" design — raise a page-level `Notification` when an
SSE frame arrives — was the epic's starting point (#109/#127) and is exactly
what this epic found insufficient on every axis but desktop-Chrome-with-a-tab-
open.

## 1. The PWA shell: one file that must never go stale

### 1.1 The manifest is generated from `APP_NAME`, never from an env var

`apps/web/pwa/manifest.ts`'s `buildManifest()` reads `APP_NAME`,
`THEME_COLOR` and `BACKGROUND_COLOR` from `@app/shared` — the same constants
`apps/web/vite.config.ts`'s `appName()` plugin substitutes into
`index.html`'s `%APP_NAME%`/`%THEME_COLOR%` tokens. Both derive from one
package because a `VITE_APP_NAME` env var was already rejected for the
HTML case, and the reasoning is unchanged for the manifest: an env var makes
the **deployment environment** a second source of truth for the product
name, so a build that forgets to set it disagrees with the wordmark the React
tree renders. `@app/shared` exists precisely so a fork renames the product by
editing three lines in one file (see [`packages/shared/README.md`](../../packages/shared/README.md));
a manifest with its own copy of the name would be a fourth line to forget.

`buildManifest()` is a function, not a frozen constant, for one concrete
reason: `apps/web/pwa/service-worker.ts` hands it straight to
`VitePWA({ manifest: buildManifest() })`, and a function is also the shape
`apps/web/src/__tests__/pwa/manifest.test.ts` needs to assert against. Two
fields carry real, non-cosmetic behaviour rather than styling:

- **`display: 'standalone'`** is the field iOS/iPadOS 16.4+ reads to decide
  whether the site may be installed to the Home Screen at all, and Safari
  grants the Notifications API only once it has been. Remove this line and
  epic #215 is unreachable on every iPhone and iPad — a platform-wide gap,
  not a styling nit.
- **`id: '/'`** is what the platform uses to decide whether a later visit is
  the *same* installed app. Pinning it explicitly means `start_url` can later
  change (a new marketing query param, a locale prefix) without the OS
  treating the result as a second, unrelated installation.

### 1.2 `injectManifest`, not `generateSW`

`apps/web/pwa/service-worker.ts`'s header states the reason directly:
`generateSW` writes the entire worker from the plugin config, so there is no
file to put a `push`, `notificationclick` or `pushsubscriptionchange` handler
in — and on Android those handlers, living in a service worker, are the
*only* way a notification can ever be shown. `generateSW`'s escape hatch,
`importScripts`, is worse than it looks: it splits ownership of one worker
across a generated file (owning the Workbox runtime config) and a hand-written
one (owning the push logic), and the two cannot see each other, so the
routing rules drift away from the push handlers silently — the first symptom
being a notification that never arrives, on a device the developer does not
have.

`buildServiceWorkerOptions()` (`apps/web/pwa/service-worker.ts:83-130`)
therefore sets `strategies: 'injectManifest'`, `srcDir: 'src'`,
`filename: 'sw.ts'`: one reviewable file, `apps/web/src/sw.ts`, into which
the plugin only substitutes the generated precache manifest
(`self.__WB_MANIFEST`, consumed at `sw.ts:67`). `globPatterns:
['**/*.{js,css,html,ico,png,svg,woff2}']` (`service-worker.ts:109`) is
deliberately narrow — `woff2` is there so an offline shell still renders in
Inter rather than a visibly different fallback font, and nothing under `/api`
can ever match, because `dist/` (what these patterns match against) is built
entirely from `apps/web` and contains nothing from the API at all.

`registerType: 'prompt'` (not `'autoUpdate'`) means a newly installed worker
waits rather than activating underneath a user mid-session — see
[Rejected alternatives](#rejected-alternatives). `sw.ts:122-126` already
listens for the `{ type: 'SKIP_WAITING' }` message the page half (#219) will
post once the user agrees, specifically so a worker shipped before that UI
lands is never permanently stuck in `waiting`.

### 1.3 Why `sw.js` must be served `no-cache`

`apps/web/nginx.conf`'s own comment calls this "the single most dangerous
item in the epic": the site-wide static-asset rule
(`location ~* \.(js|css|...)$ { expires 1y; add_header Cache-Control
"public, immutable"; }`, `apps/web/nginx.conf:64-67`) would otherwise apply
to `/sw.js` too, and a service worker a browser is told is immutable for a
year is a deploy the user may never receive — the app keeps serving the
precached shell of whatever revision first installed, with no remote remedy
short of a per-user cache purge. `apps/web/nginx.conf:48-54` carves out
exact-match `location = /sw.js` and `location = /registerSW.js` blocks ahead
of the regex rule (nginx evaluates exact matches first regardless of source
order) and marks both `Cache-Control: no-cache`, alongside a third exact
match for `/manifest.webmanifest` (`nginx.conf:58-61`) for the same reason —
a cached manifest is a cached app name and icon set.

*(Correcting a stale citation: epic #215's own body points at
`apps/web/nginx.conf:32-34` for the "expires 1y; immutable" rule. In this
worktree's actual file, lines 32-34 fall inside the **explanatory comment**
above the `/sw.js` exact-match block, not the immutable rule itself — that
rule is at `nginx.conf:64-67`, further down than the epic's line numbers
assume, evidently because the comment above it grew after that line count was
written. The behaviour the epic describes is correct; only the line numbers
had drifted.)*

Separately, `infra/nginx/nginx.conf:63-65` documents that nginx's
`add_header` **replaces** rather than merges: any `location` block adding a
header of its own loses every header the enclosing `server` block set,
including the CSP and HSTS headers at `infra/nginx/nginx.conf:66-90`. No
location block this epic added needed to be told this the hard way, but it is
the reason any *future* location block touching these routes must repeat
those headers rather than assume they inherit.

## 2. The no-auth-in-the-service-worker constraint

`apps/web/src/sw.ts:26-39` states the rule this whole file is built around:
**the service worker must never call the API.** It has no way to
authenticate, and any attempt to acquire one breaks the page. Two facts make
this true rather than merely convenient:

- The access token is **memory-only** — a private field on the `ApiClient`
  instance in `apps/web/src/services/api.ts`, never written anywhere the
  worker's separate execution context can read.
- The refresh cookie is scoped to `path: '/api/auth'`
  (`apps/api/src/auth/auth.controller.ts:40`) and **rotated on every use**. A
  worker that refreshed on its own would spend the one-shot refresh token
  behind the page's back; the page's next refresh would then present a token
  the server has already retired, and the user would be logged out **by their
  own service worker**.

Everything the worker needs from the API is therefore *pushed to it* — a Web
Push payload, or a `postMessage` from a page that already holds a token —
never fetched by it. This is what forbids the most natural-looking
implementation of `notificationclick`'s mark-read: the handler cannot call
`PATCH /api/notifications/:id/read` itself. Instead
(`sw.ts:159-173`) it either:

- focuses an already-open client and `postMessage`s the click, letting
  `NotificationContext.tsx`'s `message` listener (`NotificationContext.tsx:581-598`)
  call the exact `markRead`/`navigate` pair the in-page toast's own click
  handler calls, or
- when no page is open, `clients.openWindow()`s a fresh one with the
  notification id riding along as `?n=<id>`, for `NotificationContext.tsx`'s
  boot-time effect (`NotificationContext.tsx:624-635`) to read once the app —
  and a token — exist, stripping the param with `replace: true` afterward so
  a refresh cannot re-fire it.

Either way, the API call happens from the page, on the page's own token,
exactly as if the user had clicked the row in the bell. This is also why
`sw.ts`'s `notificationclick` handler re-validates `link` with
`isInternalLink` (`sw.ts:175-189`) even though `sanitizeLink` already
enforces root-relative-only at write time in
`apps/api/src/notifications/channels/browser-notification.channel.ts`: that
sanitizer's own comment argues a forgetful *future* consumer would have to be
unlucky to skip it, and a worker feeding an unsanitised value straight into
`clients.openWindow()` — a real navigation — is exactly that new consumer. A
row seeded by hand, or restored from a pre-sanitiser backup, is not trusted a
second time on faith.

## 3. Nothing under `/api` is ever precached

The complementary security rule, stated in the same file header
(`sw.ts:41-53`): Cache Storage is origin-scoped and outlives the session — it
is not cleared by logout and not partitioned per account. Precaching or
runtime-caching an authenticated JSON response leaves one user's data
readable by the next person to sign in on a shared device, long after the
token that fetched it expired. Two independent facts hold this line:

- `injectManifest.globPatterns` in `service-worker.ts:109` only ever matches
  built static assets (`js,css,html,ico,png,svg,woff2`) out of `dist/`, which
  never contains anything from the API — a different service entirely.
- The SPA navigation fallback registered at `sw.ts:92-96` explicitly
  denylists `/^\/api\//`, and the comment names exactly why narrowing that
  denylist would be dangerous: `/api/notifications/stream` is Server-Sent
  Events, which by design never ends. A handler that took it would hold a
  `fetch()` open for the stream's lifetime; the worker would never reach
  idle, the browser would eventually kill it as unresponsive, and the
  notification stream would die with it. `/api/docs` and
  `/api/storage/objects/:id/download` are named for the same reason — real
  server responses that must not be swapped for the cached SPA shell.

## 4. The 8-state capability model

Before #221, `BrowserNotificationPermission`'s four states
(`granted`/`denied`/`default`/`unsupported`) collapsed at least four
genuinely different situations into one `unsupported` bucket, each with a
remedy the others do not share — an iOS Safari tab (needs Home Screen
install, not a browser upgrade), an insecure context (needs HTTPS, nobody's
browser's fault), an administrator's kill switch (no client-side remedy
exists at all), and a service worker that failed to register (degraded, not
blocked — the page fallback may still work). `useNotificationCapability.ts`'s
own header is the fully-worked argument; the operative structure is:

```
resolveNotificationCapability(inputs):
  1. adminDisabled            -> 'admin-disabled'     (outranks everything)
  2. !isSecureContext         -> 'insecure-context'
  3. !hasNotification && !hasServiceWorker -> 'unsupported'
  4. isIos && !isStandalone   -> 'ios-needs-install'
  5-8. permission-shaped, decided together:
     denied  -> 'denied'
     default -> 'default'                              (prompt offered)
     granted, no SW registration -> 'sw-unavailable'   (degraded, not blocked)
     granted, SW registration    -> 'granted'
```

The order **is** the behaviour, not an implementation detail, because the
conditions are not mutually exclusive — an iPad in a Safari tab on plain HTTP
satisfies three of them simultaneously. It runs outermost-obstacle-first: an
administrator kill switch makes every downstream remedy unactionable, so it
must be checked before anything the user could otherwise be told to fix.

The one genuinely counter-intuitive placement is `sw-unavailable`, and
`useNotificationCapability.ts:84-119` documents why the "obvious" ordering —
worker trouble outranks everything permission-shaped, since Android's
Notifications API is service-worker-only — is wrong: the button that opens
the browser's permission prompt renders **only** in the `default` state
(`NotificationSettings.tsx:685-703`). If a missing registration preempted
`default`, a user whose worker failed to register could never reach the
prompt at all, and could never leave `default`. `sw-unavailable` is therefore
decided *after* permission is known to be `granted` — it describes a
granted-but-degraded device, not a pre-permission one, and it is the one
problem state whose control stays enabled (`browserChannelState`'s
`sw-unavailable` arm, `NotificationSettings.tsx:356-376`, sets `disabled:
false`).

`admin-disabled` is an **input**, not yet wired to a live fetch as of #221 —
`UseNotificationCapabilityOptions.adminDisabled` defaults to `false`
(`useNotificationCapability.ts:376-388`), and only the caller changes once
#227 wires `GET /api/notifications/config`'s real value through; the
precedence rule itself needed no edit when that landed.

## 5. The kill-switch / inbox-row split

`apps/api/src/notifications/notification-policy.ts`'s header states the
invariant of issue #226 precisely, and it is the single most important rule
in the admin-control surface: **the browser "channel" is two things**, and
the admin toggle may only ever switch off one of them.

1. A row in `notifications` — the durable, per-user inbox. **This is the
   delivery.**
2. An OS toast raised by the page or the worker. **This is decoration on top
   of it.**

`security.role_changed` is `mandatory: true` precisely so a privilege change
is never silent (`apps/api/src/notifications/notification-events.ts`,
enforced end-to-end since epic #109), and
`apps/api/src/notifications/channels/browser-notification.channel.ts:36-50`
is explicit: *"the server's obligation ends at a durable row the user can
find; the toast is a decoration on top of it."* So an admin who mutes browser
notifications must not thereby mute an audit-relevant inbox entry.

The mechanism is two separate functions in `notification-policy.ts`, never
one:

- **`policyChannels(event, policy)`** (`notification-policy.ts:178-190`)
  decides which *channels* the dispatcher calls at all. Mandatory events are
  exempt from this filter — dropping `browser` from a mandatory event's
  channel list would stop the dispatcher calling the browser channel, and the
  row would never be written, which is the one outcome this issue forbids.
- **`isBrowserToastAllowed(eventKey, policy)`** (`notification-policy.ts:131-136`)
  decides whether the OS toast fires, and it has **no** mandatory exemption:
  mandatory guarantees the user is *told*, which the durable row already does
  unconditionally, not that their operating system pops a bubble.

So for `security.role_changed` with the kill switch off: the row is written,
it is streamed, and it arrives carrying `toast: false`
(`NotificationContext.tsx:389-413`). The toast is suppressed; the bell, the
unread count, and the notification centre are not.

Enforcement is **server-side, in the value the stream frame carries**, not
client-side: `notification-policy.ts:56-60` explicitly rejects
"enforcing in the client only" — a client that merely chose not to raise a
`Notification` would leave the policy unenforced for any other stream
consumer and would make the operator's control a suggestion rather than a
gate. `NotificationContext.tsx:389-403` reinforces why this must be computed
per-frame rather than from the tab's own cached config: a long-lived tab's
`GET /api/notifications/config` can go stale the instant an administrator
flips the toggle, and nothing pushes an update to it — but every SSE frame's
`toast` flag is computed at *publish* time from the policy that held then, so
a stale client is harmless even if it still believes toasts are enabled.

`push` is explicitly ungated by this same file, and deliberately so
(`notification-policy.ts:159-174`): #228 widened `NotificationChannel`
structurally with no `NOTIFICATION_EVENTS` entry declaring `push` yet, so a
deployment-wide policy gate for it was left to #230, not claimed here ahead
of there being anything to gate.

## 6. How a non-admin learns the toggle's value

The admin card that *sets* this policy sits behind `system_settings:read`
(`apps/web/src/config/adminSections.tsx`, the "Notifications" card,
`permission: 'system_settings:read'` — the same string
`system-settings.controller.ts` enforces on its `GET`, matching its three
sibling admin cards). But `viewer` and `contributor` roles hold **no**
`system_settings:read` at all (`apps/api/prisma/seed.ts:91`), and every user
of every role needs to know whether the toggle is on, because it changes
whether asking the browser for permission is worth doing.

The answer is that a non-admin reads the toggle through a **different API
surface entirely**: `GET /api/notifications/config`
(`notifications.controller.ts:174-212`) is gated with plain `@Auth()` — no
permission at all, the same gate `GET /api/notifications/events` uses — and
returns:

```json
{ "browserEnabled": true, "pushEnabled": false, "vapidPublicKey": null }
```

`browserEnabled` is the administrator's deployment-wide switch;
`notifications.controller.ts`'s own operation description states the
rationale for the client: *"A client should not prompt for OS notification
permission when it is `false`: browser permission, once denied, cannot be
re-prompted, so prompting for a capability this deployment has switched off
spends a one-shot decision for nothing."* Per-event suppression is
deliberately **not** listed in this response — it travels with each
notification as `toast` on the SSE stream instead (Section 5), because a
long-lived tab holding a cached copy of this endpoint's response can never
re-enable something an administrator has muted mid-session.

Widening `system_settings:read` to every role was rejected — see
[Rejected alternatives](#rejected-alternatives) — because that permission
gates the *entire* settings document (jobs, nodes, database backup and
maintenance policy included), not just this one boolean. There is no
precedent in this codebase for a narrower read of one setting field to a
wider audience; #226 introduces one, purpose-built.

## 7. Foreground suppression and cross-tab dedup

Two independent mechanisms solve two independent problems, and neither
subsumes the other. `NotificationContext.tsx:414-462` states the distinction
directly:

- **"Is anyone about to miss it if we don't pop a toast?"** — a question
  about *this tab's current state*, re-evaluated on every genuinely-new
  arrival. The rule: show an OS notification only when **no** window of this
  registration is both `visible` **and** `focused`
  (`document.visibilityState === 'visible' && document.hasFocus()`, checked
  with `&&`, not `||`, because a fully-covered-but-focused window reports
  `hidden` and a visible background tab in the same window is not focused —
  both conditions together are what "the user is plausibly looking at this
  right now" actually means). A hidden or unfocused tab still gets exactly
  one toast; this check does nothing there.
- **"Has any tab of this origin already shown this exact notification?"** — a
  question about the shared browser state, answered once per arrival in
  `showAppNotification` (`browserNotifications.ts:259-295`) via
  `registration.getNotifications({ tag: notification.id })`. The stream
  publishes to every open connection, so a user with four tabs receives four
  frames for one event; without this check each tab would independently raise
  its own OS toast. Reading the registration's own notification list is
  registration-wide by construction — every tab of this origin shares one
  browser-maintained list, and `tag` is already the notification's id, so an
  existing entry can only be this exact notification. `tag` is applied
  identically on both delivery paths (`showPageNotification`'s
  `tag: notification.id`, `browserNotifications.ts:146`, and the SW path's
  matching `tag`, `browserNotifications.ts:299`), which is what makes the
  same collapsing key work regardless of which path raised the first copy.

This is also why cross-tab **leader election** was rejected as the
alternative — see [Rejected alternatives](#rejected-alternatives) — reading
the registration's own list needs no coordination protocol at all, because
the browser already maintains exactly one shared list per registration.

The Web Push path has its own version of the first check, done at the server
side of the same event, in the service worker's `push` handler
(`sw.ts:307-336`): if a client is both `visible` and `focused` when the push
arrives, that tab has *already* received the same event over SSE and shown
its own toast by the time the push physically lands, so `handlePush`
`postMessage`s the page instead of calling `showNotification` a second time.
This satisfies "the critical rule" `sw.ts:272-284` states in block capitals:
**every** code path through a `push` event must end in an awaited
`showNotification` or an equivalent substitute, because a `push` handler
that resolves without calling `showNotification` makes Chrome show its own
generic "This site has been updated in the background" notification instead
— worse than anything this app could show on purpose, so `postMessage`
deliberately counts as satisfying that rule rather than being a third,
silent path.

## 8. Why this epic doesn't touch `script-src`

`infra/nginx/nginx.conf:84` already states `script-src 'self'` permits
`/sw.js` per spec — a service worker script is same-origin JavaScript like
any other, so no CSP change was needed to allow it to load. What this epic
*does* add, at `infra/nginx/nginx.conf:86-90`, is `worker-src 'self'` and
`manifest-src 'self'`, explicit even though `default-src 'self'` already
covers both in spec-compliant browsers — Safari has historically required
`manifest-src` spelled out, and being explicit protects against a future
`default-src` change silently breaking the PWA. Deliberately out of scope:
bug #214's `script-src` relaxation. Keeping that boundary means this epic's
CSP changes can be reviewed, merged, and rolled back independently of an
unrelated, still-open bug.

## 9. Web Push: fan-out, failure handling, and the id it mints

`PushNotificationChannel` (`apps/api/src/notifications/channels/push-notification.channel.ts`)
is the third `NotificationChannelSender`, and the first that leaves this
process entirely: `BrowserNotificationChannel` writes a row and nudges a
socket this server holds open; this one hands an encrypted payload to a push
service (FCM, Mozilla's autopush, …) under no obligation to deliver it
promptly, ever, or to a tab that is even open — which is also the entire
reason it exists: it is the one channel that can reach a user with the app
closed.

**It writes its own `Notification` row rather than sharing one with the
browser channel** (`push-notification.channel.ts:38-75`).
`NotificationDispatchContext` carries no id threaded from a sibling channel's
`deliver()` call — channels are independently pluggable by design (add one,
remove one, reorder the factory array in `notifications.module.ts`, and
nothing else should care) — so depending on the browser channel having run
first, in the same dispatch, would be an undocumented coupling between two
channels meant to stay uncoupled. Today it would not even pay off: no
`NOTIFICATION_EVENTS` entry declares both `browser` and `push`, so the
id-collision case a shared id would prevent does not exist yet. The accepted
tradeoff, stated in the file's own header, is that a future event declaring
both channels would produce two separate rows — real, unlinked, and
deliberate until an event actually needs otherwise.

**Delivery is `Promise.allSettled`, never `Promise.all`** — one dead endpoint
among several devices must not stop the others, and must not turn "3 of 4
devices got this" into a thrown exception (`push-notification.channel.ts:288-303`).
Failure handling distinguishes two cases:

- **404/410** — the push service is saying, unambiguously, that this endpoint
  no longer exists (uninstalled, wiped profile, OS-level permission
  revocation). The subscription row is deleted immediately
  (`push-notification.channel.ts:339-352`); nothing short of re-subscribing
  can ever make it valid again.
- **Everything else** (429/5xx, network errors) — treated as "the endpoint
  might still be good," incrementing `failureCount`
  (`push-notification.channel.ts:363-376`) up to `MAX_PUSH_FAILURE_COUNT = 5`
  (`push-notification.channel.ts:109`) before the row is pruned. A push
  service having a bad minute must not cost a user their subscription, but a
  quietly-dead endpoint that never happens to return 404/410 must not
  accumulate forever either.

**`VAPID_SUBJECT` is optional; its absence degrades, it does not fail the
send.** `push-notification.channel.ts:266-287` falls back to a generic
`mailto:admin@example.com` and logs a warning, because `web-push`'s types
require a non-empty subject string but the field is purely advisory contact
metadata for a push-service operator — refusing to send over a missing
nicety would be a strange trade against "sent it, minus a courtesy."

**The channel is always registered, exactly like `email`/`browser` — see
Section 11 for why that changed.** Until issue #355,
`notifications.module.ts`'s factory pushed `PushNotificationChannel` into the
`NOTIFICATION_CHANNEL_SENDERS` array only when
`PushSubscriptionService.isEnabled()` — both VAPID keys present — returned
`true` **at boot**, because a deployment with no VAPID keys would otherwise
accumulate a permanently-red `notification_deliveries` row for every event
that declares `push`, with no admin remedy to fix it. #355 removes exactly
that premise: Web Push configuration is now admin-UI-configurable at runtime
(`PushConfigController`/`PushConfigService`, Section 11), so the module now
registers `push` unconditionally, the same pattern `email` already
established (`email.module.ts:31-39`) — an unconfigured channel produces an
honest, admin-actionable *failed* delivery row that an operator can see and
fix from the Push Configuration settings page, rather than the channel
silently not existing. `PushNotificationChannel`'s existing defensive guard
(no active VAPID config → `{ success: false, error }`) is now the real,
always-live gate, backed by `PushConfigService.resolveActiveVapidConfig()`
(Section 11's four-case precedence) rather than a boot-time
`ConfigService.get` read. `PushSubscriptionService.isEnabled()` is unchanged
in what it gates: whether a browser may *subscribe* at all
(`POST /notifications/push/subscriptions` still 409s with no active VAPID
config) — only the question of whether unconfigured deliveries are visible or
silently absent has changed.

## 10. Operational events: an audience that is a permission, not a user

> Issue #288, epic #254. Scoped here, in the framework document, rather than
> in `job-queue.md`, `worker-nodes.md` or `database-backup.md`, because the
> four events below span all three and the rule they establish belongs to the
> dispatcher. Implemented in `apps/api/src/notifications/notification-events.ts`,
> `apps/api/src/notifications/notifications.service.ts`,
> `apps/api/src/notifications/ops/job-failure-notifier.ts`,
> `apps/api/src/email/templates/{job-failed,node-offline,backup-failed,restore-completed}.email.ts`.
> **No migration, no table, no endpoint** — the point of the exercise.

### 10.1 The four events

| Key | Channels | Default | Raised by |
|---|---|---|---|
| `jobs.job_failed` | email | on | `JobFailureNotifier`, listening on `job.settled` |
| `nodes.node_offline` | email, browser | on | `NodeStaleOfflineTask.sweep()` |
| `db_backup.backup_failed` | email, browser | on | `DatabaseBackupRunnerService.markFailed` and `DatabaseBackupScheduleTask.releaseStaleRuns` |
| `db_backup.restore_completed` | email, browser | on, **`mandatory: true`** | `DatabaseRestoreService.swap()` |

Three of the four are muteable and one is not, and the split is the same one
`security.role_changed` draws. A *failure* is something an operator may
reasonably decide to watch in an alerting stack instead and silence here. A
*completed restore* is not: the live database has just been replaced with the
contents of an archive, every write made after that archive was taken is gone,
and the process that did it exits immediately afterwards. Silence is itself
the risk, so the event is unmuteable and its template says so in its own
footer — a mailbox has no other place to explain why a message arrived that
the preferences page will not let you switch off.

**`jobs.job_failed` is email-only, and that is not an unfinished browser
template.** Section 5's rule applies: the durable row is the product and the
toast is a decoration on top of it, so a `browser` entry is only worth having
when there is somewhere for the row to lead. A failed job's detail is a filter
on the jobs list rather than a page, and a bell row whose click target cannot
show the thing it is about is worse than no bell row. The other three each
have a real destination — `/admin/settings/workers` and
`/admin/settings/db-backup`, the exact paths their cards declare in
`apps/web/src/config/adminSections.tsx` — and that is why they carry a `link`
and it does not. `EVENT_BROWSER_TEMPLATES` has no entry for `jobs.job_failed`,
which agrees with the registry rather than shadowing it.

**`jobs.job_failed` is terminal-only.** It is raised on `status === 'failed'`,
which `JobTerminalService` writes from exactly two places: the attempt budget
running out (or a caller declaring the job unrunnable), and the rate-limit
give-up past `jobs.rateLimitMaxHits`. An ordinary retry and an ordinary
deferral write `status: 'pending'` and **emit nothing at all**, so "terminal
only" is a property of the emitter rather than something the listener
reconstructs.

### 10.2 The recipient rule: `notifyPermissionHolders`

Every entry point the framework had before #288 resolves **one** recipient the
caller already knows — `notify` a user id, `notifyAddress` an email address —
because the events they were built for are facts *about a person*. A job that
exhausted its retries, a worker that stopped heartbeating and a backup that
never finished are facts about the **deployment**, and the question "who
should hear about this?" has no user id in it.

The answer is **whoever can act on it**, which in this application is spelled
as a permission:

```ts
await this.notifications.notifyPermissionHolders(
  'db_backup.backup_failed',
  PERMISSIONS.DB_BACKUP_READ,
  payload,
);
```

It resolves **active** users (`isActive: true`) holding that permission through
any of their roles, in one indexed query selecting only `id`, and then fans out
through the same `dispatchToUser` that `notify` uses — so the preference gate,
the `mandatory` override, the admin policy of section 5, the delivery rows and
the per-channel containment are the *same code*, not a parallel implementation
of them. That is the argument `notifyAddress` already makes: a new way of
*building* a recipient is safe; a new way of *delivering* to one is a second
place the gate can be forgotten.

**Why a permission and not a role.** "Send it to the Admin role" is one string
shorter and wrong for the reason the Settings UI Pattern gives for a card's
`permission` field: a role is a bundle somebody else owns. A deployment that
adds an `Operator` role holding `db_backup:read`, or splits `Admin` in two, has
changed who can act on a failed backup — and a role-addressed notification
would keep mailing the old bundle silently, with nothing to fail and nothing to
notice. Passing the permission means the audience for "your backup failed" is,
by construction, the set of people `db-backup.controller.ts` would let look at
the backup. Grant a role the permission and its holders start receiving it;
revoke it and they stop. Nothing in the notifications code changes for either.

**Only active users, and note this is the opposite of `loadRecipient`'s rule.**
`loadRecipient` deliberately does *not* filter on `isActive`, because there the
account is the **subject** of the event and dropping it would silently defeat a
`mandatory` notification aimed at exactly the accounts an incident review cares
about. Here the account is a candidate **audience** for somebody else's
incident, and an audience of people who cannot sign in is not an audience.

**Zero recipients is a `debug` log and a no-op**, not a warning: a deployment
that runs no worker nodes legitimately has nobody holding `nodes:read`, and a
warning on every ten-minute sweep is how a log stops being read. **A failing
recipient query is a log line too** — never an exception. Every call site of
this method is already a failure path, and a throw would turn one failure into
two.

`NotifyPermissionHoldersOptions` adds one field to `NotifyOptions`:
`alsoNotifyUserIds`, unioned with the holders and **de-duplicated by user id**
before anything is dispatched. It exists for the restore, whose audience is
"everyone holding `db_backup:read`, plus the operator who triggered it" — an
operator who may hold `db_backup:restore` through some other role. Sending that
as two calls would deliver twice to anyone in both sets, and de-duplication is
impossible once the dispatches have been detached.

### 10.3 The two orderings that are easy to break

**The job listener is a bystander, deliberately.** `jobs.job_failed` is raised
by `JobFailureNotifier`, an `@OnEvent(JOB_SETTLED_EVENT)` provider registered
in `NotificationsModule` — not by a `notify()` call inside
`JobTerminalService`. Two reasons: wiring `JobsModule` (imported by
`NodesModule`, `BroadcastsModule` and the app root) to `NotificationsModule`
points a heavy graph at the module every feature enqueues through and invites a
cycle the next contributor "fixes" with `forwardRef`; and `JobTerminalService`
is the terminal chokepoint whose own writes are swallowed on purpose so an
exception cannot strand a worker slot. `EventEmitter2` dispatches
**synchronously**, so the handler calls the detached entry point, never awaits,
and wraps its body in `try`/`catch` — it runs inside the worker's completion
path and must not block or throw. The import of
`jobs/events/job-settled.event.ts` is a plain file import (that file imports
only `@prisma/client`) and adds nothing to the provider graph; if it ever grows
an import of its own, that argument stops holding.

**The restore notification is `await`ed, and must stay between the rename and
the exit.** `DatabaseRestoreService.swap()` ends in `process.exit(0)` so a
supervisor can start a process whose connection pool is built against the
promoted database. A detached dispatch raised just before that exit is simply
dropped — `schedule()` puts the work on a microtask, the process ends, and the
shutdown drain never runs because nothing is shutting Nest down. For a
`mandatory` event that is the worst possible failure: wired, green in every
registry and template test, and delivering nothing in production on the only
path that matters. So the swap calls **`notifyPermissionHoldersNow`**, the
awaited sibling, and its position is load-bearing in both directions:

- **After `renameSwap`**, because Prisma is pointed at the live database *by
  name* and that name now resolves to the promoted database — so the
  `notification_deliveries` and `notifications` rows land in the database the
  operator will actually open, and the recipients are resolved from the
  restored `users`/`user_roles`, which is the correct post-restore answer to
  "who can act on this?". The actor's address is looked up there too, and may
  legitimately not exist: an operator whose account was created after the
  archive was taken genuinely is not in it, which the template renders as "Not
  recorded" rather than as a failure.
- **Before `exitProcess`**, which is the whole reason it is awaited.

`notifyPermissionHoldersNow` never rejects (same `runContained` containment as
every other entry point), so awaiting it cannot turn a completed restore into a
recorded failure — which would be especially bad here, because that failure
lands in `executeRestore`'s `catch`, which would then try to drop a scratch
database that has already been promoted to live.

### 10.4 Roll-up is deliberately not built

A fork whose queue carries thousands of a single job type will want these
digested — one message an hour saying "412 `vision.describe` jobs failed"
rather than 412 messages. That is a real need and this template does not have
it: nothing shipped here can produce that volume, and a roll-up nobody needs is
a second scheduler, a second piece of state to reconcile, and a second way for
a failure notice to arrive late. Build it in the fork that has the volume, and
build it as a batching layer in front of `notifyPermissionHolders` rather than
as a fifth entry point on `NotificationsService` — the gate must stay in one
place.

## 11. Runtime-configurable VAPID keys: the admin surface (issue #355)

> Issue #355, not part of epic #215 — see the note at the top of this
> document. Implemented in `apps/api/src/notifications/push-config.service.ts`,
> `push-config.controller.ts`, `push-config.schema.ts`,
> `push-vapid-credential.constants.ts`, and
> `apps/web/src/pages/Admin/PushConfigPage.tsx`. Operator-facing procedure:
> [`docs/runbooks/vapid-keys.md`](../runbooks/vapid-keys.md).

Before this issue, turning Web Push on at all meant an operator running
`web-push generate-vapid-keys`, setting three environment variables, and
restarting the API — a real deploy-time-only design, and the one Section 9
originally described. #355 overturns that: generate, store, enable/disable,
and rotate a VAPID key pair entirely from the admin UI, live, with no
restart, at `/admin/settings/push`.

### 11.1 Storage: a settings row and a credential, split exactly like SMTP

**No new Prisma model or migration.** The split mirrors
`email-settings.service.ts`'s SMTP host/username-vs-password precedent
exactly, and for the identical reason:

- **`system_settings` row, key `'webPush'`**: `{ enabled, publicKey, subject
  }`. All three render in full on the admin page and none is secret — a
  public key is handed to every browser that calls `pushManager.subscribe()`
  — so putting any of them behind the masked-hint credential store would
  leave the settings page unable to show its own public key.
- **One `Credential` row**, at `(purpose: 'push_vapid', name: 'default')` via
  the existing `CredentialsService` (`push-vapid-credential.constants.ts`) —
  holds **only** the VAPID private key. It is never returned by any endpoint;
  the admin view carries only a masked `privateKeyStatus` (`configured`,
  `hint`, `updatedAt`, `updatedByUserId`), the same shape
  `SmtpPasswordStatus` already established for the SMTP password.

### 11.2 The env fallback, and its one asymmetry

`PushConfigService.resolveActiveVapidConfig()` is the one place both
`PushSubscriptionService` and `PushNotificationChannel` ask "what VAPID key
pair, if any, is active right now." Four cases, in order:

1. **No `webPush` row at all** → fall back to `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` env vars. A deployment that has never
   opened the admin page keeps working exactly as it did before #355, zero
   action required.
2. **Row exists, `enabled: true`, both a public key and the private-key
   credential present** → the DB wins, even over env vars that are still set.
   Once an admin has touched the UI, it is the source of truth.
3. **Row exists, `enabled: false`** → push is off, full stop, **no env
   fallback**. This is the one intentional asymmetry in the precedence: an
   explicit disable must be able to override a stale env var, or "disable"
   would not actually disable anything on a deployment that also has env vars
   set.
4. **Row `enabled: true` but the private-key credential is missing**
   (corruption, a hand edit, a botched migration) → treated as disabled,
   logged loudly. Never silently reverts to env — that would mask a real data
   problem as ordinary "not configured".

### 11.3 The five endpoints

All under `/api/admin/push-config`, a controller of its own — same reasoning
as `EmailSettingsController` staying apart from `SystemSettingsController`:
this surface writes a settings row and a credential the rest of
`NotificationsController` has no reason to touch.

| Method | Path | Permission | Effect |
|---|---|---|---|
| GET | `/api/admin/push-config` | `push:read` | Configuration plus masked `privateKeyStatus` |
| PUT | `/api/admin/push-config` | `push:write` | Flip `{ enabled, subject }` — does not manufacture keys |
| POST | `/api/admin/push-config/generate` | `push:write` | First-time key generation; sets `enabled: true` |
| POST | `/api/admin/push-config/rotate` | `push:write` | Replace the key pair; `enabled` unchanged |
| DELETE | `/api/admin/push-config` | `push:write` | Delete both the credential and the settings row |

Full request/response shapes: [`docs/API.md`](../API.md#push-configuration-admin-only).

`push:read`/`push:write` is a permission pair of its own, **not** a reuse of
`system_settings:*` — generating or rotating key material has a real,
described blast radius (every existing subscriber goes dark until it
re-subscribes) that should not ride along with routine settings edits, the
same reasoning that split `broadcasts:*` and `nodes:*` out from
`system_settings:*`/`jobs:*` rather than folding them in.

### 11.4 `ROTATE`/`REMOVE`: two typed confirmations, deliberately different words

`rotate` and `remove` are both destructive — every existing push subscriber
goes dark — so both require a typed confirmation literal in the request body,
mirroring `db-backup`'s `RESTORE`/`ROLLBACK` pattern exactly. The two
literals are **different words on purpose**: a confirmation body copied from
one route to the other (`rotate`'s `{ "confirmation": "ROTATE" }` posted to
`remove`, or vice versa) is rejected rather than silently accepted, because
the two actions have different recovery stories — `rotate` leaves a key pair
in place (a different one), `remove` leaves none. The frontend's
`PushConfigConfirmDialog` mirrors this at the UI layer: the typed text is
cleared every time the dialog opens or `action` changes, so a value typed for
one dialog can never carry over and satisfy the other.

**The stated consequence is real but, since issue #365, no longer
open-ended.** Before #365, there was no client-side re-subscribe-on-reopen
mechanism anywhere in this codebase, and a rotated-out subscriber stayed dead
until a manual toggle-off-and-on. Section 12 below is the fix: the client now
detects an `applicationServerKey` mismatch during its own boot-time sync and
resubscribes automatically — but only for a browser whose notification
permission is still `granted`. A browser that was never granted, or whose
permission has since been revoked, still needs the manual path (Section
12.1/12.5). Do not soften this further to "reopening the app always fixes
it" — see [the runbook's recovery-mechanics
reference](../runbooks/vapid-keys.md#4-recovery-mechanics-reference) for the
precise boundary of what self-heals and what still needs a human.

## 12. The client subscribes itself, and prompts automatically (issue #365)

Epic #215 built every server-side piece of Web Push — storage, the
endpoints, the sender, the service worker's `push` handler — and stopped one
step short of the actual subscription. Nothing under `apps/web` ever called
`pushManager.subscribe()` from the page, and nothing ever `POST`ed the result
to `POST /api/notifications/push/subscriptions`, so `push_subscriptions`
stayed empty on every real deployment and every push send failed with "No
push subscriptions for this user." Issue #365 is the missing step.

### 12.1 Why "click-only" was the rule, and why it changed

Sections 4 and 6 above, and this codebase's own
`useBrowserNotificationPermission.ts` and `NotificationSettings.tsx` before
#365, treated `Notification.requestPermission()` as something that must
**only** ever run from a user's click on `/settings/notifications` — never on
mount, never automatically. The reasoning was sound and has not changed: a
denial is effectively permanent (no API re-prompts a user who has said no),
so spending that one shot without the user having asked for anything is a
real cost.

The product owner decided that for this application push is critical enough
that the cost is worth it: **the client now requests permission
automatically on app load**, once per page load
(`pushSubscription.ts`'s `claimAutoPermissionPrompt()` — a module-level flag
that returns `true` exactly once, so React StrictMode's double effects and
shell remounts cannot spend the shot twice). `usePushSubscriptionSync.ts`
runs this the moment `capability === 'default'` and the deployment offers
push (`config.pushEnabled`, itself already gated on `browserEnabled` —
`config.browserEnabled === false` short-circuits both this and the capability
check). This does not repeal the old reasoning — it accepts the cost
deliberately for this one application, under the same
`browserEnabled`/`pushEnabled` gate Section 6's manual path already used.

**`useBrowserNotificationPermission.ts` itself is unchanged in spirit: it
still never calls `requestPermission()`, only observes.** Requesting is
still someone else's job — `services/browserNotifications.ts`'s
`requestBrowserNotificationPermission()` — the hook's role is exactly what
Section header says: report the truth of `Notification.permission`, re-read
on the Permissions API's `change` event, on `visibilitychange`, and now also
on a same-page `NOTIFICATION_PERMISSION_CHANGED_EVENT`
(`browserNotifications.ts`) that fires after every request settles, so the
banner and the settings page's own permission read update together
regardless of which one asked.

**The gesture caveat is why the manual path still exists.** Firefox and
Safari require a user gesture to show the permission prompt at all — a
gestureless `requestPermission()` call is simply ignored, no prompt appears,
and the promise never resolves to `granted` on its own. Chrome does not
refuse it outright but may demote a gestureless request to its "quiet"
permission UI (a small icon in the address bar rather than an interrupting
prompt), which most users never notice. So the automatic attempt is a
best-effort optimization for the browsers that honor it, not a replacement
for a gesture-driven path — which is why `NotificationPermissionBanner`
(12.4) and `NotificationSettings.tsx`'s own button both still exist, and both
go through the same single action described in 12.2.

### 12.2 `pushSubscription.ts`: the one action every caller shares

`apps/web/src/services/pushSubscription.ts` is the module all of this routes
through — `usePushSubscriptionSync.ts`'s auto-prompt, the banner's button
(via that hook's `requestPermission`), and `NotificationSettings.tsx`'s own
button on `/settings/notifications` (calling the module directly, bypassing
the hook's auto-prompt bookkeeping it has no use for). Its exports:

- **`requestPermissionAndSyncPush(config)`** — asks for permission, and if
  the result is `granted` and `config.pushEnabled`/`config.vapidPublicKey`
  are set, starts (does not await) `syncPushSubscription`. This is the single
  action behind the auto-prompt, the banner's **Enable notifications**
  button, and the settings page's button.
- **`syncPushSubscription(vapidPublicKey)`** — the boot-time sync itself
  (12.3). De-duplicated through a module-level `inFlightSync` promise, so the
  boot effect and a permission-grant handler racing each other share one
  subscribe-and-`POST` rather than issuing two.
- **`removePushSubscription()`** — logout cleanup (12.5).
- **`claimAutoPermissionPrompt()`** — the once-per-page-load gate for the
  auto-prompt (12.1).

Nothing in this module throws; every failure is `console.warn`-logged and
swallowed, the same contract `browserNotifications.ts` already keeps — push
is decoration over the notification centre, never something that can break a
page render or a login.

### 12.3 Boot-time subscribe-and-sync

`syncPushSubscription` runs whenever `usePushSubscriptionSync.ts`'s effect
sees `permission === 'granted'` and a `vapidPublicKey` (i.e.
`config.pushEnabled` is true) — on every boot, and again the instant
permission newly becomes `granted`. It is a no-op if permission is not
already `granted`; it never itself prompts. When it does run:

1. Waits for `navigator.serviceWorker.ready`, raced against a 10-second
   timeout (`SERVICE_WORKER_READY_TIMEOUT_MS`) — that promise never settles
   at all when no worker has registered, so an unbounded `await` would hang
   the sync forever on an unsupported or broken device.
2. Reads any existing subscription via `pushManager.getSubscription()` and
   checks it against the current key (12.4).
3. If none exists (or the stale one was just unsubscribed), calls
   `registration.pushManager.subscribe({ userVisibleOnly: true,
   applicationServerKey: <current vapidPublicKey> })`.
4. `POST`s `subscription.toJSON()` to
   `POST /api/notifications/push/subscriptions`.

Step 4 is idempotent by construction: `PushSubscriptionService.subscribe`
upserts by `endpoint`, so running this on every boot — not just the first
time permission is granted — is safe and cheap, and it is what makes the
subscription self-healing rather than a one-time event a stale device can
silently fall out of.

### 12.4 Rotation detection

Before subscribing, `subscriptionUsesKey()` compares an existing
subscription's `options.applicationServerKey` against the deployment's
current `vapidPublicKey` (converted from the URL-safe base64 the API returns
to the raw bytes `pushManager.subscribe` wants, via `urlBase64ToUint8Array`).
**Only a definite mismatch counts**: a browser that does not expose
`options.applicationServerKey` at all is treated as matching, deliberately —
re-subscribing on every boot with no way to compare keys would mint a new
endpoint each time and orphan the previous row instead of upserting it.

On a genuine mismatch — the signature of an admin having rotated keys per
[`docs/runbooks/vapid-keys.md` Section
2.4](../runbooks/vapid-keys.md#24-rotating-vapid-keys-what-the-rotate-button-does)
since this browser last subscribed — `pushManager.subscribe` cannot fix it by
itself: a `PushSubscription` is cryptographically bound to the key it was
created under (that runbook section explains why), so the client calls
`subscription.unsubscribe()` first, then subscribes fresh against the new key
and syncs it as in 12.3.

This is the mechanism `sw.ts`'s `pushsubscriptionchange` comment always
pointed at and epic #215 never built (see the corrected [Rejected
alternatives](#rejected-alternatives) entry below) — the same boot-time sync,
run unconditionally, happens to also be the rotation recovery path, with no
separate code for it. It only helps a browser whose permission is still
`granted`; one that has since been denied or reset needs the manual path
(12.1) before it can subscribe again at all.

### 12.5 The app-wide banner

`NotificationPermissionBanner` (`apps/web/src/components/notifications/`, not
`components/common/`) is mounted once in the main `Layout`, directly under
`MaintenanceBanner`, fed by the single `usePushSubscriptionSync()` call
`Layout.tsx` owns. It renders nothing unless **all** of these hold:

- the deployment offers push or plain browser notifications
  (`config.pushEnabled || config.browserEnabled`);
- the device's capability is one of exactly three states —
  `default`, `denied`, or `ios-needs-install`. Every other state (`granted`,
  `sw-unavailable`, `unsupported`, `insecure-context`, `admin-disabled`)
  shows nothing: either there is nothing left to do, or nothing the user
  could do about it;
- the current route is not `/settings/notifications` (or a sub-path of it),
  which already carries the fuller version of the same message and controls;
- that capability has not already been dismissed this browser session.

The three states, each with its own copy:

- **`default`** — an **Enable notifications** button (`onRequestPermission`,
  wired to the shell's `pushSync.requestPermission`), the gesture-driven
  fallback from 12.1, alongside a link to the settings page.
- **`denied`** — instructions for re-enabling notifications in the browser's
  own site settings; the app has no API to re-prompt a denied origin.
- **`ios-needs-install`** — the Add to Home Screen hint (Section 4's
  capability state), since Safari on iPhone/iPad only grants notification
  permission to an installed PWA.

**Dismissal is per-state, not global**, stored in `sessionStorage` keyed by
the dismissed capability's own name: dismissing a `default` banner hides only
`default` for the rest of the session — if the capability then changes (a
gestureless prompt got quietly denied, say), the banner reappears for the new
state rather than staying hidden. This is the same "don't let a stale client
hide a real gap" principle Section 5 uses for the SSE `toast` flag.

### 12.6 Logout cleanup

`AuthContext.tsx`'s `logout` calls `removePushSubscription()` **before**
`POST /auth/logout`, so a shared or public browser does not keep receiving
the previous user's pushes after someone else signs in on it.
`removePushSubscription()` uses `getRegistration()` rather than `.ready`, so
a page with no worker returns immediately instead of waiting out a timeout,
and bounds its work to 3 seconds (`LOGOUT_UNSUBSCRIBE_TIMEOUT_MS`) so a slow
or failing `DELETE` can never hold up signing out. It never throws — a 404
(never registered, or already removed server-side) is swallowed the same as
any other failure — and it deliberately leaves the **browser-side**
subscription in place: the next sign-in's boot sync re-registers that same
endpoint for whoever signs in next, rather than forcing every new session on
that device to mint a fresh one.

### 12.7 `NotificationSettings.tsx`'s push column gets the real value

`UserNotificationsPage.tsx` passed a hardcoded `pushEnabled={false}` to
`NotificationSettings` from the day #227 landed — a placeholder its own
comment said would be wired "once #227 lands," which never happened. It now
passes the real value from the same `GET /api/notifications/config` read
Section 6 describes.

The column's behavior, per `pushChannelState()`
(`NotificationSettings.tsx`), deliberately does not collapse "push is off
deployment-wide" and "push is on but not granted on this device" into the
same disabled state:

- **`pushEnabled === false`** — the row is disabled with the note "Not
  available yet," phrased as a deployment setting rather than a browser
  refusal, because the user cannot fix it and blaming their browser would
  send them looking for a setting that does not exist.
- **`pushEnabled === true`** — the row is **never disabled**: push is an
  account-level preference that applies on every device the user signs into,
  not a property of this one browser. When this particular device is not
  `granted`/`sw-unavailable`, the switch stays interactive and the row
  instead carries the note "Not enabled on this device" — the remedy lives in
  the app-wide banner and the settings page's own button, not a second alert
  here.

## Rejected alternatives

Restated from epic #215's own "Rejected alternatives," with the reasoning
that makes each one wrong:

- **`VITE_APP_NAME` for the manifest.** Rejected for the reason
  `vite.config.ts`'s `appName()` plugin already gives for the HTML case: a
  second source of truth for the product name, which a build can forget to
  set while the React tree renders the correct one from `@app/shared`.
- **`generateSW` + `importScripts`.** Splits ownership of one service worker
  across two files — a generated one owning the Workbox runtime config, a
  hand-written one owning the push handlers — with no way for either to see
  the other. The routing rules and the push handlers drift apart silently,
  and the symptom is a notification that never arrives, on a device the
  developer does not have.
- **Widening `system_settings:read` to `viewer`.** Would hand every
  authenticated user the entire settings blob — at the time, including the
  open, downstream-owned `features` map (`z.record(string, boolean)`, no
  schema; removed entirely as unused by issue #366) — far more than "can I
  see whether browser notifications are on."
- **Putting the kill switch in `features`.** `features` had no schema and was
  explicitly downstream-owned (it no longer exists at all — issue #366); a
  framework security-adjacent gate needs to be modelled, typed, and enforced
  server-side, none of which an untyped bag provides.
- **`registerType: 'autoUpdate'`.** Would reload the page mid-session the
  moment a new worker activates, discarding any unsaved form state — an
  unacceptable default for an enterprise application base where an admin
  might be mid-edit on a settings page. `'prompt'` defers the handover to a
  user action instead.
- **Cross-tab leader election** for toast dedup. Rejected because
  `registration.getNotifications({ tag })` already solves the problem
  registration-wide in one call — leader election needs a coordination
  protocol (`BroadcastChannel`, `localStorage` locks, a chosen leader tab)
  with its own failure modes (the leader tab closes mid-election, two tabs
  both think they won), none of which the tag-based read needs to reason
  about at all.
- **Server-side `pushsubscriptionchange` re-registration.** The service
  worker cannot authenticate any request it might make to record a rotated
  subscription (Section 2's constraint), so `sw.ts`'s
  `handlePushSubscriptionChange` (`sw.ts:384-403`) is a **best-effort**
  resubscription only, deliberately not backed by any attempt to `POST` the
  new subscription to the API. The real mechanism is the page's own
  idempotent re-sync on next boot — which needs no new authentication surface
  at all, since it runs from an already-authenticated page — and which epic
  #215 left unbuilt despite saying so in this very comment; issue #365
  (Section 12) is what actually built it.

## Verification

Epic #215's own manual device matrix — this cannot be faked in jsdom, and
device behaviour is the entire point of the epic:

| Platform | Check | Automated coverage in this worktree | Manual device verification |
|---|---|---|---|
| Desktop Chrome/Edge | SW notification, click focuses tab, foreground suppression | `useNotificationCapability.test.ts`, `browserNotifications.test.ts`, `service-worker.test.ts` (mocked `self.clients`/`registration`) | Not recorded in any merged PR reviewed for this document |
| Desktop Firefox | SW notification and click routing | Same mocked suites — Vitest/jsdom does not distinguish browser engines | Not recorded |
| Desktop Safari | Page-`Notification` fallback path | `browserNotifications.test.ts` covers the fallback branch by mocking `serviceWorker` absence | Not recorded |
| Android Chrome | Notification appears at all (previously threw); push with app closed | `showAppNotification`'s SW-first branch is unit-tested; PR #244's own test plan explicitly flags **"Not done — no device access in this environment"** for the real acceptance criterion | **Outstanding** |
| iOS Safari, tab | Walkthrough shown, not "unsupported" | `useNotificationCapability.test.ts` covers the `ios-needs-install` precedence and `readIsIos()`'s touch-based iPad detection | **Outstanding** — and the walkthrough UI itself (#231) is not merged into this worktree (see the provenance note above) |
| iOS, installed to Home Screen | Permission prompt, notification, push with app closed | None (requires a real installed PWA) | **Outstanding** — PR #249's test plan flags the same **"no device access in this environment"** limitation for its acceptance criterion |

Be honest about what this buys: `apps/web/src/__tests__/pwa/service-worker.test.ts`
executes `sw.ts`'s actual `notificationclick`, `push` and
`pushsubscriptionchange` handlers under jsdom with `workbox-core`,
`workbox-precaching` and `workbox-routing` mocked to no-ops, and with
hand-built fake `NotificationEvent`/`PushEvent`/`PushSubscriptionChangeEvent`
objects standing in for ones jsdom does not provide. That is real coverage of
the handler *logic* — argument parsing, the focus-vs-openWindow branch, the
malformed-payload fallback, the dedup check — and it is not a substitute for
a real Android Chrome or iOS Safari device showing a real OS-level
notification. Per the epic's own success criteria, none of the platform rows
above can be marked done from this repository alone.
