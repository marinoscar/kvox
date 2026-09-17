# Design Spec: `kvox deploy` (VPS deployment)

This is the durable design for a new `kvox deploy` command family in
`apps/cli` that installs and updates this application on a single VPS: git
clone/pull, `docker compose build`, database migration and seeding, and TLS
via a shared host-level proxy. An epic and its child issues link here instead
of restating the design — read this first, then the issue you were sent to
implement.

Source of truth for every claim below:

- `apps/cli/src/program.ts` — command registration, the two stdout/stderr and
  non-zero-exit rules every command (including `deploy`) must keep.
- `apps/cli/src/errors.ts` — `CliError`, the `EXIT` table, and why `ApiError`
  and `NetworkError` are separate types.
- `apps/cli/src/device-login.ts` — the hooks pattern this design copies for
  `DeployHooks`.
- `apps/cli/src/config.ts` — `~/.kvox/config.json` and the atomic-write
  trick deploy state must repeat, in a different file, for the same reason.
- `apps/cli/src/prompt.ts` — the one prompt primitive that exists today
  (`prompt()`), and the TTY-or-fail rule the wizard inherits.
- `apps/cli/src/tui/tty.ts`, `apps/cli/src/tui/routes.ts`,
  `apps/cli/src/tui/scroll-box.tsx`, `apps/cli/src/tui/layout.tsx` — the TUI
  gate, the closed route union, and the bounded-viewport rule a live deploy
  log must obey.
- `apps/cli/src/commands/api.ts` — the "thin `register*`, real work in a
  separate `run*`" shape every deploy subcommand follows.
- `infra/compose/base.compose.yml`, `infra/compose/prod.compose.yml`,
  `infra/compose/.env.example` — the compose layering and the environment
  contract deploy generates a `.env` against.
- `infra/nginx/nginx.conf` — the in-compose single-origin proxy; the thing
  this design puts *behind* a second, host-level proxy, not the thing it
  replaces.
- `apps/api/scripts/prisma-env.js`, `apps/api/src/config/configuration.ts`,
  `apps/api/src/prisma/prisma.service.ts` — the three places `DATABASE_URL`
  gets rebuilt from `POSTGRES_*`, and the encoding inconsistency between them.
- `apps/api/prisma/seed.ts` — the idempotent seed the update pipeline
  deliberately re-runs by default.
- `apps/api/src/health/health.controller.ts` — `/api/health/ready`, and why
  it is not evidence a migration ran.
- `apps/api/scripts/smoke-test.mjs` — the closest existing thing to a
  deploy-verification script, and the model for `health.ts`'s external check.
- `.github/workflows/deploy.yml` — the GHCR build pipeline whose deploy jobs
  are `echo` stubs; the rejected-alternative section below explains why this
  design does not consume it yet.
- `docs/runbooks/rotate-secrets-encryption-key.md` — the house style this
  document follows, and the key model `env-metadata.ts`'s validator for
  `SECRETS_ENCRYPTION_KEY` must match.

**Sections 1–17 below are the original design, epic #168 — do not rewrite
them to match what shipped.** They are what that epic's 17 child issues built
*against*, and they are left as the historical record of that design, not a
description of the code as it stands today. Everything described in them now
exists — `kvox deploy doctor|install|update|status`, `apps/cli/src/deploy/`,
`infra/compose/vps.compose.yml` and the rest — but a first real VPS install
(epic #118, issues #119–#134) found six places where what shipped diverges
from what sections 1–17 describe, for reasons discovered only by running the
pipeline against a real server, a real shared proxy and a second app on the
same box. **§18 is where those corrections live**, verified against the code
in this repository rather than against this document, with the rejected
alternative each one closes off. Read a claim in sections 1–17 against §18's
correction table before trusting it; a claim not in that table is still
accurate. §19 documents the `deploy-info/info.json` contract §15 refers to
forward, which did not exist when sections 1–17 were written. §22 amends §13:
the state file is written when a run FAILS as well as when it succeeds, which
is what makes `--resume` work at all.

---

## 1. Scope and the four decisions already made

`kvox deploy` takes this repository (or, far more likely, a fork of it —
see the Architecture Principles in `CLAUDE.md`: this is a template) from "an
empty VPS with Docker installed" to "running, migrated, seeded, and served
over HTTPS at a real domain," and back again on every subsequent `update`.
Four decisions are locked in; do not re-open them in a child issue without
raising it back at the epic level, because each one shapes several modules
at once.

| Decision | What it means | What it rules out |
|---|---|---|
| **Runs on the VPS** | The operator SSHes in with their own credentials, then runs `kvox deploy install`. The CLI never dials out over SSH itself. | An SSH client or library (`ssh2`) in the CLI; a laptop-driven orchestrator; managing the operator's SSH keys. |
| **Code delivery is git + build** | `git clone`/`git fetch` + `docker compose build` on the server, every time. No image registry in the loop. | Pulling pre-built images from GHCR (see the rejected-alternatives table — the workflow that pushes them exists, but nothing downstream of it does). |
| **TLS via a shared host proxy** | A single nginx + certbot stack at `/opt/infra/proxy`, outside this repository, terminates TLS for every app on the box. The app stack binds `127.0.0.1` only. | Each app owning its own port 443, its own certbot timer, its own nginx process. |
| **External PostgreSQL** | The operator supplies `POSTGRES_*` for a database that already exists; deploy validates it, never creates or manages it. Amended narrowly **twice**, and only twice. §20 (issue #238): when the database itself is the one thing missing, the install wizard may run `CREATE DATABASE` on explicit request. §21.3 (issue #268): `uninstall --drop-database` may run `DROP DATABASE`, behind a typed confirmation of the database's own name. Nothing else about this decision changes. | A `postgres:` service in any compose file. `base.compose.yml` deliberately has none — see its header comment. Roles, extensions, tuning, backups and anything destructive stay entirely out of scope, §20 included. |

The git-clone-on-server model is also the answer to "how does this stay safe
for a fork of the template": nothing about repo URL or ref is hardcoded
anywhere in the CLI. `repo.ts` (section 5) reads it from the operator's own
checkout, so a fork deploys itself, never the upstream template.

## 2. Phase 0: fix these first, in application code, not CLI code

Four defects exist in the repository today that would make an otherwise
correct `deploy install` fail or silently misbehave. None of them are
deploy-specific bugs — they are pre-existing gaps in `base.compose.yml`,
`prod.compose.yml`, `infra/nginx/nginx.conf`, and `configuration.ts` that
nobody hit yet because nothing has run `base + prod` against a real domain
before. Fix these as ordinary `fix:`/`chore:` commits, independent of and
before the `deploy` command lands, because every later phase assumes they are
already fixed.

| # | Where | The defect | The fix |
|---|---|---|---|
| 1 | `infra/nginx/nginx.conf` (`web_upstream`) | Proxies `/` to `web:5173` — Vite's dev port. The `production` target of `apps/web/Dockerfile` serves the built static files from **nginx on port 80**. `base + prod` today has a frontend upstream nothing listens on. | Add a second nginx config, e.g. `infra/nginx/nginx.prod.conf`, with `web:80` as the upstream, and have `prod.compose.yml` mount it over the default. `dev.compose.yml` keeps using the existing file unchanged — it is correct for the dev target. |
| 2 | `base.compose.yml` (`api.environment`) | The `api` service's `environment:` block is a hand-maintained allowlist. It never passes `APP_URL`, `COOKIE_SECRET`, `SECRETS_ENCRYPTION_KEY`, `STORAGE_PROVIDER`, `S3_ENDPOINT`, `MAX_FILE_SIZE`, `ALLOWED_MIME_TYPES`, `SIGNED_URL_EXPIRY`, `STORAGE_PART_SIZE`, or any `DEVICE_*` variable — all of which `configuration.ts` reads. | Replace the allowlist with `env_file: .env` on the `api` service (docker compose resolves that path relative to the compose file's directory, i.e. `infra/compose/.env` — exactly where local dev already puts it). This is also what makes a fork's own added variables reach the container with zero compose-file changes. |
| 3 | `base.compose.yml` (`nginx.ports`) | `"3535:80"` binds `0.0.0.0`. Fine for local dev; on a VPS behind a shared proxy it exposes the app stack directly on the public interface, bypassing the proxy and its TLS entirely. | Not fixed in `base.compose.yml` itself, since local dev legitimately wants `0.0.0.0`. Fixed by `vps.compose.yml` (section 10) overriding it to `"127.0.0.1:3535:80"`. Listed here because it is the same family of bug as #1 and #2 and must be understood together with them. |
| 4 | `apps/api/src/config/configuration.ts` | `constructDatabaseUrl` does **not** URL-encode `POSTGRES_PASSWORD`, while `apps/api/scripts/prisma-env.js` and `PrismaService`'s `buildConnectionString` both do. A password containing `@`, `:`, `/`, or `#` builds a URL here that Prisma's own tooling would have encoded correctly, and the two can disagree about what host/port/db the connection string even means. | `encodeURIComponent(password)` in `configuration.ts`, matching the other two call sites. Low blast radius on generated passwords (unlikely to contain reserved characters) but a real trap for an operator who reuses an existing DB password that does. `env-wizard.ts` (section 6) should also warn, not silently accept, a password containing URL-reserved characters until this is fixed. |

## 3. Command surface and exit codes

```
kvox deploy install [--repo <url>] [--ref <ref>] [--path <dir>] [--domain <fqdn>]
                       [--all] [--non-interactive] [--dry-run] [--skip-seed]
kvox deploy update   [--force] [--skip-seed] [--dry-run]
kvox deploy status   [--raw]
kvox deploy doctor   [--all]
```

Each is a thin `registerXCommand` delegating to a `runX` function, exactly
like `registerApiCommand`/`runApiCommand` in `commands/api.ts` — the split
exists so a test can call `runInstall(...)` directly without going through
commander's argument parsing.

`deploy install` is idempotent and resumable by design (section 7): running
it again after a partial failure re-does only what has not already
succeeded, rather than requiring an operator to hand-diagnose which step to
resume from. `deploy update` is the day-2 command; it refuses to run against
a directory `install` has not already set up (section 8).

New exit code, additive per `errors.ts`'s own contract ("Add new codes; do
not renumber existing ones"):

```ts
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  API: 3,
  NETWORK: 4,
  AUTH: 5,
  /**
   * A required doctor/preflight check failed before any destructive step ran.
   * Distinct from FAILURE because "your DB is unreachable" and "this CLI hit
   * a bug" have different owners and different next actions — a script
   * driving `deploy install` in a bootstrap pipeline should be able to tell
   * "environment isn't ready yet, retry after fixing DNS" apart from
   * "something is actually broken here."
   */
  PRECONDITION: 6,
} as const;
```

`PreconditionError extends CliError` with `exitCode = EXIT.PRECONDITION`,
thrown by `doctor.ts` and by the preflight step of `install.ts`/`update.ts`.
Everything else deploy throws is an existing `CliError` subclass where one
already fits (`UsageError` for a bad flag, `NetworkError` for an unreachable
DB or registry, a new narrow `DeployStepError` — see section 4 — for a step
that ran and failed on its own terms).

## 4. Module map

```
apps/cli/src/deploy/
  executor.ts       # spawn wrapper: argv only, no shell, timeout, streamed capture
  journal.ts        # run log to disk (human .log + machine .jsonl), retention, redaction
  state.ts          # deploy state file, separate from ~/.kvox/config.json
  hooks.ts          # DeployHooks — the CLI/TUI seam
  env-spec.ts       # parse .env.example -> EnvSpec[]
  env-metadata.ts   # annotations for the keys needing special handling
  env-wizard.ts     # prompt loop -> writes .env (0600)
  repo.ts           # resolve origin/ref dynamically; clone/fetch/checkout
  proxy.ts          # vhost render/install/validate/rollback + certbot webroot
  health.ts         # container status, /api/health/ready polling, external HTTPS
  checks/           # doctor check registry (one module per check, see section 9)
  steps/            # named steps consumed by install.ts and update.ts
  doctor.ts
  install.ts
  update.ts
  status.ts
apps/cli/src/commands/deploy.ts     # registers install/update/status/doctor, renders hooks to stderr
apps/cli/src/tui/screens/deploy.tsx # renders the same hooks as React state
infra/compose/vps.compose.yml       # the third compose overlay (section 10)
```

Every file above but `checks/` and `steps/` is a single module with one job;
`checks/` and `steps/` are directories because both are meant to grow by
adding a file and one registry entry, not by editing a long `switch`.

## 5. `repo.ts`: resolving the repo without hardcoding it

The operator's workflow is: SSH in, `git clone` (or already have cloned)
**their fork**, `cd` into it, build `kvox` from source
(`npm run build --workspace=cli`, per the CLI's own README), and run
`kvox deploy install` from inside that checkout. `repo.ts` leans on
exactly that: it walks upward from `process.cwd()` looking for a `.git`
directory (the same thing `git` itself does to find the repository root),
and when it finds one, reads:

```bash
git -C <root> remote get-url origin
git -C <root> rev-parse --abbrev-ref HEAD   # falls back to a symbolic-ref
                                             # lookup if HEAD is detached
```

as the defaults for `--repo` and `--ref`. This is what makes the tool fork-
safe with zero configuration: the template repository's URL never appears
anywhere in `apps/cli`, so a fork that has renamed everything still deploys
itself. `--repo`/`--ref` override the detected values outright; if `cwd` is
not inside a git working tree at all and neither flag is given, `install`
fails fast with a `UsageError` naming both flags — there is no silent
fallback to the template's own origin, because guessing wrong here means
deploying the wrong application.

The **deploy root** (default `/opt/<repo-name>`, overridable with `--path`)
is where the CLI manages its own clone and everything else it writes (`.env`,
the state file, the run journal). It is deliberately not required to be the
same directory as the checkout `repo.ts` read the defaults from — an
operator who builds `kvox` in `~/src/myfork` and deploys to `/opt/myapp` is
a normal, supported split. On a first `install`, `repo.ts` clones
`--repo`/detected URL at `--ref`/detected ref into `<deploy-root>/repo`; on
`update`, it `git fetch`s and compares the resolved ref's SHA against
`state.json`'s recorded `commitSha` before doing anything else (section 8).

`executor.ts` is what actually runs `git`, `docker`, `docker compose`,
`certbot`, and `openssl`-equivalent operations. It generalizes the one
existing subprocess precedent, `browser.ts`'s use of `spawn`: explicit
`argv` (never a shell string — the domain, repo URL and ref are all
operator-supplied and must never be interpolated into something a shell
re-parses), `shell: false`, `once('error')`/`once('spawn')` handling, and a
timeout. It adds two things `browser.ts` didn't need: **streamed capture**
(stdout/stderr are both relayed line-by-line to `DeployHooks.onLog` *and*
accumulated for the journal, because a `docker compose build` can run for
minutes and an operator watching it — in the plain command or the TUI —
needs to see it happen, not receive a wall of text after the fact) and an
`AbortSignal` that SIGTERMs the child (the TUI's Esc-to-cancel, section 11,
depends on this).

### 5.1 The deployment cwd is standing in (issue #266)

What §5 describes is the **weakest** of three ranks, and it was reached in a
case it had no business answering. On a server whose `/opt/infra` is itself a
git repository — infrastructure as code, with applications under
`/opt/infra/apps` — running `install --resume` from inside a deployment
(`/opt/infra/apps/<app>`) walked up past that directory's own state file,
found the infra repository, and refused: *"Refusing to guess what to deploy …
that checkout is this server's infrastructure, not the application"* (#247).
The refusal is correct; reaching it was the bug. cwd **was** the deployment,
and the repository, the ref and the name were in a file the operator was
standing on.

`install` therefore resolves in three ranks, strongest first
(`resolveInstallLayout`):

1. `--root`/`--name`, and `--repo` for the repository itself.
2. **A state file at cwd, or at an ancestor below the apps root**
   (`locateAppFromCwd` in `layout.ts`).
3. The `origin` of the git checkout around cwd — §5 above.

Rank 2 sits where it does because a state file is **not an inference**: this
CLI wrote it and it names the deployment outright, where a git remote is a
guess about what the operator probably meant — and #247 exists precisely
because that guess can land on the wrong repository. It is fed into
`resolveRepoTarget`'s own `state` rank rather than turned into a target by
hand, so `--ref` still overrides the recorded ref in the one place that rule
is written down, and no `git` process is started at all.

It settles the **deploy root**, not only the target. Deriving the root from
the state's repository URL would be a second guess on top of a fact: a
deployment installed with `--name <app>-staging` lives in a directory its
repository's name does not spell.

Two bounds, both deliberate:

- **The walk stops at the apps root.** Unbounded it leaves the territory this
  module knows about — `/opt/infra`, `/opt`, `/` — none of which is a
  deployment, and the apps root is the outermost directory that can contain
  one. Standing at the apps root itself, or above it, resolves nothing. A
  deploy root installed *outside* the apps root with `--root` is deliberately
  not found this way; there is no bound that would find it without walking the
  whole filesystem, and `--root` is how it was named in the first place.
- **It is a rank, not a search.** The one deployment cwd implies, or none. The
  apps root is never listed for candidates — #249 rejected that explicitly,
  and guessing harder is the wrong answer to a bug caused by guessing. "None"
  still refuses exactly as it did before, #247's guard included.

`describeLayoutSource` (the #249 refusal's "that directory was …" clause)
names the state file's path for this rank, rather than reporting it as a
guess. The wording is unreachable through that refusal by construction —
finding a state file is what stops the refusal firing — so it is covered by
its own test.

**`update`, `status` and `about` are not affected**, because they never take
this path: they resolve the deploy root through `locateInstalledApp`, which
uses `--name`/`--root` or the single app installed under the apps root, and
never walks a git checkout. Their own blind spot is a different one — with
several apps installed and no flags they refuse and list them, even when cwd
names one unambiguously — and is not this issue.

## 6. The env wizard: generated from `.env.example`, not hardcoded

This is the property that keeps the wizard correct against a fork's own
edits, for the same reason `commands/api.ts` is one generic command instead
of one hand-written subcommand per resource: a wizard with its own list of
34 field names goes stale the day a fork adds `STRIPE_SECRET_KEY` or removes
a block of its own. Instead:

**`env-spec.ts`** parses `infra/compose/.env.example` structurally, not with
a hardcoded key list:

- `# ---...---` banner pairs become section headers (`Application`,
  `Database (PostgreSQL)`, `JWT / Session`, ...).
- Consecutive `#`-prefixed lines immediately above a key become that key's
  help text (this is exactly the prose already in the file — e.g. the whole
  `SECRETS_ENCRYPTION_KEY` block explaining when it's optional).
- An active `KEY=value` line is a required-shape entry; a commented-out
  `# KEY=value` line (the Web Push block, `VAPID_PUBLIC_KEY` and friends) is
  an **optional** entry — present in the parsed spec, but not written to the
  generated `.env` unless the operator opts in.
- A trailing inline comment on the value (`MAX_FILE_SIZE=10737418240  # 10GB
  in bytes`) is stripped from the value and folded into the help text.
  Compose's own `.env` parser does not strip these — a `.env` written
  verbatim from a value that still carries `  # 10GB in bytes` would hand
  that whole string to the container as `MAX_FILE_SIZE`, and Node's
  `parseInt` would silently truncate it at the first non-digit rather than
  erroring, so this step is not cosmetic.

Result: `EnvSpec[]`, each entry `{ key, section, defaultValue, help,
required: boolean, commentedOut: boolean }`.

**`env-metadata.ts`** is the *only* hardcoded list in the whole subsystem,
and it is deliberately small — annotations for keys that need behavior
`env-spec.ts` cannot infer from the file's own text:

| Kind | Applies to | Behavior |
|---|---|---|
| `secret: true` | `JWT_SECRET`, `COOKIE_SECRET`, `SECRETS_ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET`, `POSTGRES_PASSWORD`, `AWS_SECRET_ACCESS_KEY`, the `UPTRACE_*` credentials (`UPTRACE_PROJECT1_TOKEN`, `UPTRACE_SECRET_KEY`, `UPTRACE_ADMIN_PASSWORD`, `UPTRACE_PGPASSWORD`, `UPTRACE_REDIS_PASSWORD`, `UPTRACE_CH_PASSWORD`) | Masked input when typed (see `promptSecret` below); the value feeds `journal.ts`'s redaction list (section 7) unconditionally, whether the operator typed it or the wizard generated it. |
| `generate: 'base64-32'` | `JWT_SECRET`, `COOKIE_SECRET`, `SECRETS_ENCRYPTION_KEY` | The wizard offers "generate one" as the default action, using `node:crypto`'s `randomBytes(32).toString('base64')` **in-process** — not a shell-out to `openssl`, even though the `.env.example` comment tells a *human* to run `openssl rand -base64 32`. Shelling out would make `openssl` a new precondition this doctor check would have to verify on every VPS; Node already has the primitive. |
| `validate: minLength(32)` | `JWT_SECRET`, `COOKIE_SECRET` | Matches the API's own documented minimum. |
| `validate: base64Decodes32Bytes` | `SECRETS_ENCRYPTION_KEY` | Must decode to exactly 32 bytes — this is the AES-256 key `secret-cipher.ts` expects (see `rotate-secrets-encryption-key.md` for the cipher this key feeds). A key that merely looks base64 but decodes to the wrong length must be rejected here, before it becomes a boot-time failure the operator sees an hour later. |
| `derivedFrom` | `GOOGLE_CALLBACK_URL` from `APP_URL`; `APP_URL` from the one domain question | The wizard asks for the public domain once ("What domain will this be served at?") and derives `APP_URL=https://<domain>` and `GOOGLE_CALLBACK_URL=https://<domain>/api/auth/google/callback`, showing both as defaults the operator can still override — never silently computed with no visibility. |
| `essential: true` | `APP_URL`, all six `POSTGRES_*`, `JWT_SECRET`, `COOKIE_SECRET`, `SECRETS_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `INITIAL_ADMIN_EMAIL` (~13 keys) | Prompted by default. Everything else in the spec takes its template default silently unless `--all` is passed, in which case the wizard walks every key — required and optional/commented-out alike — offering keep-default / edit / (for optional keys) skip. |

A key present in `.env.example` with no `env-metadata.ts` entry still gets a
prompt when it's `essential` by inference (no safe non-empty default) or is
silently defaulted otherwise — the metadata file narrows behavior for known
keys, it does not gate which keys the wizard can see. A fork that adds
`STRIPE_SECRET_KEY` to `.env.example` and nothing to `env-metadata.ts` still
gets asked for it (plain-text prompt, no masking, no generation) rather than
being invisible to the wizard; the fork can add a `secret: true` entry later
to upgrade that experience.

**`env-wizard.ts`** is the prompt loop, and it needs primitives `prompt.ts`
does not have today — that file has exactly one, free-text `prompt()`, by
design (see its own header: "this CLI asks exactly one question"). Deploy
needs three more, added to `prompt.ts` rather than duplicated in
`env-wizard.ts`, so the TUI's future rich equivalents (`ink-text-input` /
`ink-select-input`, already dependencies) have one command-line behavior to
match:

- **`promptConfirm(question, default)`** — yes/no, same TTY-or-throw rule as
  `prompt()`.
- **`promptSecret(question)`** — masked input. `node:readline` has no
  built-in echo suppression; the standard workaround is a custom output
  `Writable` (or overriding the `Interface`'s internal `_writeToOutput`)
  that substitutes `*` for each keystroke instead of echoing it, restoring
  normal output once the line is submitted. This is exactly the kind of
  fiddly terminal-mode code `prompt.ts`'s own header calls out as the reason
  a bare readline interface — not a dependency — was chosen for the simple
  case; it stays true here, it is just more work for this one case.
  **Only used for values a human types** (`GOOGLE_CLIENT_SECRET`,
  `POSTGRES_PASSWORD` when not already known) — generated secrets never go
  through a prompt at all.
- **`promptSelect(question, choices, default)`** — a fixed-choice prompt:
  type a number or the first few characters, or (in the ink TUI) an actual
  arrow-key list via the existing `ink-select-input` dependency. Used by the
  `--all` review loop's keep/edit/skip choice per key.

The finished `.env` is written to `<deploy-root>/repo/infra/compose/.env`
(since issue #120: to `<deploy-root>/.env`, with that compose path a relative
symlink `../../../.env` to it, so `rm -rf repo` never takes the secrets — see
epic #118's architecture decision 1; the full addendum is #134) —
the exact path local development already uses (`cp
infra/compose/.env.example infra/compose/.env`), which is also where docker
compose looks for a `.env` file by default when invoked from that directory
(the existing `Key Commands` in `CLAUDE.md` already `cd infra/compose`
before every `docker compose` invocation; deploy's `executor.ts` does the
same). It is written with the identical atomic-write discipline as
`config.ts`'s `writeConfigFile`: a freshly-created `wx`-flagged temp file at
mode `0600` in the same directory, then `renameSync` over the target — never
`writeFileSync` directly over an existing file, because (per that function's
own extensive comment) `mode` only applies to file *creation*, so overwriting
in place would silently leave a previously-`0644` `.env` world-readable
forever. `env-wizard.ts` should treat this as a library call into (or a
copy of the documented technique from) `config.ts`, not a new, weaker
reimplementation.

### 6.1 Where the template file comes from, and why the order matters (issues #229, #230, #234, #236)

Section 6 above assumes the wizard already has `.env.example`'s text in hand.
Getting to that text is a separate problem, and an earlier one: the wizard
has to ask its first question (the domain) before `checkout` (§7) has cloned
anything, so on a first install there is nothing on this server yet for the
wizard to read from disk.

Four sources are tried, in order, and each is a strictly weaker claim about
the same file than the one before it:

1. **The repository's own file, at the resolved ref, read from the remote**
   (`remote-template.ts`, issue #230): `gh api -H 'Accept:
   application/vnd.github.raw' repos/<owner>/<repo>/contents/infra/compose/
   .env.example[?ref=<ref>]` — the exact repository and the exact ref being
   deployed, which is the only source that cannot be stale or mismatched by
   construction. `gh`, not a plain HTTPS fetch, because the repository being
   deployed is usually private and `gh`'s stored token is the credential
   `checkout` already clones with (§5); reusing it adds no second auth path
   that could be authorised differently from the clone that follows.
2. **A checkout already on disk for this app** (`loadTemplateSpecs`/
   `templateCandidates` in `install.tsx`): this deployment's own clone under
   `<apps-root>/<name>/repo/...` (a reinstall or a resume), or the checkout
   the CLI itself is running from, walking up from `process.cwd()`. Weaker
   than (1) because it can be stale — a clone from before the operator's
   latest edit to `.env.example` — or, on a first install, simply absent;
   `bootstrap-vps.sh` leaves the operator standing inside such a checkout,
   which is what makes this source the common case rather than a theoretical
   one.
3. **The copy the installer saved beside the CLI itself**
   (`bundled-template.ts`, issue #236) — the file `install.sh` was holding
   while it built the CLI, moments before it deleted the clone
   (`TEMPLATE_SRC` in `install.sh`). Weaker again: it is fixed at whatever
   commit the CLI was installed or last updated from, so an edit landed on
   the default branch since then will not show up here until the CLI is
   reinstalled.
4. **Refuse.** With none of the above, `installSteps` drops every step whose
   fields cannot resolve — Database, Secrets, OAuth, Admin, Storage and
   Optional all vanish, leaving only Welcome, Domain, Resources and Review —
   and Review's `ConfirmDialog` is replaced by a refusal
   (`templateSource === 'none'` in `install.tsx`) rather than an offer to
   install from template defaults. Installing here would mean
   `POSTGRES_HOST=localhost`, placeholder secrets and an OAuth client that is
   not the operator's; a wizard that could not read its own question list has
   to say so, not present an install-ready screen — the same posture #234
   established for an unresolved domain.

Sources (2) and (3) are each gated on identity, not merely "a
`.env.example` exists somewhere" — this is issue #229's fix, applied twice
over. (2) is keyed on `name`, so it only ever reads *this app's own* clone,
never `readdirSync`'s first match on a host running several apps — the
originally reported #229 symptom was an install asking for a neighbouring
app's SQLite `DATABASE_URL` and never asking for PostgreSQL at all. (3) is
keyed on the repository: `install.sh` writes a `source.json` beside the saved
file recording the clone URL and ref it came from, and
`bundledTemplateMatches` refuses to answer unless that repository and the one
actually being deployed resolve to the same GitHub slug. Skipping either gate
would reintroduce the #229 bug — one application's variable list silently
answering another's questions — in a new place: a CLI built for one fork must
not configure a deploy of a different repository just because `--repo` named
it on the same server.

The one thing a failure of (1) must never do is disappear. Before #236,
`fetchRemoteTemplate` answered a bare `undefined` for a non-GitHub remote, a
missing `gh`, a `gh` that ran and refused, a timeout, and an empty file
alike — five different problems an operator and a bug report could not tell
apart. The sharpest case: `gh`'s authentication is PER USER, and the
installer deliberately supports running as root (#226), so a root shell whose
`gh` had never been logged in was indistinguishable from a healthy remote
that legitimately had nothing to add. `fetchRemoteTemplate` now returns a
`RemoteTemplateFailure` reason for every path — `not-github`, `gh-missing`,
`gh-failed`, `timed-out`, `empty` — carrying the command's own first line of
stderr, and both the Welcome provenance line and the Review refusal
(`describeRemoteTemplateFailure`) show it. A failed remote read still never
blocks an install by itself — the fallback chain above exists precisely so it
doesn't — but the operator now sees *which* of the five problems they have,
instead of a wizard that silently asked nothing and a Review screen that
could not say why.

### 6.2 Paginating the catch-all step (issue #240)

`--all` walks every remaining key `INSTALL_WIZARD_STEPS` doesn't already
claim into one step, `optional` (`CATCH_ALL_STEP_ID` in
`tui/screens/deploy/install-model.ts`). The ink TUI's `Form` renders every
field it is handed, and a catch-all key costs two rows — its keep/edit/skip
list, then its value — so handing it the whole remainder produced roughly 37
keys as 74 rows in one frame: the focused field scrolled out of the visible
window, so the cursor was invisible and every keystroke looked like it did
nothing. This was not merely awkward; the step could not be completed at
all.

The fix (`catchAllPages`) splits that one step into several, one page per
run of consecutive keys sharing the same `.env.example` **section banner**
(`EnvSpec.section`, from §6's structural parse) — `Web Push`,
`Observability`, and so on — each capped at `CATCH_ALL_PAGE_SIZE` keys (6, so
12 rows: room for the intro, the rail, the hints and a check line inside a
conventional 24-row terminal). Each page draws its section name and a
`page N of M` marker above the fields.

**Sections, not a running count, and deliberately so.** Chunking every six
keys regardless of origin would have been less code, and would also have cut
a coherent section — Observability, at roughly a dozen keys — in half across
two pages with no relationship to anything the operator recognises. Splitting
on the template's own banners instead means each page corresponds to a block
the operator has already seen once, in `.env.example` itself, in the same
order that file lists them. The cap still applies **within** a section,
because nothing stops a fork from putting thirty keys under one banner, and
that must not bring back the frame this feature exists to prevent.

**The rail still reads as ten steps.** `railSteps` collapses adjacent pages
sharing the same title into one rail entry, since a catch-all with seven
pages is several *steps* to the renderer but one *thing* to the operator — a
rail that counted pages would report sixteen or more steps for a wizard that
otherwise asks about ten questions.

One more, smaller fix travelled with the pagination work:
`optionModeChoicesFor` gives a key with no template value (commented out, or
an empty default) the label "Leave unset" in place of "Keep" — the mode is
still `keep` and still writes nothing, but "Keep" over a blank value row was
asking the operator to keep something the screen never showed them.

This step is a TUI-only concern. `env-wizard.ts`'s readline fallback (used by
a real terminal without the ink TUI, and by every `--non-interactive` run)
already asks one key at a time and has no "everything on screen" frame to
overflow, so it is unaffected and needs no pagination of its own.

## 7. Install pipeline

Every step is individually idempotent and safe to re-run — `install`'s
whole contract is "run it again after any failure and it picks up where it
left off," not "resume from a saved cursor." Steps, in order:

1. **Preflight** — every `required`-level doctor check (section 9) must
   pass; a `recommended` failure prints a warning and continues. Throws
   `PreconditionError` (exit 6) on any required failure, before anything is
   written or fetched.
2. **Resolve deploy root** — create `<deploy-root>` if absent (`mkdir -p`).
3. **Clone/checkout at ref** (`repo.ts`) — clone if `<deploy-root>/repo`
   doesn't exist; if it does (a re-run after a partial failure), fetch and
   checkout instead of re-cloning.
4. **Env wizard** (`env-wizard.ts`) — skipped if a valid `.env` already
   exists at the target path *and* `--non-interactive` was passed; otherwise
   always offered, because a re-run is exactly when an operator fixes a
   typo'd credential.
5. **Validate env** — DB connectivity + credentials + "does this database
   exist" (a real `SELECT 1` against the configured `POSTGRES_*`, not a
   syntax check on the connection string), format validation on every
   `env-metadata.ts` `validate` entry, best-effort S3 reachability (a
   warning, not a hard failure — an admin can configure storage after first
   login).
6. **Build images** — `docker compose -f base.compose.yml -f prod.compose.yml
   -f vps.compose.yml build`, streamed through `executor.ts`.
7. **Migrate** — `npm run prisma:migrate` (i.e. `prisma migrate deploy`)
   run **inside the built `api` image** (`docker compose run --rm api npm
   run prisma:migrate`), with `POSTGRES_*` exported into that run's
   environment explicitly. This matters because `prisma-env.js` only loads
   `.env` files when `NODE_ENV !== 'production'` — a production migrate step
   that relied on dotenv loading would silently see no `POSTGRES_*` at all
   and fall back to the hardcoded `localhost`/`postgres`/`postgres`
   defaults, which is a believable way to migrate the wrong database. This
   step's own exit code is the only thing that step of the pipeline trusts
   as proof migrations ran — see the note on `/api/health/ready` below.
8. **Seed** — `docker compose run --rm api npm run prisma:seed`. Safe to
   re-run: `apps/api/prisma/seed.ts` is fully idempotent (every write is an
   upsert).
9. **`up -d`** — start `nginx`, `api`, `web` per the compose overlay.
10. **Wait for health** — poll `http://127.0.0.1:<bound-port>/api/health/ready`
    (loopback, before the shared proxy is even touched) with backoff up to a
    timeout. **This step proves the process is up and can reach Postgres at
    all — nothing more.** `HealthController`'s Terminus check issues a bare
    `SELECT 1`, which **passes against an empty, unmigrated database**. It
    is not, and must never be treated as, evidence step 7 succeeded; step
    7's own exit code is that evidence. Conflating the two is exactly the
    kind of "it looked healthy" false confidence this document exists to
    prevent someone from re-discovering the hard way.
11. **Install vhost + issue certificate + validate + reload** (`proxy.ts`,
    section 10). Rolled back on any validation failure — see that section
    for the mechanics.
12. **External HTTPS verification** — an outbound request to
    `https://<domain>/api/health/ready`, following redirects, checking both
    the HTTP status and that the TLS handshake actually completed against a
    certificate for that name (a self-signed fallback or a proxy
    misconfiguration can serve 200 over broken TLS just as easily as over
    good TLS — this check must fail on the second case too). Modeled on
    `apps/api/scripts/smoke-test.mjs`'s own "boot it and hit the health
    endpoints" verification, one layer further out.
13. **Summary** — print (stderr for the command, a final screen state for
    the TUI) the domain, the commit SHA deployed, and the exact next steps
    (log in as `INITIAL_ADMIN_EMAIL`, where the state/journal files live).

## 8. Update pipeline

```
preflight (a NAMED subset, not the whole registry): docker + compose + devnet,
  git, disk space, THE DATABASE CHAIN (reachable, credentials, exists,
  vector extension - this pipeline migrates, see below), proxy container + IPv6
require state.json + <deploy-root>/repo + .env + the compose files
  -> else: "not installed here, run `kvox deploy install`" (PreconditionError)
fetch; compare resolved ref's SHA against state.commitSha
  -> unchanged and no --force: print "already up to date at <sha>", exit 0, do nothing else
record previous SHA (for the summary; there is no automatic rollback — see below)
env drift check: any .env.example key with no counterpart in the existing .env
  -> interactive: offer to run the wizard for just the new keys
  -> --non-interactive: PreconditionError naming the missing keys
build
migrate  (prisma migrate deploy is itself additive/idempotent against a DB
          already at a later state — this is Prisma's own guarantee, not
          something this pipeline adds)
seed, BY DEFAULT — a deliberate divergence from any shell-script precedent,
  which never re-seeds. The seed is idempotent, so this is how permissions
  or role rows added by a newer version of the seed actually land on an
  existing install. `--skip-seed` opts out for an operator who has hand-
  edited seeded rows and does not want them upserted back.
up -d
wait for health
refresh vhost / renew certificate if within certbot's renewal window
  (proxy.ts owns "is this cert due"; update does not force-reissue every run)
external verification
summary, including the previous SHA so a stuck update is easy to read as a diff
```

The preflight is deliberately a named subset rather than
`requiredChecks(ALL_CHECKS)`: DNS and certificate checks are install-time
concerns, and a site that is already serving does not need them re-litigated
on every update. The **database chain is not an exception to that reasoning,
it is a different category** — it is a precondition of `migrate`, a step this
same pipeline runs four lines later. Before it was included (#179), an update
against an unreachable database, a rotated password, a dropped database or a
missing `vector` extension failed *inside* `migrate`, as a Prisma stack trace,
with the api container already stopped.

There is deliberately no automatic rollback on a failed `update`. Recording
the previous SHA is for the operator's own `git checkout <previous-sha>` +
re-run of `install`, not for the CLI to attempt unattended — reverting a
database migration safely is a decision that needs a human, not a heuristic.

## 9. Doctor: the preflight check registry

`checks/` holds one module per check, each exporting the same shape,
consumed by both `kvox deploy doctor` directly and by `install`/`update`'s
own preflight step — one registry, two callers, the same pattern this
codebase already uses for `NOTIFICATION_EVENTS` and the settings-page
registries: declare the check once, let every consumer read the same list
instead of maintaining a second one that can drift.

```ts
interface DeployCheck {
  id: string;                       // e.g. 'docker-daemon', 'dns-resolves'
  level: 'required' | 'recommended';
  description: string;              // shown in `doctor` output
  run(ctx: DeployCheckContext): Promise<CheckResult>;
}

type CheckResult =
  | { status: 'pass' }
  | { status: 'warn'; message: string }
  | { status: 'fail'; message: string; remedy?: string };
```

Checks to include at minimum: `docker` and `docker compose` v2 present and
the daemon reachable; `git` present; outbound network reachable (DNS
resolves, a TCP connect to the configured `POSTGRES_HOST:POSTGRES_PORT`
succeeds); the configured domain's DNS actually resolves to this host's
public IP (a certbot HTTP-01 challenge will otherwise fail with a message
that does not mention DNS at all); `<deploy-root>` exists or is creatable
and has free disk space above a floor; nothing else is already bound to the
port `vps.compose.yml` binds nginx to; database connectivity + credentials
+ "database exists" (the same check the install pipeline's step 5 runs —
`doctor` runs it standalone so an operator can diagnose DB access *before*
attempting a full install).

`kvox deploy doctor` with no flags runs `required` checks only and exits
`PRECONDITION` on any failure; `--all` also runs `recommended` checks and
reports warnings without affecting the exit code.

### 9.1 `database-vector-extension`: the pgvector preflight (issue #179, epic #165)

Semantic search needs the `vector` extension, and `vector` is **not** a
trusted extension in PostgreSQL 16 — `CREATE EXTENSION vector` needs a
superuser, or at least a role the extension's control file permits. Decision
4 of section 1 (*external PostgreSQL: deploy validates it, never creates or
manages it*) means the operator may well hand this deployment a database on a
role that can do no such thing.

The check is `required`, not `recommended`. If the extension cannot be
provided, `prisma migrate deploy` **will** abort — so reporting it as advice
would have `doctor` say "you're fine" and then have `install` fail anyway,
mid-migration, as a Prisma stack trace with no remedy in it, after the
repository has been cloned and `.env` written. That is the exact failure this
check exists to move earlier.

Two probes, in this order, against the application database:

1. `pg_extension` — **already installed wins outright**, whatever the
   connecting role is allowed to do. That is the ordinary managed-PostgreSQL
   case: an administrator installed it once, out of band, and the application
   role never could and never needs to. A check that only asked "can you
   install it?" would fail a perfectly working deployment.
2. `pg_available_extensions` — available to install is the next-best answer;
   the migration runs `CREATE EXTENSION IF NOT EXISTS vector` itself.

Available-but-not-installed on a role that is not a superuser is a **warn**,
not a fail: superuser is not the only way a role may be permitted to create an
extension, so refusing outright would be wrong — but saying nothing would be
worse, because that is the one remaining way the migration can still abort
after this check has passed. An unreadable catalogue is likewise a warn, the
same call `database-privileges` makes: not being able to *ask* the question is
not an answer to it.

`doctor` shows it as its own row; `install` runs it both in its preflight and
again in `validate-environment`; and `update` runs it too (section 8) — that
last one matters most, because an existing deployment is precisely the
population that *receives* the pgvector migration.

**Rejected: wrapping `CREATE EXTENSION` in a `DO` block that skips when the
extension is absent.** It is the tempting fix and it is the wrong one — it
converts a loud, fixable, pre-deploy refusal into permanent *per-deployment
schema drift*, which every search query would then have to probe for at
runtime, forever. "Layer 1 (full-text search) applied, layer 2 (pgvector)
refused" is a state you can diagnose and fix; "some deployments have these
three tables and some don't" is not.

## 10. `proxy.ts`: the shared host proxy and the app's own vhost

`/opt/infra/proxy` is a second, independent Docker Compose project —
**outside this git repository**, living only on the VPS's filesystem — that
this design assumes is either already running (a second app on the same box
deployed it first) or gets bootstrapped by the first `kvox deploy install`
to ever run on a given VPS. It is not part of `infra/compose/` and is not
versioned alongside the application; it is host infrastructure, shared by
every app deployed to that box. `proxy.ts`'s job:

1. **Bootstrap if absent** — check for `/opt/infra/proxy/docker-compose.yml`;
   if missing, write a minimal nginx + certbot compose project (an nginx
   container publishing `0.0.0.0:80` and `0.0.0.0:443`, a `conf.d/` directory
   mounted in for per-app vhosts, a `webroot/` directory mounted in for
   ACME HTTP-01 challenges, a certs volume) and `docker compose up -d` it.
   This is the **only** thing in the whole design that binds a public port —
   everything else in `vps.compose.yml` is loopback-only.
2. **Render the vhost** for this app's domain into
   `/opt/infra/proxy/conf.d/<domain>.conf`, proxying to
   `127.0.0.1:<bound-port>` (the port `vps.compose.yml`'s nginx service
   binds — default `3535`, matching local dev, but distinct per app on a box
   hosting more than one).
3. **Issue the certificate** via certbot's **webroot** method against the
   shared proxy's `webroot/` mount — never the standalone/`--nginx` plugin
   method, because that plugin wants to own nginx's config itself, which
   conflicts with a proxy shared across apps it doesn't know about.
4. **Validate**: run `nginx -t` *inside the proxy container* against the
   newly rendered config before reloading anything.
5. **Reload** (`docker exec <proxy-container> nginx -s reload`) only if
   validation passed.
6. **Roll back** on any failure in 3-4: restore the previous vhost file (or
   remove it, on a first install with nothing to restore to) and leave the
   previous, known-good nginx state serving traffic. A failed cert issuance
   or a bad vhost render must never take down every other app sharing that
   proxy.

Illustrative shape of a rendered vhost (abbreviated — the real template also
carries the standard TLS cipher/protocol hardening lines, omitted here):

```nginx
server {
    listen 80;
    server_name app.example.com;
    location /.well-known/acme-challenge/ { root /webroot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    server_name app.example.com;
    ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3535;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Note `X-Forwarded-Proto` is set **here**, at the shared proxy — the
in-compose `infra/nginx/nginx.conf` already forwards it onward
(`proxy_set_header X-Forwarded-Proto $scheme` in its own `/api` and `/`
blocks) but is itself sitting behind another proxy on a VPS, so the value it
sees and passes on must originate at the outermost hop, not be invented
partway through. `apps/api/src/main.ts`'s trust-proxy configuration (outside
this document's scope) is what makes NestJS honor it once it arrives.

## 11. The CLI/TUI seam: `DeployHooks`

This is the single most important pattern to get right, and it is not new —
it is `device-login.ts` copied faithfully. `apps/cli/src/device-login.ts`'s
own header states the rule: **nothing in the business-logic module writes
to a terminal.** Everything a human would see is delivered through a hooks
object; `commands/login.ts` renders those hooks as stderr lines and
`tui/screens/login.tsx` renders the identical callbacks as React state. Two
renderers, one sequence, and the sequence is the thing that gets tested.

```ts
export interface DeployStep {
  id: string;            // matches a steps/ module, e.g. 'migrate'
  label: string;          // "Running database migrations"
}

export interface StepResult {
  status: 'ok' | 'skipped' | 'failed';
  message?: string | undefined;
  durationMs: number;
}

export interface DeployHooks {
  onStepStart?: ((step: DeployStep) => void) | undefined;
  onStepResult?: ((step: DeployStep, result: StepResult) => void) | undefined;
  /** A line of subprocess output, already ANSI-stripped. */
  onLog?: ((line: string, level: 'info' | 'warn' | 'error') => void) | undefined;
  /** For a long step (build, migrate) that has no natural sub-steps to report. */
  onProgress?: ((info: { completed: number; total: number }) => void) | undefined;
}
```

`install.ts`/`update.ts` take `hooks?: DeployHooks` exactly like
`runDeviceLogin` takes `options.hooks`, and neither ever calls
`process.stdout.write`/`process.stderr.write` directly — `commands/deploy.ts`
does that, formatting `onLog` as a line and `onStepResult` as a
`✓ Migrated database (2.1s)`-shaped line, following `formatStatusLine`'s
existing precedent in `output.ts`. `tui/screens/deploy.tsx` instead
accumulates `onLog` lines into component state feeding a `ScrollBox`
(section 12) and renders `onStepResult` as a checklist.

## 12. Logging: the run journal

Every invocation of `install`/`update`/`doctor` writes two files under
`<deploy-root>/logs/`: a timestamped human-readable `.log` and a matching
machine-readable `.jsonl`, one JSON object per executed command —
`{ argv, cwd, exitCode, durationMs, stdout, stderr, startedAt }`. Retention
keeps the newest N runs (a small constant, e.g. 20) and deletes older ones
at the start of each run, the same "prune on write, not on a schedule"
approach as nothing needing a cron job.

**Redaction is mandatory and happens before a single byte reaches disk.**
Every value `env-metadata.ts` marks `secret: true` — whether generated by
the wizard or typed by the operator — is collected into a redaction list
once the `.env` is known, and `journal.ts` does a literal substring replace
of each value with a fixed placeholder across every line of captured
stdout/stderr and every recorded `argv`, for both the `.log` and the
`.jsonl`. State the honest boundary of this: it is a substring match against
*known* secret values, not a pattern-based scan — a value `env-metadata.ts`
does not know to be secret (a fork's own newly added credential with no
metadata entry) will not be redacted, because there is nothing to compare
against. This is precisely why section 6 says a fork adding a new secret-ish
key should add a `secret: true` entry: doing so is what makes both masking
*and* redaction apply to it. Console output during a run gets the *rendered*
summary (via `DeployHooks`, already free of raw secret material by
construction — nothing puts a secret value into an `onLog` line in the
first place); the file gets the full captured output, redacted the same
way.

## 13. Deploy state

`<deploy-root>/state.json`, **not** `~/.kvox/config.json` — this is a hard
requirement, not a style preference. `writeConfigFile` "replaces the whole
file and drops unknown keys" (`config.ts`'s own words); if deploy state
shared that file, the next `kvox login` on the same VPS (an operator
re-authenticating the CLI itself against the API, entirely unrelated to
deploy) would silently erase every field deploy had written. `state.ts`
must implement the identical temp-file-then-rename, mode-at-creation
pattern `writeConfigFile` uses (section 6 makes the same requirement for
`.env`), for the identical reason: a crash or a full disk mid-write must
leave the previous, valid state file intact rather than a truncated one that
reads as corrupt.

```ts
interface DeployState {
  repoUrl: string;
  ref: string;
  commitSha: string;          // as of the last successful install/update
  domain: string;
  boundPort: number;          // what vps.compose.yml bound nginx to, locally
  installedAt: string;        // ISO 8601, set once, never overwritten
  updatedAt: string;          // ISO 8601, set on every successful run
  appctlVersion: string;      // CLI_VERSION at time of write. Field name kept
                               // as `appctl` on purpose — it is read back from
                               // state files already written by installs that
                               // predate the `kvox` rename; see docs/RENAMING.md
  lastCommand: 'install' | 'update';
  lastSuccessAt: string;      // ISO 8601
}
```

`status.ts` reads this file (never required to exist — `status` on a
never-installed directory reports that plainly, not as an error) and
augments it with live data: `docker compose ps` per-service state, an
immediate `/api/health/ready` poll, the certificate's expiry date, and how
many commits (if any) the tracked ref is ahead of `state.commitSha` — the
last one answering "is there an update available" without performing one.

## 14. TUI integration

A new route joins the closed union in `tui/routes.ts`:

```ts
export type Route = 'menu' | 'login' | 'invoke' | 'status' | 'logout' | 'deploy';
```

...listed in `screens/menu.tsx`, switched on in `app.tsx`, and
`tui/screens/deploy.tsx` follows the existing screen contract exactly: one
`onDone: () => void` prop, a discriminated-union state machine, an
`AbortController` in a ref aborted on unmount, `useInput` gated by
`isActive` whenever a child (a text field, the confirm prompt, the eventual
select list) owns the keyboard.

The live step/log view reuses `ScrollBox` — its own header already explains
why: ink redraws the *entire* frame on every state change, so an unbounded
list of `<Text>` lines behind a minutes-long `docker compose build` is
exactly the failure mode that component exists to prevent. Two things
`ScrollBox` does not do today that this screen needs:

- **`followTail`** — a new prop, off by default (matching the existing
  behavior an operator scrolling old JSON output relies on) but the natural
  default *while a deploy step is actively running*: new log lines should
  keep the viewport pinned to the bottom unless the operator has manually
  scrolled up, at which point auto-follow disengages until they return to
  the bottom. This is genuinely new work, not a trivial prop threading.
- **ANSI-free input, still enforced** — `executor.ts` must strip ANSI
  escapes from captured output before it ever reaches a hook (section 5),
  which is what keeps this a non-issue for `ScrollBox` rather than a second
  place needing the same fix `screens/invoke.tsx`'s existing note about
  colour-run slicing already documents.

**The abort-safety honesty this screen must carry**: unlike
`device-login.ts`'s poll loop, which is safe to abort at any point because
polling has no side effect of its own, a deploy step mid-flight
(`docker compose build`, a migration) is not uniformly safe to interrupt.
`executor.ts` SIGTERMs the child on abort, and `docker compose build`
interrupted mid-layer or a migration interrupted mid-statement can leave a
genuinely partial state. The screen must say so on Esc — a confirmation
naming the risk ("this may leave a partial deployment; re-running install
will resume safely") — rather than implying cancellation is free the way it
is on the login screen. This is the one place this design's "everything is
idempotent, so re-running is always the fix" promise needs a caveat spoken
out loud to the operator at the moment it matters, not buried in this
document.

**The exit-code inversion also matters here.** `tui/index.tsx` today lets a
failed *interactive* operation still exit the process with 0 — the TUI
itself completed even though the thing it did failed. `kvox deploy
install` run as an explicit subcommand must not inherit that: a scripted
`kvox deploy install --non-interactive` in a bootstrap pipeline needs the
real exit code (0, or `PRECONDITION`/`FAILURE`/etc.), because that is
exactly the class of automation `program.ts`'s two binding rules exist to
serve. The TUI screen's own "operation failed" state can still return 0 to
`onDone` for the *menu* to keep working — but the explicit `deploy install`
command path, going through `program.ts`'s ordinary `run()`, must not.

## 15. `infra/compose/vps.compose.yml`

A third overlay, layered the same way `dev.compose.yml` and
`prod.compose.yml` already are:

```bash
docker compose -f base.compose.yml -f prod.compose.yml -f vps.compose.yml up -d
```

Its whole job, once Phase 0's fixes land in `base.compose.yml` and
`prod.compose.yml` themselves, is the one override that is legitimately
VPS-specific and wrong for local dev: binding nginx to loopback only.

```yaml
services:
  nginx:
    ports:
      - "127.0.0.1:3535:80"
```

Nothing else belongs in this file, with one exception added by epic #118
(issue #120): the `api` service's read-only bind mount of
`${DEPLOY_ROOT:-../../..}/deploy-info` at `/app/deploy-info`, plus the
`DEPLOY_INFO_PATH` that points the API at `info.json` inside it — metadata the
CLI writes about *this* deployment on *this* server, which is VPS-specific by
definition (the full design is §18, #134). The `env_file` fix, the
`nginx.prod.conf` mount, and the memory limits all belong in
`base.compose.yml`/`prod.compose.yml` because they are correct for *any*
production-like run, VPS or otherwise — keeping `vps.compose.yml` to what is
specifically "there is a shared proxy in front of me, and a CLI that deployed
me" is what keeps the compose layering legible instead of every overlay
re-deciding the same things slightly differently.

## 16. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **Drive the VPS over SSH from a laptop** | Requires bundling an SSH client/library (`ssh2` or a shell-out to system `ssh`), a private-key or agent-forwarding story, and turns ordinary network flakiness between the laptop and the VPS into deploy failures. The confirmed model instead reuses the operator's own already-authenticated interactive SSH session and never needs a second credential. |
| **Pull pre-built images from GHCR** | `.github/workflows/deploy.yml` already builds and pushes `ghcr.io/<repo>-api`/`-web` on every tag — but its `deploy-staging`/`deploy-production` jobs are literal `echo` stubs, no compose file anywhere uses `image:` (both `api` and `web` are `build:`-only), and consuming a GHCR image from a VPS needs registry credentials staged there too. This is the obvious next integration once `kvox deploy` exists — a `--from-registry` mode that skips the build step — but it is a second, separable piece of work, not part of v1. |
| **A self-contained per-app nginx + certbot** | A VPS hosting one app today is a VPS hosting a second one within a year. Per-app TLS termination means N certbot renewal timers and N nginx processes contending for port 443, with no coherent answer for "what's already bound there" the moment a second app deploys. The shared proxy owns 443 exactly once. |
| **PostgreSQL inside the app stack** | `base.compose.yml` deliberately ships no Postgres service — bundling one here would make the CLI additionally responsible for its backups, volumes, and version upgrades, none of which this repository does for any other stateful dependency (S3/storage is always external too). External-and-validated keeps deploy's blast radius to the stateless tier. |
| **A hardcoded env-var list in the wizard** | The same drift risk `commands/api.ts`'s "one generic command" design exists to avoid — a fork that edits `.env.example` would silently desync from a wizard that doesn't read it. Parsing the file at run time is the only shape that survives a fork's own edits. |
| **A single 34-field TUI form** | Most installs only ever touch the same dozen fields (domain, DB credentials, Google OAuth, admin email); stepping through all 34 including `UPTRACE_ADMIN_PASSWORD` on every single install is exactly the kind of form an operator abandons partway through. The essential-subset-plus-`--all` split targets the common path while keeping the full set one flag away. |

## 17. Suggested phasing (non-binding)

Not the actual issue list — the epic owns that — but a grouping that keeps
each piece reviewable on its own and roughly matches the module boundaries
above, for whoever slices this into the 17 child issues:

1. Phase 0 fixes (section 2) — no CLI code, must land first.
2. Foundations: `executor.ts`, `journal.ts`, `state.ts`, `hooks.ts`, the
   `PRECONDITION` exit code, the three new `prompt.ts` primitives.
3. `repo.ts` + `checks/` + `doctor.ts`.
4. `env-spec.ts` + `env-metadata.ts` + `env-wizard.ts`.
5. `proxy.ts`, including the shared-proxy bootstrap.
6. `health.ts` + `steps/` + `install.ts` end to end.
7. `update.ts`.
8. `status.ts`.
9. `commands/deploy.ts` (stderr rendering for all four subcommands).
10. `tui/screens/deploy.tsx` + the route/menu wiring, including
    `ScrollBox`'s `followTail`.
11. `infra/compose/vps.compose.yml` + this document's own follow-up: once
    real usage exists, fold anything this design got wrong back into it.

## 18. v2: the real VPS (epic #118)

Epic #168 (sections 1–17) designed `kvox deploy` against no VPS, no Docker
daemon and no shared proxy — `docs/deployment/vps.md` said so plainly until
this epic. Epic #118 (issues #119–#134) is what running the pipeline for
real corrected. Every claim below is verified against the source files named,
not against sections 1–17 or against any issue's plan.

### 18.1 What sections 1–17 got wrong, and where it is now corrected

| § / claim | What sections 1–17 describe | What ships today | Fixed by |
|---|---|---|---|
| §3, §5 — deploy root | A single `--path` flag, default deploy root `/opt/<repo-name>` | `--apps-root <dir>` (default `/opt/infra/apps`) + `--name <app>` selects `<apps-root>/<name>`; `--root <dir>` is the escape hatch naming the full path outright. `<name>` is *also* the docker compose project name | #119 (`apps/cli/src/deploy/layout.ts`) |
| §10 — certificate issuance | A host-installed `certbot` | `docker run --rm certbot/certbot …` against the shared proxy's `letsencrypt/`/`webroot/` directories. There is no host certbot anywhere in the pipeline | #125 (`apps/cli/src/deploy/proxy.ts`, `certbotArgv`) |
| §10 — vhost validate/reload | Host `nginx -t` / `nginx -s reload` | `docker exec <proxy-container> nginx -t` / `nginx -s reload`. There is no host nginx; the proxy container is resolved once (`--proxy-container`, or whatever publishes `:443`, or `proxy-nginx`) and recorded in state | #125 (`apps/cli/src/deploy/proxy.ts`, `validateProxy`/`reloadProxy`) |
| §10 — rendered vhost | The illustrative vhost names host filesystem paths for the certificate | Every path in the real vhost is the path the *proxy container* sees (`/etc/letsencrypt/live/<domain>/…`, `/var/www/certbot`), declared once in `PROXY_MOUNTS` and shared by the `docker run` argv and the render — the two cannot disagree | #125 (`apps/cli/src/deploy/proxy.ts`, `PROXY_MOUNTS`, `renderVhost`) |
| §13 — deploy state | `DeployState.updatedAt`, stamped "on every successful run" | `state.json` carries `lastDeployedAt` (never stamped on a failed attempt — a failed update must not claim a deploy that never happened) and a separate `lastAttemptAt`. A **second file**, `deploy-info/info.json`, is what the running application reads — `state.json` stays the CLI's private 0600 file, never mounted anywhere | #120 (`apps/cli/src/deploy/state.ts`, `apps/cli/src/deploy/deploy-info.ts`) |
| §6 — where `.env` is written | `<deploy-root>/repo/infra/compose/.env` | `<deploy-root>/.env` (0600), with `repo/infra/compose/.env` a *relative* symlink (`../../../.env`) to it — so `rm -rf repo` during a reinstall never takes the secrets with it, and a moved/bind-mounted app folder keeps working because the link is relative | #120 (`apps/cli/src/deploy/env-file.ts`) |
| §15 — `vps.compose.yml` scope | "Nothing else belongs in this file" beyond the loopback port override | Loopback binding is still the file's main job, but it also carries the `api` service's **read-only** bind mount of `<deploy-root>/deploy-info` at `/app/deploy-info` plus `DEPLOY_INFO_PATH` — the deployment metadata §19 describes, which is VPS-specific by construction and belongs nowhere else | #120 (`infra/compose/vps.compose.yml`) |

Nothing else in sections 1–17 is known to be wrong. The command surface in
§3, the module map in §4, the env-wizard design in §6, the install/update
pipelines in §7–§8, the doctor registry in §9, the `DeployHooks` seam in
§11, the journal/redaction contract in §12 and the TUI integration in §14
all match the shipped code in shape, even where a detail (an extra flag, an
extra check) was added on top. Where this document could not verify a
sub-claim precisely (the exact set of ~32 doctor checks against §9's
"minimum" list, for instance), it is left alone rather than guessed at — see
this issue's report for what that means in practice.

### 18.2 Architecture decisions (epic #118), with the alternative each closes off

These are numbered in the source as `epic #118, decision N` — the same
number appears at every call site listed, so a future correction can find
every place a decision governs.

1. **Git access on the server is `gh`, and only `gh`.** `install`/`update`
   require the GitHub CLI installed and logged in, run `gh auth setup-git` so
   plain `git clone`/`fetch` reach a **private** repository over HTTPS with
   `gh`'s own token, and rewrite an `ssh://`/`git@github.com:` origin to
   HTTPS so that credential helper is what git actually uses. *Rules out*: any
   SSH-key handling in this CLI (an operator's private key staged on the
   server, or an agent-forwarding story) and a `GITHUB_TOKEN`-shaped
   environment variable to manage. A remote not on `github.com` is not a
   failure — it falls back to plain git, and `--skip-github` skips the whole
   group for a non-GitHub remote (e.g. CI's `file://` origin). (`apps/cli/src/deploy/checks/github.ts`, `apps/cli/src/deploy/repo.ts`)
2. **No database hostname is ever pre-filled.** The env wizard's database
   step starts blank for `POSTGRES_HOST` on every path, including a re-run.
   *Rules out* silently carrying over a value that might be stale or might be
   a different environment's database entirely — a wrong pre-fill accepted
   without a second look is a worse failure mode than retyping a hostname.
   (`apps/cli/src/deploy/env-metadata.ts`)
3. **The proxy is a container, with no host fallback.** There is no host
   nginx and no host certbot on the target server, ever — nginx is addressed
   only through `docker exec <proxy-container>`, and certificates only
   through `docker run --rm certbot/certbot`. *Rules out* a host-binary
   fallback path: a validation that runs against a config the real (containerized)
   proxy never reads is a check that lies, and rendering host filesystem
   paths into the vhost fails `nginx -t` in the one nginx that matters — see
   18.1's vhost/validate rows. (`apps/cli/src/deploy/proxy.ts`)
4. **The proxy's two bind mounts are declared exactly once.**
   `PROXY_MOUNTS` (letsencrypt, webroot — host path and container path for
   each) is the single table both the `docker run certbot` argv and the
   rendered vhost read. *Rules out* the two ever independently drifting —
   the failure mode a hand-written vhost path and a hand-written `docker run
   -v` flag, edited in two files, would eventually hit. (`apps/cli/src/deploy/proxy.ts`, `PROXY_MOUNTS`)
5. **Every certbot invocation shares one `docker run --rm` prefix.**
   `certbotArgv()` builds the mount flags and the image name once; issuance
   and renewal both call it. *Rules out* the issuance and renewal code paths
   naming the image or the mounts separately and drifting apart.
   (`apps/cli/src/deploy/proxy.ts`, `certbotArgv`)
6. **DNS routing is proven before any certificate rate-limit budget is
   spent.** `probeAcmeRouting` writes a nonce under the proxy's webroot and
   fetches it over the public `http://<domain>/.well-known/acme-challenge/…`
   URL — the exact path the real HTTP-01 challenge takes — before
   `issueCertificate` ever calls certbot. *Rules out* discovering a bad DNS
   record only after a failed issuance has already spent part of the
   5-per-hour / 50-per-week Let's Encrypt budget, which is shared with every
   other app behind the same proxy. (`apps/cli/src/deploy/proxy.ts`, `probeAcmeRouting`)
7. **A second, non-secret file is what the running application reads about
   its own deployment.** `deploy-info/info.json` (§19) is written by the CLI
   on every `install`/`update` and has its `remote` block refreshed by
   `update --check` and `status`, entirely separate from the CLI's own
   private `state.json`. *Rules out* two alternatives considered and
   rejected: exposing `state.json` itself (0600, refused on a version
   mismatch, never meant to be mounted anywhere) and environment variables
   (read once at container start, so `remote` — only known after a later
   `update --check` — could never reach a running container without a
   restart). (`apps/cli/src/deploy/deploy-info.ts`)
8. **`GET /api/admin/about` is gated on `system_settings:read`, not a new
   permission.** "What is deployed here" is an administrator's configuration
   read, the same standing as every other `system_settings:read` surface.
   *Rules out* a dedicated `about:read` permission that every existing
   deployment's seed would need re-running to grant before anyone could open
   the card. (`apps/api/src/about/about.controller.ts`)
9. **A server-derived value (port, worker slots, memory limit) is always
   shown with its reason, and is always overridable.** Since issue #257 the
   four keys carrying `autoAccept` are *applied* rather than asked — they are
   measurements of the server, not decisions about the deployment — but the
   guarantee that changed is "never applied without being ASKED", not "never
   applied without being SHOWN": each is printed as it is taken and carries
   its reason into the Review table, an explicit `--answer` or an existing
   `.env` value still wins, and `--all` still forces the question. *Rules out*
   silently applying a value with no explanation and no way to override it
   before it is written. (`apps/cli/src/deploy/env-metadata.ts`, `EnvVarMetadata.autoAccept`;
   `apps/cli/src/tui/components/field-state.ts`, `Suggestion.reason`)
10. **The TUI validates every field exactly as the plain command would.**
    There is no TUI-only relaxation or extra check. *Rules out* the two
    surfaces drifting into accepting or rejecting different values for the
    same key — the same "one sequence, two renderers" discipline §11 already
    states for `DeployHooks`. (`apps/cli/src/tui/screens/deploy/doctor-model.ts`)
11. **The bind port is chosen against three sources, and re-verified before
    `up -d`.** State files see a stopped app this CLI installed; Docker's
    `HostConfig.PortBindings` sees a stopped container it did not; a loopback
    bind probe sees a process that is no container at all. *Rules out* the
    #257 failure — taking the published port of a stopped, unrelated
    container, so that the *other* application breaks days later with nothing
    linking it back to this install — and the narrower one where a port free
    when it was chosen is taken during the four-minute build and surfaces as a
    health timeout instead of as a port collision. A failed Docker query falls
    back to the other two sources rather than making Docker a requirement of
    installing, and the re-check refuses rather than re-picking, because an
    external proxy may already point at the port.
    (`apps/cli/src/deploy/docker-ports.ts`; `apps/cli/src/deploy/install.ts`, `assertBindPortStillFree`)

## 19. The `deploy-info/info.json` schema

One document, two independent implementations that must agree on its shape:
the CLI writes it (`apps/cli/src/deploy/deploy-info.ts`) and the API reads it
back (`apps/api/src/about/deploy-info.schema.ts`, consumed by
`apps/api/src/about/about.service.ts`). This section is the one place both
are described together, so neither drifts from the other without a reader of
this section noticing.

**Location.** `<deploy-root>/deploy-info/info.json`, world-readable (`0644`)
— unlike `state.json` (`0600`), nothing in this file is secret by
construction. `vps.compose.yml` bind-mounts the **directory**, read-only, at
`/app/deploy-info` inside the `api` container (never the file itself — the
CLI rewrites it with a temp-file-then-rename, which replaces the inode, and
a single-file bind mount would leave the container reading the old one
forever). `DEPLOY_INFO_PATH` (default `/app/deploy-info/info.json`) is what
the API resolves on **every** request, so a rewritten file takes effect on
the very next response with no restart.

**Schema version.** `DEPLOY_INFO_SCHEMA = 1` (`apps/cli/src/deploy/deploy-info.ts`),
independent of `DEPLOY_STATE_VERSION`. It is the **one** field the API's
reader treats as strict (`z.literal(1)`) — every other field is optional and
nullable, because the file is the CLI's best effort at deploy time
(`dockerVersion` is `null` when `docker --version` failed to parse;
`remote` is `null` until the first `update --check`), and a missing value is
information ("the CLI could not tell"), not a parse failure. Every object in
the API's Zod schema also carries `.passthrough()`, so a newer CLI adding a
field never makes an older API answer `invalid` — the extra field rides
through to the client untouched.

**Adding an optional field does not bump it, and #283 is the worked example.**
`schema` being the one strict field on the read side is exactly what makes a
bump expensive: `2` would make *every already-deployed API* answer
`deployInfoStatus: "invalid"` for a file written by a newer CLI — the very
downgrade the optional-and-nullable rule exists to prevent — and
`validateDeployInfo` compares for equality too, so an older CLI would refuse
to **read** the file it has to patch during `update --check`. A field that is
optional on both sides breaks neither direction by construction. The version
is therefore reserved for a change that alters what an existing field
**means**, exactly as `DEPLOY_STATE_VERSION` is (§22.1).

**Shape**, as the CLI's `DeployInfo` interface and the API's
`deployInfoSchema` both describe it:

```ts
interface DeployInfo {
  schema: 1;
  app: {
    name: string;            // the app folder / compose project name
    version: string | null;  // apps/api/package.json in the deployed clone
    commitSha: string;
    ref: string;
    repoUrl: string;
  };
  installedAt: string;       // ISO-8601 UTC, set once, never overwritten
  updatedAt: string;         // = state.lastDeployedAt: last SUCCESSFUL deploy
  lastCommand: 'install' | 'update';
  deployedBy: { cli: string; version: string };
  domain: string | null;
  bindPort: number;
  host: {                    // captured at deploy time; see server-facts.ts
    hostname: string | null;
    os: string | null;
    kernel: string | null;
    arch: string | null;
    cpuModel: string | null;
    cpus: number | null;
    memoryBytes: number | null;
    diskBytes: number | null;
    dockerVersion: string | null;
    composeVersion: string | null;
    nodeVersion: string | null;
  };
  remote: {                  // null until the first `update --check`
    sha: string;
    commitsBehind: number;
    checkedAt: string;       // ISO-8601 UTC
  } | null;
  run?: {                    // #283; ABSENT means the run completed
    completed: boolean;
    failedStep?: string;     // present only when `completed` is false
    attemptedAt?: string;    // ISO-8601 UTC; present only when incomplete
  };
}
```

**`run` (issue #283).** How the deploy run that wrote this document ended.
Written from the `health` step onward, on the **failure** path as well as on
success — §22 below carries the rule and the argument. Three properties are
load-bearing:

* **Optional, and absent means the run completed.** Every `info.json` already
  on every live server predates the field and was written only after a
  pipeline finished, so absence is information, not a gap — the same
  convention `DeployState.lastOutcome` established (§22.1). A reader must
  test `completed === false` and never `!== true`, or every deployment
  installed by an older CLI reads as a failed one.
* **`failedStep` and `attemptedAt` are present only when `completed` is
  false.** On a completed run `updatedAt` already *is* that instant, and a
  second copy of a value is a second value that can disagree with the first.
* **`updatedAt` still means "the last deploy that SUCCEEDED", untouched.** A
  failed **update** past `health` keeps the previous success's instant while
  `app.commitSha` names the revision that is now actually serving; `run` is
  what reconciles the two. A failed first **install** past `health` has no
  earlier success, so `updatedAt` falls back to `installedAt` — that run's
  own `now`, which is what a first successful install records there anyway.
  Nothing on either path stamps a deploy time that did not happen, which is
  the rule #120 established and §22.1 restates.

**Write path.** `writeDeployInfo` (install/update, full document) and
`updateDeployInfoRemote` (`update --check`/`status`, replaces only `remote`,
a no-op when no file exists yet — a pre-#120 deployment has nothing to
patch, and a check is not the moment to invent one) both go through
`writeDeployInfoDocument`: validate with the same `validateDeployInfo` the
reader uses (a document this module would refuse to read is never written in
the first place), `mkdirSync` the directory `0755` (world-traversable — the
API container's unprivileged user has to read through it, and nothing in it
is secret), then a `wx`-flagged temp file at `0644` and `renameSync` over the
target, inside the same directory the mount points at.

**Read path.** `AboutService.readDeployInfo` (`apps/api/src/about/about.service.ts`)
reads the file on every `GET /api/admin/about` request, parses it against
`deployInfoSchema`, and always answers **200**: no file is
`deployInfoStatus: "absent"`; unreadable (permissions, a torn write outside
the temp-then-rename window) is `"unreadable"`; JSON that fails schema
validation is `"invalid"`; a successful parse is `"ok"`. `updateAvailable` is
derived from `remote.commitsBehind` (`null` when the CLI has never checked)
— **never** from a network call the API itself makes; this endpoint performs
no network I/O, ever (18.2 decision 7's whole reason for existing).
`deployRunComplete`, `deployFailedStep` and `deployAttemptedAt` (#283) are
derived from `run` in the same place and for the same reason: the
"absent means completed" convention is written **once**, on the server, so
the web About card (#126) and the CLI's `deploy about` (#128) cannot disagree
about a deployment an older CLI installed. They are **additional** to
`deployInfoStatus`, not a fifth value of it — the four statuses answer "could
the record be read", and an incomplete run's record was read perfectly well.
Folding "incomplete" into that enum would force a client to choose between
rendering the deployment facts and reporting the failure, when the whole
point of the record is that both are true at once. Every
value under a key matching `/password|secret|key|token/i`, at any depth
`.passthrough()` let through, is stripped before the response is built — a
defense against a future CLI, or a hand-edited file, putting something
secret-shaped into a document this design otherwise promises is safe to show
every admin.

**Test fixture.** `apps/api/src/about/__fixtures__/deploy-info.json` is the
shared vector both sides are tested against, so the writer and the reader
cannot drift without one of the two suites noticing.

## 20. Creating the database, on request only (issue #238)

Decision 4 of section 1 says the operator supplies `POSTGRES_*` for a
database that already exists, and that deploy validates it rather than
managing it. That decision holds. What issue #238 adds is one narrow,
explicit exception to it, not a reversal of it.

**The exception, and its exact bounds.** When the install wizard's Database
step fails `database-exists` — and only that check, and only with PostgreSQL's
own `3D000` (`invalid_catalog_name`) — it now offers to run one statement,
`CREATE DATABASE <name>`, against the `postgres` maintenance database, using
the very credentials the operator just typed. Everything else about decision 4
is unchanged: no role is created or altered, no extension is installed, no
table is touched, nothing is ever dropped. `database-privileges` and
`database-vector-extension` — both of which `requires: ['database-exists']`
and so reported `skip` up to this point — then run for the first time against
a real database, exactly as they would have if the database had existed
before the wizard started.

> **⚠ This section's "there is no DROP and there never will be" is now
> qualified, in exactly one place.** §21.3 (issue #268) adds
> `uninstall --drop-database`, and the argument below is what bounds it: the
> asymmetry §20 names — *"an empty database created in error is recoverable by
> deleting it by hand; the inverse is not"* — is precisely why a drop can never
> be **offered** the way this creation is. It has to be **asked for by flag**
> and authorised by typing the database's own name. `install` still contains no
> DROP, and that has not changed.

**Why offering this is not "managing" the database, in the sense decision 4
rules out.** By the moment this is offered, `database-credentials` has
already passed: the supplied user has already authenticated against this
cluster, over this network path, with this password. Nothing about the offer
grants a capability the operator did not already demonstrate they hold —
it spends one more round trip on a statement they were otherwise being told
to go type by hand, in another terminal, before re-entering this same step.
Declining leaves today's behaviour exactly as it was: `database-exists` fails,
its remedy prints the `createdb` command, and the operator runs it themselves.

**Why the read-only guarantee that makes `doctor` safe against production is
unchanged.** Section 9's rule 4 (`checks/types.ts`'s own header) is that a
check never writes. `database-create.ts` is deliberately not a check, is not
in `DATABASE_CHECKS`, and `doctor` never imports or calls it — grep the
registry and it is not there. `database-exists` keeps reporting a plain
`fail`, unchanged, whoever calls it. The creation is a *separate* action the
install wizard's step loop offers **after** the check registry has already
reported, gated on an explicit `yes` (or, unattended, on an explicit
`--create-database`) that only the wizard's caller can give — never on a
check's own result. Running `kvox deploy doctor` against a production server
at 3 a.m. still creates nothing, exactly as before, because `doctor` is the
one caller that never reaches this code at all.

**Under `--non-interactive`.** There is nobody to ask, so `--create-database`
is the entire authorisation, not a default. Without it, an unattended run that
finds the database missing reports the failure and stops, exactly as it did
before this issue — the flag existing does not change what happens when it is
absent. With a terminal, the flag only changes the confirmation prompt's
*default* answer; the operator is still asked by name, naming the database,
host, port and user, every time.

**Why the name is validated, not only quoted.** `POSTGRES_DB` is operator
input, and `CREATE DATABASE` takes no bind parameters, so the name has to be
interpolated into the SQL text somehow. Quoting it correctly is not enough on
its own — correct-looking quoting is exactly the kind of thing that decays
once someone later builds a second statement beside it — so the name is first
required to look like an ordinary identifier (a letter or underscore, then
letters, digits, underscores or `$`) before anything is built. A name that
does not pass is refused with the same `createdb` remedy `database-exists`
already prints, never escaped and sent anyway.

**Rejected:**

- **Creating the database inside `database-exists` itself**, so the check
  passes on retry with nothing else needed. This is the alternative decision
  4 exists to rule out: a check that writes when it does not like what it
  finds is a check an operator can no longer reason about as a whole, only
  check by check, remembering which ones they hope are harmless. Once one
  check writes, "run `doctor` against production, any time" stops being true
  of the registry, not just of that one check.
- **Creating roles or extensions along the way**, since the wizard is already
  connected and it would save the operator the pgvector step too. Rejected for
  the same reason decision 4 rejects it generally: a role or an extension is a
  capability grant, not a database that simply does not exist yet, and
  `database-vector-extension` already has its own preflight-and-remedy design
  (§9.1) that assumes it is being asked, never assumed on the operator's
  behalf.
- **Anything destructive** — a `DROP DATABASE` to "start clean," a `CREATE OR
  REPLACE`-shaped operation. There is no drop here and there never will be:
  an empty database created in error is recoverable by deleting it by hand;
  the inverse is not, and this design does not put that outcome one
  mis-clicked confirmation away.

## 21. Removing a deployment, what it refuses to remove, and the two extras that must be asked for (issues #261, #268)

Sections 1–20 describe a CLI that can **create** a deployment and **advance**
one. Until issue #261 nothing could **remove** one, and the gap was not
cosmetic. "I'll start over" meant an operator improvising `docker compose down`
plus `rm -rf repo`, which is subtly wrong in a way §10 and the `.env` design
make almost inevitable.

**The concrete failure this closes.** `env-file.ts` keeps the environment file
at `<deployRoot>/.env` — *outside* `repo/` — precisely so `rm -rf repo` cannot
take the secrets with it. That is the right design for a re-clone and exactly
the wrong outcome for a start-over, and nothing in the CLI distinguished the
two. Issue #259 is the bill: a corrupt `.env` survived three consecutive
`install` attempts and produced a failure (`deploy install` dying at "Wait for
health" on a deployment that was serving correctly) whose symptom pointed
nowhere near its cause. The same applies to the state file, `deploy-info/`, the
journal, the compose project's **named volumes**, the vhost in the shared proxy
and the renewal cron in `/etc/cron.d`: every one of them outlives a manual
`rm -rf repo`, and none was documented as the operator's to clean up.

### 21.1 What `uninstall` removes

Five things, and each is removed by the *same* mechanism that created it, never
by a second implementation that could drift from it:

1. **The compose project** — containers, project networks and named volumes —
   with `down -v --remove-orphans`, built through `composeArgv` so the
   `-p <name> -f base -f prod -f vps` invocation is literally the one `install`
   uses. `-v` is what makes this a removal rather than a stop: a "start over"
   that silently keeps the volumes is the failure being improvised today.
2. **The deploy root**, enumerated entry by entry (`repo/`, `.env`, `logs/`,
   `data/`, `deploy-info/`, the state file) rather than with one `rm -rf`. Two
   reasons: `--keep-env` has to be able to spare exactly one of them, and
   `--dry-run` has to be able to print a list an operator can check against
   what they believe is there, rather than a promise they must take on trust.
3. **This app's vhost in the shared proxy**, through the existing `removeVhost`
   (§10) — the *exact path* `vhostPath()` computes, never a glob over
   `conf.d/`, and only when the file still carries the `# Managed by appctl
   deploy` marker. The proxy is then **reloaded, never restarted**, for §10's
   own reason: a restart drops every other site's connections.
4. **This app's certificate renewal cron**, `/etc/cron.d/<cli>-certs-<name>`,
   **conditionally, and never silently** — see §21.1.1, which is a rule, not a
   caveat.
5. **The `.env`, after copying it** to `<appsRoot>/<name>.env.<timestamp>.bak`,
   0600, with the same atomic temp-file-then-rename discipline `writeEnvFile`
   uses. The copy lands in the **apps root** — a sibling of the folder being
   deleted — because a backup inside the directory being removed is not a
   backup. It is taken even with `--keep-env`: keeping the file and copying it
   are not alternatives, and a few kilobytes is the whole cost of not losing
   generated secrets that exist nowhere else.

#### 21.1.1 The renewal cron is shared infrastructure wearing a per-app filename

The filename is `<cli>-certs-<name>`, which reads as "this app's entry". The
*contents* are not per-app at all. `renderRenewalCron` emits `deploy certs renew
**--all**`, and its own comment says why: *"`--all` on purpose: the proxy is
shared, and one entry renewing every lineage under it serves every app this CLI
manages."*

So the entries are **not independent**. The last one standing is renewing every
other app's certificates too, and removing it stops automatic renewal for the
entire shared proxy. On a server running eight or ten apps — the ordinary case
this design is for — that surfaces 60–90 days later as every certificate on the
box expiring at once, with nothing connecting the outage to the uninstall that
caused it. That is the *same* "shared with every other app" property §21.2 uses
to refuse `devnet`, the proxy container and the certificates themselves, so it
gets the same treatment rather than a footnote.

**The rule:**

1. Enumerate the sibling entries first, through `listRenewalCrons(cronDir)` —
   which shares the `<cli>-certs-` prefix constant with `renewalCronPath`, so
   the reader and the writer cannot drift. A second hand-rolled glob would stop
   matching the moment the naming changed, and would fail *silently* at exactly
   the question it was consulted about.
2. **At least one other entry survives** → remove this app's and say nothing.
   Renewal is still covered, by a line that was always renewing everything.
3. **This was the last entry** → remove it anyway, and raise a first-class
   warning.

Removing it in case 3 is deliberate and is the lesser evil. The line names
`--apps-root <root> --name <name>` pointing at a deploy root this very run
deletes, so leaving it behind means a cron entry that is present, broken, and
failing silently twice a day — which is not renewal coverage, it is the
appearance of it.

**The warning is treated as output, not as documentation.** It goes into
`UninstallResult.warnings`, the non-JSON renderer prints it **above** the
inventory under `Action required:` (a notice at the foot of a twelve-path list
is a notice nobody reads), and it is produced under `--dry-run` too — deciding
*whether* to uninstall is precisely when this has to be known. It states three
things in order: that renewal has stopped, that this affects **every** app
behind the proxy and not only the one being removed, and the exact command that
puts it back. That command names a **real surviving deployment**, found with
`listInstalledApps(appsRoot)` minus this one, so it can be pasted rather than
filled in; when this was the only app on the box there is nothing to point at
and the message says so instead of printing a placeholder that cannot work.

Nothing is said when this app had no entry at all (installed with
`--no-install-cron`, or it never issued a certificate): there was no coverage to
lose, and a warning about a loss that did not happen is how operators learn to
skip warnings.

#### 21.1.2 Writing that cron is best effort, and must never fail an install (issue #265)

§21.1.1 is about removing the entry. This is about writing it, and it is the
same file seen from the other end of the deployment's life.

**The failure.** A non-root install reached its last step and died there:

```
✖ kvox: Publish over HTTPS failed: EACCES: permission denied, open '/etc/cron.d/kvox-certs-kvox'
```

`publish` issues the certificate, installs the vhost, then writes the cron.
The first two had **succeeded** — the certificate existed, the site was serving
HTTPS — and the third threw, taking the step and the whole install down with it.

**The contradiction it exposed.** `/etc/cron.d` is `root:root`, and this CLI is
deliberately *not* run as root: §18 records that `sudo kvox` breaks `gh`
authentication (sudo resets `HOME`, and `gh` credentials are per-user), and
#245's remedy is `sudo install -d -o $USER …` on the deploy root precisely so
the tool never needs to be elevated. So one step of the pipeline requires root
inside a design that requires not-root. That contradiction is real and cannot
be argued away; the only question is which way it resolves.

**The decision: the cron write is best effort.** The failure is caught,
recorded as a warning, and the install completes.

*Why not fail the install, which is the conservative-looking choice?* Because
it is not conservative, it is inaccurate. What "failed" describes is a state
that does not exist: the deployment **is** complete when the write throws —
certificate issued, vhost written and validated, proxy reloaded, stack healthy.
Only the scheduling of a renewal 60–90 days out is missing. Reporting that as
a failed install means:

- The operator is told to fix a deployment that is already serving traffic.
- The obvious remedy is `--resume`, which re-enters `publish` and asks certbot
  again — against a rate limit of **five duplicate certificates per week**. A
  design that makes the retry the dangerous action has chosen wrongly.
- The thing actually needed is one `sudo` command, which the tool knows exactly
  and was throwing an errno instead of printing.

**Best effort is not silent.** These four are what separate "best effort" from
"swallowed", and all four are load-bearing:

1. **Every errno, not just `EACCES`.** `EROFS`, `ENOTDIR` and `EPERM` leave the
   same deployment behind — complete, serving, unscheduled. Special-casing one
   errno would fail a successful install for all the others.
2. **The error is reported as it came.** Not flattened into "could not write the
   cron"; an operator diagnosing a read-only `/etc` needs the errno.
3. **The remedy is derived, never described.** The rendered file is staged into
   the deploy root and the warning carries `sudo install -m 644 <staged>
   <target>`, so what the operator installs is byte-identical to what the CLI
   would have written. Prose describing the file could drift from
   `renderRenewalCron`; a copy of its output cannot.
4. **It surfaces at the END of the run.** `InstallResult.warnings`, printed
   under `Action required:` — the same channel and the same renderer shape
   §21.1.1's warning uses, for the same reason. An install that completed
   without a renewal schedule must never be silent; the only other notice of it
   is an expired certificate three months later.

The pasteable form is one `sudo install` line rather than a `sudo tee`
heredoc of the contents, and that is a decision, not a preference: the report
indents warnings by four, and a heredoc does not survive indentation — the
body keeps the leading spaces and carries them into the cron file, and an
indented `EOF` does not terminate the heredoc at all, so the paste hangs the
operator's shell. A single `install -m 644` line is indentation-proof and
carries the mode, which is part of the contract (cron ignores a group- or
world-writable file in `cron.d`).

**The quieter defect, and why the gate had to change.** The cron was gated on

```ts
if (context.options.installCron ?? certificate.issued) {
```

and `issueCertificate` answers `{ issued: false }` for a certificate that
already exists. So the `--resume` an operator reaches for after this failure
skipped the cron block **entirely**, reported success, and left a deployment
holding a certificate nothing renews — no error, no warning, nothing in the
journal. A loud failure had become a silent one, which is strictly worse.

The gate is therefore *"does this deployment have a renewal entry?"*, answered
by `hasRenewalCron` over `listRenewalCrons` — §21.1.1's reader, so this and
`renewalCronPath` share one prefix constant rather than two that can drift. An
existing certificate with no entry is exactly the state that needs one.
`--install-cron` still forces the write; `--no-install-cron` still declines it.
Nothing about the rate-limit posture changes: `issueCertificate` consults
`certificateStatus` before invoking certbot, so a re-run over an existing
certificate never re-requests it.

**Doctor gets the matching check, and it is `recommended`.** `cron-dir-writable`
probes the deepest existing ancestor of `/etc/cron.d`, the same way
`deploy-root-writable` probes the deploy root's — #245's finding ("doctor is
complete about somebody else's directory and silent about its own") applied to
the *second* directory this CLI writes outside the deploy root. `recommended`
rather than `required` follows directly from the decision above: the install
does not treat this as fatal, so doctor must not either. A root-owned
`/etc/cron.d` is the ordinary state of a standard Linux server, not a broken
one, and failing on it would refuse a machine this CLI installs on perfectly
well — and teach the operator to pass `--force`, which is how the *required*
checks stop being enforced too. Its remedy names the `sudo install` command and
explicitly says not to re-run the CLI under sudo, which would trade this for a
logged-out `gh` at the `checkout` step.

**Rejected:** *run just this step under `sudo` from inside the CLI.* It would
work, and it would make the tool one that sometimes elevates itself — the
property §18 spent an issue removing. An operator who can read the command and
decide to run it is a better arrangement than a tool that decides for them, and
the gap it leaves is one printed line.

### 21.2 The refusals, and why each is a decision rather than an omission

**The external database.** Decision 4 of §1 is that deploy *validates* the
database and never creates or manages it; §20 adds exactly one narrow exception
(`CREATE DATABASE` on an explicit request) and closes it with a sentence that
settles this question in advance: *"an empty database created in error is
recoverable by deleting it by hand; the inverse is not, and this design does
not put that outcome one mis-clicked confirmation away."* A `dropdb` inside
`uninstall` is that outcome, one mis-clicked confirmation away. It also usually
lives on another host and is frequently shared. So the command **prints the
`dropdb`** — assembled from the deployment's own `.env`, read in the **first**
step, because after the deploy root is gone nothing is left that knows the
database's name — and never runs it. The printed command carries **no
password**: `dropdb` prompts or reads `~/.pgpass`, and a connection string on a
command line is a credential in the shell history of whoever pastes it.

**The `devnet` network.** §15 declares it `external: true` in
`base.compose.yml` precisely because it is shared: every app on the host joins
it. `docker compose down` does not remove an external network and must not, and
neither does this command. `install`'s `network` step creating it when absent is
not a symmetry argument — creating a shared resource that is missing is
idempotent and harms nobody; removing one that other apps are attached to is
neither.

**The shared proxy container.** The same argument, one level up, and §10's
central decision: TLS is terminated once, by a shared containerized proxy, for
every app on the box. This command removes *its own vhost* from that proxy and
reloads it. Stopping, restarting or removing the container would take every
other site on the server down with this one.

**TLS certificates, by default.** This is the refusal most likely to be
"fixed" by someone tidying up, so the reasoning is worth stating in full.
Let's Encrypt enforces a **duplicate-certificate limit of 5 per week** for an
identical set of hostnames. The operator reaching for `uninstall` is, by
construction, the one iterating on an install that is not working — and a
reinstall re-requests the certificate. Destroying and re-requesting on each
iteration therefore burns the week's budget in an afternoon and locks the
operator out of issuing for **their own domain** for a week, with the
application down. Keeping the certificate costs a few kilobytes on disk and is
harmless to a domain that is never redeployed; deleting it costs a week in the
one situation where somebody is actually watching. `--certs` opts in
explicitly, and it uses `certbot delete --cert-name` rather than `rm -rf` into
`letsencrypt/live/`: that directory is three linked trees (`live/`, `archive/`,
`renewal/`) and a partial removal leaves certbot able to neither renew nor
reissue for the name.

### 21.3 Safety

**A typed confirmation of the app's name, not a y/N.** This is the convention
the API already holds for destructive actions — `confirmation: "RESTORE"`,
`"ROLLBACK"`, `"REMOVE"`, and the Danger Zone's scope-uppercased word — and it
holds here for the same reason: a y/N is one stray Enter away from happening,
and typing the app's own name additionally proves the operator is removing the
deployment they *think* they are. Under `--non-interactive` it must arrive as
`--confirm <name>`; a destructive default reachable by omission is not a
default. A missing terminal is refused too, never treated as consent.

**`--dry-run` writes nothing at all**, the run journal included. `openJournal`
creates `<deployRoot>/logs/` and two files in it before the first line is
written, so a dry run using the real journal would have already broken its own
promise — and, on a deployment whose root is already gone, would recreate the
very directory it was asked only to describe. `nullJournal()` exists for this.

**It is resilient to a half-removed deployment.** No containers, no clone, no
deploy root, an unreadable state file: each is an ordinary outcome that is
*reported*, not an error that stops the run. The operator reaching for this
command has, more often than not, already tried to do it by hand — and a
deployment whose state file this build cannot parse is precisely the one
somebody most wants to be rid of.

**The uninstall journal survives only a failed uninstall.** `logs/` is part of
the deployment being removed, so a successful run deletes its own log. The
journal is therefore stood down — after its last line — immediately before the
deploy root goes, rather than being left to append to files that no longer
exist. A *failed* uninstall stops before that step and keeps its log, which is
the run anybody wants one for.

### 21.3.1 The two opt-in extras: `--drop-database` and `--purge-storage` (issue #268)

§21.2's first refusal and the "out of scope" line at the end of §21.5 both
answer the same question — *may `uninstall` destroy the data?* — and both
answered "no" because the alternative on offer was **a flag with a y/N**.
Issue #268 changes the alternative, not the answer's reasoning: each extra is
opt-in, off by default, gated by a typed confirmation of **that resource's own
real name**, and preceded by an inventory of exactly what it would destroy. An
operator who wants the deployment *gone*, data included, should not have to
leave for two other tools and do it from memory.

**Rule 1 — each extra confirms its own resource, never a shared "yes".** The
database drop takes `--confirm-database <database>`; the purge takes
`--confirm-bucket <bucket>`. Each value is compared against that one resource
and nothing else, so a word typed for one **cannot** authorise the other. This
is the API's own convention stated for a second surface: the Danger Zone's rule
that *the confirmation IS the scope, uppercased*, exists precisely so a word
typed for one scope can never authorise another. A single
`--yes-delete-everything` would be one keystroke authorising two unrecoverable
acts against two unrelated systems, and it is rejected permanently.

**Rule 2 — the inventory precedes the confirmation.** Objects and bytes per
prefix, everything in the bucket that is not this application's, the database's
name, host, size and open session count. An operator cannot consent to a number
they were never shown. The read is done in `runUninstall` *before* the first
prompt, is entirely read-only, and runs under `--dry-run` too — which is how an
operator looks before deciding. A resource that could not be **read** is never
confirmed and never destroyed: there is no real name to type, and the run
reports the problem and removes the deployment anyway.

**Rule 3 — the order is fixed, and each step of it is an argument.**
Containers down → storage → database → deployment.

- *Containers first*, because nothing may write a new object or open a new
  connection mid-teardown.
- *Storage before the database*, because the deployment's own rows are the only
  thing that could ever reconcile an object the purge missed, and the drop
  destroys them.
- *The deployment last*, because its `.env` holds the credentials the other two
  steps authenticate with. Removing it first would leave them with nothing.

**Rule 4 — a failed extra never fails the uninstall.** It is reported under
`Action required:`. The deployment was going whatever the bucket said, and an
abort with the containers already stopped would leave an arbitrary amount done
and nothing said about it.

#### The drop, and the one write against sessions that are not ours

`DROP DATABASE "<name>"` against the `postgres` maintenance database, through
the same one-off `psql` container §20's `CREATE DATABASE` uses — `postgres`
because a database cannot be dropped from a session connected to it, which is
§20's own reason inverted.

`DROP DATABASE` fails with `55006` while **any** session is connected.
`uninstall` brings this app's containers down first, so the ordinary case is
clean — but a `psql` left open in another terminal, a pooler, or a second
replica on another host all block it, and leaving the operator with
`ERROR: database is being accessed by other users` and no idea which is not an
outcome worth shipping.

So: **the plain drop is tried first**, and on the ordinary path *no session
belonging to anybody is touched at all*. Only on `55006` are the blocking
sessions terminated, scoped `WHERE datname = <this database> AND pid <>
pg_backend_pid()` — never a bare terminate-all, because the operator authorised
destroying **one** database and a session against a different one is not theirs
to end — and **the number ended is reported**, in the result and in the run log.
Termination is defensible here and only here: by that moment the operator has
typed this database's own name, and a session connected to a database that is
about to cease existing cannot lose anything the drop was not already going to
destroy.

**Rejected: `DROP DATABASE … WITH (FORCE)`.** It does the same thing in one
statement, and it is PostgreSQL 13+ — this deployment's database is
operator-supplied and may be older, where it fails as a syntax error saying
nothing about connections. It is also **silent** about what it killed, which is
the one property the two-step shape exists to provide.

#### The purge, and why there is no per-app key prefix to lean on

This application writes at **bucket root**, under six prefixes — `avatars/`,
`database-backups/`, `node-outputs/`, `notes/`, `transcripts/`, `uploads/`.
There is no per-app namespace, so *"empty the bucket"* and *"delete this app's
objects"* coincide **only when the bucket is dedicated**. The rule that follows:

> **Delete the prefixes this application writes. Report everything else,
> without reading into it and without touching it.**

That is complete for a dedicated bucket and safe for a shared one, and where it
is incomplete it says so by name instead of degrading catastrophically. The
root listing uses `--delimiter /` deliberately: enumerating a shared bucket
exhaustively would mean *reading* somebody else's data in order to decide not to
touch it, and could mean millions of keys. **The bucket itself is never
deleted** — it is infrastructure the operator created, often with a lifecycle
policy, a CORS rule and a name that cannot be reclaimed for hours.

**Versioned buckets are the trap this design refuses to fall into.** Deleting
an object in a versioned bucket writes a **delete marker** and keeps every byte,
and the bill. So versions and delete markers are removed **by id**, and an
unreadable `GetBucketVersioning` (an ordinary least-privilege setup) is treated
as *versioned*, never as off — assuming the cheaper answer is exactly what
produces silent retention while reporting "emptied".

**The `aws` client is borrowed from a one-off container**, the same argument
`checks/database.ts` makes for `psql`: docker is already a hard prerequisite,
the image caches after one pull, and it behaves identically on a host with
nothing installed. Two alternatives were rejected. Adding `@aws-sdk/client-s3`
puts ~15 MB of dependency into a CLI installed on a VPS for a teardown almost
nobody runs — the API package carries it, this one deliberately does not, and
the worker node never needed it because the **server** signs every URL a node
uses. Hand-rolling SigV4 over `node:crypto` is the other no-dependency option
and is worse: versioned listings, pagination, the batch delete's payload and its
digest are a lot of security-relevant surface exercised only during a teardown,
which is the single worst moment to discover a signing bug. Credentials are
passed **by name** into the container's environment and never appear in an argv,
the rule `runPsql` already states about `PGPASSWORD`.

### 21.4 `install --fresh`

The convenience path for the case above, and deliberately much narrower.
`--fresh` discards this app's **local state only** — the `.env`, the state file
and `deploy-info/` — backs the `.env` up exactly as `uninstall` does, and
installs clean. It does **not** touch the containers, the proxy vhost, the
certificate or the database, and it needs **no typed confirmation**: nothing
irreversible is destroyed, because the backup is taken first and the clone is
re-fetched in the ordinary way. It implies `--reinstall` — discarding a state
file and then refusing because a state file exists would be a contradiction one
line apart.

The two share their teardown helpers through `deploy/teardown.ts` rather than
duplicating them. That module exists for a mechanical reason worth recording:
`uninstall.ts` imports `composeArgv`/`composeCwd` from `install.ts`, so putting
the helpers in `uninstall.ts` would make `install → uninstall → install` an
import cycle.

### 21.5 Rejected alternatives

- **`uninstall --all`, or any flag that also drops the database.** Rejected for
  decision 4's reason at its strongest: a flag that exists will eventually be
  passed by someone who meant something else, and there is no recovery. The
  printed `dropdb` is a deliberate speed bump, not an oversight.
- **A y/N confirmation, matching `tui/components/confirm-dialog.tsx`.**
  Rejected: see §21.3. The TUI has no typed-confirmation component today, which
  is exactly why this command is **not** on the `deploy` TUI menu — adding it
  there means adding that component first, and a y/N dialog standing in for a
  typed app name would quietly weaken the guarantee while looking like it
  satisfied it.
- **Removing `letsencrypt/live/<domain>` directly under `--certs`**, avoiding a
  `docker run`. Rejected: §21.2's three-linked-trees problem.
- **One `rm -rf <deployRoot>`.** Rejected: `--keep-env` and `--dry-run` both
  need the entries named. See §21.1.
- **Removing every vhost in `conf.d/` matching the app.** Rejected outright:
  `removeVhost` removes one exact path and refuses a file this CLI did not
  write. The proxy directory is shared, and a glob there is a bug waiting for
  a second app with a similar domain.
- **Leaving the renewal cron in place when it is the last one**, so renewal
  keeps running for the other apps. Rejected: the line names the deploy root
  being deleted, so it would fail on every run — the operator would be left
  with a broken entry, no warning, and the same expiry 60–90 days later, minus
  the chance to act on it. §21.1.1.
- **Rewriting the last entry to name a surviving deployment automatically.**
  Rejected: this command's job is to remove *its own* deployment, and silently
  editing a cron entry on another app's behalf is a write to shared
  infrastructure — the very thing §21.2 refuses. Printing the one-line command
  leaves the decision where it belongs.
- **Deleting the deployment's storage bucket or its uploaded objects, with no
  confirmation of its own.** Refused for the database's reason: object storage
  is supplied by the operator (§6's `STORAGE_*` variables), is frequently
  shared, and this CLI never created it. **Revisited by issue #268** (§21.3.1),
  which keeps every word of that and adds the missing piece: the objects may be
  deleted behind `--purge-storage` plus a typed confirmation of the bucket's own
  name, only under the six prefixes this application writes, with everything else
  reported rather than touched — and **the bucket itself is still never
  deleted**, because that part was never about confirmation.
- **A single "also delete the data" flag covering both the database and the
  bucket.** Rejected permanently (§21.3.1, rule 1): one keystroke authorising
  two unrecoverable acts against two unrelated systems, in a project whose own
  API convention is that *the confirmation IS the scope, uppercased*.
- **`DROP DATABASE … WITH (FORCE)`.** Rejected: PostgreSQL 13+ on an
  operator-supplied server, and silent about which sessions it ended. §21.3.1.
- **Treating an unreadable `GetBucketVersioning` as "not versioned".** Rejected:
  it is the cheaper answer and the one that leaves data behind a delete marker
  while the run reports "emptied". §21.3.1.

---

## 22. The state is written on both endings, `deploy-info/` from `health` onward (issues #267, #283)

`§13` above, and `§18.1`'s correction to it, describe a state file written
after a run succeeds. That was the whole of it, and it made `--resume`
unusable for the only thing it is for.

`--resume` reads `completedSteps` out of the state file. `runInstall` computed
`result.completed` on the failure path and threw it away there, writing the
state only after `runPipeline` returned without a failure — so a failed
install left no state, `--resume` answered `Nothing to resume: no deployment
state at <root>`, and the failure message that had just recommended the flag
was advising an impossible action. Every retry re-ran the whole pipeline,
including a multi-minute image build, against a deployment whose first ten
steps had already succeeded.

**The state is now written on both endings, from one builder.**
`buildInstallState` in `apps/cli/src/deploy/install.ts` is called twice —
once with `{ outcome: 'success' }`, once with `{ outcome: 'failure',
failedStep }` — and every field but the outcome is constructed identically.
Two object literals would drift: the success literal being replaced had
already gained `proxyContainer` and `envPath` since it was written, and a
second copy would not have had either. The failure record's entire purpose is
to be the file the next run reads back, so "identical apart from the ending"
is a correctness property, not tidiness.

**`deploy-info/info.json` is written from the `health` step onward**, on the
failure path as well as on success. #267 withheld it from every failed run and
argued the withholding: §19's document is what the *running application*
reports about itself, mounted read-only into the `api` container, and an
install that did not finish has not deployed what that file would claim.

**That argument is right up to `health` and wrong after it (issue #283).** A
real production install cloned, built, applied 21 migrations, seeded, started
the stack, passed the health wait and issued the certificate — and then failed
at its very last action, writing `/etc/cron.d/…` (§265). `/admin/settings/about`
told the administrator *"This instance was not deployed with the deploy CLI, so
deployment details are unavailable"*, which is false about a server the CLI had
plainly deployed and which was serving traffic at that moment. Withholding the
record produced a **worse lie than writing it**: "not deployed by the CLI"
rather than "deployed, and the run did not finish".

So the rule is now: **the moment the API responds, the deployment is real.**
From `health` onward the record is written on both endings, carrying `run`
(§19) — whether the run completed and, when it did not, which step stopped it.
#267's actual insight is preserved unchanged: a run that fails **before**
`health` still writes no deploy-info at all, because nothing is serving and a
record would describe a deployment that does not exist.

### 22.0 The gate is `health`, not `verify`

`health` **is** the claim this document makes. `waitForHealthy` polls
`/api/health/ready` until the application answers, so a run past that step has
a deployment that demonstrably exists and is reachable — which is precisely
what "what is deployed here" means. `verify` is the **last** step of both
pipelines, so gating on it would write the record on success and essentially
nowhere else, leaving the reported failure (a `publish` that sits *between*
the two) reporting nothing at all — the bug, unfixed.

The test is `result.completed.includes('health')`, read off the pipeline's own
record rather than re-derived. `health` carries no `skip` guard in either
pipeline, and a step skipped by a guard is in **neither** list
(`steps/pipeline.ts`), so this cannot mistake a `--skip-*` for a pass. A
`--resume` that carried `health` in from a previous run's `completedSteps` is
the same claim: that run reached a serving API at this root.

The ordering comment in `runInstall` ("AFTER the state: deploy-info is derived
from it") stays true on both paths — both writes gained a second call site, in
that order. Neither may fail the run: like the state write, the deploy-info
write is wrapped and journaled, because a full disk that stops the record
being kept is a worse second run, not a different first failure.

### 22.0.1 `update`, and the two things it must not do

`update` follows the same gate, with two constraints of its own.

**It must not stamp a deploy time that did not happen.** `update` records
`lastDeployedAt` only on success (§18.1, #120), and the failure path leaves
that alone: the state file is not written at all, and the record is derived
from an in-memory state whose `lastDeployedAt` is the previous success's. So
`updatedAt` keeps meaning "the last deploy that succeeded" while
`app.commitSha` names the revision `restart` actually brought up and `health`
actually answered on.

**It must not rewrite the record backwards on the next run.** After a failure
past `health` the clone is at the new revision and serving it, while the state
still names the old one. A plain re-run then takes the "already up to date"
path, which refreshes deploy-info to pick up moved host facts — and, derived
from that stale state, would move the record from the revision that *is*
running to the one that is not, and mark it complete. That path therefore
takes its commit from the **clone** (`context.commitSha`) and carries the
existing document's `run` through **unchanged**: a run that deployed nothing
has nothing to say about how any run ended.

### 22.1 Three fields, and why each is shaped the way it is

- **`lastOutcome: 'success' | 'failure'`, optional, absent meaning success.**
  Every state file written before this change was written only after a
  pipeline finished, so absence already means "this run completed". A reader
  must therefore test for `'failure'` and never for `!== 'success'`, or every
  pre-#267 deployment reads as broken. `DEPLOY_STATE_VERSION` stays at 1: it is
  bumped only when a field **changes meaning**, and nothing here does.
- **`lastFailedStep`, beside `completedSteps` rather than derived from it.**
  A skipped step (`--skip-seed`, a non-GitHub remote) is in neither list, so
  "the first id not in `completedSteps`" is not the step that failed.
- **`lastDeployedAt` became optional.** §18.1 already records the rule this
  preserves: a failed run must not claim a deploy that never happened. A failed
  run carries an earlier success's value forward unchanged; a **first** install
  that fails has no earlier success, so there is no instant to record and the
  field is absent. Absent means "no deploy has ever completed here", which is
  the only encoding that is neither a sentinel nor a lie.

### 22.2 The refusal this would otherwise have broken

`install` refuses to run over an existing deployment and points at `update` or
`--reinstall`. That refusal keyed on the state file merely **existing** — which
stopped being the same question the moment a failed run started writing one.
Left alone, the fix would have broken the ordinary retry it exists to enable:
install fails, the operator fixes the cause, re-runs `install`, and is told to
pass `--reinstall` to start over a deployment that never happened.

The refusal now keys on `lastDeployedAt` being present, not on `lastOutcome`.
The difference matters: a failed **reinstall** over a real deployment still
carries the earlier success's `lastDeployedAt`, so it is still refused — the
containers, the certificate and the database it would clobber are all still
there. Only a root where no deploy has ever completed is let through.

`--fresh` (§21.4) is unaffected: it discards the state file **before**
`readState`, so a failure record is discarded exactly like a success one and
nothing on this path can resurrect it.

### 22.3 Two consequences worth stating

A resumed run skips `checkout`, so `context.commitSha` and `context.target`
are never set on that path. `buildInstallState` therefore falls back to the
existing state for `commitSha`, `repoUrl` and `ref` — without which the run
that finally **succeeds** would record an empty commit and an empty repository
URL, and publish both to `deploy-info`.

A `deploy status` on a root whose install failed now reports it — "the last
install failed at `<step>`" — rather than rendering it as an ordinary
deployment that happens to be down. The TUI's status screen does the same, and
says `never` where it would otherwise print a deploy time that does not exist.

### 22.4 On `--repo` with `--name`

#267 also reports that `--repo` is silently ignored when combined with
`--name`, because `resolveInstallLayout` returns early on `--name` without a
`RepoTarget`. Checked against the code, it is not: the `checkout` step calls
`resolveTarget`, which passes `options.repo` to `resolveRepoTarget` as
`repoFlag` whenever the context has no target yet, and that is rank 1 of that
function's resolution order. The flag is honoured; what the early return costs
is only `describeLayoutSource`'s wording in the `--resume` refusal, which
describes the **directory** and is accurate about it.

`apps/cli/src/deploy/install.test.ts` pins this, so the two flags cannot start
contradicting each other unnoticed. Refusing the combination was considered and
rejected: it would remove a working capability (deploy repository X into folder
Y) to fix a defect that is not there.
