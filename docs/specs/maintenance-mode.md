# Maintenance Mode

> Issue #257, epic #254 (Phase 0). Builds on #256, which declared the
> `maintenance` system-settings namespace (`enabled`, `message`, `allowAdmins`,
> `startedAt`, `startedById`) and reserved the `Maintenance` OpenAPI tag before
> any controller used it. Implemented in
> `apps/api/src/common/maintenance/maintenance-mode.service.ts`,
> `apps/api/src/common/maintenance/maintenance.guard.ts`,
> `apps/api/src/common/maintenance/maintenance.controller.ts`,
> `apps/api/src/common/maintenance/maintenance.module.ts`,
> `apps/api/src/common/maintenance/allow-during-maintenance.decorator.ts`, and
> `apps/api/src/common/maintenance/dto/update-maintenance.dto.ts`, with
> exemptions applied in `apps/api/src/health/health.controller.ts`,
> `apps/api/src/auth/auth.controller.ts`,
> `apps/api/src/device-auth/device-auth.controller.ts` and
> `apps/api/src/test-auth/test-auth.controller.ts`, and the global registration
> in `apps/api/src/app.module.ts`.
>
> Operator procedures — turning a window on and off, the environment
> break-glass, and recovering from an `allowAdmins: false` lockout — are in
> [`docs/runbooks/maintenance-mode.md`](../runbooks/maintenance-mode.md).
> This document is the design and the reasoning; it does not restate the
> runbook.

Maintenance mode takes the application out of service **deliberately**: every
API route answers `503` with an operator-supplied message and a `Retry-After`
header, instead of serving requests. It exists for two reasons, and the second
one is the demanding one:

1. **Planned work.** An upgrade, a migration, a configuration change an
   operator wants to make with nobody writing to the database.
2. **The database restore's swap window (#285).** Restoring a backup renames
   the live database out from under the running process. For those seconds
   there is momentarily **no database under the expected name** — so requests
   must already be stopped, and stopping them cannot depend on reading
   anything out of that database.

Requirement 2 is what makes this feature more than a boolean.

## Why this shape, and not the obvious one

The obvious design is one flag in the settings row, read by a guard. Three
facts rule it out.

1. **A persisted flag is unreadable during the exact window it exists for.**
   The flag lives in `system_settings`, inside the database being renamed. A
   guard that could only consult the row would fail open — or throw, and turn
   every request into a `500` — at the one moment the answer matters most.
   Hence a second, in-memory layer that the swap can set before it starts and
   clear when it finishes.
2. **An in-memory flag alone does not survive the restart it was set for.**
   The commonest reason to open a window is to restart the process. A flag
   that lived only in memory would switch itself off precisely when traffic
   was supposed to stay held back. Hence the persisted layer remains the
   normal path.
3. **Any configuration can be wrong in a way that locks out its own fix.**
   `allowAdmins: false` is a legitimate setting — a window in which no human
   should touch the application — and it is also the one configuration that
   makes the endpoint that would undo it unreachable. Hence a third layer,
   outside the application's own data and its own API: the environment.

Three layers, each answering a failure the other two cannot.

## 1. The three layers

Resolved in `MaintenanceModeService.resolve()`, in this order:

```
env override  ??  in-memory override  ??  persisted setting
```

### 1.1 Persisted — the normal path

The `maintenance` namespace of the `system_settings` row (#256), read through
`SystemSettingsService.getMaintenancePolicy()` and written through
`SystemSettingsService.patchSettings()`. No new table, no new column, no second
storage location.

Two details of that accessor are deliberate. It **does not create the row**
(unlike `getSettings()`, which upserts) — a read on a path that runs for every
request in the application must not write. And it **is allowed to throw**:
`readPersisted` catches it, because "this read failed" is a normal, anticipated
outcome during the swap rather than a bug, and swallowing it inside the
settings service would take that distinction away from the only caller that
can act on it.

A failed read degrades to the last value this process saw, and to the seeded
defaults (`enabled: false`) if it has never seen one. Neither is a guess about
the operator's intent — the swap's own in-memory override is what holds traffic
back in that window, and it outranks this layer anyway.

**The read is cached for five seconds** (`MAINTENANCE_PERSISTED_CACHE_MS`).
A global guard runs on every request, and an uncached implementation would add
one query to every call the API serves, forever, to answer a question whose
answer is almost always "no". The instance that handles a write invalidates its
own cache synchronously, so it never serves a stale value to the next request;
other instances in a fleet converge within the window. `GET
/api/admin/maintenance` passes `fresh: true` and bypasses the cache entirely,
because an operator inspecting the switch must never be shown a stale one.

### 1.2 In-memory — the swap window's layer, and only that

`setInMemoryOverride({ enabled, message?, allowAdmins? })`, held in the process
and written nowhere. Its only intended caller is the restore swap (#285): take
the window before the rename, release it after.

It is **not reachable over HTTP**, on purpose. An override that nothing
persists, nothing else in a fleet can see, and no audit row records would be an
operator's worst afternoon; it is a mechanism for one internal caller, not a
feature. `message` and `allowAdmins` are optional on it, and when absent the
persisted values apply — those being the last thing that *was* readable before
the database went away.

### 1.3 Environment — the break-glass, honoured in both directions

`MAINTENANCE_MODE`, read straight from `process.env` on every resolve.

- `true` forces the window open even with an unreadable database, so traffic
  can be stopped before the application is fully up.
- `false` forces it shut. **This is the documented recovery** from a window
  opened with `allowAdmins: false`.

Only the literal strings `'true'` and `'false'` count. Anything else — unset,
`1`, `yes`, `on`, `off`, `TRUE` — means *no override*, and `readEnvOverride()`
returns `null`. A truthiness check here would turn `MAINTENANCE_MODE=off` into
an outage and `MAINTENANCE_MODE=0` into an unplanned recovery; both directions
are pinned by `maintenance-mode.service.spec.ts`.

It is read from `process.env` rather than through `ConfigService`, the same way
`SECRETS_ENCRYPTION_KEY` is read in `common/crypto/secret-cipher.ts`. A
break-glass control whose entire value is that it works when other things do
not should not depend on a successful configuration load, and should not have a
second, cached copy of its answer that can disagree with the environment the
operator actually edited.

### 1.4 `??`, never `||`

`false` is a meaningful value at the first two layers. `||` would silently
promote "forced off" to "ask the next layer" — which is exactly the bug the
break-glass exists to prevent.

`message` and `allowAdmins` are resolved **independently of `enabled`**, from
the highest layer that actually supplies them. The environment layer carries a
boolean and nothing else, so a window forced open from the environment still
shows the operator's stored copy and honours the stored `allowAdmins` — which
is what makes `MAINTENANCE_MODE=true` usable without having to invent a message
in a shell variable.

`startedAt` / `startedById` always come from the persisted layer. Neither the
environment nor the restore swap has a user to attribute a window to, and
inventing one would put a lie in the audit trail.

## 2. The guard resolves the admin role itself

`MaintenanceGuard` is registered as `APP_GUARD` — **the repository's first
global guard** — so it runs on every Nest route before any route-level
`UseGuards`. That ordering is the whole point (a window must hold back a route
before that route's own auth runs), and it has a direct consequence:
`request.user` does not exist yet. `JwtAuthGuard` is a route-level guard and
has not run.

So the guard verifies the bearer token itself, with its own `JwtService`, and
reads the `roles` claim that `auth/strategies/jwt.strategy.ts` puts there.

Three rules govern that, and each is asserted in `maintenance.guard.spec.ts`:

- **It never populates `request.user`.** Writing a user onto the request here
  would give every downstream guard, interceptor and handler an authentication
  path that did not go through Passport, the disabled-user check, or the PAT
  lookup — a second front door, opened by the one component in front of every
  route. This guard answers one yes/no question and gets out of the way;
  `JwtAuthGuard` still does the real work afterwards.
- **A token that fails verification is simply "not an admin", never a
  rejection.** Rejecting would change the status every unauthenticated caller
  sees on every route the moment a window opens (`401` instead of the `503`
  that is actually true), and would let a malformed header override a
  deliberate operational decision.
- **`pat_` and `nod_` bearers never get the bypass**, whatever `allowAdmins`
  says. They are opaque: no claims to read, and resolving one takes a database
  round trip — per request, on a guard that runs for every request, during a
  window in which the database may be exactly what is being worked on. They
  also belong to unattended clients, which are the callers that most need to
  back off and the least likely to be the human trying to fix things. The
  `Retry-After` header is the right answer for them.

### 2.1 `MaintenanceModule` does not import `AuthModule`

It registers its **own** `JwtModule.registerAsync` against the same
`jwt.secret`, with the same `'fallback-secret'` default `jwt.strategy.ts` uses.

`AuthModule` does export `JwtModule`, so importing it would work today. It also
pulls in `UsersModule`, `AllowlistModule`, `PatModule`, `NotificationsModule`,
`PassportModule` and both Passport strategies — the entire authentication
graph — behind a guard that runs in front of every request. That is one
refactor away from a circular import, and the shape of that failure is the
application not booting at all. It is an **acceptance criterion** of #257, and
`maintenance.module.spec.ts` asserts it by walking the module graph rather than
leaving it as a convention someone restores later.

The module deliberately does **not** re-export its `JwtModule`. `AuthModule`
already exports one into the root context, and a second exported `JwtService`
binding there could shadow it — including for the helpers the test suite
resolves from the root injector to sign tokens. `app.module.ts` therefore
aliases the guard with `useExisting`, so the instance is constructed in
`MaintenanceModule`'s context (where its `JwtService` lives) while the global
registration stays visible in the module that owns the application.

## 3. The 503: a stable marker and `Retry-After`

A `503` is also what a crashed upstream, an exhausted connection pool, or a
load balancer with no healthy backends produces. A client that cannot tell
those apart cannot show the operator's message and retry without also showing
it when the deployment is simply broken.

So every blocked response carries:

- **`details.reason === 'MAINTENANCE_MODE'`** — `MAINTENANCE_ERROR_MARKER`,
  exported from `maintenance.guard.ts`. The web client mirrors this constant in
  #258; changing it is a wire-contract change.
- **`details.retryAfterSeconds`** and a **`Retry-After` header**, both
  `MAINTENANCE_RETRY_AFTER_SECONDS` (30). Fixed and short rather than an
  estimate of when the window will close: nobody knows that, and a confident
  wrong answer is worse than a conservative one.
- **`details.allowAdmins`**, so a client can decide between "come back later"
  and "sign in as an administrator and carry on".

**The marker must live under `details`.**
`common/filters/http-exception.filter.ts` rebuilds every error body from a
fixed key allowlist (`statusCode`, `code`, `message`, `details`, `timestamp`,
`path`) and *always* derives `code` from the status, ignoring any `code` on the
thrown payload. A custom top-level field would be silently stripped on the way
out. That is why the marker is asserted through the **real filter**, over HTTP,
in `test/maintenance/maintenance.integration.spec.ts`, and not only against the
guard in isolation.

The header is set on the Fastify reply by the guard before it throws; the
filter's `send()` preserves headers set earlier.

## 4. Health semantics are deliberately asymmetric

| Probe | During a window | Why |
|---|---|---|
| `GET /api/health/live` | **200** | Liveness means "this process is not hung", which is still true. An orchestrator told otherwise would kill and restart the container in the middle of the very upgrade the window was opened for. |
| `GET /api/health/ready` | **503**, before the DB probe | Readiness means "send me traffic", which is exactly what must not happen. A load balancer drains the instance instead. |
| `GET /api/health` | unchanged | A diagnostic, not a traffic signal. During a window the honest answer is whatever its dependencies actually say — which, during the swap, is "the database is not there". |

The whole controller carries `@AllowDuringMaintenance()`: a probe that answered
`503` because it was *blocked* would tell an orchestrator nothing about the
process it is probing. What each probe *reports* is then decided route by
route, in the handler.

**The ordering in `readiness()` is the requirement, not an optimisation.**
The maintenance check runs *before* `health.check([...])`. During the swap the
database probe would fail on a connection error and readiness would report
`503` for a reason that reads like a fault; answering the maintenance question
first means the instance drains for the reason that is actually true, with a
body that says so — and readiness keeps answering correctly at the one moment
storage genuinely is not there. `resolve()` never throws, so this cannot turn a
database outage into a `500` on the probe. Both the ordering and the status are
asserted (`health.controller.spec.ts` proves the probe is never reached).

The readiness `503` carries the same marker but **no `Retry-After`** — that
header is the guard's contract with API clients, and this response is read by
probes. It is also what lets the reachable-set test tell a route the guard
*blocked* from a route that was *reached* and chose to report `503`.

## 5. What is reachable during a window

Exactly this set, and nothing else:

| Route | Why it must answer |
|---|---|
| `GET /api/health`, `/live`, `/ready` | Orchestrators and load balancers. |
| `GET /api/auth/providers`, `/google`, `/google/callback` | Signing in. A window nobody can sign in to is a window nobody can end. |
| `POST /api/auth/refresh` | Staying signed in. An access token is minutes long; a longer window would evict the admin who opened it. |
| `GET /api/auth/me` | The identity lookup the maintenance page needs to know whether the viewer is an admin. |
| `POST /api/auth/logout`, `/logout-all` | Signing out must never be the unavailable thing. |
| `GET /api/auth/device/activate`, `POST /api/auth/device/authorize` | The **browser** half of RFC 8628, driven by a signed-in human. |
| `POST /api/auth/test/login` | Non-production only (`TestAuthModule` is not registered in production). |
| `GET`/`PUT /api/admin/maintenance` | The switch that closes the window. |

Deliberately **not** exempt: `POST /api/auth/device/code` and
`POST /api/auth/device/token`, the polling half of the device flow. Those
belong to unattended clients — exactly what a window is asking to back off —
and the consequence is accepted and documented: **a CLI cannot log in while a
window is open.** Use the web UI, or the environment break-glass.

A CLI that is *already* logged in is a different case, and a deliberately
useful one: exemption is checked **before** the admin bypass, so a `pat_`
bearer can call `GET`/`PUT /api/admin/maintenance` during a window even though
it is blocked from everything else. An operator with a working token can close
a window from a shell without a browser.

`@AllowDuringMaintenance()` is **not** `@Public()`. That decorator answers "does
this route need a token?"; this one answers "may this route be served while the
application is deliberately out of service?". They are independent in both
directions: `GET /api/auth/me` needs a token and must still answer, while a
public read endpoint added by a fork must *not* become reachable merely because
it is public. Exemption is reachability only — `@Auth()` still runs, so a
caller without `system_settings:write` still gets a `403` during a window.

**The set is asserted as a whole**, by enumerating every route from the
application's own router metadata (the generated OpenAPI document) in
`test/maintenance/maintenance-reachable-set.integration.spec.ts`. A missing
exemption on a sign-in route locks every user out permanently, so this test is
the safeguard, not a nicety. A controller added by a later issue arrives in it
automatically: not exempt means blocked and the test still passes (blocked is
the safe default); exempt means the reachable set changed and the test fails,
which is the moment somebody should have to justify it.

## 6. `/api/docs` is not covered by this guard

`openapi/register-docs-routes.ts` mounts `/api/docs` and `/api/openapi.json`
**directly on the Fastify instance, outside Nest's router**. No Nest guard —
global or otherwise — ever sees them, so both stay readable while a window is
open.

That is intentional, and that file's own comments already say so: a maintenance
window is exactly when an operator wants the API reference. It is stated here,
in `maintenance.guard.ts`, in `app.module.ts` and in the reachable-set test so
that it is a documented decision rather than a hole somebody finds by noticing
the enumeration test does not cover it.

## 7. Permission and audit

**No new permission.** `GET` is gated on `system_settings:read` and `PUT` on
`system_settings:write` — the same pair the system settings endpoints use,
because this *is* a system setting, stored in the `maintenance` namespace of
that row and nowhere else.

Every write records an audit row following the repository's existing pattern
(`UsersService`, `AllowlistService`): `action` is `maintenance:enable` or
`maintenance:disable`, `targetType` is `maintenance`, `targetId` is `global`,
and `meta` carries `previouslyEnabled` plus only the fields the write actually
set. A row is written for every write, including one that merely edits the
message of an open window — somebody reaching for this switch during an
incident is the entire value of the record.

Because the write goes through `SystemSettingsService.patchSettings()` — which
owns the merge, the unknown-key preservation (#130) and the row's version
counter — the shared `system_settings:patch` row is written too. The
`maintenance:*` row is the one that names the window and carries its
provenance, and is what an operator greps for.

Opening a window stamps `startedAt` and `startedById`; closing one clears both.
Re-sending `enabled: true` to change the message is an **edit, not a new
window**, and leaves the original start alone — moving the timestamp would
erase how long traffic has actually been held. Neither field is accepted from
the request body: an audit trail the audited party can dictate is not one.

## Rejected alternatives

- **Folding this into the restore service (#285).** The restore swap is the
  demanding consumer, so putting the switch there looks economical. It is not:
  this work introduces the repository's **first `APP_GUARD`**, which touches
  every request in the application, and that blast radius does not belong
  inside the epic's riskiest PR. Landing it separately means the guard, the
  exemption list and the reachable-set test are reviewed on their own terms —
  and means the restore can consume a mechanism that already has tests behind
  it, instead of shipping one.
- **Persisted state only, with no in-memory layer.** Cannot work during the
  swap, which is the case the feature exists for: the flag lives in the
  database being renamed, so at that moment it is unreadable. A design with one
  layer either fails open (traffic hits a database that is being replaced) or
  throws (every request becomes a `500`).
- **In-memory state only.** Does not survive the restart it was set for, which
  is the commonest reason to open a window at all.
- **A dedicated `maintenance:manage` permission.** Protects nothing
  `system_settings:write` does not already cover — that permission already
  means "may change global application behaviour", and this is a system
  setting. A new permission would need seeding, assigning, documenting and
  granting, and every one of those is a chance for an administrator to hold
  `system_settings:write` and still be unable to end a window.
- **Importing `AuthModule` for its `JwtService`.** See §2.1. Works today,
  couples the application's first global guard to the entire authentication
  graph, and is asserted against.
- **Populating `request.user` from the guard's token verification.** Would
  create a second authentication path in front of every route, bypassing the
  disabled-user check and the PAT lookup. See §2.
- **Rejecting an unverifiable token with `401`.** Would change the status every
  unauthenticated caller sees on every route the moment a window opens, and
  would report something that is not true — the application is out of service,
  not the caller unauthenticated.
- **Middleware instead of a guard.** Middleware runs before Nest resolves the
  handler, so it has no access to route metadata and could not read
  `@AllowDuringMaintenance()` without re-implementing route matching by path.
  The exemption list would become a string-matching table maintained separately
  from the routes it exempts — and that table is the thing that must not be
  wrong.
- **A no-cache read of the settings row on every request.** Correct, and it
  adds a database query to every call the API serves, forever. The five-second
  cache with synchronous invalidation on write costs nothing an operator can
  perceive on the instance that made the change.

## Verification

| Claim | Where it is asserted |
|---|---|
| `MAINTENANCE_MODE=false` overrides a persisted `enabled: true` | `maintenance-mode.service.spec.ts`, and end to end in `test/maintenance/maintenance.integration.spec.ts` |
| Only `'true'`/`'false'` count as an override | `maintenance-mode.service.spec.ts` (table-driven over `1`, `0`, `yes`, `no`, `TRUE`, `False`, `on`, `off`, `''`) |
| The 503 body carries the marker **through the real exception filter**, plus `Retry-After` | `test/maintenance/maintenance.integration.spec.ts` |
| `pat_` and `nod_` bearers never receive the admin bypass | `maintenance.guard.spec.ts` and the integration suite |
| The guard never populates `request.user` | `maintenance.guard.spec.ts` |
| The exact reachable set, enumerated from the router | `test/maintenance/maintenance-reachable-set.integration.spec.ts` |
| `/api/health/live` is 200, `/api/health/ready` is 503 **before** the DB probe | `health.controller.spec.ts` (probe never reached) and the integration suite |
| `MaintenanceModule` does not import `AuthModule` | `maintenance.module.spec.ts` (module-graph walk) |
| `/api/docs` and `/api/openapi.json` stay readable | `test/maintenance/maintenance-reachable-set.integration.spec.ts` |
| A window is audited, with provenance | `maintenance-mode.service.spec.ts` and the integration suite |

Not covered here, and left to the issues that own them: the client-side banner
and the mirrored marker (#258), and the restore swap that installs the
in-memory override (#285). Nothing in this repository calls
`setInMemoryOverride` yet — it is exercised by tests and by
`GET /api/admin/maintenance`'s layer reporting, and its first production caller
arrives with #285.
