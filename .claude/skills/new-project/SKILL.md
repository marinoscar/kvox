---
name: new-project
description: Bootstrap a new product from this template — rename it, generate a local environment, get it running against a database, and reset the release state a fork inherits. Use when the user says they are starting a new project from this repository, forking it, setting it up for the first time, or asks to get a fresh clone running.
---

# Starting a new product from this template

This repository is a foundation that gets forked. Your job is to take a fresh
clone from "somebody else's template" to "this person's project, running
locally, with a green test suite".

Two scripts do the mechanical work — `scripts/rename.mjs` and
`scripts/new-project.mjs`. **Your value is in the order, the checkpoints, and
refusing to automate the things that should not be automated.** Several steps
here are one-way; `git checkout .` does not undo a squashed migration history.

The human-facing guide is [`docs/RENAMING.md`](../../../docs/RENAMING.md).

---

## Step 0 — establish where you are

**Check whether this is the template or a fork** before touching anything:

```bash
git remote get-url origin
node -e "console.log(require('./packages/shared/identity.json').repoSlug)"
```

If those match, this is the **template itself**. Stop and confirm with the user
before proceeding — resetting the release state here would discard the
template's real history. `scripts/new-project.mjs` refuses in this case by
design; do not reach for `--force` to get past it without an explicit yes.

Then follow this repo's rules from `CLAUDE.md`: a tracking issue, and a worktree
rather than the main checkout (unless the environment already put you on a
designated branch).

## Step 1 — rename it

Use the **`rename-app`** skill. Do not reimplement it here; it handles the
identity codemod, the do-not-rename list, and the visual-baseline consequence.

Come back when the rename is committed and its tests pass.

## Step 2 — get it running

This is the part that has historically eaten the first hour.

```bash
npm install
npm run setup     # generates infra/compose/.env, secrets and all
```

The user must supply three things nothing can generate:

- **`INITIAL_ADMIN_EMAIL`** — without it nobody can log in at all. It is the one
  address that bypasses the allowlist, and seeding adds it to that allowlist.
- **`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`** — Google OAuth is **required**,
  not optional. The API fails to bootstrap inside passport without a client ID.
  They come from the Google Cloud console, with the redirect URI set to
  `<APP_URL>/api/auth/google/callback`.
- **A PostgreSQL to point at.** There is no `db` service in the base compose
  stack, on purpose. Either use the opt-in overlay, or point `POSTGRES_*` at an
  instance they already run.

Then bring it up, migrate and seed:

```bash
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml up
npm run prisma:migrate --workspace=api
npm run prisma:seed --workspace=api
```

**Do not skip the seed, and do not invent a variant of that command.** Running
`prisma/seed.ts` directly fails, because `DATABASE_URL` is constructed by the
npm script and is not an environment variable anywhere in the stack. A skipped
seed surfaces as "Default role not found" at first login, which reads like a bug
rather than a missing step.

Confirm the user can actually log in at http://localhost:3535 before moving on.
That round trip working is the real acceptance test for this whole step.

## Step 3 — reset what a fork inherits

```bash
node scripts/new-project.mjs --reset-release --license mit --holder "<name>"
```

**Ask which licence before running this.** It is the user's decision, not yours,
and it is not a technical one. Built-in options are `mit` and `proprietary`; for
anything else they add `./LICENSE` themselves and the script's audit stops
mentioning it.

This also resets `CHANGELOG.md` to `[Unreleased]` + `[0.1.0]` and sets all four
workspace versions to `0.1.0`.

## Step 4 — walk the audit

```bash
node scripts/new-project.mjs --audit
```

Each item is a judgement call. Present them; do not action them silently.

**The one to get right: it recommends KEEPING the example job handlers, and that
recommendation is correct.** They look like demo code and are not —
`example.checksum` is the canonical node-eligible job type, and the jobs and
worker-node test suites use it and `example.echo` as fixtures across ~27 files.
Deleting them hands the new project a broken test suite. If the user still wants
them gone, treat it as a deliberate refactor with its own issue and a green
suite either side — never as a bootstrap step.

The others — the stub deploy jobs, `docs/specs/` carrying the template's issue
numbers, the inherited migrations — are all "fine to leave" defaults. Say so
rather than manufacturing work.

## Step 5 — the one-way steps, only if asked

Never do these on your own initiative. Each needs an explicit yes, and each
should be its own commit.

| Action | Ask first about |
|---|---|
| Squash the migrations into one initial | Only safe **before** any environment has run them. Afterwards it desynchronises every deployed `_prisma_migrations` table. |
| `rm -rf .git && git init` | Discards all history including the work you just did. Confirm the rename and setup are pushed or genuinely disposable. |
| Fill in or delete `deploy.yml`'s staging/production jobs | They currently target a placeholder domain via `echo`, and expect GitHub Environments that may not exist. |

## Step 6 — verify and hand over

```bash
npm run test:run --workspace=cli    # includes the identity guard
npm test --workspace=api
npm run test:run --workspace=web
```

Report honestly: what is running, what is still stubbed, and the outstanding
manual items (OAuth redirect URIs, the GitHub repository rename, visual
baselines if the rename has not had them regenerated yet).

---

## The general rule

If a step needs a judgement about *this product* rather than about *the
template*, put it to the user. The scripts exist to remove the mechanical cost
of starting over, not to make the decisions that make it their project.
