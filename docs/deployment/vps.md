# Runbook: Deploy to a VPS

This runbook covers taking a single Ubuntu VPS from nothing to a running,
migrated, seeded, HTTPS-served deployment of this application using `appctl
deploy`, and keeping it current afterward. It is the operator-facing
companion to [`docs/specs/vps-deploy.md`](../specs/vps-deploy.md): that
document explains why `appctl deploy` is built the way it is (why the CLI
never dials out over SSH, why TLS is terminated by a shared proxy instead of
per-app, why there is no `db` service, what was rejected and why); this one
tells you what to actually run, in order, on a real box. Read the spec first
if something here doesn't make sense — it almost certainly has the "why."

Source of truth for every claim below:

- `apps/cli/src/deploy/checks/` — the ~27 doctor checks (`host.ts`,
  `database.ts`, `dns.ts`, `tls.ts`), run standalone by `doctor` and as the
  required-only preflight of `install`/`update`.
- `apps/cli/src/deploy/install.ts` — the install pipeline.
- `apps/cli/src/deploy/update.ts` — the update pipeline, its re-seed default,
  and why there is no automatic rollback.
- `apps/cli/src/deploy/health.ts` — what `status` reports, and the frontend
  probe kept separate from `/api/health/ready`.
- `apps/cli/src/deploy/proxy.ts` — the shared reverse proxy, vhost rendering,
  and certbot issuance (rate-limit handling included).
- `apps/cli/src/deploy/repo.ts` — resolving the repository and ref from the
  checkout's own git remote, with no fork-specific configuration anywhere.
- `apps/cli/src/deploy/journal.ts` — the run log and its redaction guarantee.
- `apps/cli/src/deploy/env-metadata.ts` — which environment variables are
  derived (`GOOGLE_CALLBACK_URL`, `APP_URL`), which are secrets, and which are
  essential.
- `infra/compose/vps.compose.yml` — the loopback-only overlay a VPS deploy
  adds on top of `base.compose.yml` + `prod.compose.yml`.
- `apps/api/prisma/seed.ts` — the idempotent seed `install` and `update` both
  run; what it writes and, just as important, what it does not.
- `apps/api/src/health/health.controller.ts` — `/api/health/ready`, and why a
  green result there is not evidence a migration ran.
- `apps/cli/README.md`, section "Deploying to a server" — the command
  reference (flags, exit codes) this runbook assumes you have open alongside
  it.

**The full install has not been run end to end against a real VPS.** The
environment this was built in has no Docker daemon, so there has been no
opportunity to run `appctl deploy install` against an actual server with real
DNS and a real Let's Encrypt certificate. What backs the claims in this
document is: the unit test suite for every module listed above (including the
doctor checks, the pipelines, and the proxy/certificate logic), `docker
compose -f base.compose.yml -f prod.compose.yml -f vps.compose.yml config`
validating cleanly, and a real `appctl deploy doctor` run. Treat the first
real install on a new box as the first true end-to-end exercise of this path,
and lean on `doctor` and `--staging` (section 8) accordingly.

---

## 1. Prerequisites

`appctl deploy doctor` checks all of the following, and running it is the
intended first step — before you've written a line of configuration, before
you've touched the shared proxy, before anything. Don't hand-verify this list
yourself; let doctor do it, and fix whatever it reports.

- An Ubuntu VPS you have root SSH access to.
- Docker Engine, with the **Compose v2 plugin** (`docker compose`, not the
  standalone `docker-compose` v1 binary — see the troubleshooting table).
- git and Node.js on the server, to clone the repository and build `appctl`.
- A shared reverse proxy at `/opt/infra/proxy`, with `nginx/conf.d` and its
  ACME webroot both writable. If this is the first app ever deployed to this
  box, `install` bootstraps this for you; if a different app got there first,
  it already exists and `install` reuses it.
- certbot, for Let's Encrypt certificate issuance via the proxy's webroot.
- A DNS **A record** for your domain, already pointing at this server's
  public IP, before you run `install` — the certificate can't be issued
  otherwise, and issuance failures spend real rate-limit budget (section 8).
- An **external PostgreSQL** database, reachable from this server, that
  already exists. This application ships no `db` service — `base.compose.yml`
  deliberately has none — so you are responsible for standing one up
  (managed or self-hosted) before you install.
- Google OAuth credentials whose **redirect URI matches
  `https://<domain>/api/auth/google/callback`** — the exact domain you're
  about to deploy under, not a placeholder.

```bash
appctl deploy doctor
appctl deploy doctor --domain app.example.com
```

Nothing is installed, written, or started by `doctor` — it's read-only, so
it's safe to run against a production server at any time, not just before a
first install. Run it plain first; add `--domain` once you know what domain
you're deploying to, which turns on the DNS and certificate checks.

## 2. Installing for the first time

`appctl deploy` has no SSH client and never dials out to a server on your
behalf — you SSH in yourself, with your own credentials, and everything below
runs **on the VPS**.

1. **SSH into the VPS.**

2. **Clone the repository you want to deploy** (your fork, if you have one —
   see section 6) and build `appctl` from source:

   ```bash
   git clone <your-repo-url>
   cd <your-checkout>
   npm install --workspace=cli
   npm run build --workspace=cli
   node apps/cli/dist/cli.js deploy doctor
   ```

   You need a real git checkout here, not the standalone `appctl` the
   `curl | bash` installer in the main [CLI README](../../apps/cli/README.md)
   produces — `deploy install` reads its default repository URL and ref from
   *this checkout's own git remote* (section 6), and a standalone install has
   no remote to read. If `~/.local/bin` is already on your `PATH` from an
   earlier `appctl` install, the plain `appctl` command works the same as
   `node apps/cli/dist/cli.js` from here on; this runbook uses `appctl` for
   brevity.

3. **Run `doctor`** (as above) and fix everything it reports before going
   further. A required failure here is cheaper to fix now than mid-install.

4. **Run `install`:**

   ```bash
   appctl deploy install --domain app.example.com
   ```

   This is interactive by default: it walks you through the essential
   environment variables (database credentials, JWT/cookie secrets — offering
   to generate the ones that can be generated, Google OAuth credentials,
   `INITIAL_ADMIN_EMAIL`) with sensible defaults, then runs preflight,
   checkout, environment validation, build, migrate, seed, start, health
   wait, certificate issuance and vhost publish, and a final external HTTPS
   verification, printing each step's result as it completes. `--domain` is
   the one required flag; everything else — `--root` (default
   `/opt/infra/apps`), `--proxy-root` (default `/opt/infra/proxy`), `--port`
   (default `3535`) — has a workable default.

   For a scripted or first-time-nervous install, add `--staging` (section 8)
   and/or `--non-interactive` (which fails, listing what's unresolved,
   instead of prompting — useful once you already know every value you want
   to pass, or want a `.env` prepared ahead of time).

5. **If it fails partway through**, fix whatever it reported and run the
   *same command again* — `install` is idempotent, and each step is safe to
   re-run. Add `--resume` to skip straight to the step that failed rather
   than re-checking everything before it.

6. **Once it succeeds**, do not treat a clean `install` as "the site is
   live and correct" until you've done section 3 — the seed does not create
   anyone who can log in.

Full flag reference and exit codes: [`apps/cli/README.md`, "Deploying to a
server"](../../apps/cli/README.md#deploying-to-a-server).

## 3. After install: the first login (do this before anything else)

**A successful `install` does not create an admin user, or any user at
all.** The seed (`apps/api/prisma/seed.ts`) writes an **allowlist row** for
`INITIAL_ADMIN_EMAIL` — the same mechanism the "Access Control: Email
Allowlist" section of the root `CLAUDE.md` describes for local development —
and nothing more. Nobody is an admin, and nobody has an account, until that
exact email address completes Google OAuth login at `https://<domain>`.

If you skip this step and go looking for why the admin panel is empty or why
nobody can do anything privileged, you will not find a bug — you'll find a
correctly-installed application with no users. So:

1. Open `https://<domain>` in a browser.
2. Log in with Google, using the exact address configured as
   `INITIAL_ADMIN_EMAIL` during the environment wizard.
3. This creates the account and grants it the **admin** role, the same
   first-login bootstrap local development relies on.
4. From there, use the admin panel (`/admin/settings/users`, Allowlist tab)
   to add every other address that should be able to log in — the allowlist
   restricts access to pre-authorized emails only, and `INITIAL_ADMIN_EMAIL`
   is the only address the seed adds automatically.

## 4. Checking status and health

```bash
appctl deploy status
appctl deploy status --domain app.example.com
```

`status` reports container state, an immediate `/api/health/ready` poll, a
**separate frontend probe**, and — this is the part worth understanding, not
just running — migration state reported on its own, not inferred from the
health probe.

**`/api/health/ready` returning 200 only proves the app can run `SELECT 1`
against the configured database.** It passes against a completely empty,
unmigrated database exactly as readily as a fully migrated one, because
that's all the underlying check does. Nothing about a green readiness probe
tells you the schema is current. This is precisely why `status` reports
"Migrations: up to date" / "N pending" / "could not be determined" as its own
line, and why the install/update pipelines treat their own migrate step's
exit code — not the later health wait — as the only real evidence a
migration ran.

The frontend gets its own probe for the same kind of reason: the API can
answer every request correctly while the site itself 502s, if the web
container's own nginx and the shared proxy's upstream ever disagree about
which port to talk on (see the troubleshooting table's last row). A single
"healthy: true/false" that only checked the API would hide that class of
failure completely.

```bash
appctl deploy status --json || alert 'deployment unhealthy'
```

Exit codes: `0` serving and schema current, `1` installed but unhealthy, `2`
nothing installed at `--root`. The distinct exit `2` matters for monitoring —
"nothing is installed here" and "something is installed and broken" need
different alerts.

## 5. Updating

```bash
appctl deploy update
```

Fetches, and if the resolved ref's commit has moved, rebuilds, migrates,
re-seeds, restarts, and re-verifies. `update` refuses outright if nothing is
installed at `--root` — run `install` first.

**If the revision hasn't moved, `update` exits `0` and does nothing else** —
no rebuild, no restart, no seed. That's what makes it safe to run
unattended, for example from cron:

```cron
# Check for a new release every night at 03:00, do nothing if there isn't one
0 3 * * * cd /opt/infra/apps/repo && appctl deploy update --non-interactive >> /var/log/appctl-update.log 2>&1
```

Two behaviors are worth knowing before your first `update`, because both are
deliberate and both surprise people who've operated the shell-script
deployments this replaces:

**The seed re-runs by default, on every update.** `apps/api/prisma/seed.ts`
is entirely upserts, and re-running it is the *only* way a permission or role
row a newer release adds actually reaches a server that was installed
earlier. Skip it, and a release that ships a new permission does nothing on
your server — the feature ships, the permission doesn't exist in your
database, and the first symptom is a confusing 403 with nothing in the logs
pointing at "you needed to re-seed." The shell scripts this replaces never
re-seeded; this is a deliberate change, not an oversight. Pass `--skip-seed`
only if you've hand-edited seeded rows (a role's permission set, say) and
don't want them upserted back to their defaults.

**There is no automatic rollback.** A partly-applied database migration
can't be safely undone by checking out the old application code — that's a
decision that needs a human looking at what actually happened, not a
heuristic guessing at it. On failure, `update` prints the previous revision
and the exact command to redeploy it:

```bash
appctl deploy update --ref <previous-sha> --force
```

`--force` is what makes that command work even though the "ref" you're
moving to is technically older than what's currently checked out — without
it, `update` would see the ref hasn't "moved forward" in the way it expects
and do nothing.

Full flag reference: [`apps/cli/README.md`, "Deploying to a
server"](../../apps/cli/README.md#deploying-to-a-server).

## 6. Deploying a fork

You do not need to change anything in this CLI to deploy a fork, and that
property is worth understanding rather than just trusting.

`appctl deploy install`/`update` read the repository URL and ref from **the
checkout you ran them from** (`repo.ts` walks upward from the current
directory looking for `.git`, then reads `git remote get-url origin` and the
current branch) — not from a value hardcoded anywhere in `apps/cli`.
`--repo`/`--ref` override the detected values when you need to, but the
default is always "whatever this checkout points at." The environment
wizard's questions are parsed structurally from **your checkout's own**
`infra/compose/.env.example`, not from a fixed list of field names baked into
the CLI — rename the application, add a new secret, remove the Microsoft
OAuth block, switch your default branch to `develop`, and the wizard follows
all of it with no CLI change. The only two places a fork edits by hand are
outside `appctl deploy` entirely: the `bin` field in `apps/cli/package.json`
and `install.sh`'s default clone URL, both documented in the CLI README's
"Renaming this for a fork" section — neither is part of the deploy path.

In practice: clone your fork on the VPS (step 2 of section 2), build `appctl`
from *that* checkout, and run `deploy install` from inside it. It deploys
your fork, at your fork's default branch, asking about your fork's own
environment variables, automatically.

## 7. Logs

Every `doctor`, `install`, and `update` run writes two files under
`<deployRoot>/logs/`: a timestamped human-readable `.log` and a matching
machine-readable `.jsonl` (one JSON object per executed subprocess:
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

## 8. Using Let's Encrypt staging while you work out the setup

```bash
appctl deploy install --domain app.example.com --staging
```

`--staging` requests a certificate from Let's Encrypt's **staging**
environment instead of production. The certificate it issues won't be
trusted by a real browser, but the whole rest of the pipeline — DNS,
webroot, vhost rendering, `nginx -t` validation, reload — runs identically,
so it's the right way to work out a first install's kinks.

The reason this matters more than it might look: a **failed** production
issuance spends real, shared rate-limit budget — five failures per hostname
per hour, and 50 certificates per registered domain per week, shared with
*every* subdomain on that server, not just this one app. Burn through that
debugging a typo'd DNS record on your first attempt, and you (and anyone else
deploying to the same box) are locked out of real certificates for the rest
of the week. Use `--staging` until `doctor --domain <yours>` and a full
`install --staging` both come back clean, then run `install` again without
the flag for the real certificate — `install` skips issuance entirely when a
usable certificate already exists, so re-running costs nothing if staging
already got you a (test) one.

## 9. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Certificate issuance fails during `install` | The domain's DNS doesn't actually point at this server. | `doctor --domain <domain>` runs `dns-resolves` and `dns-points-here` specifically for this — the failure names both addresses (what the domain resolves to, and what this server's own address is) so a CDN or a stale record is obvious at a glance. |
| Login redirects loop, or Google rejects the callback | `GOOGLE_CALLBACK_URL` disagrees with the domain you're actually serving. | `GOOGLE_CALLBACK_URL` is **derived automatically** from the domain you gave during install (`https://<domain>/api/auth/google/callback`) unless you deliberately overrode it in the wizard's `--all` review. If you're seeing this, something overrode the derived value — check the deployed `.env` and either fix it there or re-run the wizard for that key. |
| Migration step succeeds, but the app can't connect to the database afterward | `POSTGRES_PASSWORD` contains a URL-reserved character (`@`, `:`, `/`, `#`). | Fixed for new deployments (issue #172) — the database URL is now built in one place and the password is percent-encoded. An **older** deployment predating that fix, or a hand-edited `.env`, can still hit this. Either change the password to avoid those characters or confirm your checkout includes the fix. |
| `install`/`doctor` reports the loopback port is already in use, by something that isn't this deployment | Another app on the same VPS is already bound to that port. | Pick a different port for this app with `APP_BIND_PORT` in its `.env` (or `--port` during install), or stop whatever's holding the port. `doctor`'s `bind-port-free` check is written to *not* flag this app's own already-running nginx as a conflict — a false positive here means it's genuinely something else. |
| Repeated `install` attempts start failing with a rate-limit error from Let's Encrypt | You burned the hourly/weekly certificate budget on earlier failed attempts (section 8). | Wait — retrying immediately makes it worse. Use `--staging` for everything except the attempt you actually intend to keep. |
| `docker compose` commands fail as if the command doesn't exist, or behave unexpectedly | The standalone `docker-compose` **v1** binary is installed instead of the Compose **v2 plugin** (`docker compose`, no hyphen). | `doctor`'s `docker-compose-v2` check catches this directly. Install the v2 plugin per Docker's current documentation; v1 is not a supported substitute anywhere in this pipeline. |
| `status`/health checks show the API healthy, but the site itself returns 502 | The web container's own nginx and the shared proxy's upstream port have drifted out of agreement — the historical failure mode this exact pair of files used to have. | This is why `status` probes the frontend **separately** from `/api/health/ready` — an API-only health check would show green while the site is down. A stock deployment is guarded by a test asserting these two ports agree; if you've modified `apps/web/nginx.conf` or `infra/nginx/nginx.conf` in a fork, check that they still match. |

## Summary checklist

- [ ] `appctl deploy doctor` run clean (or only recommended warnings) before starting
- [ ] DNS A record for the domain points at this server, confirmed by `doctor --domain <domain>`
- [ ] Google OAuth redirect URI matches `https://<domain>/api/auth/google/callback` exactly
- [ ] External PostgreSQL reachable, with credentials `doctor`/`install`'s environment validation accepts
- [ ] First install run with `--staging` if this is a new domain or a first attempt on this server
- [ ] `appctl deploy install --domain <domain>` completed, including the external HTTPS verification step
- [ ] Logged in at `https://<domain>` as `INITIAL_ADMIN_EMAIL` — this, not the seed, is what creates the admin account
- [ ] Additional users added to the allowlist from the admin panel
- [ ] `appctl deploy status` reports healthy, with migrations "up to date," not just the readiness probe green
- [ ] `appctl deploy update` scheduled (cron or otherwise) if this server should track new releases automatically
- [ ] `<deployRoot>/logs/` reviewed for anything unexpected if any step above didn't go as described
