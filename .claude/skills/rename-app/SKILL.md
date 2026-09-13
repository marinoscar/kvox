---
name: rename-app
description: Rebrand this template for a new product — set the application name, repository slug and brand colours, run the identity codemod, and finish the steps it cannot do. Use when the user asks to rename the app, rebrand a fork, change the product name or theme colour, or set up this template for a new project.
---

# Rebranding this template

This repository is a starting point, never a destination. Your job here is to
take it from the template's identity to the user's, completely, without leaving
a stale name in a published API document or an old colour on a notification icon.

Almost all of the mechanical work is already done by `scripts/rename.mjs`. Your
value is in the four things it cannot do: asking the right questions, deciding
whether the *binary* should be renamed, verifying the result, and committing it
the way this repository expects.

**The detailed human guide is [`docs/RENAMING.md`](../../../docs/RENAMING.md).
Read it before you start.** This file is the procedure; that one is the reference.

---

## Step 0 — preconditions

This repository mandates issue-first, worktree-based development
(see `CLAUDE.md`). Before touching anything:

1. **Confirm a tracking issue exists**, or create one:
   `gh issue create --template feature_request.yml`. A rebrand is a feature.
2. **Work in a worktree**, never in the main checkout:
   ```bash
   git worktree add worktrees/rebrand -b feat/rebrand
   ```
   If the environment already has a designated branch checked out (a remote or
   CI-driven session), stay on it rather than forcing a worktree — but say which
   you did.

## Step 1 — gather the values, do not guess them

Ask for these. Do not infer a product name from a directory name or a git remote.

| Value | Flag | Notes |
|---|---|---|
| Product display name | `--name` | The one value most surfaces derive from |
| Repository slug | `--repo` | `owner/name`. **Published in the OpenAPI document** |
| Brand primary colour | `--theme` | 6-digit hex only |
| Splash / first-paint colour | `--background` | 6-digit hex only. Usually left alone |
| One-line description | `--tagline` | Becomes the README subtitle |

**Always ask, separately and explicitly, whether the CLI binary should be
renamed too**, defaulting to *no*. It is a deliberately independent identity: a
product called "Acme" may perfectly well still ship a binary called `appctl`.
State the cost before they choose:

- ~6 CLI test files assert literal environment-variable names and **are meant to
  break** on a rename — they need fixing by hand
- `apps/cli/Dockerfile` declares 14 such `ENV` lines
- `infra/compose/worker.compose.yml` carries the same prefix
- Machines already running the CLI have a config directory and a systemd unit
  under the old name, and are **not** migrated for you

If they say yes, pass `--cli-name` and plan for the follow-up work above.

## Step 2 — dry run, show, confirm

```bash
node scripts/rename.mjs --name "<name>" --repo <owner/name> --theme '<#rrggbb>' --dry-run
```

Show the user the edit plan. Then run it for real (the script requires a clean
working tree — that is what makes `git checkout .` a complete undo).

**If it reports an anchor that did not match as declared: stop.** That means a
file changed shape since the codemod was written. Fix the anchor in
`scripts/rename.mjs` and re-run. **Never loosen an anchor to make the error go
away** — a codemod that silently matches nothing is exactly how the old name
ends up in a published OpenAPI document, reported as a success.

Read the residual scan at the end. It should be clean; anything it lists is a
value the codemod does not know about and is worth a look.

## Step 3 — verify

Run all of these and report what actually happened:

```bash
npm install                              # the lockfile carries the workspace root name
npm run test:run --workspace=cli         # includes the identity guard
npm test --workspace=api
npm run test:run --workspace=web
npm run build --workspace=web
```

The guard (`apps/cli/src/template-identity.test.ts`) is the one that matters
most: it derives its patterns from the manifest, so after a rename it is
checking the **new** name. If it fails, it names the offending `file:line`.

## Step 4 — the visual baselines

```bash
docker run --rm -it -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.62.1-noble \
  npx playwright test --config=tests/visual/playwright.config.ts --update-snapshots
```

**Tell the user plainly that CI is red until this is done, and that this is
expected rather than a regression.** Seven of eleven baselines are full-page
screenshots containing the app-name wordmark, and the suite runs at
`maxDiffPixels: 4` — effectively zero tolerance. Changing the name *is* a pixel
change.

Baselines are only ever regenerated inside that pinned container; a locally
installed browser renders differently and will produce baselines that fail in CI.

## Step 5 — commit

Two commits, not one:

- `feat(core): rebrand to <name>` — the code and configuration. It is genuinely
  one intent, so one commit is right.
- `chore(tests): regenerate visual baselines after rebrand` — the pixels. A diff
  of eleven PNGs does not belong in a reviewable code commit.

Reference the issue (`Relates to #<n>`). Follow the Conventional Commits rules in
`CLAUDE.md`.

## Step 6 — hand back the rest

Remind the user of what nothing in the repository can do:

- Rename the repository on GitHub, then `git remote set-url origin <new-url>`
- Update the OAuth redirect URIs in the Google Cloud console (and any other
  provider) so the callback still matches `APP_URL`
- If they renamed the binary: the ~6 CLI test files and the Dockerfile `ENV`
  block

---

## Before you touch anything by hand

Read [`references/do-not-rename.md`](references/do-not-rename.md).

One entry on that list, if you "helpfully" rename it, **permanently destroys
every stored credential in the database**. A repo-wide case-insensitive
find-and-replace is the realistic way that happens. Do not run one.

If you find an identity string the codemod missed, the fix is to **add an anchor
to `scripts/rename.mjs`**, so the next fork gets it for free — not to hand-edit
the file and move on.
