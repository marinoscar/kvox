# Running worker nodes

> Operator runbook for the distributed worker fleet (epic #254, Phase 4).
> The design and its rejected alternatives live in
> [`docs/specs/worker-nodes.md`](../specs/worker-nodes.md); the command
> reference lives in [`apps/cli/README.md`](../../apps/cli/README.md). This
> file is the *how do I run one* half, and deliberately does not restate
> either.

## What a worker node is

A machine running `appctl node start` that claims jobs from the application's
queue, runs them locally, and submits results. The **same handler code** runs
on the API server or on a node — a node is an option, never a requirement, and
a deployment with no nodes at all still executes every job type it enqueues.

Nodes coordinate through nothing but the database. Two workers never receive
the same job because the claim is a `FOR UPDATE SKIP LOCKED` on one table, so
you scale by starting more of them and configuring none of them to know about
the others.

## Prerequisites

| Requirement | Why |
|---|---|
| Node.js 20+ | The CLI's runtime floor |
| Outbound HTTPS to the application | The only network access a node needs — no inbound ports, ever |
| An account with `nodes:read` and `nodes:write` | To enroll and register |

A worker needs **no persisted** database access, no VPN, and no inbound
firewall rule. It downloads and uploads job data through short-lived presigned
URLs the server issues, so it never holds storage credentials at all, ever.
The one exception on the database side is `db.backup.run` (below): if your
fleet is going to take database backups, the node needs a **network route**
to PostgreSQL, and the credential it uses to connect is brokered per job, held
in memory only, and never written to disk — see "Taking database backups on a
node" further down.

## Getting a machine running

```bash
# 1. Enroll — device login, then mint a node credential for this machine.
appctl node enroll

# 2. Register — create (or re-attach to) this machine's row in the fleet.
appctl node register --concurrency 4

# 3. Check everything before committing to it.
appctl node doctor

# 4. Run it.
appctl node start --daemon
```

Step 3 is worth not skipping. `doctor` reports three independent things an
operator routinely conflates, and a failure in one never masks the others:

- **This machine** — runtime, capabilities for the advertised job types, and
  whether the state directory is writable.
- **The server** — reachable, credential accepted, permissions present. It
  distinguishes *cannot reach the server* from *reached it and was refused*,
  which look identical in a stack trace and have entirely different fixes.
- **The worker** — whether a daemon is actually running here.

## Running a fleet in containers

Containers are the recommended shape for more than one or two workers.

```bash
cd infra/compose
cp .env.worker.example .env.worker      # server URL + node credential
docker compose --env-file .env.worker -f worker.compose.yml up -d --scale worker=4
```

That is the whole configuration. Each replica registers as its own node and
they load-balance through the database — nothing coordinates them, and nothing
needs to. Every variable either file may set —
[generated from `WORKER_ENV`](../../apps/cli/README.md#worker-environment-variables),
never hand-copied — is in `apps/cli/README.md`'s own reference; this guide
does not restate it.

> **Leave `APPCTL_NODE_NAME` and `APPCTL_NODE_ID` empty when scaling.** Setting
> either makes every replica reattach to the same node row, and the server's
> per-node claim cap is then shared between processes that each believe they
> own it.

| Setting | Why it is there |
|---|---|
| `restart: unless-stopped` | The memory valve exits deliberately; without this a clean drain leaves the worker down |
| `stop_grace_period: 300s` | Long enough for a real drain before Docker escalates to `SIGKILL` |
| Exec-form `ENTRYPOINT` | Shell form wraps PID 1 in `/bin/sh -c`, which does not forward `SIGTERM` — the drain would never run |
| A volume at `/var/lib/worker` | State survives a restart, so a replica re-attaches instead of leaking a node row |

The worker makes only **outbound** connections: no ports, no inbound firewall
rule, and no database access.

To build the image from a checkout instead of pulling it:

```bash
docker compose -f worker.compose.yml -f worker.build.compose.yml up --build
```

CI publishes `ghcr.io/<owner>/<repo>-worker` beside the api and web images on
every tag, using the same tag conventions.

## Surviving a reboot

```bash
appctl node service install
loginctl enable-linger $USER      # ← do not skip this
```

This writes a systemd **user** unit — no root needed, and a worker has no
reason to run as root. Two details in the generated unit matter:

**`Restart=on-failure` is not decoration.** The memory watchdog exits
*deliberately* when the heap crosses its threshold, after draining cleanly and
writing a snapshot. Without a supervisor that successful drain leaves the
worker down — a self-healing mechanism turned into an outage.

**`loginctl enable-linger` is the step people miss.** Without it a user unit
stops when your last session ends, so a worker on a box you SSH into dies when
you log out. That reads as a crash and is actually policy.

`service install` on Windows or macOS, or on a Linux box with no per-user
systemd, prints guidance rather than a stack trace — including how to enable
systemd on WSL 2.

## Capabilities and the startup self-test

The worst failure a worker has is starting successfully and then failing every
job it claims: it looks healthy to every orchestrator and dashboard while
draining the queue into the failed pile, and each failure charges the job an
attempt.

So a headless worker probes its capabilities at startup and compares them
against what its eligible job types declare:

- A missing **required** capability → **hard exit** (code `70`), naming the
  capability and the type. In a container that is a visible crash-loop with a
  clear reason, which is strictly better than a node quietly failing
  everything.
- A missing **degradable** capability → warn and continue.

The template's example job type hashes a stream and needs nothing native. The
one entry that is real is the database backup:

| Type | Required | Degradable |
|---|---|---|
| `db.backup.run` | `pg_dump` | `psql` |

A node without `pg_dump` therefore never declares `db.backup.run` — which
matters more for this type than for any other, because it is configured never
to retry: a claim it cannot fulfil is a backup that simply did not happen.
`psql` is degradable because it is used only to read the server version and the
newest applied migration; without it the backup is taken, uploaded and verified
with those two audit fields left `null`.

A node also needs a **network route** to the database, which nothing on this
machine can check for you at startup. `appctl node doctor --db-host
db.internal:5432` probes it, as a warning rather than a failure — see
"Health checks" in [`apps/cli/README.md`](../../apps/cli/README.md#running-a-worker-node).

Beyond those, the **structure** is the deliverable, and it is the documented
place a fork declares that its `video.transcode` type needs `ffmpeg`.

### Taking database backups on a node

`db.backup.run` needing a real PostgreSQL connection — not a presigned URL —
is the one place a worker node's "no persisted database access" rule (above)
gets an exception rather than an exemption. Three things an operator turning
this on needs to know, none of them a code change:

1. **The connection is per job, not per node.** A node never holds a database
   password in its config file or its state directory. When it holds a
   `db.backup.run` job it calls `POST /nodes/:id/jobs/:jobId/secret`, gets one
   short-lived credential back, holds it in memory for the life of that job,
   and drops it. `apps/cli/src/node/executors/db-backup-run.test.ts` asserts
   this statically — the executor imports no config writer at all.
2. **Two independent switches, both off by default, must both be on** before
   any node is ever offered the job type: `nodes.jobSecretBrokerEnabled` ("may
   this deployment broker credentials to nodes at all?") and
   `databaseBackup.nodeOffloadEnabled` ("may *this* workload leave the API
   server?"). They are separate on purpose — a deployment can trust its fleet
   with credentials in general while still keeping backups on the server, or
   vice versa. Both live in the admin UI, not in an environment variable.
3. **The database role this API connects as needs `CREATEROLE`** to mint the
   short-lived, read-only role each backup job uses. `GET
   /api/admin/db-backup/node-credential-preflight` tells you, without
   changing anything, whether it already has that grant — and if it does not
   (the ordinary case on managed PostgreSQL, where the application role is
   deliberately not a superuser), it hands back a paste-ready `ALTER ROLE …
   CREATEROLE;` (or a dedicated minter role, the least-privilege option) in
   its response rather than failing. Run one of those once, as whatever
   account administers your database. Auditing issued roles and cleaning up
   an orphan by hand is [`docs/runbooks/node-job-secrets.md`](../runbooks/node-job-secrets.md).

Until all three are true, `db.backup.run` runs on the API server exactly as it
did before node offload existed — nothing about turning this on is required
to take backups at all.

### Declaring a requirement in a fork

In `apps/cli/src/node/capabilities.ts`:

```ts
export const PROBED_BINARIES = ['ffmpeg'];

export const JOB_TYPE_REQUIREMENTS = {
  'video.transcode': {
    required: [binaryCapability('ffmpeg')],
    degradable: [binaryCapability('exiftool')],
  },
};
```

## Installing dependencies

```bash
appctl node install-deps --dry-run   # print the plan, change nothing
appctl node install-deps
```

⚠️ **This ships as a framework, not as a set of real installs.** The template
has no native dependencies to install, and inventing some would mean a fork had
to work out which of the steps were real. What you get is the structure —
ordered steps, per-step `skipped | installed | failed | unsupported`, distro
detection, an explicit sudo announcement before anything runs, and a working
`--dry-run`. Add your own steps in `apps/cli/src/node/install-deps.ts` beside
the two generic ones.

## Memory

Three mechanisms, all on by default, all with one thing in common: they assume
a supervisor is watching.

**Heap tuning.** The worker re-execs itself once at startup with a RAM-aware
`--max-old-space-size`, because Node's default old-space limit is low for a
machine dedicated to being a worker. The original process becomes a
signal-forwarding shim, so a container `SIGTERM` still reaches the worker and
still drains. Set `APPCTL_HEAP_LIMIT_MB=0` when a cgroup or a PaaS already
manages memory — a second opinion there is worse than none.

**The watchdog** samples memory and, once the samples span a real window,
reports a least-squares growth trend in MB/hour. That trend is the difference
between "it died" and "it was climbing 40 MB/hour for six hours".

**The pre-OOM valve** fires once when `heapUsed / heapLimit` crosses the
threshold (default `0.9`): snapshot → log → drain → exit `71`.

> ⚠️ **The valve requires a supervisor.** It exits deliberately after a clean
> drain. Without `Restart=on-failure` or `restart: unless-stopped`, a
> *successful* drain leaves the worker down — a self-healing mechanism turned
> into an outage. `appctl node service install` sets this for you.

### Diagnosing a leak

```bash
appctl node heap-snapshot     # asks the LIVE daemon
```

Ask the running worker, not a fresh one. Restarting to attach a diagnostic flag
discards exactly the accumulated state that names the retainer — which is also
why the valve writes its snapshot *before* draining rather than after.

Snapshots land in `<state dir>/heap-snapshots`, newest five kept, and are
skipped with a clear reason when free disk is under 1.5× the live heap: a
snapshot must never be the thing that fills the volume. Open one in Chrome
DevTools → Memory → Load.

| Exit code | Meaning |
|---|---|
| `0` | Clean stop |
| `70` | A required capability for an advertised job type is missing |
| `71` | The pre-OOM valve fired — restart it |

## Day-to-day operation

```bash
appctl node status              # live snapshot from the running worker
appctl node logs --follow       # attach to the daemon's event stream
appctl node set-concurrency 8   # applies live; persists either way
appctl node stop
```

Attaching is **read-only** and passive: inspecting a worker never perturbs it,
and detaching leaves it running untouched.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `A worker is already running here (pid N)` | A live daemon holds this state directory | `appctl node stop`, or use a different `APPCTL_STATE_DIR` |
| Starts, then exits with code `70` | An advertised job type is missing a required capability | The message names both — install it, or drop the type from `--types` |
| `doctor` says reachable but refused (401) | The credential was revoked or belongs to another server | `appctl node enroll` again |
| `doctor` says refused (403) | The account lacks `nodes:read`/`nodes:write` | Ask an administrator to grant them |
| `doctor` says 404 on `/api/nodes` | The server predates worker nodes | Upgrade the server |
| The node shows online in the admin UI but does nothing | It has no executor for any advertised type | `appctl node status` lists what it can actually run |
| Jobs fail immediately with a rate-limit message | A provider is throttling | Nothing to do — the server defers those without charging an attempt |
| The worker vanishes when you log out | No systemd lingering | `loginctl enable-linger $USER` |

## What lands in the logs

JSONL under `<state dir>/logs/node.log`, one rollover generation at 5 MiB,
written synchronously so the lines immediately before a crash survive it.

**Secrets are redacted before anything reaches disk** — tokens, API keys,
passwords, and presigned storage URLs — recursively, through nested objects and
arrays. That last one matters: a presigned URL is a bearer capability over an
object, and log files are things people attach to issues.
