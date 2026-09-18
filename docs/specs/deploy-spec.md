# Deploy CLI — Portable Implementation Specification

**Status:** Reference implementation shipped and running in production.
**Purpose:** Enable a faithful re-implementation in another repository.
**Reference implementation:** `apps/cli/src/deploy/` in this repository, CLI 1.8.0.

---

## 0. How to use this document

This is **not** the design history of this repository's deploy CLI — that is
[`vps-deploy.md`](./vps-deploy.md), 25 sections of decisions and rejected
alternatives, tied to this codebase's own issue numbers. This document is the
**portable** version: what to build, in what order, and — most importantly —
the twenty-odd defects that were discovered only by running this against a real
server, each with the rule that prevents it.

Read it in this order:

1. **§1–§3** — the model. Get these wrong and nothing else matters.
2. **§13 (the bug catalogue)** — read it *before* implementing, not after. Every
   entry cost real debugging time on a live server. Most are invisible in tests.
3. **§4–§12** — the subsystems, in implementation order.
4. **§14** — the port checklist.

Where this document says **MUST**, it is because the alternative was tried and
failed in production. Where it says **SHOULD**, it is a strong default with a
stated escape hatch.

### The single most important sentence in this document

> **A deployment is a clone, an `.env`, and running containers. It is not a
> record in a file.**

Two separate production outages in this implementation traced to code that
keyed on bookkeeping instead of evidence. See §13.11 and §13.12.

---

## 1. Scope and the four decisions that shape everything

### 1.1 What the CLI does

One first-party CLI binary with a `deploy` command group that takes a fresh
Linux VPS to a running, HTTPS-served application, and keeps it updated.

Eight subcommands:

| Command | Purpose |
|---|---|
| `doctor` | Read-only readiness report. Changes nothing, ever. |
| `install` | Fresh deployment: clone → configure → build → migrate → seed → start → publish TLS. |
| `update` | Move an existing deployment to a newer revision. |
| `uninstall` | Remove a deployment, with opt-in database drop and storage purge. |
| `status` | Health of a deployed app: containers, endpoint, certificate. |
| `about` | What is deployed here — revision, version, timestamps. |
| `list` | Inventory of every app under the apps root. |
| `certs` | Issue, renew and inspect TLS certificates. |

### 1.2 Decision 1 — The CLI runs **on** the server, not against it

There is **no SSH client in the CLI**. The operator SSHes into the VPS
themselves and runs the binary there.

**Why:** an SSH-driven deployer must reimplement a shell, quoting, error
propagation, TTY handling, and connection recovery. Running locally means every
command is an ordinary child process with an exit code, and the interactive
wizard is an ordinary terminal program. The cost — the operator must SSH first —
is one line in the runbook.

**Consequence you must accept:** the CLI must be *installed* on the VPS. Provide
a `bootstrap-vps.sh` one-liner that installs Node, clones, builds and links the
binary.

### 1.3 Decision 2 — TLS terminates at a **shared, containerized proxy**

One nginx container on the host serves every app. Each deployment writes its own
vhost file into the proxy's conf directory and reloads the proxy. Certificates
come from certbot via a shared ACME webroot.

**Why not per-app TLS:** N apps would mean N certbot installs, N renewal crons,
and a port-80 fight. One shared proxy means one renewal path.

**Consequences, all of which bit us:**

- The proxy, its network and its certificates are **shared infrastructure**.
  `uninstall` MUST refuse to remove them (§7.4).
- A renewal cron entry is **per-host, not per-app** — one entry renews every
  certificate behind the proxy. Installing a second one is duplicated work.
- Let's Encrypt permits **5 duplicate certificates per week**. A CLI that
  re-issues on every install will exhaust that quota during a debugging session.
  This is the direct reason `uninstall` keeps certificates by default.

### 1.4 Decision 3 — **No database service** in the compose file

The application connects to an existing PostgreSQL the operator already runs.
The compose stack is `api`, `web`, `nginx` — no `db`.

**Why:** a database inside the app's compose project is deleted by
`docker compose down -v`, which is exactly what an uninstall does. Making the
CLI responsible for someone's data store means making uninstall responsible for
destroying it.

**Consequence:** the wizard must *verify* the database connection before the
install proceeds, because there is no fallback (§6.6).

### 1.5 Decision 4 — The deploy pipeline is **data, not a function**

Both pipelines are arrays of `{ id, title, skip?, run }`. Four separate consumers
read that array: the `--skip-*` flags, `--resume`, `status`, and the TUI's
progress view.

**Why:** an imperative function forces every one of those four to re-derive what
the steps are, and they drift. As data, adding a step updates all four for free.

```ts
export interface DeployStep<C> {
  id: string;
  title: string;
  /** Skipped, with this reason, when it returns a string. */
  skip?: ((context: C) => string | undefined) | undefined;
  run(context: C): Promise<void>;
}
```

---

## 2. The model: what a deployment is

### 2.1 On disk

```
<apps-root>/                       default /opt/infra/apps
  <app-name>/                      the DEPLOY ROOT
    repo/                          git clone, always detached HEAD
    data/                          bind-mounted persistent data
    deploy-info/
      info.json                    what the APP reports about itself
    logs/                          run journals
    .env                           0600, the real configuration
    .appctl-deploy.json            the CLI's own bookkeeping
<proxy-root>/                      default /opt/infra/proxy
  conf.d/<app>.conf                this app's vhost
  certs/                           shared certificates
  webroot/                         shared ACME challenge dir
```

### 2.2 The recognition predicate — get this right first

```ts
// A directory is a deployment when BOTH are true.
function isDeployment(deployRoot: string): boolean {
  return hasGitCheckout(join(deployRoot, 'repo')) && hasReadableEnvFile(deployRoot);
}
```

**Both, and only these two.** Each is something the CLI creates and the pipeline
needs, and neither is inferable from the other.

⚠ **Running containers are deliberately EXCLUDED from this predicate.** A
deployment whose containers are stopped or wedged is *precisely* the one being
updated or repaired, and consulting Docker would put a subprocess on a path that
must work when the daemon is down.

⚠ **The state file is NOT part of this predicate.** That is the entire lesson of
§13.11.

### 2.3 Two records, two different questions

| | `.appctl-deploy.json` | `deploy-info/info.json` |
|---|---|---|
| Question | What does the CLI know about this deployment? | What does the running app report about itself? |
| Reader | The CLI | The API, on every request |
| Location | Deploy root | Bind-mounted read-only into the api container |
| Missing means | Unrecorded — adopt it (§7.3) | `deployInfoStatus: "absent"` — never an error |
| Written | Both success and failure paths | Once `health` passes |

Keep them separate. They answer different questions for different readers, and
conflating them produces a CLI that lies to the UI or a UI that cannot render a
partially-failed deploy.

---

## 3. Prerequisites and host layout

### 3.1 What the operator provides

- A Linux VPS with Docker and Compose v2, a non-root user in the `docker` group.
- `git`, Node ≥ 22, and the GitHub CLI (`gh`) if the repo is private.
- An existing PostgreSQL reachable from the VPS.
- A DNS A record pointing at the VPS.
- Object storage (S3-compatible) if the app needs it.

### 3.2 Never run the CLI under `sudo`

⚠ **`sudo` resets `HOME` to `/root`.** The GitHub CLI stores credentials
per-user under `$HOME/.config/gh`. An operator who authenticated as themselves
and then ran `sudo kvox deploy install` gets an unauthenticated `gh` and a
confusing clone failure.

Everything the CLI writes must be writable by the ordinary operator: the apps
root, the proxy conf directory, the ACME webroot. Where it cannot be — `/etc/cron.d`
is the real case — that failure MUST be non-fatal (§13.7).

---

## 4. Repository layout to create

```
apps/cli/
  src/
    errors.ts                   CliError hierarchy carrying exit codes
    package-info.ts             reads version from package.json at runtime
    commands/
      deploy.ts                 Commander wiring: 8 subcommands, flags
    deploy/
      layout.ts                 apps root, deploy roots, app resolution
      state.ts                  .appctl-deploy.json read/write
      deploy-info.ts            info.json build/validate
      deployment-evidence.ts    the recognition predicate (§2.2)
      adopt.ts                  rebuild a missing state file from evidence
      repo.ts                   resolve repo URL/ref without hardcoding
      env-spec.ts               parse .env.example into EnvVarSpec[]
      env-metadata.ts           per-key policy: secret, essential, derive...
      env-file.ts               read/write/serialize the real .env
      env-wizard.ts             the interactive + unattended resolver
      wizard/steps.ts           the question grouping
      executor.ts               runCommand: spawn, capture, abort
      journal.ts                per-run log file with redaction
      hooks.ts                  DeployHooks — the CLI/TUI seam
      steps/pipeline.ts         runPipeline over DeployStep[]
      install.ts                the install pipeline
      update.ts                 the update pipeline
      uninstall.ts / teardown.ts
      database-create.ts / database-drop.ts
      storage-purge.ts
      version-step.ts / app-version.ts
      proxy.ts                  vhost write + reload + certbot
      health.ts                 readiness probing
      server-facts.ts           CPU, RAM, public IP
      docker-ports.ts           every host port Docker has promised
      inventory.ts              deploy list
      about.ts / status.ts
      checks/                   the doctor registry
        index.ts host.ts database.ts dns.ts github.ts tls.ts probe.ts types.ts
      testing/fake-vps.ts       the test harness (§12)
    tui/screens/deploy/         one screen + one model per command
  README.md
  bootstrap-vps.sh
infra/compose/
  .env.example                  ⚠ THIS IS THE WIZARD'S QUESTION LIST
  vps.compose.yml
.github/workflows/deploy-e2e.yml
```

### 4.1 One rule about module boundaries

`env-spec.ts` MUST be **pure and metadata-free** — it parses a file into
structs and knows nothing about which keys are secret or essential. Policy lives
in `env-metadata.ts`. This separation is what lets a second consumer (a local
`init` profile) reuse the parser with a different policy, and it is why §13.15's
fix could not live in the parser.

---

## 5. Architecture: the pipeline, the hooks seam, two renderers

### 5.1 `runPipeline`

```ts
export async function runPipeline<C extends StepContext>(
  steps: readonly DeployStep<C>[],
  context: C,
): Promise<PipelineResult> {
  const results: StepResult[] = [];
  const completed: string[] = [];

  for (const [index, step] of steps.entries()) {
    const alreadyDone = context.completed.has(step.id);
    const skipReason = alreadyDone ? 'already completed (resumed)' : step.skip?.(context);

    if (skipReason !== undefined) {
      results.push({ id: step.id, title: step.title, outcome: 'skipped', durationMs: 0, detail: skipReason });
      if (alreadyDone) completed.push(step.id);
      context.hooks?.onStepResult?.(/* … */);
      continue;
    }

    context.hooks?.onStepStart?.({ id: step.id, title: step.title, index, total: steps.length });
    try {
      await step.run(context);
    } catch (error) {
      const failed = { id: step.id, title: step.title, outcome: 'failed' as const, detail: message(error) };
      results.push(failed);
      context.hooks?.onStepResult?.(failed);
      // STOP. Continuing past a failed step is how a deployment ends up
      // half-applied and harder to reason about than one that stopped.
      return { steps: results, completed, failed, error };
    }
    results.push({ id: step.id, title: step.title, outcome: 'ok' });
    completed.push(step.id);
  }
  return { steps: results, completed };
}
```

Two details that matter:

- **`completed` is returned on the failure path too.** This is what `--resume`
  reads. Discarding it is §13.9.
- **The thrown error is returned as `error`**, not flattened into a string, so a
  step that fails on a precondition keeps its exit code.

### 5.2 The hooks seam

```ts
export interface DeployHooks {
  onStepStart?(step: { id: string; title: string; index: number; total: number }): void;
  onStepResult?(result: StepResult): void;
  onProgress?(message: string): void;
}
```

**No step writes to a terminal.** Every step reports through hooks. That is what
makes the TUI a second *renderer* rather than a second *implementation* — and it
is the only reason the CLI and TUI cannot drift apart in behaviour.

⚠ **The abort controller must actually reach the child process.** An earlier
iteration created one and never passed it anywhere, so Esc "cancelled" a
`docker compose build` that went on running on a production server. Thread it
through `runCommand` into the spawn, and kill with SIGTERM.

### 5.3 Errors carry their own exit codes

```ts
export abstract class CliError extends Error {
  abstract readonly exitCode: ExitCode;
}
export class UsageError extends CliError { readonly exitCode = EXIT.USAGE; }
export class PreconditionError extends CliError { readonly exitCode = EXIT.PRECONDITION; }
export class AuthRequiredError extends CliError { readonly exitCode = EXIT.AUTH; }
export class NetworkError extends CliError { readonly exitCode = EXIT.NETWORK; }
```

A monitoring script must be able to tell *"this server is not ready"* from
*"the CLI broke"*. A switch at the top level cannot, because by then the error is
a string.

---

## 6. The environment system — the largest subsystem, and the one that breaks

This is where most of the production defects lived. Budget accordingly.

### 6.1 The central idea

> **`infra/compose/.env.example` IS the wizard's question list.**

There is no second list of variables anywhere. Adding a variable to the template
adds a question. Nothing is hardcoded in the CLI.

### 6.2 `EnvVarSpec` — the parse result

```ts
export interface EnvVarSpec {
  key: string;
  /** The section banner this key appeared under. '' before the first one. */
  section: string;
  /** Template value, with any trailing inline comment removed. */
  defaultValue: string;
  /** The comment lines immediately above the key, joined with newlines. */
  help: string;
  /** True when the key appeared commented out (`# KEY=value`). */
  optional: boolean;
  /** 1-based line in the source file, for error messages. */
  line: number;
}
```

⚠ **`optional` is derived from the key being commented out in the template.**
This is elegant and has one sharp edge you must document in the template itself:
*any* commented `# KEY=value` line registers as an optional-variable
declaration. Writing an illustrative example in prose — `# MAINTENANCE_MODE=true`
inside an explanatory comment — silently declares that key twice. Put a comment
in the template saying so, and add a parity test.

### 6.3 Line splitting — read §13.4 before writing this function

```ts
function splitLines(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}
```

**MUST be the only line splitter in the module.** Deliberately not
`split(/\r?\n/)` — this form keeps array indices identical to the LF case, which
is what `spec.line` reports.

### 6.4 `EnvVarMetadata` — per-key policy

```ts
export interface EnvVarMetadata {
  /** Never echoed, never logged, never rendered into a frame. */
  secret?: boolean;
  /** Asked even when the template supplies a default. */
  essential?: boolean;
  /** In an UNATTENDED run, the template default is an acceptable answer. */
  defaultAcceptable?: boolean;
  /** Offer to generate rather than make someone invent one. */
  generate?: 'base64-32';
  validate?: (value: string) => string | undefined;
  /** Computed from the domain and earlier answers; never prompted for. */
  derive?: (context: DeriveContext) => string | undefined;
  /** Proposed from the server when nothing usable is set yet. */
  suggest?: (context: DeriveContext) => Promise<Suggestion | undefined>;
  /** A produced `suggest` is TAKEN rather than put to the operator. */
  autoAccept?: boolean;
  help?: string;
  /** Forced for a VPS deployment. Not offered, not overridable. */
  fixed?: string;
  /** Only asked when the operator opted into this group. */
  group?: EnvGroup;
  /** Never written at all, whatever the template says. */
  never?: boolean;
  /** An EMPTY value is an acceptable answer. */
  allowBlank?: boolean;
}
```

A key with **no entry** still works: not secret, not essential, template default.
That is the point — metadata is the exception list, not a mirror of the template.

**`defaultAcceptable` exists because of a real distinction:** in an unattended
run, `POSTGRES_PASSWORD=postgres` is a placeholder nobody chose and must be
refused; `POSTGRES_SSL=false` is a real setting somebody did. Both are template
defaults for essential keys. Only the second carries `defaultAcceptable: true`.

### 6.5 `autoAccept` — four guards, each separate

A suggestion the server can compute better than a human (a free port, a worker
count) is **taken**, not asked. Four things it must NOT do, and each needs its
own guard at the call site:

1. It does not **hide** the value — the row still reaches the review table as
   `suggested`, with its reason.
2. It does not beat an explicit `--answer` or a value already in the `.env`.
3. It does not survive `--all`, whose whole purpose is to force every question.
4. It does nothing when no suggestion could be produced (an exhausted port scan,
   an unknown CPU count) — the key falls back to being asked.

### 6.6 Inline verification

The domain and database wizard steps verify their answers **before the next
question**, using the same check registry the doctor runs. Discovering a wrong
database password at the `migrate` step, twelve minutes and one image build
later, is the failure this prevents.

### 6.7 Writing the file

```ts
writeEnvFile(deployRoot, serializeEnvFile(values, specs));   // 0600, at the app root
```

- **0600, at the deploy root** — it holds the database password, the JWT secret
  and the OAuth client secret, and it must survive `rm -rf repo`.
- A symlink from the compose directory into it keeps `docker compose` working.
- `serializeEnvFile` preserves the template's **section banners and key order**,
  then emits anything not in the template under a `# Not in .env.example` banner.
  The file's purpose is to diff cleanly against the template; losing that order
  is a real regression even though no data is lost (§13.15).
- The CLI writes two keys of its own that are **deliberately absent from the
  template**: `COMPOSE_PROJECT_NAME` and `DEPLOY_ROOT`. They carry through under
  that banner. `DEPLOY_ROOT` later doubles as the marker that says *this `.env`
  was written by this CLI* (§7.7).

### 6.8 Three ways a key is permanently absent — and none is drift

This is §13.15, stated here because it shapes the data model:

1. The operator **declined an optional variable** (`optional: true` in the
   template; the resolver deletes the key).
2. The key carries **`never: true`** and is deleted outright.
3. The key belongs to an **opt-in feature group** the deployment did not enable.
   ⚠ These are **not** commented out in the template, so `spec.optional` does not
   cover them.

Any code asking *"what did this revision add?"* must exclude all three. Asking
only *"what is in the template and not in the file?"* is a different question
with a different answer.

---

## 7. The eight commands

### 7.1 `doctor` — the check registry

A read-only report. It creates nothing, drops nothing, renames nothing. An
operator runs `doctor` precisely when they have *not* decided to install.

```ts
export interface Check {
  id: string;
  title: string;
  severity: 'required' | 'recommended';
  run(context: CheckContext): Promise<CheckResult>;   // 'pass' | 'warn' | 'fail' | 'skip'
}
```

The shipped registry, as a starting set:

| Group | Checks |
|---|---|
| Host | `docker-installed`, `docker-daemon`, `docker-compose-v2`, `git-installed`, `node-version`, `disk-space`, `memory`, `bind-port-free`, `deploy-root-writable`, `cron-dir-writable` |
| Proxy | `proxy-root`, `proxy-conf-writable`, `acme-webroot`, `proxy-container`, `proxy-network-mode`, `proxy-config-valid`, `certbot-image`, `proxy-ipv6`, `ufw-ports` |
| Database | `database-reachable`, `database-credentials`, `database-exists`, `database-privileges`, `database-vector-extension`, `database-ssl` |
| DNS | `dns-resolves`, `dns-points-here` |
| GitHub | `gh-installed`, `gh-authenticated`, `gh-repo-access` |
| TLS | `certificate-present`, `certificate-validity`, `certificate-renewal` |

Rules learned the hard way:

- **A check that cannot run answers `skip`, never `fail`.** `bind-port-free` with
  no app name yet is not a failure, it is an unanswerable question (§13.6).
- **Severity is `recommended` for anything the install can proceed without.**
  Marking the shared Docker network `required` fails a deployment that works.
- **Database checks are reachable from the wizard**, not only the doctor —
  §6.6's inline verification runs this same registry.

### 7.2 `install` — fifteen steps

```
preflight → network → auth → checkout → environment → validate-environment
  → version → build → migrate → seed → start → health → publish → verify
  → publish-version
```

| Step | Does |
|---|---|
| `preflight` | Runs the required checks. Refuses on a `fail`. |
| `network` | Ensures the shared Docker network exists. |
| `auth` | Confirms `gh` can reach the repo (skipped for a public/non-GitHub remote). |
| `checkout` | Clone or fetch, then `checkout --force --detach <sha>`. |
| `environment` | The wizard. Writes `.env`. **The first write of the whole run.** |
| `validate-environment` | Re-runs the database checks against the written values. |
| `version` | Choose and write the release version, commit it (§9). |
| `build` | `docker compose build`. The expensive step — four minutes. |
| `migrate` | `run --rm --no-deps api npm run prisma:migrate`. |
| `seed` | Idempotent seed. |
| `start` | `up -d`. |
| `health` | Poll the readiness endpoint until it answers. |
| `publish` | Write the vhost, issue the certificate, reload the proxy, install the renewal cron. |
| `verify` | Fetch the public URL over HTTPS. |
| `publish-version` | Push the version commit to the repo (§9). |

**Nothing is written to disk before the review is confirmed.** The wizard reads
(probes, DNS, database, server facts); the first write is the `environment`
step. Leaving the wizard therefore discards nothing.

### 7.3 `update` — thirteen steps

```
preflight → auth → fetch → environment-drift → version → build → migrate
  → seed → restart → health → publish → verify → publish-version
```

Differences from install that matter:

- There is **no `checkout` step** — there is `fetch`, which fetches, compares,
  *then* checks out. Code that assumes a step named `checkout` exists in both
  pipelines is wrong.
- `environment-drift` asks only about **genuinely added** variables (§6.8).
- Most steps carry `skip: skipWhenUnchanged`, so an update with no new revision
  does nothing and says so.
- **`update` adopts a deployment it has no record of.** If the state file is
  missing but §2.2's predicate passes, reconstruct the record from the clone, the
  `.env` and the proxy — and **invent nothing**. `installedAt` is recoverable
  from a surviving `deploy-info`; `lastDeployedAt` is not, because that document
  writes `updatedAt` as `lastDeployedAt ?? installedAt` and reading it back
  cannot tell the two apart. Record `adoptedAt` as a third axis.

### 7.4 `uninstall` — and the four things it refuses

Removes: the containers and their volumes, the clone, the vhost, the state file,
the deploy-info, the logs, the `.env`.

**Refuses, always:**

1. The **shared Docker network** — other apps are on it.
2. The **shared proxy container** — other apps are served by it.
3. The **TLS certificates**, by default — Let's Encrypt allows 5 duplicate certs
   per week, and re-installing during a debugging session will exhaust it.
4. The **renewal cron entry** — it is per-host and renews every app's cert.

**Two opt-in extras**, each needing its own flag *and* its own typed
confirmation of that resource's own real name:

| Extra | Flag | Confirmation |
|---|---|---|
| Drop the database | `--drop-database` | the database's real name |
| Purge object storage | `--purge-storage` | the bucket's real name |

⚠ **A word typed for one must never authorise the other.** This is why the
confirmation is the resource's name and not the word `DELETE`.

⚠ **Run a read-only inventory before every prompt.** Nobody can consent to a
number they were not shown.

Implementation notes that cost time:

- The storage purge must delete **the real key prefixes**, derived from the
  application's own constants rather than transcribed. Ours were
  `avatars/`, `database-backups/`, `node-outputs/`, `notes/`, `transcripts/`,
  `uploads/`. A transcribed list said `backups/` and would have left every
  database backup in the bucket after reporting a complete purge.
- Build purge targets **only** from that constant list — a structural guarantee,
  not a filter someone can invert.
- **Versioned buckets** need every version and delete marker removed by id, and
  an unreadable versioning answer must be treated as *versioned* — assuming the
  cheaper answer is exactly what produces silent retention.
- The drop tries plain `DROP DATABASE` first and terminates backends only on
  error 55006, scoped to that database, always reporting the count.
  `DROP DATABASE WITH (FORCE)` was rejected: a syntax error on PostgreSQL 13 and
  silent about what it killed.
- Reach S3 through a one-off `aws-cli` container rather than adding a 15 MB SDK
  for a path exercised only during teardown. Pass credentials **by name**, never
  in an argv.

### 7.5 `status`, `about`, `list`

- **`status`** — containers, endpoint health, certificate expiry. "Nothing
  installed" must be a *usage* error, distinct from "installed and unhealthy",
  so a monitoring script can tell them apart.
- **`about`** — the deployment record, rendered. Read-only.
- **`list`** — the inventory of every app under the apps root: name, root,
  revision, port, domain, last deploy, and whether the record came from a state
  file or was inferred. **Filesystem only** — no git, no Docker, no network — so
  an unrecorded deployment reports a null commit rather than running
  `git rev-parse` per directory.

### 7.6 Which deployment am I in? — the resolution ranks

`locateApp` resolves a deployment from flags and context, in this order:

1. `--root <dir>` — an explicit path.
2. `--name <app>` — an explicit name.
3. **The deployment cwd is standing in** (walk up, bounded by the apps root).
4. The sole installed app.
5. Refuse, naming the candidates.

⚠ **Rank 3 must land BEFORE the ambiguity refusal.** That is its entire purpose.
Without it, an operator standing in `/opt/infra/apps/myapp` on a host with seven
apps is told to pass `--name` (§13.14).

⚠ **The cwd walk must use the same deployment predicate as the enumeration.**
If the walk requires a state file while enumeration accepts evidence, the walk
fails to find exactly the unrecorded deployment it exists to find.

⚠ **`--name` still outranks cwd.** `--name other` from inside `myapp/` means
`other`.

### 7.7 Enumeration vs. adoption — the same question asked twice, differently

- **Adoption** asks *"is this named directory a deployment?"* — the operator
  pointed at it. Keep the predicate **loose** (§2.2).
- **Enumeration** asks *"which of these directories are mine?"* — nobody pointed
  at anything. Here the loose predicate matches any app under the same
  convention, and a seven-app host produces a seven-name ambiguity refusal.

Narrow enumeration with a marker the CLI itself writes. We use `DEPLOY_ROOT` in
the `.env`:

- It is **not** in `.env.example`, so a stranger's `.env` will not carry it.
- `update` re-pins it every run.
- ⚠ `COMPOSE_PROJECT_NAME` was **rejected** as the marker: Docker Compose itself
  defines that variable, so a foreign `.env` may legitimately have it.

⚠ **An honest limit:** a neighbouring app that is a *fork of the same template*
is deployed by this same CLI family and writes the same marker. Two forks on one
host are genuinely ambiguous, and no marker can separate them. Rank 3 is what
actually resolves the operator's problem; the narrowing only excludes genuinely
foreign apps. Say this in your own spec rather than implying the narrowing solves
more than it does.

---

## 8. The two records

### 8.1 `.appctl-deploy.json` — the CLI's bookkeeping

```ts
export interface DeployState {
  version: 1;
  repoUrl: string;
  ref: string;
  commitSha: string;
  domain?: string;
  bindPort: number;
  deployRoot: string;
  name?: string;
  appsRoot?: string;
  proxyRoot?: string;
  proxyContainer?: string;
  envPath?: string;
  installedAt?: string;          // optional — see below
  lastDeployedAt?: string;       // absent means NO deploy has ever completed here
  lastAttemptAt?: string;
  lastCommand: 'install' | 'update';
  lastOutcome?: 'success' | 'failure';
  lastFailedStep?: string;
  appctlVersion: string;
  adoptedAt?: string;
  previousSha?: string;
  completedSteps?: string[];     // what --resume reads
}
```

Six rules, each earned:

1. **Write it on the failure path too.** `--resume` reads `completedSteps`; a
   state written only on success means `--resume` can only resume a run with
   nothing left to resume (§13.9).
2. **Write it *before* finishing the journal**, so a failure to write is itself
   journaled — and never let it replace the pipeline's own error, which is the
   operator's actual problem.
3. **`lastDeployedAt` is optional, not stamped.** The state's idiom for "the last
   run did not finish" is `lastAttemptAt > lastDeployedAt`, which cannot express
   a *first* install that failed — there is no earlier success to be later than.
   Absent means no deploy has ever completed here.
4. **Read `lastOutcome` as `=== 'failure'`, never `!== 'success'`.** The field is
   absent on every state file written before it existed, and absent means
   success.
5. **Never bump the state version to add optional fields.** A bump makes this
   CLI refuse every state file already on every live server.
6. **Guard `--reinstall` on `lastDeployedAt`, not `lastOutcome`.** A failed
   reinstall over a real deployment still has one — the containers, certificate
   and database it would clobber are still there — while a root where nothing
   ever completed is let through.

### 8.2 `deploy-info/info.json` — what the app reports

Bind-mounted **read-only** into the api container; the API reads it on every
request, so a rewrite needs no restart.

```ts
{
  schema: 1,
  app: { name, version, commitSha, ref },
  installedAt: string | null,
  updatedAt: string | null,
  deployedBy: { cli: string, version: string },
  domain: string | null,
  remote: { commitsBehind, checkedAt } | null,
  run?: { completed: string[], failedStep?: string, outcome: 'success' | 'failure' },
}
```

Four rules:

1. **Write it once `health` passes** — not at the end. If the API is answering,
   the application demonstrably *is* deployed, and withholding the record
   produces a worse falsehood than writing it. Gating at the last step would
   write it on success and essentially nowhere else, so a failure in `publish` —
   between health and the end — reports nothing.
2. **`schema` is the one field the API validates strictly.** Never bump it to add
   optional fields: every already-deployed API would answer *invalid* for a file
   the new CLI just wrote, immediately, before the container it describes has
   necessarily restarted.
3. **`null` is this document's idiom for known-to-be-absent.** Do not invent an
   instant no disk carries.
4. **Create the directory before the stack starts.** Docker creates a missing
   bind source as `root:root`, after which the CLI's own write fails with EACCES
   — with every step green.

### 8.3 The About endpoint

- Gate on an **existing** administrator read permission. Do not invent
  `about:read`.
- **Always answer 200.** A missing file is `deployInfoStatus: "absent"`; an
  unreachable database is `database: null` plus `databaseError`.
- **Never perform network I/O.**
- Render **three** states, not two: `ok`, `absent`, and *complete-but-the-run-
  did-not-finish* (render every fact plus a warning naming the step).
- The absent copy must not assert a negative. "This instance was not deployed
  with the CLI" is false when the file is merely at a mis-set path, on an
  unattached bind mount, or from a run that stopped early.

---

## 9. Versioning — chosen at deploy time

### 9.1 The decision, and its honest cost

The operator is prompted for the release version **during `install`/`update`**,
with a suggested patch bump they can override.

The considered alternative was release-time bumping in the repository, which is
the more conventional design and avoids everything in §9.3. It was declined
deliberately. Record both in your own spec so a later reader does not reopen it
as an oversight.

**Accepted risks:**

- The commit running in production is **not** the commit CI built. Bounded by
  changing only `package.json` version fields and the lockfile — nothing that
  changes behaviour — and by pushing only after the deployment is healthy.
- The production host can **write to the repository**.
- The same code can carry **different versions on two servers**.

### 9.2 The flow

1. Read the clone's current version from the app manifest.
2. Suggest a patch bump; accept any higher valid SemVer. **Reject anything that
   does not sort above the current version** — a deploy must never move the
   number backwards.
3. Write it to every app manifest **in lockstep** plus the lockfile's workspace
   entries.
4. Stamp it into the `.env` as `APP_VERSION`, through the full spec list so
   banners and order survive.
5. **Commit in the same step as the write** (§9.3).
6. Build with it, so the image carries it.
7. After the deployment is healthy and verified, **push**.

Flags: `--app-version <semver>`, `--no-version-bump`. `--non-interactive` takes
the suggestion — refusing would break every cron and the E2E for a question with
a correct default — but a **bad** `--app-version` stops the run rather than
falling back, because deploying a different number from the one typed is the
worst available outcome.

### 9.3 The invariant the whole design rests on

Three facts about the clone, each verified against real git:

- **The checkout step refuses a dirty tree.** So writing manifests and leaving
  them dirty across a four-minute build would **wedge the next update** behind a
  refusal about files the operator never touched — every time a deploy died at
  `build`. This is why the write and the commit are **one step**: the dirty
  window is milliseconds.
- **A local-only commit wedges nothing** — `checkout --force --detach` moves over
  it.
- **The clone is always detached**, on every normal deployment.

> **At the end of every run, the clone's HEAD is the commit `origin/<ref>`
> resolves to — either because the bump commit became that commit, or because it
> was rolled back out.**

On a **failed push**, roll the bump commit back out (`checkout --force --detach
<baseSha>`). Not for tidiness: without it the clone sits permanently one commit
ahead of origin, every later `update --check` reports *behind*, and the server
rebuilds byte-identical images for ever. The deployment **keeps** the version —
it is in the image, the `.env` and the deploy-info.

⚠ **On success, the recorded deployed commit is the BUMP commit.** Recording the
pre-bump one leaves every server permanently reporting itself a commit behind,
rebuilding identical code and bumping again on every update — an infinite
treadmill. It is also more accurate: the step commits before `build`, so the
images were built with HEAD there.

### 9.4 Publishing rules

- **Push last, after verify** — not at the health gate. `deploy-info` is gated at
  health because it must describe a *running* deployment even on a failed run.
  Pushing to a shared repository is **irreversible and externally visible**: a
  version not pushed is re-derived next run; a version pushed for a deploy that
  did not finish is a commit someone has to reason about.
- **A failed push is a warning, never a failure.** The app is built, migrated,
  started and answering by then.
- **Never `--force`. Never retry.** A retry re-commits the bump on top of
  wherever origin moved — but the deployment was built from the *old* tip, so the
  published tree would contain code this server never built. Rebasing a version
  bump is a code change wearing a bookkeeping retry's clothes.
- Push explicitly: `git push origin HEAD:refs/heads/<ref>`. Works from a detached
  HEAD. ⚠ "Skip on a detached HEAD" would skip **always** (§13.19).
- A tag, a raw SHA, a read-only fork and a non-fast-forward all decline
  identically, with the reason named.

### 9.5 ⚠ Do not use `npm install --package-lock-only` on the deploy path

It resolves dependency ranges **against the registry**, so a deploy can pull
newer transitive versions into the lockfile and `npm ci` will install them into
the image — breaking the "nothing that changes behaviour" bound the whole design
rests on. It also needs the registry, mid-deploy, for a three-character edit.

Edit the workspace `version` entries **textually**, and assert against the real
lockfile in a test so a future npm format cannot make the edit silently partial.

### 9.6 Where the version surfaces

```
app manifest  →  CLI reads clone  →  deploy-info app.version  →  About page
              →  APP_VERSION in .env  →  API runtime version
              →  build-time define    →  the web bundle's own version line
```

The API should resolve its version as `APP_VERSION` → `npm_package_version` →
the manifest, in that order, and never throw — an unresolvable version degrades
to `0.0.0` rather than failing a boot.

**Start at `1.0.0` and let the first deploy move it.** Any other starting number
is fiction if no release has ever been cut, and inventing one re-creates the
"the version means nothing" problem the feature exists to fix.

---

## 10. The TUI

One ink screen per command, each a **renderer** over the same functions the CLI
calls. Split every screen into a pure `*-model.ts` (data → view model) and a
`*.tsx` (keyboard, effects, rendering). The models are where the tests live.

### 10.1 Rules

- **The TUI must pass the same flags the CLI does.** Ours claimed three times
  that re-running install resumes, and passed no `resume` flag — so every retry
  re-ran the whole pipeline including a four-minute build (§13.16).
- **Prefill from the deployment's own `.env`**, never a sibling's, and *retract*
  the seed when the resolved app name changes — the name is a field on the first
  screen, so typing a neighbour's name reads their file on the way past.
- **Mask secrets by one rule in one place.** Drive masking off the metadata's
  `secret` flag so a prefilled secret is masked identically to a typed one.
- **A screen that asks questions first cannot naively resume.** See §13.16's
  fourth condition — it is the subtlest thing in this document.
- **Abort must be honest.** Say what was already written and what re-running
  will do — and make that statement true on every path, including the ones that
  do not resume.

### 10.2 The permissionless-route trap (if your API has one)

A route declared with authentication but **no** permissions may never attach the
resolved user to the request, leaving `permissions` undefined. Read as an empty
set, that silently filters every permissioned item out of a 200. Only an
integration test through the real guard stack catches it; a unit test that
constructs the user by hand cannot.

---

## 11. Application-side integration

Three things the app must provide. All are small; all are easy to forget.

1. **A readiness endpoint** the `health` step can poll, which includes the
   database.
2. **An About endpoint** (§8.3) reading `deploy-info/info.json` from a
   configurable path, defaulting to the bind-mount location.
3. **A version line in the UI, visible to every role.** Bake the version into the
   web bundle at build time rather than fetching it — it then reports what *the
   bundle* is, and a stale cached bundle serving old JS against a freshly
   deployed API is exactly the bug a version line should expose. An API-sourced
   number hides it.

⚠ If your build and test configs are separate files, the build-time define must
be spread by **both**. A define in only the build config leaves the constant
undefined in every test that renders the component.

⚠ Resolve the version by **importing** the manifest, not from `import.meta.url`:
bundlers relocate a config into a temp directory, and a relative path resolves
somewhere else entirely.

---

## 12. Testing

### 12.1 The fake VPS

A harness that fakes `runCommand` and lays out a real temp directory as a deploy
root. Every pipeline test drives the **real** pipeline against it. This is what
makes the step logic testable without Docker.

### 12.2 What unit tests cannot catch

The fake VPS never spawns `docker`, so a change that breaks `docker compose
build`, the migrate invocation, the `.env` symlink resolution or the `-p <name>`
project naming passes every unit test green.

**Run a real end-to-end workflow on a CI runner with a Docker daemon.** Install
with `--skip-proxy` and an unattended answers file, then update twice.

### 12.3 E2E rules that were learned by breaking them

- Put the workflow in **its own file** with a `paths:` filter. A path filter on a
  shared CI workflow gates *every* job in it.
- Keep a `gate` step that runs typecheck and the unit suites in-job before
  anything touches Docker — a broken unit test should fail in one minute, not
  after ten minutes of image builds.
- Run it **nightly** too. Base-image drift changes no file in the repository.
- ⚠ **The E2E deploys from a `file://` remote whose branch is checked out**, so a
  push to it is *always* rejected. That makes it an excellent test of the §9.3
  rollback — and a trap: without the rollback, the clone sits a commit ahead and
  the "already up to date" and image-digest assertions both fail.
- Assert the **redaction** of the journal, not just the exit codes.

### 12.4 Test the refusals

Every rule in §7.4 and §8.1 is a refusal. Refusals are what a later "simplify"
pass deletes. Pin each one.

---

## 13. The failure catalogue

Every entry below was found by running this against a real server. Most pass
every unit test. Read this section **before** implementing.

### 13.1 A recursive `chown` on the apps root broke the database

**Symptom:** `FATAL: could not open file "global/pg_filenode.map": Permission denied`.

**Cause:** the apps root contained another app's bind-mounted PostgreSQL data
directory. `chown -R` over the apps root took it from `999:999` to the operator.

**Rule:** never recommend or run a recursive ownership change over a directory
that holds other applications' data. Scope it to the one path that needs it.
A CLI's `deploy-root-writable` remedy must name a single directory.

### 13.2 `sed 's/\r$//'` does not strip a mid-line CR

**Symptom:** the health step failed with `Response does not match the HTTP/1.1
protocol (Missing expected LF after header value)` — an `HPE_LF_EXPECTED` from
the HTTP parser, surfaced through the fetch client.

**Cause:** a CR had landed *inside* a quoted value in the `.env`
(`connect-src 'self' ^M^M^M;`), reached a response header, and made the API's
own output un-parseable.

**Rule:** to clean a file of CRs, use `s/\r//g`, not `s/\r$//`. And diagnose
invisible characters with `cat -A`, not by eye.

### 13.3 A CRLF `.env.example` parsed to **nothing**, silently

**Symptom:** a wizard that asked no questions and an `.env` with no variables.
No error anywhere.

**Cause — and this is the interesting part.** In JavaScript, unlike most
languages, `.` does **not** match `\r`: CR is a line terminator in ECMAScript, so
`.` excludes it alongside `\n`. And `$` without the `m` flag matches only the very
end of input. So an assignment regex does not match `KEY=value\r` **at all** —
the line is skipped, and a CRLF file parses to an empty map while reporting
success. 72 specs from an LF file; **0** from the same file with CRLF.

**Rule:** normalise line endings in one function and make it the only splitter
(§6.3). Test the parser against a CRLF fixture. The failure mode is total silent
data loss, not a stray character.

### 13.4 An optional variable the operator declined failed the whole install

**Symptom:** *"Install — failed. 5 values missing."* for variables the operator
does not use.

**Cause:** the unattended resolver deliberately set optional keys to `undefined`,
then the next line treated `undefined` as *missing*.

**Rule:** "skipped" is a **third** outcome beside "answered" and "missing". Model
it explicitly:

```ts
if (isBlank(candidate) && spec.optional === true && metadata.essential !== true) {
  values.delete(spec.key);
  return { key: spec.key, display: '(skipped)', source: 'skipped' };
}
```

### 13.5 The port check ran against a placeholder app name

**Symptom:** the install was gated on a port conflict with an app called `app`.

**Cause:** the TUI did `const name = answerOf(answers, NAME_FIELD) || FALLBACK_APP_NAME`
and passed that placeholder into a real decision.

**Rule:** keep "the resolved name" (`string | undefined`) and "the name to
display" as **two variables**. A placeholder may reach a label; it must never
reach a check, a path, or a port probe. A check that cannot run answers `skip`.

### 13.6 Port selection could not see stopped containers

**Symptom:** the wizard suggested a port another app took back on its next start.

**Cause:** the wizard consulted its own state files and a live bind probe.
Neither sees a **stopped** container that Docker has already promised a host port.

**Rule:** three independent sources, unioned:

1. Sibling deployments' recorded ports (a stopped app of *ours* still counts).
2. A live bind probe.
3. **`HostConfig.PortBindings` from `docker inspect`** — the create-time config,
   which survives a stop. `.NetworkSettings.Ports` and `docker ps --format
   '{{.Ports}}'` are *runtime* views and are empty when the container is stopped.

Every failure of source 3 — no Docker, no socket, a timeout — answers `[]` and
costs only what it was going to catch.

### 13.7 A write to `/etc/cron.d` failed a finished deployment

**Symptom:** `Publish over HTTPS failed: EACCES … /etc/cron.d/<cli>-certs-<app>`
— after the application was built, migrated, started, answering, and serving
HTTPS with a valid certificate.

**Rule:** classify every action as *the deployment* or *bookkeeping about it*.
Bookkeeping failures are **warnings**, carried in the result and surfaced on the
summary. Anything that runs after the app is answering is bookkeeping.

⚠ Also: a renewal cron is **per-host**. A second app must not install a second
entry, and `--resume` must not silently skip the step that reports it.

### 13.8 `--resume` never worked, for its entire existence

**Symptom:** after a failure, the CLI advised `--resume`, which answered
*"Nothing to resume: no deployment state."*

**Cause:** state was written only on success. `completedSteps` was computed on
the failure path and discarded there.

**Rule:** §8.1 rule 1. Also: the message telling the operator to use a flag and
the code that makes the flag work must be written in the same change.

### 13.9 `--resume` refused from the deployment's own directory

**Symptom:** run from where the CLI's own failure message leaves the operator
standing, `--resume` walked up to the parent infrastructure repository and
correctly tripped a guard.

**Cause:** layout resolution consulted state only when `--name`/`--root` was
passed. Control fell through to repository-target resolution, whose ancestor walk
found the wrong thing.

**Rule:** §7.6. Resolve *where you are standing* before guessing. Bound the walk
strictly inside the apps root — guessing harder is the wrong answer to a bug
caused by guessing.

### 13.10 The storage prefix list was wrong, and a purge would have reported success

**Symptom:** none — which is the point. A transcribed prefix list said
`backups/`; the application's real constant was `database-backups/`.

**Rule:** derive such lists from the application's own exported constants and
assert them in a test. Never transcribe a list of keys into a destructive path.
A specification is a hypothesis; the code is the fact.

### 13.11 `update` refused to update a live, serving deployment

**Symptom:** a deployment with a clone at the right revision, an `.env`, running
containers, an issued certificate and a serving site could not be updated,
because a JSON file was missing. The operator was told there was no deployment
**while standing in one**, and pointed at `install`, whose precondition is the
opposite.

**Cause:** the precondition asked whether the CLI's own *record* was present, not
whether a *deployment* was.

**Rule:** §2.2. The state file is bookkeeping; the deployment is the clone, the
`.env` and the containers. When the record is missing and the evidence is there,
**adopt** — and invent nothing.

⚠ **Fix discovery at the same time.** Our enumeration keyed on the same wrong
fact, so a bare `update` never reached the new adoption path. Put the predicate
in one module both import, with a test asserting they export the same function.

### 13.12 About said the instance was not deployed with the CLI. It was.

**Symptom:** a live production instance reported *"not deployed with the deploy
CLI"* after the CLI had cloned, built, run 21 migrations, seeded, started the
stack and issued the certificate — failing only at §13.7's cron write.

**Cause:** deploy-info was withheld on the failure path, on the reasonable-sounding
argument that an install which did not finish has not deployed what it would
claim. That is right for a failure at `build` or `migrate`, and wrong after
`health` passes.

**Rule:** §8.2 rule 1, and: **absent copy must not assert a negative.**

### 13.13 Re-running the TUI install rotated the deployment's secrets

**Symptom:** none visible — the worst kind. Every stored credential became
undecryptable.

**Cause:** the generator minted a value whenever a generate-mode secret was
blank, and the TUI always started blank. So each re-install over a live
deployment generated a **new** `JWT_SECRET`, `COOKIE_SECRET` and
`SECRETS_ENCRYPTION_KEY` and wrote them over the `.env`. A generated value is not
blank, so it was passed as an answer and overrode the on-disk one.

**Rule:** prefill from the existing `.env` — which fixes this **by construction**,
because the value is no longer blank. And write a test that a re-run over an
existing deployment leaves every generated secret unchanged.

⚠ A sibling defect in the same area: a "keep current value" mode that writes the
*template's* default. Correct for an unanswered key; catastrophic once one is
seeded from disk.

### 13.14 Every command except `install` refused on a multi-app host

**Symptom:** `Several apps are installed under /opt/infra/apps: … Pass --name`,
while standing in the app's own directory.

**Cause:** the resolution ranks had no cwd rank — and a function that *did* the
cwd walk already existed, with exactly one caller.

**Rule:** §7.6. When you write a resolution helper, audit every consumer that
should use it. Nine surfaces funnelled through one resolver that could not see
cwd.

### 13.15 `update` re-asked all 72 environment questions, on every update, forever

**Symptom:** a step named *"Check for new environment variables"* walked the
operator through the whole install wizard — including the database connection —
on an update whose template had **not changed at all**.

**Cause:** two defects compounding.

1. The drift check asked *"what is in the template and not in the file?"*, which
   is not the same question as *"what did this revision add?"* — see §6.8's three
   absence classes. The filter kept anything `essential || secret` **without
   consulting any of them**, so secrecy alone forced the wizard.
2. The wizard was handed the **full** spec list rather than the new keys, so even
   a genuine one-variable revision re-asked everything.

⚠ **The larger half is the one that looks covered and is not.** Optional
(commented-out) variables were 11 keys, 3 of them secret. **Opt-in feature group**
keys were **13 required keys, 6 of them secret** — and they are *not* commented
out, so `spec.optional` does not cover them. A fix reading only `spec.optional`
looks correct and leaves the reported failure live on every deployment that never
enabled those groups.

**Rule:** apply the three-class rule at the call site, not in the pure parser
(§4.1). And when narrowing the wizard's question list, keep the **writer's**
template list full — they are two different arguments with two different values.

⚠ **Do not infer enabled groups from the `.env`.** Nothing distinguishes
`FEATURE_ENABLED=true` from `=false` — both are merely *present*. An inference
would write a group's placeholder defaults into a live `.env`.

⚠ **The unattended path was worse than a clean failure, and quieter:** with a
recorded domain it *succeeded* and silently re-ran the wizard over hand-set
values, reverting them.

### 13.16 The TUI said "resumes" three times and did not resume

**Symptom:** every retry re-ran all steps including the four-minute build, and
re-asked every question blank.

**Cause:** the screen never passed the resume flag, and never read the existing
`.env`.

**Rule:** §10.1. And the fourth resume condition, which is the subtlest thing in
this document:

> The environment step is early in the pipeline, so any run that reached `build`
> has it in `completedSteps` — and a resumed run **skips it, `.env` and all**.
> That is correct for a shell `--resume`, where nobody was asked anything. It is
> **wrong** for a screen that asks every question *first*: an operator whose
> install failed at `migrate`, who re-runs and **corrects the database
> password**, would have the correction silently dropped and watch the identical
> failure, forever.

So: resume only when the answers still match the file. Prefilling is what makes
"unchanged" the ordinary case rather than a lucky one.

⚠ Also: passing resume over a **completed** deployment would be strictly worse
than the refusal it waives — the flag exempts the "already exists" guard, so it
would skip every recorded step and report an install that did nothing.

### 13.17 Operator-facing prose exposed an internal legacy filename

**Symptom:** *"no `.appctl-deploy.json` was here"*, from a binary not called that.

**Rule:** the state filename is **read back off live servers** and must never be
renamed — renaming it makes every existing deployment invisible, which is
§13.11's failure deliberately re-introduced. Fix the **copy**: operator-facing
strings say what the thing *is*; the literal filename belongs in the journal,
in `--json`, and in a list of paths the operator is meant to check by hand.

Audit per call site. Ours had seven legitimate uses that stayed, including a
proxy vhost **sentinel** matched with `startsWith` on live servers — the same
do-not-rename argument.

### 13.18 A "skip on a detached HEAD" rule would have disabled a feature permanently

**Symptom:** none — caught in review.

**Cause:** the checkout step always ends in `checkout --force --detach`, so the
clone is detached on **every** normal deployment. A rule skipping the publish on
a detached HEAD would skip 100% of the time.

**Rule:** before writing a guard on a repository state, check what that state
*normally* is. The real question was whether the target ref resolves to a branch
on origin — and the push works fine from a detached HEAD when written
explicitly.

### 13.19 Two merges 48 seconds apart made a green build look cancelled

**Symptom:** all eight CI jobs killed mid-step, every one showing `cancelled`,
none reporting a failure.

**Cause:** a concurrency group with `cancel-in-progress: true` and a second merge
to the same branch.

**Rule:** a `cancelled` conclusion on a superseded commit is not a failure. Check
whether a newer run exists on a newer HEAD before diagnosing. Only HEAD matters.

### 13.20 Assorted smaller ones, each worth a line

- **A bind mount's source directory must exist before compose starts**, or Docker
  creates it `root:root` and the CLI's own write fails with EACCES, with every
  step green.
- **`chmod` in a `mkdirSync` call is umask-masked and a no-op on an existing
  directory** — a reinstall over a root-owned directory silently keeps it
  unreadable. Chmod unconditionally, and refuse with a pasteable `chown` when
  you cannot.
- **A `--dry-run` inventory built by reading the directory** reports real names
  to the operator; a constant interpolated into prose does not. They are
  different things and deserve different treatment (§13.17).
- **An unreadable state file is not an unrecorded deployment.** The file is there
  and this build cannot interpret it — a different problem from there being no
  file, and the command acting on it should say so.
- **Ambiguity must never resolve by preference.** Two candidates refuse by name;
  silently preferring the recorded one invents a tiebreak at the moment the
  operator most needs to be asked.

---

## 14. Implementation order for a new repository

Each phase ends somewhere useful. Do not reorder — later phases depend on
earlier ones existing, and the order front-loads the parts that are hard to
retrofit.

### Phase 0 — application prerequisites (before any CLI code)

1. A readiness endpoint including the database.
2. A compose file with **no database service** (§1.4), parameterised on
   `DEPLOY_ROOT`, with `deploy-info/` bind-mounted read-only into the API.
3. `.env.example` organised into **section banners**, with optional variables
   commented out and a comment stating §6.2's sharp edge.
4. The version resolver: `APP_VERSION` → `npm_package_version` → manifest, never
   throwing.

### Phase 1 — the spine

`errors.ts` (exit codes) · `executor.ts` (`runCommand` with abort) ·
`journal.ts` (redaction from the first line) · `hooks.ts` ·
`steps/pipeline.ts` · `layout.ts` · `state.ts`.

**Ends at:** a pipeline that runs a list of no-op steps and journals them.

### Phase 2 — the environment system

`env-spec.ts` (with §6.3's splitter and a CRLF fixture) · `env-metadata.ts` ·
`env-file.ts` · `env-wizard.ts` · `wizard/steps.ts`.

**Ends at:** a wizard that turns `.env.example` into a `.env`, interactively and
unattended, with `--answer` / `--answers-file`.

⚠ Write §13.3, §13.4 and §6.8's tests **here**, not later.

### Phase 3 — doctor

`checks/` and the registry. Severity discipline from §7.1.

**Ends at:** `deploy doctor` reporting honestly on a real VPS. Run it on the
target server now — it will find things.

### Phase 4 — install

`repo.ts` · `proxy.ts` · `health.ts` · `server-facts.ts` · `docker-ports.ts` ·
`install.ts` · `deploy-info.ts`.

**Ends at:** a working `deploy install`. Run it against a real VPS before
proceeding. Everything after this is refinement; this is the proof.

### Phase 5 — update, adopt, resolve

`update.ts` · `deployment-evidence.ts` · `adopt.ts` · cwd resolution (§7.6) ·
`inventory.ts`.

### Phase 6 — uninstall

`uninstall.ts` · `teardown.ts` · `database-drop.ts` · `storage-purge.ts`, with
every refusal in §7.4 pinned by a test.

### Phase 7 — the TUI

One screen per command. §10's rules, especially §13.16's four resume conditions.

### Phase 8 — versioning

`app-version.ts` · `version-step.ts` · the About page's three states · the
build-time define and the UI version line.

### Phase 9 — CI

The unit suites, then the real-Docker E2E in its own workflow file (§12.3).

---

## 15. Port checklist

Tick each. The left column is what to carry over; the right is where it is
specified.

**Model**
- [ ] A deployment is clone + `.env`, not a record — §2.2
- [ ] Two separate records, two questions — §2.3
- [ ] Adoption is loose, enumeration is narrow — §7.7

**Environment**
- [ ] `.env.example` is the only question list — §6.1
- [ ] One line splitter, CRLF fixture in the tests — §6.3, §13.3
- [ ] "Skipped" is a third outcome — §13.4
- [ ] The three absence classes, applied at the call site — §6.8, §13.15
- [ ] `autoAccept`'s four guards — §6.5
- [ ] Section banners and key order survive serialization — §6.7
- [ ] Inline verification before the next question — §6.6

**Pipeline**
- [ ] Steps are data; four consumers read the same array — §1.5
- [ ] Hooks seam; no step writes to a terminal — §5.2
- [ ] Abort reaches the child process — §5.2
- [ ] `completed` returned on the failure path — §5.1, §13.8
- [ ] Errors carry exit codes — §5.3

**State**
- [ ] Written on both endings, before the journal closes — §8.1
- [ ] `lastDeployedAt` optional; `lastOutcome === 'failure'` — §8.1
- [ ] Never bump a schema version to add optional fields — §8.1, §8.2
- [ ] deploy-info written once `health` passes — §8.2, §13.12
- [ ] Bind-mount source created before the stack starts — §8.2, §13.20

**Resolution**
- [ ] Five ranks, cwd before the refusal — §7.6, §13.14
- [ ] The cwd walk uses the enumeration predicate — §7.6
- [ ] Ambiguity refuses by name, never prefers — §13.20

**Uninstall**
- [ ] Four refusals — §7.4
- [ ] Two opt-in extras, each with its own typed confirmation — §7.4
- [ ] Prefixes derived from the app's constants — §13.10
- [ ] Versioned buckets; unreadable versioning treated as versioned — §7.4

**Versioning**
- [ ] Write and commit in one step — §9.3
- [ ] The HEAD invariant, with rollback on a failed push — §9.3
- [ ] Deployed commit is the bump commit — §9.3
- [ ] Push last; failure is a warning; never force, never retry — §9.4
- [ ] No `--package-lock-only` on the deploy path — §9.5
- [ ] Start at `1.0.0` — §9.6

**UI**
- [ ] About always 200, three states, no network I/O — §8.3
- [ ] Version baked into the bundle, visible to every role — §11
- [ ] The define is spread by build **and** test configs — §11

**Bookkeeping vs. deployment**
- [ ] Post-health failures are warnings — §13.7
- [ ] Prefill prevents secret rotation — §13.13
- [ ] Operator prose never shows internal filenames — §13.17

**Testing**
- [ ] Fake VPS for pipeline tests — §12.1
- [ ] Real-Docker E2E, own workflow file, nightly, gated — §12.2, §12.3
- [ ] Every refusal pinned — §12.4

---

## 16. What this cost, honestly

Thirteen tracked issues in one working session, on top of the original
implementation: CLI 1.2.5 → 1.8.0. Roughly half were found only by running
against a real VPS with real DNS, a real external PostgreSQL, a shared proxy and
seven neighbouring applications.

The pattern worth internalising: **almost every defect was a module that kept
working correctly after a neighbouring module changed its meaning.**

- The wizard learned that an absent optional variable means *skipped* — and the
  drift check still read absent as *missing* (§13.15).
- Adoption learned that a deployment is evidence, not a record — and resolution
  still read it as a record (§13.14).
- The install learned to prefill — and the secret generator still read blank as
  *mint a new one* (§13.13).

Each pair was individually defensible. The bug was the **disagreement**. When you
change what a value means, grep every reader of that value in the same change —
and if two modules must agree on a predicate, make them import the same function
and assert it in a test.

The second pattern: **the cheap answer is usually the silent one.** A CRLF file
parsed to nothing and reported success. A purge with the wrong prefix reported
complete. An unattended update reverted hand-set values and exited 0. When
choosing between a loud failure and a quiet degradation, prefer the one that
cannot be mistaken for success.

---

*Reference implementation: `apps/cli/src/deploy/` at CLI 1.8.0. Design history
and rejected alternatives: [`vps-deploy.md`](./vps-deploy.md). Operator runbook:
[`../deployment/vps.md`](../deployment/vps.md). Command reference:
[`../../apps/cli/README.md`](../../apps/cli/README.md).*
