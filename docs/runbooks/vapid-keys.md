# Runbook: Generate, Enable, Rotate, and Disable VAPID Keys (Web Push)

This runbook covers the operator-facing lifecycle of Web Push on this
deployment: generating a VAPID key pair, turning the channel on, rotating the
keys, and turning it back off (or removing it entirely). It does not cover
the delivery mechanism itself — see
[`docs/specs/browser-notifications.md`](../specs/browser-notifications.md)
for why Web Push exists, how it fits alongside the browser-toast channel, and
what it does and does not guarantee.

**As of issue #355, the recommended path is the admin UI** at
`/admin/settings/push` — generate, enable, rotate, or remove a VAPID key pair
live, with no restart. Section 2 covers that path. The original env-var
procedure (Section 3) still works and is kept as a documented fallback for a
deployment that has not touched the admin UI — see Section 1.1 for exactly
how the two interact when both are present.

Source of truth for every claim below:

- `apps/api/src/notifications/push-config.service.ts` — `PushConfigService`,
  and specifically `resolveActiveVapidConfig()`, the one place both callers
  below ask "what VAPID key pair, if any, is active right now."
- `apps/api/src/notifications/push-config.controller.ts` — the five
  `/api/admin/push-config` routes the admin UI (and any other client) calls.
- `apps/api/src/notifications/push-config.schema.ts` — the `webPush`
  `system_settings` row's shape (`enabled`, `publicKey`, `subject`).
- `apps/api/src/notifications/push-vapid-credential.constants.ts` — where the
  private key actually lives (`CredentialsService`, `purpose: 'push_vapid'`).
- `apps/api/src/config/configuration.ts` — the `push` config block
  (`push.vapidPublicKey`, `push.vapidPrivateKey`, `push.vapidSubject`), read
  from `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — the
  env-var fallback path only.
- `apps/api/src/notifications/push-subscription.service.ts` — `isEnabled()`,
  the predicate that decides whether this deployment accepts push
  subscriptions at all; delegates to `resolveActiveVapidConfig()`.
- `apps/api/src/notifications/channels/push-notification.channel.ts` — the
  sender, including what happens when a send fails.
- `apps/api/src/notifications/notifications.module.ts` — registers the push
  channel unconditionally (like email/browser); see its header comment for
  why that changed with #355.
- `apps/web/src/pages/Admin/PushConfigPage.tsx` and
  `apps/web/src/components/admin/PushConfigConfirmDialog.tsx` — the admin UI.
- `infra/compose/.env.example` — the three fallback environment variables,
  commented out by default.

**Web Push ships disabled by default.** Neither touching the admin UI nor
setting the three environment variables is required — nothing in this
codebase requires either, and every other notification channel (email, the
in-app browser toast) is unaffected by their absence.

---

## 1. Before you start

- Decide whether you want Web Push at all. It is the *only* channel that can
  reach a signed-in user with the app fully closed (no open tab, no installed
  PWA in the foreground) — if that is not a requirement for this deployment,
  there is nothing to do here.
- Decide on a contact address (the VAPID subject) before generating keys: a
  `mailto:` or `https:` URL identifying the operator, per the Web Push
  protocol (RFC 8292). This is advisory metadata a push service (FCM,
  Mozilla's autopush, …) can use to reach you if this deployment's traffic
  looks abusive — it is never seen by end users. See Section 2.3/3.3 for what
  happens if you skip it.
- You need `push:read` (to view configuration) and `push:write` (to change
  it) — a permission pair of its own, **not** a reuse of `system_settings:*`,
  because generating or rotating key material has a real blast radius (every
  existing subscriber goes dark until it re-subscribes) that should not ride
  along with routine settings edits.

### 1.1 How the admin UI and the environment variables interact

`PushConfigService.resolveActiveVapidConfig()` is the one place this decision
is made, for every send and every subscribe attempt. Four cases, in order:

1. **No `webPush` row exists at all** (the admin page has never been saved
   on) → fall back to the `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/
   `VAPID_SUBJECT` environment variables, exactly as before #355. A
   deployment that only ever used Section 3's procedure needs to do nothing
   differently.
2. **A `webPush` row exists, `enabled: true`, and both a public key and the
   private-key credential are present** → the database wins, **even over
   env vars that are still set**. The moment an admin saves anything through
   `/admin/settings/push`, that row is the source of truth, full stop.
3. **A `webPush` row exists with `enabled: false`** → push is off, and there
   is **no fallback to the environment variables**. This is the one
   deliberate asymmetry in the rule: an explicit disable in the admin UI must
   actually disable push, even on a deployment that also has env vars set —
   otherwise "disable" would do nothing on such a deployment.
4. **A `webPush` row exists with `enabled: true`, a public key is stored, but
   the private-key credential is missing** (corruption, a hand-edited row, a
   botched migration) → treated as disabled, and logged loudly. This never
   silently falls back to the env vars — that would mask a real data problem
   as ordinary "not configured."

In short: touch the admin UI once, and it owns the answer from then on,
regardless of what the environment variables say. Never touch it, and the
environment variables behave exactly as they always did.

## 2. The admin UI (recommended)

Visit `/admin/settings/push` as an Admin (or any role holding `push:read`/
`push:write`). The page has three panels, matching `PushConfigPage.tsx`:

1. **Status** — always shown: configured/not, enabled/disabled, the full
   public key (monospace, copyable — it is not secret), the subject, and the
   private key's provenance (a masked hint, when it was last set, and by
   whom). The private key itself is never rendered or returned by any
   endpoint.
2. **Empty state** (nothing generated yet) — a single **Generate & enable**
   action, with an optional subject field.
3. **Configured state** — an enable/disable switch and the subject field
   (saved via `PUT`, non-destructive: the keys are retained either way), plus
   two destructive actions in a "Danger zone": **Rotate keys** and **Remove
   configuration**.

### 2.1 Generating the first key pair

From the empty state, optionally fill in a subject (`mailto:` or `https://`),
then click **Generate & enable**. This calls
`POST /api/admin/push-config/generate`, which:

- Generates a fresh VAPID key pair with `web-push`'s `generateVAPIDKeys()`.
- Stores the private key in the encrypted credential store
  (`(purpose: 'push_vapid', name: 'default')`), written **before** the
  settings row — the same partial-failure-safe ordering
  `EmailSettingsService.update` uses for the SMTP password.
- Stores the public key and the subject in the `webPush` system-settings row,
  and sets `enabled: true`.

This is **first-time only** — a second call returns `409 Conflict` and points
you at Rotate instead. It is deliberately not idempotent: a second `generate`
silently replacing a live key pair with no confirmation step would invalidate
every existing subscriber with no warning, which is exactly what Rotate's
typed confirmation exists to prevent.

### 2.2 Enabling and disabling

Once a key pair exists, the switch on the configured-state panel toggles
`enabled` via `PUT /api/admin/push-config`. This is the **non-destructive**
action — the stored key pair is retained either way, so switching back on
needs no regenerating. Disabling takes effect immediately (Section 1.1, case
3): no push is sent while `enabled` is `false`, and `POST
/api/notifications/push/subscriptions` starts rejecting new subscriptions
with `409 Conflict`.

Attempting to enable before any key pair has been generated returns `409
Conflict` — this endpoint flips the switch, it does not manufacture keys.

### 2.3 What happens if the subject is left blank

The subject is optional at every step. If it is unset,
`PushNotificationChannel` still sends, but falls back to a generic
`mailto:admin@example.com` and logs a warning on every delivery. Every push
this deployment sends will therefore carry `web-push`'s own example address
as its contact, which is harmless to end users (they never see it) but means
a push-service operator investigating unwanted traffic from this deployment
has no way to reach you. Set a real subject before enabling push on any
deployment that will see real traffic.

### 2.4 Rotating VAPID keys (what the Rotate button does)

Click **Rotate keys** in the Danger zone. This opens a confirmation dialog
that states the consequence and requires typing the literal `ROTATE` before
the button is enabled — the same typed-confirmation pattern
`db-backup`'s restore/rollback flow uses, with a deliberately different word
so a confirmation typed for Remove (Section 2.5) can never satisfy this one.
Confirming calls `POST /api/admin/push-config/rotate` with
`{ "confirmation": "ROTATE" }`, which:

- Generates a fresh VAPID key pair and overwrites both the stored credential
  and the row's `publicKey`.
- Leaves `enabled` exactly as it was — rotating is not a decision about
  whether push should be on, only about which keys back it.
- Replaces the subject only if one was supplied in the request; omitted
  keeps the existing one.

Returns `400 Bad Request` if nothing is configured yet — use Generate
(Section 2.1) for a first key pair.

**Every existing push subscription becomes permanently unusable the moment
you rotate.** A `PushSubscription` a browser holds is cryptographically bound
to the public key it was created with (`applicationServerKey`) — there is no
"re-key in place" operation on either side of the Web Push protocol. This is
expected behavior of the protocol, not a bug in this implementation. What
happens on the next send attempt against a subscription negotiated under the
old keys, per `push-notification.channel.ts`'s failure handling (Section 9 of
the spec document covers this in full): the push service rejects the send.
Whether that arrives as a 404/410 (immediate deletion of the row) or some
other error code that instead increments `failureCount` toward the 5-attempt
threshold (`MAX_PUSH_FAILURE_COUNT`) depends on how the specific push service
(FCM, autopush, …) reports a key mismatch — this codebase does not
special-case that response, so expect anywhere from immediate pruning to up
to 5 silently failed deliveries per stale subscription before the row is
cleaned up automatically.

**⚠ Recovery is now automatic for a still-permitted browser, since issue
#365 — but only for one.** Before #365, there was **no** client-side
re-subscribe-on-reopen mechanism anywhere in this codebase: `sw.ts`'s
`pushsubscriptionchange` handler only re-subscribes when the *browser
itself* rotates a subscription out from under the page (a browser-initiated
event, unrelated to a server-side key rotation) — it has no way to detect
"the server changed its VAPID keys," because nothing tells it that.

Issue #365 added the missing piece: on every app boot, the client compares
its existing subscription's `applicationServerKey` against the deployment's
current `vapidPublicKey`. On a mismatch, it unsubscribes the stale
subscription and calls `pushManager.subscribe({ applicationServerKey: <new
public key> })` itself, then `POST`s the result to `POST
/api/notifications/push/subscriptions` —
`PushSubscriptionService.subscribe` upserts by `endpoint`, replacing whatever
row existed. See [`docs/specs/browser-notifications.md` Section
12](../specs/browser-notifications.md#12-the-client-subscribes-itself-and-prompts-automatically-issue-365)
for the full mechanism.

**The boundary that still needs a human:** this self-heals only a browser
whose notification permission is still `granted` at the moment it next boots
the app. A browser that was never granted, whose permission has since been
revoked, or that simply never reopens the app, is still dead weight —
nothing re-prompts a denied origin, and nothing runs this sync without a page
load. For those cases the remedy is still manual: the
`NotificationPermissionBanner`'s **Enable notifications** button, or a user
toggling notifications off and back on. Until one of those happens, that
subscription keeps failing every send and eventually prunes itself via the
failure-threshold mechanism above.

### 2.5 Removing the configuration

Click **Remove configuration** in the Danger zone. Same typed-confirmation
mechanism as Rotate, but with the literal `REMOVE` — a different word on
purpose, so a confirmation copied from one dialog can never satisfy the
other. Confirming calls `DELETE /api/admin/push-config` with
`{ "confirmation": "REMOVE" }`, which:

- Deletes the stored private-key credential **first**, then the `webPush`
  settings row — the opposite order from Generate, and deliberately so: the
  safer partial-failure state is "row still present but the credential is
  gone" (Section 1.1's case 4 already treats that as disabled and logs
  loudly), not "row gone but the credential still present," which would let a
  partial failure silently fall back to any env vars this deployment also has
  set — reactivating push on stale keys the admin just asked to remove.
- Returns the resulting, now-empty configuration.

This is **destructive and immediate**: every existing push subscriber stops
receiving push, exactly as with a rotation and needing the same manual
re-subscribe to recover (Section 2.4), and there is no way to bring the same
key pair back — a subsequent Generate mints an entirely new one. The app
keeps working; only web push stops. `push_subscriptions` rows are not deleted
by this action — they sit inert until a new key pair is generated and each
browser re-subscribes, or until the 404/410 pruning path removes them.

## 3. The environment-variable path (fallback)

This is the original, deploy-time-only mechanism from before #355. It still
works, unchanged, and is the automatic behavior for any deployment that has
never saved anything through `/admin/settings/push` (Section 1.1, case 1).
Use it if you would rather manage Web Push the same way as `JWT_SECRET` or
`GOOGLE_CLIENT_SECRET` — provisioned once at deploy time, outside the
application — or as a bootstrap step before an admin ever opens the UI.

### 3.1 Generating a key pair

```bash
npx web-push generate-vapid-keys
```

This prints a public and a private key (base64url-encoded). It requires no
network access and touches no state on this deployment — it is a pure
keypair generation, and running it twice produces two independent, unrelated
key pairs.

### 3.2 Where the keys go

Set three environment variables (`infra/compose/.env.example:86-93` documents
them, commented out by default):

```bash
VAPID_PUBLIC_KEY=<the generated public key>
VAPID_PRIVATE_KEY=<the generated private key>
VAPID_SUBJECT=mailto:admin@example.com
```

Do not commit these to the repository. Store them the same way you store
`JWT_SECRET` or `GOOGLE_CLIENT_SECRET` — this deployment's ordinary
environment-variable secret path, not the encrypted `credentials` table (that
path is what the admin UI itself uses for the private key — see Section
2.1 — and is reserved for runtime-configured, admin-entered secrets).

Both keys are required together: a public key with no private key is
useless, since nothing on this server could sign a push, and a deployment
that only sets one is treated by the fallback resolution as "not configured"
(Section 1.1, case 1's env read requires both).

### 3.3 What happens if `VAPID_SUBJECT` is absent

Unlike the two keys, `VAPID_SUBJECT` is not required for the env fallback to
activate — it is contact metadata for the JWT `web-push` signs, not something
that affects whether signing is possible at all. See Section 2.3 for what
happens when it (or the admin UI's subject field) is left unset: the same
generic fallback and warning apply regardless of which path supplied the
keys.

### 3.4 Applying an environment-variable change

Restart the API. Unlike the admin UI, this path has no live-reload mechanism:
`ConfigService` resolves `process.env` once, at process boot, so changing
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` on a running process
has no effect until it restarts, and `resolveActiveVapidConfig()`'s case-1
fallback only re-reads those values when it runs (case 1 applies at all only
when no `webPush` row exists). Confirm the change took effect by calling `GET
/api/notifications/config` as any authenticated user — `pushEnabled` should
read `true` and `vapidPublicKey` should carry your public key.

Unsetting all three and restarting turns push back off, following the same
case-1 logic in reverse — with no `webPush` row present, an empty env read
resolves to "no active config."

## 4. Recovery mechanics reference

This section is the single source both Section 2.4 (admin UI rotate/remove)
and Section 3 (env-var changes) point back to, so the claim is checked once,
not re-asserted per path.

**As of issue #365, this codebase has a client-side re-subscribe-on-reopen
mechanism, in both paths — bounded by one condition.** The boot-time sync
described in [`docs/specs/browser-notifications.md` Section
12](../specs/browser-notifications.md#12-the-client-subscribes-itself-and-prompts-automatically-issue-365)
runs on every app load: it reads the deployment's current `vapidPublicKey`
from `GET /api/notifications/config`, compares it against any existing
subscription's `applicationServerKey`, and on a mismatch unsubscribes and
calls `pushManager.subscribe()` against the new key — then `POST`s the
result to `POST /api/notifications/push/subscriptions`, which upserts by
`endpoint`. This applies identically whether the active key pair came from
the admin UI (Section 2) or the environment-variable fallback (Section 3):
the sync reads whatever `resolveActiveVapidConfig()` currently resolves to,
with no awareness of which path produced it.

**The one condition: notification permission must still be `granted` on
that browser.** The sync runs from page code, which can only call
`pushManager.subscribe()` without prompting when permission is already
`granted` — it does not itself re-prompt. A browser that was never granted,
that has since moved to `denied`, or that simply never loads the app again,
does **not** self-heal; it needs the manual path (the
`NotificationPermissionBanner`'s button, or a user re-toggling notifications)
before anything can resubscribe it. Verified directly against
`apps/web/src/services/pushSubscription.ts` (`syncPushSubscription`,
`subscriptionUsesKey`), `apps/web/src/hooks/usePushSubscriptionSync.ts` (what
triggers the sync, and only while `permission === 'granted'`), and
`apps/web/src/sw.ts`'s `pushsubscriptionchange` handler (still a
browser-initiated-only, best-effort path, unchanged by #365 — see that spec
section's corrected "Rejected alternatives" entry). Do not write or accept
documentation, UI copy, or code comments claiming "reopening the app
*always* re-subscribes"
without the granted-permission qualifier — that is the detail most likely to
get silently dropped when this file is next revised.

## 5. Summary checklist

**Admin UI path (recommended):**
- [ ] Signed in as a user holding `push:read`/`push:write`
- [ ] Subject decided (a real `mailto:` or `https:` address, not left to the
      `mailto:admin@example.com` fallback, for any deployment with real
      traffic)
- [ ] Generated via `/admin/settings/push` → **Generate & enable**
- [ ] `GET /api/notifications/config` confirms `pushEnabled: true` and
      `vapidPublicKey` matches
- [ ] If rotating or removing: typed the exact confirmation literal
      (`ROTATE`/`REMOVE`), and understood that recovery now happens
      automatically the next time each subscriber's browser boots the app
      *while its notification permission is still granted* (Section 4); a
      browser that isn't still granted needs the manual path instead

**Environment-variable path (fallback, no admin UI touched):**
- [ ] Key pair generated with `npx web-push generate-vapid-keys`
- [ ] `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` set in the
      deployment's environment (not committed, not stored in the
      `credentials` table)
- [ ] API restarted — this path has no live-reload; the admin UI path does
- [ ] `GET /api/notifications/config` confirms `pushEnabled` and
      `vapidPublicKey` match the change just made
- [ ] Understood that once any admin saves through `/admin/settings/push`,
      the database takes over as the source of truth and these environment
      variables are no longer consulted (Section 1.1, case 2) — even if they
      remain set
