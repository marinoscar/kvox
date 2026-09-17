# Runbook: Deploy to a VPS

This runbook covers taking a single Ubuntu or Debian VPS from nothing to a
running, migrated, seeded, HTTPS-served deployment of this application using
`kvox deploy`, and keeping it current afterward. It is the operator-facing
companion to [`docs/specs/vps-deploy.md`](../specs/vps-deploy.md): that
document explains why `kvox deploy` is built the way it is (why the CLI never
dials out over SSH, why TLS is terminated by a shared container proxy instead
of per-app, why there is no `db` service, what was rejected and why — §18 in
particular is what corrected the original design against a real server); this
one tells you what to actually run, in order, on a real box. Read the spec
first if something here doesn't make sense — it almost certainly has the
"why."

The server is operated as `root`; every command below is written for a root
shell and none of them use `sudo`. Nothing in this runbook is ever edited by
hand in a text editor — every file `kvox deploy` writes (the `.env`, the
vhost, the cron entry) is written by the CLI, and the one place you type
values is the wizard's own prompts.

Source of truth for every claim below:

- `apps/cli/src/deploy/layout.ts` — the app-folder layout, `--apps-root`/
  `--name`/`--root`, and why two apps on one box need separate compose
  project names.
- `apps/cli/src/deploy/checks/` — the ~33 doctor checks (`host.ts`,
  `github.ts`, `database.ts`, `dns.ts`, `tls.ts`), run standalone by `doctor`
  and as the required-only preflight of `install`/`update`.
- `apps/cli/src/deploy/wizard/steps.ts` — the install wizard's steps, in the
  order the CLI and the TUI both render them.
- `apps/cli/src/deploy/install.ts` / `update.ts` — the install and update
  pipelines.
- `apps/cli/src/deploy/proxy.ts` — the shared, containerized reverse proxy:
  vhost rendering, `docker run certbot/certbot` issuance, `docker exec`
  validate/reload, and the ACME self-probe.
- `apps/cli/src/deploy/deploy-info.ts` and
  `apps/api/src/about/deploy-info.schema.ts` — the deployment record the CLI
  writes and the API reads; the full schema is
  [`docs/specs/vps-deploy.md` §19](../specs/vps-deploy.md#19-the-deploy-infoinfojson-schema).
- `apps/cli/bootstrap-vps.sh` — the fresh-server bootstrap script.
- `apps/cli/README.md`, section
  ["Deploying to a server"](../../apps/cli/README.md#deploying-to-a-server) —
  the full command and flag reference this runbook assumes you have open
  alongside it; this runbook does not repeat every flag.
- `.github/workflows/deploy-e2e.yml` — the **Deploy end-to-end (issue #118)**
  CI job, described in "What backs these claims" below.

## What backs these claims

The full pipeline is exercised by CI on every change that touches it: the
**Deploy end-to-end (issue #118)** workflow
(`.github/workflows/deploy-e2e.yml`) runs `kvox deploy install`,
`kvox deploy update --check` and `kvox deploy update` against a real Docker
daemon and a real PostgreSQL service container, with `--skip-proxy` (a CI
runner has no public DNS to prove routing against, so the proxy/certificate
half is out of scope for that job specifically — the vhost rendering has its
own snapshot test instead). It runs on every pull request and push touching
`apps/cli/src/deploy/**`, `infra/compose/**` or the API/web Dockerfiles, and
nightly. Treat a real install's first run on a new box as the first exercise
of the proxy/certificate half specifically, and lean on `doctor` and
`--staging` (section 8) accordingly.

---

## 1. Prerequisites

`kvox deploy doctor` checks all of the following, and running it is the
intended first step — before you've written a line of configuration, before
you've touched the shared proxy, before anything. Don't hand-verify this list
yourself; let doctor do it, and fix whatever it reports.

- An Ubuntu or Debian VPS you operate as `root` (directly, or over SSH with
  root access).
- Docker Engine, with the **Compose v2 plugin** (`docker compose`, not the
  standalone `docker-compose` v1 binary — see the troubleshooting table).
- The `devnet` external Docker network. `install` creates it for you if it's
  missing (`docker network create devnet`); nothing else needs it created by
  hand.
- git and Node.js **>= 20** on the server, to clone the repository and build
  `kvox`. The bootstrap script (section 2) installs both if they're missing.
- The **GitHub CLI** (`gh`), installed and logged in
  (`gh auth login --hostname github.com --git-protocol https`). `install`/
  `update` clone and fetch over HTTPS using `gh`'s own stored token — there
  is no SSH key or deploy token anywhere in this pipeline. A remote that
  isn't on `github.com` skips this requirement and uses plain git.
- A shared reverse proxy container at `/opt/infra/proxy`, with
  `nginx/conf.d` and its ACME `webroot/` both writable. If this is the first
  app ever deployed to this box, `install` bootstraps it for you; if a
  different app got there first, it already exists and `install` reuses it.
  There is no host nginx and no host certbot anywhere in this pipeline —
  only `docker exec`/`docker run` against that container (section 8).
- A DNS **A record** for your domain, already pointing at this server's
  public IP, before you run `install` — the certificate can't be issued
  otherwise, and a failed issuance spends real rate-limit budget (section
  8).
- An **external PostgreSQL** server, reachable from this server, that you
  control the credentials for. This application ships no `db` service —
  `base.compose.yml` deliberately has none — so you are responsible for
  standing one up (managed or self-hosted) before you install. The
  **database itself** is no longer a hard prerequisite the way the server is:
  if it doesn't exist yet, the install wizard's Database step now offers to
  run `CREATE DATABASE` for you, against the same credentials, once they've
  authenticated (section 3.2). That only works when the supplied role may
  create databases — a managed provider that denies it is the ordinary case,
  not a failure of this feature — so creating the database yourself first, or
  granting `CREATEDB`, remains the safer default if you'd rather not depend on
  it.
- The **`vector` extension (pgvector)** available on that server — see
  section 3.1. Doctor reports it as `pgvector available`, and it is a
  *required* check, because the migration that creates the semantic-search
  tables cannot run without it.
- Google OAuth credentials whose **redirect URI matches
  `https://<domain>/api/auth/google/callback`** — the exact domain you're
  about to deploy under. The wizard prints this exact URI when it asks for
  the credentials, so you never have to derive it yourself.

```bash
kvox deploy doctor
kvox deploy doctor --domain app.example.com
```

Nothing is installed, written, or started by `doctor` — it's read-only, so
it's safe to run against a production server at any time, not just before a
first install. Run it plain first; add `--domain` once you know what domain
you're deploying to, which turns on the DNS and certificate checks.

## 2. Fresh server in three commands

For a brand-new box, [`bootstrap-vps.sh`](../../apps/cli/bootstrap-vps.sh)
does everything up through a first `doctor` run and opens the interactive
menu. From a fresh root shell on an Ubuntu or Debian server that already has
Docker:

```bash
gh auth login --hostname github.com --git-protocol https
gh repo view <owner>/<repo> --json name && curl -fsSL "$(gh api repos/<owner>/<repo>/contents/apps/cli/bootstrap-vps.sh --jq .download_url)" -o /tmp/bootstrap-vps.sh
bash /tmp/bootstrap-vps.sh --repo <owner>/<repo>
```

For a **public** repository, the plain raw URL works with nothing installed
first:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/apps/cli/bootstrap-vps.sh -o /tmp/bootstrap-vps.sh
bash /tmp/bootstrap-vps.sh --repo <owner>/<repo>
```

**Verify:** the script prints each of its six steps before running it and
checks the result after — `id -u`/`/etc/os-release`/`docker compose version`
preconditions, `gh` install + `gh auth login` + `gh auth setup-git`, Node.js
(installs Node 22 from NodeSource with a `[y/N]` prompt if missing or
older than 20; `--yes` answers for you), cloning this repository to
`/opt/infra/cli/<repo>` and building `kvox` onto `/usr/local/bin` (verified
with `kvox --version`), creating `/opt/infra/apps`, then a read-only
`kvox deploy doctor --skip-proxy` (its exit code is reported, not fatal) and
either the interactive menu or, with `--no-tui`, the exact next command to
run. It's idempotent — re-running it is a no-op except for `--update`, which
pulls and rebuilds the CLI checkout itself. The full flag table and the
script's own six-step breakdown are in
[the CLI README](../../apps/cli/README.md#fresh-server-in-three-commands);
this is the operator-facing shortcut, not a second copy of that reference.

Skipping the script means doing its steps 2–5 yourself: clone your repository,
`npm install --workspace=cli && npm run build --workspace=cli`, put
`apps/cli/dist/cli.js` somewhere runnable, `mkdir -p /opt/infra/apps`, then
continue at section 3 below.

## 3. Installing for the first time

`kvox deploy` has no SSH client and never dials out to a server on your
behalf — you're already on the VPS (via the bootstrap script or your own
SSH session), and everything below runs **on the VPS**.

1. **Run `doctor`** (section 1) and fix everything it reports before going
   further. A required failure here is cheaper to fix now than mid-install.

2. **Run `install`:**

   ```bash
   kvox deploy install --domain app.example.com
   ```

   This is interactive by default, in nine steps, in this order — each
   verified before the next opens, so a wrong answer is caught immediately
   instead of fifteen questions later:

   | Step | Asks for | Verified before moving on |
   |---|---|---|
   | Domain | The public hostname (`APP_URL` and the OAuth callback are derived from it) | `dns-resolves`, `dns-points-here` |
   | Database | `POSTGRES_HOST`/`PORT`/`USER`/`PASSWORD`/`DB`/`SSL` — nothing is pre-filled for the host | `database-reachable`, `database-credentials`, `database-exists` (offers to `CREATE DATABASE` if it's the one thing missing — section 3.2), `database-privileges`, `database-vector-extension` |
   | Secrets | `JWT_SECRET`, `COOKIE_SECRET`, `SECRETS_ENCRYPTION_KEY` — generated with a CSPRNG unless you paste your own | — |
   | Google OAuth | `GOOGLE_CLIENT_ID`/`SECRET`/`CALLBACK_URL` — the exact redirect URI is printed first | `google-oauth-credentials`: a client id missing `.apps.googleusercontent.` fails outright; one on a reserved TLD (a well-formed placeholder) warns and skips Google entirely; otherwise the pair is presented to Google's own token endpoint with a bogus authorization code — `invalid_client` fails (not a real pair), `invalid_grant` passes (it is). A pass proves the credentials are real, not that login will work: a secret can't be fully exercised without a browser round-trip, and redirect-URI registration isn't checkable from here. Google being unreachable warns rather than fails |
   | Administrator | `INITIAL_ADMIN_EMAIL` — also the certificate registration address unless `--email` overrides it | — |
   | Object storage | S3-compatible storage keys, optional — blank skips it | a reachability probe, as a warning only |
   | Resources | The loopback port, job worker slots, and container memory limits — each suggested from this server's own CPU/RAM, shown with its reason, and editable | — |
   | Everything else | Every remaining `.env.example` key not already asked, only with `--all` | — |
   | Review | The full set of answers, before anything is written | — |

   The full pipeline, in order, is: preflight → the `devnet` network →
   `gh auth setup-git` → checkout → environment (the wizard above) →
   validate-environment (the database checks) → build → migrate → seed →
   start → wait for `/api/health/ready` → publish (prove the domain routes
   here, issue the certificate, write the vhost) → an external HTTPS
   verification, printing each step's result as it completes.

   Everything lands under `/opt/infra/apps/<name>/`, where `<name>` defaults
   to the repository's own name and doubles as the docker compose **project**
   name — this is what keeps a second app on the same box from replacing the
   first app's containers. Pass `--name <app>` to choose it explicitly, or
   `--root <dir>` to name the full path outright.

3. **If it fails partway through**, fix whatever it reported and run the
   *same command again* — `install` is idempotent, and each step is safe to
   re-run. Add `--resume` to skip straight to the step that failed rather
   than re-checking everything before it.

4. **Once it succeeds**, do not treat a clean `install` as "the site is
   live and correct" until you've done section 4 — the seed does not create
   anyone who can log in.

For a scripted or first-time-nervous install, add `--staging` (section 8)
and/or `--non-interactive --answers-file <path>` (which fails, listing
what's unresolved, instead of prompting — the domain may be given in the
file as `APP_DOMAIN`).

Full flag reference and exit codes: [`apps/cli/README.md`, "Deploying to a
server"](../../apps/cli/README.md#deploying-to-a-server).

### 3.1 pgvector, before you install

Semantic search stores embeddings in a `vector` column, so the migration that
creates its tables runs `CREATE EXTENSION IF NOT EXISTS vector`. `vector` is
not a trusted extension in PostgreSQL 16: creating it needs a superuser (or a
role your provider has explicitly permitted). Doctor asks about it up front —
as `pgvector available` — so you find out now rather than mid-migration, with
the repository already cloned and `.env` already written.

What doctor reports, and what to do:

| Result | What it found | What to do |
|---|---|---|
| `pass` | The extension is already installed, or it is available and your role may install it | Nothing. |
| `warn` | It is available, but the connecting role is not a superuser | Probably fine — some providers permit it anyway. If the migration then fails, run the command below once. |
| `fail` | The server offers no `vector` extension at all | Install the package, then the extension, before you install the app. |

The remedy, in the order you have to do it in:

```bash
# 1. The server-side package, on the machine PostgreSQL runs on.
#    Debian/Ubuntu (match your server's major version):
apt install postgresql-16-pgvector
#    RDS, Cloud SQL and Azure Database for PostgreSQL ship it already —
#    there it only needs enabling, not installing.

# 2. The extension, in your application database, as a superuser:
psql -h <POSTGRES_HOST> -p <POSTGRES_PORT> -d <POSTGRES_DB> -c 'CREATE EXTENSION vector;'
```

This blocks semantic search only — nothing else in the application uses the
extension. `kvox deploy update` checks it too, not just `install`: an
already-running deployment is exactly the one that *receives* the migration. The migration is deliberately **not** softened to skip it when it
is missing: a per-deployment "some databases have these tables and some
don't" is not a state anyone can diagnose later, whereas this refusal is one
command to fix. See
[`docs/specs/vps-deploy.md` §9.1](../specs/vps-deploy.md#91-database-vector-extension-the-pgvector-preflight-issue-179-epic-165).

### 3.2 Creating the database, if it isn't there yet (issue #238)

The Database step above still expects the database itself to already exist —
the credentials, the server and the network path are always the operator's
to provide, and that hasn't changed. What's new is that when `database-exists`
fails because the database is genuinely absent (not a wrong host, not a
rejected password — those still fail exactly as before), the wizard offers a
shortcut instead of only printing a remedy to run by hand:

```
The database does not exist yet: appdb on db.example.com:5432 as appuser.
The credentials above already authenticated against this server.
Create the database appdb now? (Y/n)
```

Saying yes runs one statement, `CREATE DATABASE`, against the same server the
credentials just authenticated against, then re-runs the step's checks — so
`database-privileges` and `pgvector available`, both of which had nothing to
check a moment ago, answer for real. Saying no leaves things exactly as they
were: the step fails, the same `createdb -h ... -U ... <db>` remedy prints,
and you run it yourself in another terminal before re-entering the step.

This only works when the supplied role has `CREATEDB` (or is a superuser).
Most managed PostgreSQL offerings — RDS, Cloud SQL, Azure Database for
PostgreSQL — grant it to the role you create by default; a shared or
more tightly locked-down role may not have it, and that's an ordinary refusal,
not a bug: the wizard reports it and hands you the same `createdb` command,
or the one-line grant (`ALTER ROLE <user> CREATEDB;`) an administrator can run
instead.

Nothing here creates a role, an extension, or anything beyond that one empty
database — the pgvector step above still runs afterward, on its own, exactly
as it would have if the database had existed from the start. Under
`--non-interactive` there's nobody to ask, so nothing is created unless you
pass `--create-database`; with a terminal that same flag only changes the
default answer shown above, and you're still asked. Full design and the
rejected alternatives:
[`docs/specs/vps-deploy.md` §20](../specs/vps-deploy.md#20-creating-the-database-on-request-only-issue-238).

## 4. After install: the first login (do this before anything else)

**A successful `install` does not create an admin user, or any user at
all.** The seed (`apps/api/prisma/seed.ts`) writes an **allowlist row** for
`INITIAL_ADMIN_EMAIL` — the same mechanism the "Access Control: Email
Allowlist" section of the root `CLAUDE.md` describes for local development —
and nothing more. Nobody is an admin, and nobody has an account, until that
exact email address completes Google OAuth login at `https://<domain>`.

1. Open `https://<domain>` in a browser.
2. Log in with Google, using the exact address configured as
   `INITIAL_ADMIN_EMAIL` during the environment wizard.
3. This creates the account and grants it the **admin** role, the same
   first-login bootstrap local development relies on.
4. From there, use the admin panel (`/admin/settings/users`, Allowlist tab)
   to add every other address that should be able to log in — the allowlist
   restricts access to pre-authorized emails only, and `INITIAL_ADMIN_EMAIL`
   is the only address the seed adds automatically.

**Verify:** `https://<domain>` loads over a trusted certificate (not the
`--staging` one, if you used it) and the admin panel shows the account you
just created.

## 5. Status and about

Two different questions, two different commands.

```bash
kvox deploy status
```

**Is it up, and is it current?** Container state, an immediate
`/api/health/ready` poll, a fetch-and-compare against the remote (bounded to
ten seconds, never cloning — rendered as an `Update: N commits behind` line),
and migration state reported **as its own fact**, never inferred from the
health probe.

**`/api/health/ready` returning 200 only proves the app can run `SELECT 1`
against the configured database.** It passes against a completely empty,
unmigrated database exactly as readily as a fully migrated one, because
that's all the underlying check does. This is why `status` reports
"Migrations: up to date" as its own line, and why the install/update
pipelines treat their own migrate step's exit code — not the later health
wait — as the only real evidence a migration ran.

```bash
kvox deploy status --domain app.example.com   # also checks external HTTPS
kvox deploy status --json || alert 'deployment unhealthy'
```

Exit codes: `0` serving and current, `1` installed but unhealthy, `2`
nothing installed under `--apps-root` (or at `--root`) — the distinct exit
matters for monitoring, since "nothing is installed here" and "something is
installed and broken" need different alerts.

```bash
kvox deploy about
```

**What is deployed, when, by whom, and on what.** Three blocks — Application
(the running process's own version, Node, uptime, PostgreSQL version and
applied migration count, read live from `GET /api/admin/about`), Deployment
(revision, ref, repository, domain, when installed/last updated, by which
command, the previous revision, and the same `Update: N commits behind`
line), and Server (hostname, OS, kernel, CPU, memory, disk, Docker/Compose/
Node **as recorded at deploy time**, with any live value that has changed
since shown beside it, e.g. `3.8 GiB (now 7.6 GiB)`). `--check` fetches the
remote first so the Update line is current; without it, it reports what was
last recorded. It is **informational, never a health verdict** — a stopped
API or an unreachable remote is reported inline and still exits `0`; use
`status` for the check a monitor should act on.

**Verify:** `kvox deploy about --json | jq .deployment.commitSha` matches
`git -C /opt/infra/apps/<name>/repo rev-parse HEAD` on the server.

## 6. Updating

```bash
kvox deploy update --check
```

**Always run `--check` first.** It fetches and prints `current <sha> ->
latest <sha>, N commits behind` with the commit subjects — or `already up to
date` — records the result in `deploy-info/info.json` (what `about` and the
web Console's About page both read), and exits `0` either way, **with
nothing checked out, built, or written to the state file.** Read what it
would apply before you apply it.

```bash
kvox deploy update
```

Fetches, and if the resolved ref's commit has moved, prints the same block
`--check` would, then rebuilds, migrates, re-seeds, restarts, and
re-verifies. Its preflight checks the database first — reachable,
credentials, the database exists, and `pgvector` (section 3.1) — because the
pipeline migrates a few steps later; an update that can't use the database
now stops before it stops the API container, not inside `migrate`. It refuses outright if nothing is installed at `--apps-root`/
`--root` — run `install` first. **If the revision hasn't moved, `update`
exits `0` and does nothing else** — no rebuild, no restart, no seed — which
is what makes it safe to run unattended:

```cron
# Check nightly at 03:00; does nothing if there's no new revision
0 3 * * * cd /opt/infra/apps/<name> && kvox deploy update --non-interactive >> /var/log/kvox-update.log 2>&1
```

Two behaviors surprise people who've operated the shell-script deployments
this replaces, and both are deliberate:

**The seed re-runs by default, on every update.** `apps/api/prisma/seed.ts`
is entirely upserts, and re-running it is the *only* way a permission or role
row a newer release adds actually reaches a server that was installed
earlier. Skip it only if you've hand-edited seeded rows and don't want them
upserted back — `--skip-seed`.

**There is no automatic rollback.** A partly-applied database migration
can't be safely undone by checking out the old application code — that's a
decision that needs a human, not a heuristic. On failure, `update` prints the
previous revision and the exact command to redeploy it:

```bash
kvox deploy update --ref <previous-sha> --force
```

**Verify:** `kvox deploy status` reports healthy and current, and
`kvox deploy about --json | jq .deployment.commitSha` matches the new `HEAD`.

Full flag reference: [`apps/cli/README.md`, "Deploying to a
server"](../../apps/cli/README.md#deploying-to-a-server).

## 7. Certificates and the renewal cron

Certificates live behind the shared proxy **container**, never on the host.
Issuance during `install` runs `docker run --rm certbot/certbot certonly
--webroot`, validated and reloaded with `docker exec <proxy-container> nginx
-t` / `nginx -s reload` — there is no host `certbot` and no host `nginx`
anywhere in this pipeline.

```bash
kvox deploy certs status
```

Lists every certificate behind the proxy with its expiry. Exits `0` while
all are valid, `1` when one has expired, `2` when there are none.

```bash
kvox deploy certs renew
kvox deploy certs renew --dry-run   # rehearse only; nothing written or reloaded
```

Runs `docker run --rm certbot/certbot renew` against the proxy's own
`letsencrypt/`/`webroot/` mounts; certbot itself decides what's due (within
30 days of expiry), and the proxy is `docker exec`-reloaded **only** when
something was actually renewed — a scheduled run on a quiet day touches
nothing.

```bash
kvox deploy certs renew --install-cron
```

Writes `/etc/cron.d/kvox-certs-<name>` — `root`, twice daily at a minute
derived from the app's name (so several apps on one box don't all fire
together), running `certs renew --all` so one cron entry serves every app
behind the shared proxy. `install` writes this same file automatically the
first time it issues a certificate; `doctor`'s `certificate-renewal` check
recognizes it (or `certbot.timer`, or any cron line mentioning `certbot`/
`renew`) as evidence something is renewing certificates on this box.

**Verify:** `crontab -l` inside `/etc/cron.d/kvox-certs-<name>` shows the
entry, and `kvox deploy doctor --domain <domain>`'s `certificate-renewal`
check passes.

## 8. Using Let's Encrypt staging while you work out the setup

```bash
kvox deploy install --domain app.example.com --staging
```

`--staging` requests a certificate from Let's Encrypt's **staging**
environment instead of production. The certificate it issues won't be
trusted by a real browser, but the whole rest of the pipeline — the ACME
self-probe, webroot, vhost rendering, `nginx -t` validation, reload — runs
identically, so it's the right way to work out a first install's kinks.
Before spending any rate-limit budget at all, `install` writes a nonce under
the proxy's webroot and fetches it over
`http://<domain>/.well-known/acme-challenge/…` — the exact path the real
HTTP-01 challenge takes — and fails, naming the domain and what answered
instead, if the DNS record is wrong or the proxy isn't routing (see the
troubleshooting table).

A **failed** production issuance spends real, shared rate-limit budget: five
failures per hostname per hour, and 50 certificates per registered domain
per week, shared with *every* subdomain on that server, not just this app.
Use `--staging` until `doctor --domain <yours>` and a full `install
--staging` both come back clean, then run `install` again without the flag —
`install` skips issuance entirely when a usable certificate already exists,
so re-running costs nothing once staging already worked.

## 9. The layout on disk, and what's secret

```
/opt/infra/apps/<name>/
  repo/                       the CLI's own clone
  logs/                       the run journal (human .log + machine .jsonl)
  data/                       bind-mounted persistent data
  deploy-info/info.json       what the running application reads about itself
  .env                        the real environment file, 0600
  .appctl-deploy.json         the CLI's own state file, 0600
```

- **`.env`** (0600) is the canonical environment file. `repo/infra/compose/.env`
  is a *relative* symlink to it (`../../../.env`), so `rm -rf repo` on a
  reinstall never takes your secrets with it, and the link keeps working
  wherever the app folder ends up moved or bind-mounted. **Secret.**
- **`.appctl-deploy.json`** (0600) is the CLI's own deployment record — never
  mounted anywhere, refused outright if a newer CLI wrote it and this one
  doesn't understand the version. The filename keeps the pre-rename `appctl`
  spelling on purpose: it's read back off live servers, and renaming it would
  make every existing deployment invisible to `status`/`update`. **Secret**
  by construction, though it holds no credentials itself — treat it as you
  would any file that proves what's installed where.
- **`deploy-info/info.json`** (0644) is a **second, non-secret** file the CLI
  writes on every `install`/`update` (and refreshes `remote` on `update
  --check`/`status`) specifically so the running API can answer `GET
  /api/admin/about` with no database write and no restart — bind-mounted
  **read-only** into the `api` container at `/app/deploy-info`. **Not
  secret** — full schema:
  [`docs/specs/vps-deploy.md` §19](../specs/vps-deploy.md#19-the-deploy-infoinfojson-schema).
- **`repo/`** and **`data/`** hold no secrets of their own; `repo/` is an
  ordinary git checkout of the application, and its own `.env` is the symlink
  above.
- **`logs/`** (0600, both files) holds the run journal. Every value the CLI
  knows to be a secret is **redacted** from it before a single byte reaches
  disk — see section 10.

**Verify:** `stat -c '%a %n' /opt/infra/apps/<name>/.env
/opt/infra/apps/<name>/.appctl-deploy.json` both read `600`; `stat -c '%a %n'
/opt/infra/apps/<name>/deploy-info/info.json` reads `644`.

## 10. Logs

Every `doctor`, `install`, `update`, and `certs renew` run writes two files
under `<deployRoot>/logs/`: a timestamped human-readable `.log` and a
matching machine-readable `.jsonl` (one JSON object per executed subprocess:
`argv`, `cwd`, `exitCode`, `durationMs`, captured `stdout`/`stderr`,
`startedAt`). Both are written mode `0600`, and only the newest ten runs are
kept — older ones are pruned at the start of each new run.

**Every value the CLI knows to be a secret is redacted from both files
before a single byte reaches disk** — whether you typed it during the wizard
or the wizard generated it. This is what makes it safe to attach a `.log` to
a support request or a GitHub issue without a second pass to scrub it by
hand. The honest boundary: redaction is a substring match against *known*
secret values (the ones `env-metadata.ts` marks `secret: true`), not a
pattern-based scan of the output — a value your fork's own `.env.example`
introduces with no corresponding metadata entry won't be recognized as a
secret and won't be redacted. If you add a new secret-shaped variable to a
fork, add a `secret: true` entry for it in `env-metadata.ts` so both masking
and log redaction pick it up.

## 11. Deploying a fork

You don't need to change anything in this CLI to deploy a fork. The
repository URL and ref are read from your own checkout's git remote (a fork
using `master` or `develop` as its default branch works with no `--ref`
needed), and the environment wizard's questions are parsed structurally from
*your fork's own* `infra/compose/.env.example`, not a list of field names
hardcoded into the CLI. In practice: clone your fork on the VPS, build
`kvox` from *that* checkout, and run `deploy install` from inside it — it
deploys your fork, at your fork's default branch, asking about your fork's
own environment variables, automatically.

## 12. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `install`/`doctor` fails on `gh-authenticated` | `gh auth status` is failing — the GitHub CLI isn't logged in, or its token expired. | Run `gh auth status` directly to see the reason, then `gh auth login --hostname github.com --git-protocol https`. `install`/`update` also run `gh auth setup-git` for you afterward, so plain `git` immediately picks up the same credential. |
| The install wizard shows only `Welcome › Domain › Resources › Review` — no Database, Secrets, OAuth, Admin or Storage step — and Review refuses to install rather than offering a confirm dialog | None of the wizard's three ways to read `infra/compose/.env.example` produced anything: the remote read failed (the Welcome screen names the reason — `gh` not installed, not logged in, no access to the repository, timed out, or an empty file), no checkout of the repository being deployed exists on this server or is the one the CLI is running from, and no template was bundled when this CLI was installed. Installing anyway would take the database, secrets and OAuth client from template defaults, so the wizard refuses instead — see [`apps/cli/README.md`](../../apps/cli/README.md#deploying-a-fork) and [`docs/specs/vps-deploy.md`](../specs/vps-deploy.md#61-where-the-template-file-comes-from-and-why-the-order-matters-issues-229-230-234-236). | Either fix the reason the Welcome screen gave for `gh` and re-open the wizard — `gh auth login --hostname github.com --git-protocol https` as **the same user running `kvox`**: `gh`'s login is per-user, so `sudo kvox` needs root's own `gh auth login`, separate from any account you logged in as yourself — or reinstall the CLI from inside a checkout of the repository actually being deployed (`sudo bash install.sh` from that checkout, or `KVOX_SRC=<path> sudo bash install.sh`) so `install.sh` bundles that repository's own template and the wizard needs no network call for it. |
| `install`/`doctor` fails on `proxy-container` | No container publishes port 443, and no container named `proxy-nginx` (the default) is running. | Start the shared proxy: `cd /opt/infra/proxy && docker compose up -d`. If it runs under a different name, pass `--proxy-container <name>`. |
| You said yes to creating the database (section 3.2), but it reports `<user> may not create databases on this server` instead | The supplied role has no `CREATEDB` — the ordinary case on a managed or shared PostgreSQL instance, not a bug in the wizard. | Either create the database yourself with the `createdb -h ... -U ... <db>` command the wizard prints alongside the refusal, or have an administrator grant it first: `ALTER ROLE <user> CREATEDB;`, then answer the prompt again (or re-run `install`). Nothing was created or changed by the attempt itself. |
| Certificate issues, but the proxy fails to **reload** afterward even though `nginx -t` passed | The vhost binds `[::]` (IPv6) listeners, and this host — or the proxy container — has no IPv6 configured. `nginx -t` doesn't catch this; only the reload does, and it fails for every site behind that proxy, not just this one. | Enable IPv6 on the host, or re-render the vhost without it: `kvox deploy install --no-ipv6` (or `doctor`'s `proxy-ipv6` check names the same remedy ahead of time). |
| Certificate issuance fails with a message naming the domain and "did not answer" or "answered ... instead of the probe" | The ACME self-probe — a nonce written under the proxy's own webroot and fetched back over `http://<domain>/.well-known/acme-challenge/…` — didn't get its own nonce back, so Let's Encrypt's real HTTP-01 challenge would fail identically. The DNS record doesn't point here, or port 80 isn't reaching the proxy. | `doctor --domain <domain>` runs the same `dns-resolves`/`dns-points-here` checks standalone, naming both addresses (what the domain resolves to, and this server's own) so a stale record or a CDN in front of it is obvious. Nothing was requested from Let's Encrypt — the self-probe runs *before* any rate-limit budget is spent. |
| `install` fails creating or using the `devnet` Docker network | The network doesn't exist and something prevented `install` from creating it (a permissions issue, or it exists with an incompatible configuration from an unrelated project). | Create it directly: `docker network create devnet`, then re-run. `doctor`'s `docker-network-devnet` check reports the same remedy. |
| Two apps on the same box interfere with each other — one's `up -d` seems to replace the other's containers, or they can't both bind their proxy vhost | They share a compose **project name** (a deployment from before issue #119 has no `--name` recorded at all, and every such deployment on a box shared the single project name `compose`). | Give each app an explicit `--name` under the shared `--apps-root` (`kvox deploy status`/`update`/`doctor` all default to *the one* app installed there, and refuse — listing them — the moment there's more than one). Containers land as `<name>-api-1`, `<name>-web-1`, `<name>-nginx-1`; two different names never collide. |
| `docker compose` commands fail as if the command doesn't exist, or behave unexpectedly | The standalone `docker-compose` **v1** binary is installed instead of the Compose **v2 plugin** (`docker compose`, no hyphen). | `doctor`'s `docker-compose-v2` check catches this directly. Install the v2 plugin per Docker's current documentation; v1 is not a supported substitute anywhere in this pipeline. |
| Login redirects loop, or Google rejects the callback | `GOOGLE_CALLBACK_URL` disagrees with the domain you're actually serving. | It's **derived automatically** from the domain you gave during install (`https://<domain>/api/auth/google/callback`) unless you deliberately overrode it in the wizard's `--all` review. If you're seeing this, check the deployed `.env` and either fix it there or re-run the wizard for that key. |
| `install`'s Google OAuth step fails on `google-oauth-credentials` | Either the client id doesn't contain `.apps.googleusercontent.` at all — a project id or an API key pasted into the wrong field — or it does, but the pair Google was asked about isn't real, most often a secret copied from a different, or since-rotated, OAuth client. | Re-copy both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the *same* client's own page in Google Cloud console. A well-formed id on a reserved TLD (RFC 2606 `.invalid`/`.test` — a deliberate placeholder) only **warns** and skips the check against Google entirely; Google being simply unreachable also **warns** rather than fails. Neither blocks the install. |
| Repeated `install` attempts start failing with a rate-limit error from Let's Encrypt | You burned the hourly/weekly certificate budget on earlier failed attempts (section 8). | Wait — retrying immediately makes it worse. Use `--staging` for everything except the attempt you actually intend to keep. |
| `install`/`doctor` reports the loopback port is already in use, by something that isn't this deployment | Another app on the same VPS is already bound to that port. | Pick a different port for this app with `APP_BIND_PORT` in its `.env` (or `--port` during install), or stop whatever's holding the port. `doctor`'s `bind-port-free` check is written not to flag this app's own already-running nginx as a conflict. |
| `status`/health checks show the API healthy, but the site itself returns a bad gateway | The web container's own nginx and the shared proxy's upstream port have drifted out of agreement. | This is why `status` probes the frontend **separately** from `/api/health/ready` — an API-only health check would show green while the site is down. If you've modified `apps/web/nginx.conf` or `infra/nginx/nginx.conf` in a fork, check that they still agree on the port. |

## Summary checklist

- [ ] `kvox deploy doctor` run clean (or only recommended warnings) before starting
- [ ] `gh auth status` passes and the repository being deployed is visible to that account
- [ ] DNS A record for the domain points at this server, confirmed by `doctor --domain <domain>`
- [ ] Google OAuth redirect URI matches `https://<domain>/api/auth/google/callback` exactly
- [ ] External PostgreSQL reachable, with credentials `doctor`/`install`'s environment validation accepts (the database itself can be created by the wizard on request — section 3.2 — if it doesn't exist yet)
- [ ] First install run with `--staging` if this is a new domain or a first attempt on this server
- [ ] `kvox deploy install --domain <domain>` completed, including the external HTTPS verification step
- [ ] Logged in at `https://<domain>` as `INITIAL_ADMIN_EMAIL` — this, not the seed, is what creates the admin account
- [ ] Additional users added to the allowlist from the admin panel
- [ ] `kvox deploy status` reports healthy and current; `kvox deploy about` shows the expected revision
- [ ] Renewal cron installed (`kvox deploy certs renew --install-cron`, or it was written automatically on first issuance) and `doctor`'s `certificate-renewal` check passes
- [ ] `kvox deploy update` scheduled (cron or otherwise) if this server should track new releases automatically
- [ ] `<deployRoot>/logs/` reviewed for anything unexpected if any step above didn't go as described
