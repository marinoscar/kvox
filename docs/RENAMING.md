# Renaming this template

This repository is a starting point, never a destination. Forking it and
keeping the placeholder name for more than a day is the most common way a
project ends up with "Acme Hub" in its README and the old template name
baked into a published OpenAPI document, a database backup filename, and a
dozen other places nobody thought to check. This guide is the complete
runbook — read it once, end to end, before you run anything.

Two things are worth knowing before you start:

- **Renaming is idempotent.** `scripts/rename.mjs` reads the *current* values
  out of `packages/shared/identity.json` rather than hardcoding an old name
  anywhere, so it works the same way on the tenth rename as on the first, and
  running it twice with the same arguments changes nothing the second time.
- **It cannot leave things half-done silently.** Every edit it makes declares
  how many times it expects to find its target text, and a mismatch is a hard
  failure with nothing written — see [Troubleshooting](#troubleshooting).

## TL;DR

Pick one of two equivalent routes:

**In Claude Code:**

```
/rename-app
```

**Directly:**

```bash
node scripts/rename.mjs --name "Acme Hub" --repo oscar/acme-hub --theme '#7c3aed'
```

Either way, three things happen after the codemod finishes, and none of them
are optional:

```bash
npm install                                   # the lockfile carries the old workspace name too
```

Then regenerate the visual baselines — see [step 5](#5-the-manual-steps) —
and expect CI to be red until you do; that's covered in its own section
below because it's the thing most likely to cause a moment of panic on a
first fork.

## What gets renamed, and what doesn't

Three groups. Knowing which one a given string falls into lets you predict
the diff before you run anything.

### Derived at runtime

Change `packages/shared/identity.json` (or let the script do it) and these
surfaces are correct the next time the app builds — no codemod involved,
because they all read `APP_NAME` / `THEME_COLOR` / `BACKGROUND_COLOR` /
`REPO_SLUG` from `@app/shared` rather than holding their own copy. The
~12-row consumer table — the web wordmark, the OpenAPI document title, the
email layout, the CLI banner, the MUI theme, the web app manifest, and so on
— lives in [`packages/shared/README.md`](../packages/shared/README.md#consumers)
and isn't duplicated here to avoid two lists drifting apart. Two more
surfaces that work the same way, added since that table was written:

- The **OpenTelemetry service name** — `apps/api/src/common/otel/service-name.ts`
  falls back to `${APP_SLUG}-api` whenever the `OTEL_SERVICE_NAME` environment
  variable isn't set, so it follows a renamed product automatically in every
  span and every log line.
- The **OpenAPI document's repository link** — `apps/api/src/openapi/document.ts`
  and `description.ts` both import `REPO_URL` from `@app/shared` rather than
  writing out a GitHub URL, so the published API reference always points at
  the fork's own repository.

Nothing in this group needs the codemod. If all you're changing is the
product name, colours, or repo slug, `identity.json` plus a rebuild is
functionally the whole change for anything a browser or a running server
renders — the codemod exists for the group below.

### Codemodded

These are values *no runtime read can reach* — files that are read before
the application (or even the repository) exists, or values baked into a
Compose default rather than resolved from JavaScript. `buildPlan()` in
`scripts/rename.mjs` is the authoritative list; the categories it actually
edits:

| Target | Why it can't derive |
|---|---|
| `install.sh` (the `curl \| bash` header comment, the `APPCTL_REPO` default) | **This is the sharpest example.** It is fetched and executed via `curl \| bash` *before the repository exists on disk* — there is nothing to read a manifest out of, because the clone that manifest lives in hasn't happened yet. This is a permanent codemod target; it can never move to the "derived" group. |
| `apps/cli/README.md` (the same install/uninstall one-liners and `APPCTL_REPO` default, restated in docs) | Prose describing the installer above — same reasoning, once removed. |
| `README.md` (title, tagline, CI badge URL, clone/`cd` instructions, directory-tree root) | The one place in the codebase where the product name and repo slug appear as hand-written prose rather than as a rendered value. |
| `infra/compose/.env.example` and `base.compose.yml` (`OTEL_SERVICE_NAME` default) | These are Compose-file string defaults, not JavaScript — nothing executes `@app/shared` to produce them. The codemod changes the *value* only; it never adds a new key, because `apps/cli/src/deploy/env-spec.test.ts` counts every commented `# KEY=value` line in `.env.example` as a declared variable, and a new key would fail that test. |
| `infra/compose/test.compose.yml`, `apps/api/.env.test`, `scripts/dev.ps1` (test database name and container name) | Same reasoning as the OTEL default — Compose/env-file values, not code. |
| `package.json`'s `"name"` field | npm reads this before any of the repository's own code runs, so it is necessarily a second copy of the slug. |
| `apps/web/public/favicon.svg` and `apps/web/public/icons/source.svg` (the `fill` attribute on the background rect) | These are the two hand-editable *vector* masters. `generate-icons.py` reads the manifest for the *rasters* but deliberately does not rasterise these two SVGs — see [The binary-name decision](#the-binary-name-decision)'s sibling note in `packages/shared/README.md` on why an SVG toolchain is refused. |
| `apps/cli/src/branding.ts` and `apps/cli/package.json`'s `bin` key | Only touched when `--cli-name` is passed — see the next section. |

### Never renamed

See [Do not rename](#do-not-rename) below — read it before running anything,
not after.

## Every flag

```
node scripts/rename.mjs --name "Acme Hub" [options]

  --name <string>        Product display name. The one value most surfaces derive from.
  --repo <owner/name>    GitHub repository slug. Published in the OpenAPI document.
  --theme <#rrggbb>      Brand primary colour. 6-digit hex only.
  --background <#rrggbb> PWA splash / first-paint colour. 6-digit hex only.
  --tagline <string>     One-line description, used as the README subtitle.
  --cli-name <name>      ALSO rename the CLI binary. Read the warning it prints first.
  --dry-run              Show every edit and its hit count; change nothing.
  --force                Proceed even with a dirty working tree.
  -h, --help             This message.

At least one of --name/--repo/--theme/--background/--tagline/--cli-name is required.
```

`--theme` and `--background` must be 6-digit `#rrggbb` hex — a PWA manifest's
`theme_color` is parsed by the platform, not by a CSS engine, and the
3-digit shorthand and `rgb()` forms aren't reliably accepted there. `--repo`
must match `owner/name`. `--cli-name` must be lowercase letters, digits and
hyphens starting with a letter, because it becomes both a dotfile directory
(`~/.acmectl/`) and an environment-variable prefix (`ACMECTL_`) — see the
next section.

A worked example — starting from a fork that has already been through one
rename (its manifest currently says `"Prior Name"` / `prior/prior-repo`) and
is being renamed again, with `--dry-run` so nothing is written:

```bash
node scripts/rename.mjs --name "Acme Hub" --repo oscar/acme-hub --theme '#7c3aed' --dry-run
```

```
Planned edits (Prior Name -> Acme Hub):

  ~ README.md  1x  "# Prior Name\n"
  ~ README.md  1x  "A production-grade full-stack application foundation..."
  ~ install.sh  1x  "https://raw.githubusercontent.com/prior/prior-repo/..."
  ~ install.sh  2x  "https://github.com/prior/prior-repo.git"
  ~ apps/cli/README.md  2x  "https://raw.githubusercontent.com/prior/prior-repo/..."
  ~ apps/cli/README.md  1x  "https://github.com/prior/prior-repo.git"
  ~ README.md  2x  "https://github.com/prior/prior-repo/actions"
  ~ README.md  1x  "cd prior-repo\n"
  ~ README.md  1x  "prior-repo/\n"
  ~ infra/compose/.env.example  1x  "OTEL_SERVICE_NAME=prior-name-api"
  ~ infra/compose/base.compose.yml  1x  "OTEL_SERVICE_NAME:-prior-name-api"
  ~ infra/compose/test.compose.yml  1x  "container_name: prior-name-db-test"
  ~ infra/compose/test.compose.yml  1x  "POSTGRES_DB: prior_name_test"
  ~ apps/api/.env.test  2x  "prior_name_test"
  ~ scripts/dev.ps1  1x  "\"prior_name_test\""
  ~ package.json  1x  "\"name\": \"prior-name\","
  ~ apps/web/public/favicon.svg  1x  "fill=\"#0044cc\""
  ~ apps/web/public/icons/source.svg  1x  "fill=\"#0044cc\""

  ~ packages/shared/identity.json  (structured write)
      productName: "Acme Hub"
      tagline: "A production-grade full-stack application foundation..."
      repoSlug: "oscar/acme-hub"
      themeColor: "#7c3aed"
      backgroundColor: "#ffffff"

(--dry-run: nothing was written.)
```

(Abridged for width — the real output prints each `find` string in full, and
on your fork the "before" side will be whatever `identity.json` currently
holds, not the fictional values above.)

## The binary-name decision

`--cli-name` is deliberately a separate flag from `--name`, not a value
derived from it. A product called "Acme Hub" may well still ship a binary
called `appctl` — `git` isn't called `github-cli`, `kubectl` isn't called
`kubernetes-cli`, and there's no reason a fork's control client should be
forced to match the product name syllable-for-syllable. `apps/cli/src/branding.ts`
carries the full rationale; the summary is that `CLI_NAME` seeds three
things the product name has no business touching: the executable shown in
`--help`, the config directory (`~/.appctl/`), and the environment-variable
prefix (`APPCTL_`).

Renaming the binary is a bigger, and honestly a more expensive, change than
renaming the product, and the script says so out loud when you pass
`--cli-name`. State the cost plainly, because it is real:

- **~6 CLI test files assert literal `APPCTL_` environment-variable names on
  purpose** — they are *meant* to break on a rename, as a forcing function
  to catch every place that reads the old prefix. Fix them by hand.
- **`apps/cli/Dockerfile` declares 14 `ENV APPCTL_*` lines.** All 14 need the
  new prefix.
- **`infra/compose/worker.compose.yml` carries the same prefix.**
- **Machines already running the CLI are not migrated for you.** They have a
  config directory (`~/.appctl/`) and, if deployed via `appctl deploy`, a
  systemd unit under the old name. The rename only affects what a fresh
  install produces; existing installations keep working under the old name
  until someone manually migrates or reinstalls them.

If you don't have a specific reason to rename the binary, don't — leave
`--cli-name` off and let the product and the binary diverge on purpose.

## The manual steps

The codemod handles everything a file edit can handle. Four things need a
human, in this order:

1. **`npm install`.** The npm workspace root name lives in the lockfile as
   well as in `package.json`, and `npm ci` — which CI and all three
   Dockerfiles run as their first step — fails hard if the two disagree.
   Skipping this step doesn't fail quietly; it fails the very next build.

2. **Regenerate the visual baselines**, from inside the pinned container
   (never a local browser — see `tests/visual/playwright.config.ts` for why
   rendering differences between browser builds would produce false diffs):

   ```bash
   docker run --rm -it -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.62.1-noble \
     npx playwright test --config=tests/visual/playwright.config.ts --update-snapshots
   ```

   See [CI will be red until you regenerate the baselines](#ci-will-be-red-until-you-regenerate-the-baselines)
   below for why this isn't optional.

3. **Rename the repository on GitHub, then re-point the local remote:**

   ```bash
   git remote set-url origin https://github.com/oscar/acme-hub.git
   ```

4. **Update the OAuth redirect URIs** in the Google Cloud Console (and any
   other provider you've enabled), so the callback still matches `APP_URL`.
   Nothing in this repository can reach into a third-party console for you.

## Do not rename

Read this table before you run a find-and-replace of your own — every row
here is a place where the *literal text*, not the concept it names, has to
stay exactly as it is. The first row is the one that matters most.

| What | Where | Consequence |
|---|---|---|
| The HKDF label `enterpriseappbase:secret-cipher:v1:` | `apps/api/src/common/crypto/secret-cipher.ts` | **Every stored credential becomes permanently undecryptable.** This string happens to be lowercase and to contain the template's old name, which makes it look renameable — it isn't. A case-insensitive find-and-replace across the repository is the realistic way this gets broken by someone who never opened this file; say so explicitly, because "don't do a blind find-and-replace" is the actual lesson here. (Naming the literal here is safe: the guard test's check is case-sensitive against the *current product name*, and this label is lowercase and structurally different from it, so quoting it does not trip CI.) |
| The `Symbol.for(...)` registry key | `apps/api/src/common/exceptions/verbatim-error-body.exception.ts` | `Symbol.for` interns by string across realms (a worker thread, a separately-loaded copy of the module). Changing the string breaks that cross-realm identity check silently — two symbols that were supposed to compare equal stop doing so. |
| The `# Managed by appctl deploy` sentinel comment | `apps/cli/src/deploy/proxy.ts` | This line is written into an nginx vhost file on a live server *and* parsed back out of it later to recognise which vhosts the CLI itself manages. Change the string and the CLI stops recognising vhosts it wrote before the change. |
| The `.appctl-deploy.json` filename | `apps/cli/src/deploy/state.ts` | Read from live deployment servers as the CLI's own state file. Renaming it orphans the deployment state of every server the CLI has already touched. |
| `@app/shared`, and the `api` / `web` / `nginx` Compose service names | — | These are internal plumbing names, not identity — nothing user-facing reads them, and nothing about a rebrand depends on them. |

## CI will be red until you regenerate the baselines

Say this loudly, because it is the single most likely thing to cause a
moment of panic on a first fork: **after you rename the product name, CI
will fail until you regenerate the visual baselines, and that is expected —
it is not a sign that something went wrong.**

Seven of the eleven visual-regression baselines under
`tests/visual/specs/**/*-snapshots/` are full-page (`fullPage`) screenshots
that include the AppBar wordmark, and the suite runs at `maxDiffPixels: 4` —
effectively zero pixel tolerance. Changing the product name is a genuine
pixel change to every one of those seven screenshots, so the very next CI
run after a rename will show seven failing visual tests until you run the
[baseline regeneration command](#5-the-manual-steps) above and commit the
result. The remaining four baselines are rail-scoped or drill-down shots
that don't include the wordmark and are unaffected.

## Troubleshooting

**An anchor fails with an `expectedHits` mismatch.** The script reports
something like `expected 1 occurrence(s) of "..." found 0` and writes
nothing. This means the file the codemod targets has changed shape since
`scripts/rename.mjs` was written — not that your rename is unsafe. **Fix the
anchor in `scripts/rename.mjs`; never loosen the expected count or delete
the check.** A codemod whose pattern silently matches zero times is worse
than no codemod at all: it reports success while leaving the old name
sitting in a *published* OpenAPI document or a live Compose default, and
nobody notices until a user does.

**The guard test (`apps/cli/src/template-identity.test.ts`) fails.** It
fails when the current product name or repo slug (or either half of the
slug) shows up in a file outside its small allowlist. Two ways to resolve
it, in order of preference:

1. **Derive the value instead of writing it out.** Import `APP_NAME` /
   `APP_SLUG` / `REPO_SLUG` / `REPO_URL` from `@app/shared` rather than
   hardcoding the string — this is almost always the right fix, and it's
   exactly the pattern the [derived-at-runtime group](#derived-at-runtime)
   above already uses everywhere.
2. **If the file genuinely cannot import runtime code** (a shell script, a
   Compose YAML default, a file executed before the repo exists on disk —
   see the [codemodded group](#codemodded)), add it to `scripts/rename.mjs`'s
   edit plan instead, so a future rename keeps it in sync automatically,
   and justify the allowlist entry in the test file's own comments rather
   than adding it silently.

**`python3` or Pillow is missing when regenerating icons.** The rename
script tries to run `apps/web/scripts/generate-icons.py` for you after a
colour change and prints a fallback command if that fails:

```bash
pip install --user 'Pillow>=10'
python3 apps/web/scripts/generate-icons.py
```

The icon PNGs are committed pixels precisely so that a fork is never forced
to have an image toolchain in order to run the rename — the icon
regeneration step is the one part of the whole process that's genuinely
optional infrastructure, deferred until you actually change a brand colour.

**I want to undo a rename.** Run `git checkout .` — this is exactly why the
script refuses to run against a dirty working tree without `--force` in the
first place: a clean tree going in is what makes a full revert a single
command coming out. If you've already run `npm install` or the icon
regenerator, those produced files (`package-lock.json`, the icon PNGs) are
tracked too, so `git checkout .` reverts them along with everything else.

## Starting a whole new project

Renaming (above) is the first step of turning this template into your own
project, not the whole of it. What follows is the rest of the bootstrap:
getting a database, getting the app running, and deciding what a fork keeps
from the template versus what it eventually sheds.
[`.claude/skills/new-project/SKILL.md`](../.claude/skills/new-project/SKILL.md)
walks an agent through this same sequence with the same checkpoints — this
section is its human-facing twin, not a second, conflicting version of it.

### 1. Rename first

Do the rename in the [TL;DR](#tldr) above before anything below. Everything
past this point assumes `identity.json` already describes your product,
because `scripts/new-project.mjs`'s own safety check (step 6) refuses to run
against a checkout that still looks like the template.

### 2. Generate a local environment: `npm run setup`

```bash
npm run setup
```

This builds the CLI and runs `appctl init` — the deploy wizard pointed at
your own machine. It exists because `cp .env.example .env` produces a file
whose three secrets are the literal placeholder string
`your-super-secret-key-min-32-characters-long` and whose Google credentials
don't exist:

- **`JWT_SECRET`, `COOKIE_SECRET` and `SECRETS_ENCRYPTION_KEY`** are
  generated with the CSPRNG. They are never prompted for, and re-running
  with `--force` never regenerates one that's already set — replacing
  `JWT_SECRET` on a re-run would invalidate every session and refresh token
  you're holding, for no reason you asked for.
- It asks about the database and Google OAuth interactively, then writes
  **`infra/compose/.env`, at mode `0600`, and nothing else.** It never
  modifies `.env.example` — that file stays the validated template every
  other command reads its own questions from.

Useful flags:

- `--non-interactive` — never prompt: generate the secrets, take every
  default, and leave OAuth blank. For a scripted checkout or CI; you still
  fill in OAuth by hand afterward.
- `--admin-email <email>` — set `INITIAL_ADMIN_EMAIL` without being asked
  for it.
- `--force` — update an existing `.env` in place. It fills in whatever is
  missing while keeping every value already set, secrets included — a
  top-up, not a reset.

### 3. The three things nothing can generate

`npm run setup` cannot manufacture these, and skipping any one of them fails
in its own specific, memorable way:

- **`INITIAL_ADMIN_EMAIL`.** Leave it empty and nobody can log in — not
  "log in without admin rights", *at all*. The allowlist refuses every
  address that isn't already on it, and this is the one address that
  bypasses that check on first login.
- **Google OAuth — required, not optional.** The API does not start without
  `GOOGLE_CLIENT_ID`; the literal failure is `OAuth2Strategy requires a
  clientID option`, thrown before the process gets anywhere near listening
  on a port. Get `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from the
  [Google Cloud Console](https://console.cloud.google.com), with the
  redirect URI set to `<APP_URL>/api/auth/google/callback`.
- **A PostgreSQL to point at.** There is deliberately no `db` service in
  `base.compose.yml` — see `infra/compose/devdb.compose.yml`'s own header
  for why baking one in would be wrong for a host that's already running
  Postgres for other applications built from this template. Either use the
  opt-in overlay (step 5) or point `POSTGRES_*` in `.env` at an instance you
  already run.

### 4. Create the shared Docker network, once per machine

```bash
docker network create devnet
```

`base.compose.yml` declares `devnet` as `external: true`, so the very first
`docker compose up` on a fresh machine fails with *network devnet declared
as external, but could not be found* until this exists. It's a one-time
step per machine, not per project — it exists so several applications built
from this template can share one PostgreSQL container on a shared host, and
you need it even when you aren't sharing anything, because the network is
declared unconditionally.

### 5. Bring it up, migrate, seed

```bash
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml up
npm run prisma:migrate --workspace=api
npm run prisma:seed --workspace=api
```

Leave `-f devdb.compose.yml` off if `.env`'s `POSTGRES_*` variables already
point at a database you run yourself.

**Do not invent a variant of the last two commands.** Running
`apps/api/prisma/seed.ts` directly — or any form of `npx prisma db seed`
that bypasses the npm script — fails, because `DATABASE_URL` is constructed
by `scripts/prisma-env.js` from the individual `POSTGRES_*` variables; it is
not an environment variable anywhere in the stack. A skipped seed doesn't
fail loudly at seed time, either — it surfaces later, at first login, as
"Default role not found", which reads like a bug in the app rather than a
missing setup step.

Confirm you can actually log in at `http://localhost:3535` with the
`INITIAL_ADMIN_EMAIL` address before moving on — that round trip is the
real acceptance test for everything above.

### 6. Reset what a fork inherits: `scripts/new-project.mjs`

`scripts/rename.mjs` changes the *identity*. `scripts/new-project.mjs`
changes the *state* — the release history, the version numbers, the
licence — the things that are true of the template and false of the
product built from it.

It refuses `--reset-release` and `--license` if this still looks like the
template: it compares `identity.json`'s `repoSlug` against the checkout's
`git remote get-url origin` and dies if they still match, so a `--force`
habit picked up from the rename step can't wipe out the template's own
release history by accident. `--force` skips that check for the rare case
where you really are working in the template itself, or the remote hasn't
been re-pointed yet.

```bash
node scripts/new-project.mjs --reset-release --license mit --holder "Your Name or Company"
```

- `--reset-release` resets `CHANGELOG.md` to `[Unreleased]` + `[0.1.0]` and
  sets all four workspace `package.json` versions to `0.1.0`.
- `--license <id>` writes a `LICENSE` file and replaces the README's
  `[Your License Here]` placeholder. Only `mit` and `proprietary` are built
  in — not because those are the only licences that exist, but because
  embedding the full text of every licence choice would make this script
  mostly licence text. For anything else (Apache-2.0, BSD, GPL, ...), copy
  the official text from https://choosealicense.com into `./LICENSE`
  yourself; nothing else in the repository depends on which you pick.
- Which licence to use is a decision for you to make; the script has no
  default and won't guess.

### 7. Walk the audit

```bash
node scripts/new-project.mjs --audit
```

This is the default action when no other flag is given, and it changes
nothing — it only reports. Each item is a judgement call to present, not to
action silently.

**The one to get right — and the most important paragraph in this
section — is that the audit recommends KEEPING the example job handlers,
and that recommendation is correct.** `example-echo.handler.ts` and
`example-checksum.handler.ts` look like disposable demo code. They are not.
`example.checksum` is the canonical **node-eligible** job type — the only
handler in the codebase implementing both `process` and
`nodeResultSchema`/`persistNodeResult` together — and the jobs and
worker-node test suites use it and `example.echo` as fixtures across
roughly 27 files. Their coupling to production code is two registrations
and some comments; their coupling to the test suite is real and deep.
Deleting them on a bootstrap pass hands a new project a broken test suite
in its first hour, which is the worst possible introduction to a codebase.
If you genuinely want them gone, that's a deliberate refactor with its own
issue and a green suite before and after — never a step you take because a
bootstrap checklist told you to.

The audit's other items — the stub `deploy.yml` staging/production jobs,
`docs/specs/` carrying the template's own issue numbers, the Prisma
migrations inherited from the template — are ordinary "fine to leave, here's
what to know" defaults, not action items.

### 8. The one-way steps — only if you mean it

None of these are part of the bootstrap above, and none should happen on
your own initiative. Each is irreversible in a way `git checkout .` cannot
undo, so give each its own explicit decision and its own commit:

- **Squashing the migrations into a single initial migration.** Only safe
  *before* any environment — including your own laptop's dev database — has
  run them. Do it afterward and you desynchronise every deployed database's
  `_prisma_migrations` table against the migration history in the repo.
- **Resetting git history** (`rm -rf .git && git init`, or equivalent).
  Discards everything, including the rename commit and everything from this
  bootstrap. Confirm it's pushed somewhere, or genuinely disposable, first.
- **Filling in or deleting `deploy.yml`'s stub staging/production jobs.**
  They currently target a placeholder domain via `echo` and expect GitHub
  Environments named `staging` and `production` to exist. The image build
  above them already follows the fork automatically; only the deploy steps
  need a decision.
