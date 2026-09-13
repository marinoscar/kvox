# Runbook: Open, Close, and Recover a Maintenance Window

This runbook covers the operator-facing lifecycle of maintenance mode: taking
the application out of service for planned work, putting it back, the
environment break-glass, and recovering from a window that has locked
administrators out. It does not cover the design — see
[`docs/specs/maintenance-mode.md`](../specs/maintenance-mode.md) for the three
layers, why each exists, and what is deliberately left uncovered.

Source of truth for every claim below:

- `apps/api/src/common/maintenance/maintenance-mode.service.ts` — the three
  layers and how they are resolved.
- `apps/api/src/common/maintenance/maintenance.guard.ts` — what a blocked
  caller receives, and who is let through.
- `apps/api/src/common/maintenance/maintenance.controller.ts` —
  `GET`/`PUT /api/admin/maintenance`.
- `apps/api/src/common/maintenance/allow-during-maintenance.decorator.ts` —
  the exemption, and every controller that carries it.
- `infra/compose/.env.example` — `MAINTENANCE_MODE`, commented out by default.

**Maintenance mode ships off.** A fresh deployment has
`maintenance.enabled: false` in its system settings and no `MAINTENANCE_MODE`
in its environment; nothing in this codebase turns it on by itself.

---

## 1. Before you start

- **Decide about `allowAdmins` first.** With it left at its default (`true`),
  anyone holding the `admin` role keeps full access while everyone else gets a
  `503`. Setting it to `false` locks administrators out too — a legitimate
  choice for a window in which no human should touch the application, and the
  one configuration that needs section 5 to undo. If you are unsure, leave it
  alone.
- **Know how you will get back in.** You need one of: an admin session in a
  browser, an already-issued token, or shell access to the deployment's
  environment. You cannot obtain a *new* CLI token during a window — see
  section 6.
- **Write the message you want callers to see.** It is shown verbatim to every
  blocked caller and to the client's maintenance banner. 1–1000 characters.
- Windows are **global**. There is one window for the whole deployment; there
  is no per-route or per-tenant maintenance.

## 2. Opening a window

### 2.1 From the API

```bash
curl -sS -X PUT https://<your-deployment>/api/admin/maintenance \
  -H "Authorization: Bearer <admin access token>" \
  -H 'Content-Type: application/json' \
  -d '{
        "enabled": true,
        "message": "Upgrading the database. Back at 03:00 UTC.",
        "allowAdmins": true
      }'
```

Requires `system_settings:write`. `message` and `allowAdmins` are optional:
omitting them keeps whatever is stored, so re-opening a window with copy you
already agreed on is just `{"enabled": true}`.

With the CLI, if you are already logged in:

```bash
appctl api PUT /api/admin/maintenance \
  --data '{"enabled": true, "message": "Upgrading. Back at 03:00 UTC."}'
```

### 2.2 What changes immediately

- Every API route except the exempt set answers `503` with your message, a
  `Retry-After: 30` header, and `details.reason: "MAINTENANCE_MODE"` in the
  body.
- `GET /api/health/live` keeps answering `200`, so orchestrators do not restart
  the container.
- `GET /api/health/ready` answers `503`, so load balancers drain the instance.
- The window's start time and the user who opened it are recorded in the
  settings row and in an audit event (`maintenance:enable`).

### 2.3 What stays reachable, on purpose

Sign-in (`/api/auth/providers`, `/google`, `/google/callback`), token refresh,
`/api/auth/me`, logout, the browser half of device activation, the health
probes, and the maintenance endpoints themselves. Also `/api/docs` and
`/api/openapi.json`, which are served outside the guard entirely.

The full list, and the reasoning for each entry, is in the spec. It is asserted
by a test that enumerates every route in the application, so it cannot drift
from what this runbook says.

### 2.4 Verifying

```bash
curl -sS https://<your-deployment>/api/health/live    # expect 200
curl -sS -i https://<your-deployment>/api/health/ready # expect 503
curl -sS -i https://<your-deployment>/api/user-settings # expect 503 + Retry-After
```

## 3. Closing a window

```bash
curl -sS -X PUT https://<your-deployment>/api/admin/maintenance \
  -H "Authorization: Bearer <admin access token>" \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'
```

This clears `startedAt` and `startedById` and records a `maintenance:disable`
audit event. Traffic resumes on the instance that handled the request
immediately; other instances in a fleet pick the change up within a few
seconds, because each caches its read of the settings row briefly.

If the application still appears to be down after this, **do not repeat the
call** — go to section 4 and find out which layer is deciding.

## 4. "I turned it off and it is still on"

`GET /api/admin/maintenance` reports the effective state **and every
contributing layer separately**, which is exactly the question to ask here:

```bash
curl -sS https://<your-deployment>/api/admin/maintenance \
  -H "Authorization: Bearer <admin access token>" | jq
```

```json
{
  "data": {
    "enabled": true,
    "message": "Upgrading. Back at 03:00 UTC.",
    "allowAdmins": true,
    "startedAt": "2026-01-01T02:00:00.000Z",
    "startedById": "…",
    "source": "env",
    "layers": {
      "env":       { "present": true,  "enabled": true },
      "memory":    { "present": false, "override": null },
      "persisted": { "readable": true, "value": { "enabled": false, "…": "…" } }
    }
  }
}
```

Read `source` first — it names the layer that decided `enabled`:

| `source` | What is happening | What to do |
|---|---|---|
| `env` | `MAINTENANCE_MODE` is set in the environment and outranks everything else. | Remove or change the variable and restart the process (section 5). Writing to the API will not help. |
| `memory` | An in-process override is held — during normal operation this only happens while a database restore is mid-swap. | Wait for the restore to finish. If nothing is running, restarting the process clears it. |
| `persisted` | The stored setting is deciding, which is the normal case. | `PUT` with `{"enabled": false}` (section 3). |

Two further tells:

- `layers.persisted.readable: false` means the settings row could not be read
  at all. The values shown are the last ones this process saw, or the seeded
  defaults. Expect this during a restore swap; outside one, it means the
  database is unreachable and that is the problem to fix.
- `layers.env.present: true` with `enabled: false` is the break-glass holding
  the application **open** — which is what section 5 sets up, and which you
  must remember to remove afterwards.

## 5. The environment break-glass

`MAINTENANCE_MODE` overrides both other layers, in both directions.

```bash
MAINTENANCE_MODE=true    # force the window OPEN
MAINTENANCE_MODE=false   # force the window SHUT
```

Only the literal strings `true` and `false` are honoured. Anything else —
unset, `1`, `yes`, `on`, `off`, `TRUE` — means *no override*, and the stored
setting decides. This is deliberate: a lenient reading would turn
`MAINTENANCE_MODE=off` into an outage.

The variable is read from the process environment, so **changing it requires a
restart** of the API process (`docker compose up -d api`, or your platform's
equivalent).

Use `MAINTENANCE_MODE=true` when:

- traffic must stop before the application is even fully up, or
- the database cannot be read, so the stored flag is unreachable.

Use `MAINTENANCE_MODE=false` when: see section 6.

**Remove the variable when you are done.** It outranks the API permanently, so
a forgotten `MAINTENANCE_MODE=false` means a future window opened through the
UI will appear to do nothing at all — the confusing state section 4 exists to
diagnose.

## 6. Recovering from an `allowAdmins: false` lockout

**Symptom.** A window was opened with `"allowAdmins": false`. Every route
answers `503`, including for administrators. Signing in still works, but every
page after sign-in is blocked. The `PUT` that would close the window is itself
reachable — the maintenance endpoints are always exempt — so try this first:

```bash
curl -sS -X PUT https://<your-deployment>/api/admin/maintenance \
  -H "Authorization: Bearer <admin access token>" \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'
```

You need an access token to do that. Sign-in and refresh are exempt, so you can
get one through the browser. What you **cannot** do is complete a *new* CLI
login: the polling half of the device flow (`/api/auth/device/code`,
`/api/auth/device/token`) is blocked during a window, deliberately, because it
belongs to unattended clients. An `appctl` installation that already holds a
valid token still works against the maintenance endpoints.

**If you have no usable token at all**, use the break-glass:

1. Set `MAINTENANCE_MODE=false` in the deployment's environment
   (`infra/compose/.env`, or your platform's variable store).
2. Restart the API process.
3. Confirm with `GET /api/admin/maintenance` that `source` is now `env` and
   `enabled` is `false`. The application is serving traffic again, but the
   stored window is **still open underneath** — `layers.persisted.value.enabled`
   will still be `true`.
4. Close the stored window properly:
   `PUT /api/admin/maintenance {"enabled": false}`.
5. **Remove `MAINTENANCE_MODE` from the environment** and restart again. Until
   you do, no future maintenance window will have any effect.

Do not skip step 4. Leaving the stored window open and the override in place
means the deployment is one environment change away from an unexplained
outage.

## 7. Summary checklist

**Opening a window**

- [ ] Message written, 1–1000 characters
- [ ] `allowAdmins` decided (default `true`; `false` needs section 6 to undo)
- [ ] `PUT /api/admin/maintenance {"enabled": true, …}` returned `200`
- [ ] `/api/health/live` is `200`, `/api/health/ready` is `503`
- [ ] A blocked route returns `503` with `Retry-After` and
      `details.reason: "MAINTENANCE_MODE"`

**Closing a window**

- [ ] `PUT /api/admin/maintenance {"enabled": false}` returned `200`
- [ ] `GET /api/admin/maintenance` reports `enabled: false` with
      `source: "persisted"`
- [ ] `/api/health/ready` is `200` again
- [ ] No `MAINTENANCE_MODE` left in the environment

**After using the break-glass**

- [ ] Stored window closed through the API, not just overridden
- [ ] `MAINTENANCE_MODE` removed from the environment
- [ ] Process restarted, and `GET /api/admin/maintenance` reports
      `layers.env.present: false`
