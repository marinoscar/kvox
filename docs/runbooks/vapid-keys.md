# Runbook: Generate, Enable, Rotate, and Disable VAPID Keys (Web Push)

This runbook covers the operator-facing lifecycle of Web Push on this
deployment: generating a VAPID key pair, turning the channel on, rotating the
keys, and turning it back off (or removing it entirely). It does not cover
the delivery mechanism itself — see
[`docs/specs/browser-notifications.md`](../specs/browser-notifications.md)
for why Web Push exists, how it fits alongside the browser-toast channel, and
what it does and does not guarantee.

**Web Push is the platform's since issue #470.** The routes, permissions and
stored data are the ones this deployment has always used (`/api/admin/push-config`,
`push:read` and `push:write`, the `webPush` settings row, the `push_vapid`
credential), so existing keys and browser subscriptions keep working with no
re-subscription. What changed for an operator:

- **The admin UI at `/admin/settings/push` is the only path.** Generate, enable,
  rotate or remove a VAPID key pair there, live, with no restart (Section 2).
- **The environment-variable path is gone.** The platform has no fallback to
  `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` or `VAPID_SUBJECT`. A deployment that
  relied on those variables alone has Web Push **off** after the #470 deploy
  until an admin generates a key pair in the UI. Section 3 says how to carry
  over an existing pair, and what to do if you must keep the same keys.
- **After the deploy, open `/admin/settings/push`** (and `/admin/settings/email`)
  and confirm the status; see Section 1.2.

Source of truth for every claim below:

- `@marinoscar/platform-api/notifications`: `PushConfigService` (and its
  `resolveActiveVapidConfig()`, the one place that decides which key pair is
  active), `PushConfigController` (the six `/api/admin/push-config` routes),
  `PushTestService`, `PushSubscriptionService`, the push channel, and
  `PUSH_VAPID_CREDENTIAL_PURPOSE_DEF` (purpose `push_vapid`, name `default`).
  The TSDoc is in `node_modules/@marinoscar/platform-api/dist/notifications/`.
- `apps/api/src/platform/credentials/credential-purposes.manifest.ts`: where
  the application registers the `push_vapid` purpose (the string is
  permanent, it is also the AES sub-key domain).
- `apps/api/src/platform/notifications/notifications.config.ts`: the mount.
- `@marinoscar/platform-web/notifications/ui` (`PushConfigPage`) and
  `apps/web/src/platform/notifications.ts`: the admin UI.
- `apps/web/src/sw.ts`: the service worker, composed from the package's
  handlers ([browser-notifications spec](../specs/browser-notifications.md#the-service-worker-453-parity)).

**Web Push ships disabled by default.** Nothing in this codebase requires it,
and every other notification channel (email, the in-app bell) is unaffected by
its absence.

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

### 1.1 Which key pair is active

`PushConfigService.resolveActiveVapidConfig()` decides, for every send and
every subscribe attempt. Three cases, in order:

1. **No `webPush` row exists, or the row has `enabled: false`** → push is off.
   There is no environment fallback (the platform retired it, its #635, to keep
   one source of truth for a credential). An explicit disable always wins.
2. **A row exists with `enabled: true` but is broken**: no public key, or the
   private-key credential is missing (corruption, a hand-edited row) → treated
   as disabled, and logged loudly.
3. **A row exists with `enabled: true`, a public key, and the private-key
   credential** → that key pair is active.

Before #470 this deployment also honoured `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` when no row existed. Those variables are
no longer read by anything; see Section 3.

### 1.2 After the #470 deploy

1. Open `/admin/settings/push`. If the deployment already had a stored key pair
   (anything generated or rotated in the UI before), the page shows it as
   configured and enabled, and nothing else is needed: the stored row, the
   encrypted private key and every browser subscription are reused.
2. If the page shows **not configured** and push worked before the deploy, the
   deployment was running on the environment variables. Follow Section 3.
3. Press **Test & diagnostics** → send a test push to your own devices and
   confirm the acknowledgement.
4. Open `/admin/settings/email`, check the provider, the sender address and the
   masked password status, and press **Send test email**. The stored settings are
   reused; the page is the packaged one.

## 2. The admin UI (recommended)

Visit `/admin/settings/push` as an Admin (or any role holding `push:read`/
`push:write`). The page has three panels, matching the packaged `PushConfigPage`:

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
1): no push is sent while `enabled` is `false`, and `POST
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
  gone" (Section 1.1's case 2 treats that as disabled and logs loudly), not "row
  gone but the credential still present," which would leave a live private key
  behind after the admin asked for it to be removed.
- Returns the resulting, now-empty configuration.

This is **destructive and immediate**: every existing push subscriber stops
receiving push, exactly as with a rotation and needing the same manual
re-subscribe to recover (Section 2.4), and there is no way to bring the same
key pair back — a subsequent Generate mints an entirely new one. The app
keeps working; only web push stops. `push_subscriptions` rows are not deleted
by this action — they sit inert until a new key pair is generated and each
browser re-subscribes, or until the 404/410 pruning path removes them.

## 3. The environment-variable path (retired in #470)

`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are not read by
anything any more. They remain listed in `infra/compose/.env.example` (marked as
retired) only because the install wizard's metadata still names them; setting
them has no effect, and the `deploy install` wizard has not asked about them
since issue #241.

**If this deployment ran on the variables alone** (Web Push worked, but
`/admin/settings/push` shows not configured):

1. Press **Generate & enable** (Section 2.1), with a real subject. This mints a
   new key pair and stores the private key encrypted.
2. Every browser re-subscribes against the new key the next time it opens the
   app while its notification permission is still `granted` (Section 4). A
   browser that is not still granted needs the manual path.
3. Remove the three variables from `.env` when convenient.

There is no UI to paste an existing key pair. Keeping the **same** keys, so that
no browser needs to re-subscribe, is possible only by writing the `webPush`
settings row and the `push_vapid` credential yourself; do not do this by hand
without a reason, and never put the private key in the settings row. Ask for a
change to the platform's `PushConfigService` rather than working around it.

Unsetting the variables changes nothing; push stays off until a key pair is
generated in the UI.

## 4. Recovery mechanics reference

This section is the single source Section 2.4 (rotate/remove) and Section 3
(carrying over from the environment variables) point back to, so the claim is
checked once, not re-asserted per path.

**As of issue #365, this codebase has a client-side re-subscribe-on-reopen
mechanism — bounded by one condition.** The boot-time sync
described in [`docs/specs/browser-notifications.md` Section
12](../specs/browser-notifications.md#12-the-client-subscribes-itself-and-prompts-automatically-issue-365)
runs on every app load: it reads the deployment's current `vapidPublicKey`
from `GET /api/notifications/config`, compares it against any existing
subscription's `applicationServerKey`, and on a mismatch unsubscribes and
calls `pushManager.subscribe()` against the new key — then `POST`s the
result to `POST /api/notifications/push/subscriptions`, which upserts by
`endpoint`. The sync reads whatever `resolveActiveVapidConfig()` currently resolves to.

**The one condition: notification permission must still be `granted` on
that browser.** The sync runs from page code, which can only call
`pushManager.subscribe()` without prompting when permission is already
`granted` — it does not itself re-prompt. A browser that was never granted,
that has since moved to `denied`, or that simply never loads the app again,
does **not** self-heal; it needs the manual path (the
`NotificationPermissionBanner`'s button, or a user re-toggling notifications)
before anything can resubscribe it. Implemented by the packaged `usePushSubscriptionSync` and
`requestPermissionAndSyncPush` (`@marinoscar/platform-web/notifications/headless`;
the sync runs only while `permission === 'granted'`), and by the
`pushsubscriptionchange` handler of `apps/web/src/sw.ts` (still a
browser-initiated-only, best-effort path, unchanged by #365 — see that spec
section's corrected "Rejected alternatives" entry). Do not write or accept
documentation, UI copy, or code comments claiming "reopening the app
*always* re-subscribes"
without the granted-permission qualifier — that is the detail most likely to
get silently dropped when this file is next revised.

## Verify push works and troubleshoot

Open `/admin/settings/push` and use **Test & diagnostics** (needs `push:write`).
It checks the browser, sends a test push to your own devices and reports each
step. Design: [browser-notifications spec, Section 9](../specs/browser-notifications.md).

| Symptom in the panel | Cause | Fix |
|---|---|---|
| Permission denied | The browser blocked notifications for this site | Allow notifications in the browser's site settings, then rerun |
| Key mismatch | The browser subscription was created under a previous key pair | Reload the app so it re-subscribes, then rerun |
| `403` from the push service | The push service rejects the VAPID signature or subject | Check the key pair and set a valid `mailto:` or `https:` subject (Section 2.3) |
| `404`/`410` from the push service | The subscription expired; the server pruned it | Reload the app to re-subscribe |
| Sent, but no acknowledgement in the panel | The device did not receive it in time | Check OS and battery settings for the browser, or an outdated service worker (reload to update) |
| Notification shows the browser's icon (for example the Chrome logo) instead of the app icon | Android attributes a notification to the app that posts it; from a browser tab that is the browser. The app `icon` is still the large image on the right; the `badge` is the status-bar glyph. The report shows `isStandalone: false` | Install the PWA (Chrome menu, **Install app**) so Chrome creates a WebAPK. "Add to Home screen" as a plain shortcut does not change attribution |
| Status bar shows a blank square instead of a glyph | The `badge` image is not a white and transparent silhouette | Use a monochrome white-on-transparent badge image |
| Service worker `scriptURL` in the report is `dev-sw.js?dev-sw` | The deployment runs the Vite dev server, not the production build. Push works, but Chrome's **Install app** (WebAPK) can be less reliable | Deploy with `prod.compose.yml` for production-like behaviour |

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

**After the #470 deploy (once per deployment):**
- [ ] `/admin/settings/push` shows the expected state; if it shows not
      configured on a deployment that used the environment variables, generate
      a key pair (Section 3)
- [ ] **Test & diagnostics** sent a test push and the device acknowledged it
- [ ] `/admin/settings/email` shows the provider and sender, and a test email
      arrived
