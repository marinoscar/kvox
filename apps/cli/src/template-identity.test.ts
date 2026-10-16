import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_SLUG } from '@app/shared';

// =============================================================================
// The template-renameability guard (issue #343, epic #341)
// =============================================================================
//
// WHY THIS LIVES IN apps/cli, NOT SOMEWHERE REPO-WIDE
// -----------------------------------------------------------------------------
// This file scans the ENTIRE repository, not just apps/cli. It lives here
// anyway, for three practical reasons:
//
//   - `apps/cli/vitest.config.ts` already scopes to `src/**/*.test.ts` and CI
//     already runs this workspace's test script, so there is no new job to
//     wire up.
//   - This package is real ESM (`"type": "module"`), so `node:fs` /
//     `node:child_process` and `import.meta.url` are natural here in a way
//     they are not in `apps/api` (CommonJS + ts-jest) or `apps/web` (browser
//     runtime, jsdom).
//   - There is precedent for a CLI test reaching outside `apps/cli`:
//     `apps/cli/src/worker-image.test.ts` and `apps/cli/src/app.test.ts` both
//     already do it. This is the same move, aimed at the whole tree instead of
//     one other package.
//
// It is the keystone of the epic: `packages/shared/identity.json` plus
// `@app/shared` gives new code a rebrand-safe way to reference the product
// name, the repo, and the brand colours. Nothing stops new code from
// hardcoding the old strings again instead of importing them. This test is
// what makes CI catch that.
//
// -----------------------------------------------------------------------------
// WHY THE FORBIDDEN PATTERNS ARE DERIVED FROM identity.json, NEVER LISTED
// -----------------------------------------------------------------------------
// A denylist that spells out `'EnterpriseAppBase'` (or `'My App'`, or
// `'marinoscar'`) literally goes vacuously green the instant a fork renames —
// the old name is gone, the new one was never forbidden, and the guard is
// quietly protecting nothing. Worse, `scripts/rename.mjs` would then have to
// rewrite THIS FILE as part of a rename, which is circular: the codemod
// editing its own guard.
//
// Instead every pattern below is built from the CURRENT contents of
// `packages/shared/identity.json` at test-run time. Immediately after a fork
// runs `rename.mjs`, this test starts protecting the NEW name with no edit of
// its own required. The CLI's environment prefix follows the same model: it is
// derived from `cliName` in the manifest (`app.test.ts`), never listed.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/cli/src -> apps/cli -> apps -> <repo root>
const REPO_ROOT = join(HERE, '..', '..', '..');
const MANIFEST_PATH = join(REPO_ROOT, 'packages', 'shared', 'identity.json');

interface Identity {
  productName: string;
  tagline: string;
  repoSlug: string;
  themeColor: string;
  backgroundColor: string;
  cliName: string;
}

function readManifest(): Identity {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Identity;
}

describe('the manifest shape (packages/shared/identity.json)', () => {
  const identity = readManifest();

  it('has a non-empty productName', () => {
    expect(typeof identity.productName).toBe('string');
    expect(identity.productName.trim().length).toBeGreaterThan(0);
  });

  it('has a non-empty tagline', () => {
    expect(typeof identity.tagline).toBe('string');
    expect(identity.tagline.trim().length).toBeGreaterThan(0);
  });

  it('has a repoSlug shaped like owner/name', () => {
    expect(identity.repoSlug).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  // Lowercase, 6-digit `#rrggbb` is load-bearing, not a style preference: a
  // PWA manifest's `theme_color`/`background_color` are parsed by the
  // PLATFORM, not by a CSS engine, and the 3-digit shorthand and `rgb(...)`
  // forms are not reliably accepted there. `scripts/rename.mjs` enforces the
  // same shape on the way in (`HEX` regex there); this asserts it held.
  it('has a lowercase 6-digit hex themeColor', () => {
    expect(identity.themeColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('has a lowercase 6-digit hex backgroundColor', () => {
    expect(identity.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  // The CLI binary name seeds a config directory name and an environment
  // variable prefix, so it must survive both `.${name}` and
  // `${NAME.toUpperCase()}_` intact (`scripts/rename.mjs` enforces the same
  // shape on the way in).
  it('has a cliName that is a valid binary, directory and env-prefix seed', () => {
    expect(identity.cliName).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('exposes a non-empty APP_SLUG from @app/shared', () => {
    expect(typeof APP_SLUG).toBe('string');
    expect(APP_SLUG.trim().length).toBeGreaterThan(0);
  });
});

// =============================================================================
// The no-stale-identity-literal guard
// =============================================================================

/** Files allowed to carry an identity literal outright, each with its own reason. */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // The definition itself — this IS where the values live.
  'packages/shared/identity.json',
  // The shop window: deliberately carries the real name and repo slug, and is
  // one of `scripts/rename.mjs`'s own codemod targets.
  'README.md',
  // Install one-liners carrying the repo URL for `npm install -g`/`npx`.
  'apps/cli/README.md',
  // Fetched and run via `curl | bash` BEFORE the repository exists on disk —
  // it can never read the manifest. A permanent codemod target, not a bug.
  'install.sh',
  // A cross-realm `Symbol.for()` registry key. It is a REGISTRY KEY, not a
  // display string — see the file's own comment on `VERBATIM_ERROR_BODY` for
  // why it must be a stable, globally-unique string, not why it happens to be
  // spelled like the product name.
  'apps/api/src/common/exceptions/verbatim-error-body.exception.ts',

  // ---------------------------------------------------------------------
  // Added when this fork rebranded to KVox (issue #18).
  //
  // All of the entries below became necessary at once, for ONE reason: this
  // fork chose a CLI binary name equal to its repository name. In the
  // template those were three distinct strings (`My App` / `EnterpriseAppBase`
  // / `appctl`), so a legitimately-hardcoded binary name or service name could
  // never collide with an identity pattern. Here `kvox` is all three at once,
  // and the derive-don't-list design above means the guard now matches every
  // one of them. None of these is new code hardcoding what it should import.
  // ---------------------------------------------------------------------

  // The product vision document. Prose about the product, by definition names
  // the product; Markdown cannot import from `@app/shared`.
  'VISION.md',
  // The workspace root name. npm requires a literal here, and it is already a
  // `scripts/rename.mjs` codemod target.
  'package.json',
  // The npm `bin` key — the one place `CLI_NAME` provably cannot reach, since
  // npm reads this file before any code runs. `app.test.ts` asserts this key
  // equals `CLI_NAME` (from `identity.json`), and it is a codemod target under
  // `--cli-name`.
  'apps/cli/package.json',
  // Compose/env files: not JavaScript, so importing the manifest is
  // impossible. Each is an existing `scripts/rename.mjs` codemod target, the
  // same standing as `install.sh` above.
  'infra/compose/.env.example',
  'infra/compose/base.compose.yml',
  'infra/compose/test.compose.yml',
  // Worker container env plus one prose comment naming the enroll command.
  'infra/compose/.env.worker.example',
  'infra/compose/worker.compose.yml',
  // GENERATED by `platform-infra sync` from `cliName` in identity.json (#483): the
  // rendered CLI name in the stack-agent token message and the "kvox deploy
  // builds the list" prose, and the identity the lock records. Neither is
  // hand-edited (`sync --check` fails on it); a rename re-runs the sync.
  'infra/compose/vps.compose.yml',
  'infra/platform-infra.lock.json',

  // ---------------------------------------------------------------------
  // Added by epic #19 (issue #20), the transcription architecture spec.
  // ---------------------------------------------------------------------

  // Prose about the product, on the same standing as `VISION.md` above:
  // a design document arguing about what this product does names it, and
  // Markdown cannot import from `@app/shared`.
  'docs/specs/transcription.md',
  // A PUBLISHED FORMAT IDENTIFIER, not a display string — the same
  // standing as the `Symbol.for()` registry key in
  // `verbatim-error-body.exception.ts` above. `kvox.transcript/v1` is the
  // `$id`/`const` a third-party consumer matches on to recognise an export
  // it has already written a parser for, so it is deliberately PERMANENT:
  // rewriting it on a rebrand would silently invalidate every consumer of
  // every file exported before the rename, which is exactly the breakage a
  // versioned schema exists to prevent. A fork that wants its own format
  // publishes `<name>.transcript/v1` as a NEW schema beside this one; it
  // does not renumber this one. See docs/specs/transcription.md §8.2.
  'docs/specs/transcript-export.v1.schema.json',
  // The exporter that WRITES that `$id` into every document it renders
  // (issue #28). Exactly the same standing, for exactly the same reason: the
  // string is the published format identifier a third-party parser matches on,
  // not a display string, and a rebrand that rewrote it would invalidate every
  // consumer of every file exported before the rename. Everything else in the
  // file is product-neutral; the constant carries the argument at its own
  // declaration so nobody "tidies" it into a template literal.
  'apps/api/src/transcripts/export/json.exporter.ts',

  // ---------------------------------------------------------------------
  // Added by epic #45 (issue #46), the notes/AI architecture spec.
  // ---------------------------------------------------------------------

  // Prose about the product, on exactly the same standing as
  // `docs/specs/transcription.md` above: a design document arguing about
  // what this product does has to name it, and Markdown cannot import from
  // `@app/shared`. It is a `scripts/rename.mjs` codemod target like every
  // other Markdown document here.
  'docs/specs/notes.md',

  // Added by `docs(docs): add knowledge-graph ontology spec`. Same standing as
  // `docs/specs/notes.md` directly above: a design document arguing about
  // what this product does has to name it, and Markdown cannot import from
  // `@app/shared`. A `scripts/rename.mjs` codemod target like every other
  // Markdown document here.
  'docs/specs/ontology.md',

  // ---------------------------------------------------------------------
  // Comments naming the EXECUTABLE in files outside the CLI.
  //
  // The CLI's own sources used to be listed here too (a docstring naming
  // `kvox login` matches the repo-name pattern, because this fork set
  // `CLI_NAME` equal to its repository name). Since #482 the CLI is the
  // platform's engine plus `src/app.ts`; none of the app's own files spells the
  // name out, and a new one must not be added here: derive it from `CLI_NAME`
  // or say "this app".
  // ---------------------------------------------------------------------
  'apps/api/src/db-backup/restore-preflight.service.ts',
  'apps/api/src/transcripts/handlers/media-audio-transcode.handler.ts',

  // ---------------------------------------------------------------------
  // Added when the CLI rename from `appctl` to `kvox` finished across the
  // DOCUMENTATION (93 hits across 16 files).
  //
  // WHY THESE ARE HERE: the same collision the two blocks above already
  // describe, just in prose instead of code. This fork's CLI binary name
  // equals its repository name, so the moment these docs stopped saying
  // `appctl` and started saying `kvox`, every invocation example
  // (`kvox deploy`, `kvox node start`, `~/.kvox/config.json`) began matching
  // the `repoName` pattern too — a doc author showing a command and a doc
  // author hardcoding the product identity now look identical to a literal
  // scan. Markdown, YAML comments and READMEs cannot import from
  // `@app/shared`.
  //
  // The shapes differ across this group, and the reason tracks the shape:
  //   - Most of these (`docs/deployment/*`, `docs/runbooks/*`,
  //     `docs/specs/*`, `docs/ARCHITECTURE.md`, `docs/DEVICE-AUTH.md`,
  //     `docs/RENAMING.md`, `CLAUDE.md`, `packages/shared/README.md`) are
  //     Markdown prose or runbooks showing `kvox <subcommand>` invocations —
  //     the same standing as `VISION.md` and `docs/specs/transcription.md`
  //     above.
  //   - `.github/workflows/ci.yml` carries exactly one explanatory COMMENT
  //     naming the command (`kvox deploy`) inside an otherwise
  //     product-neutral file — the same standing as
  //     the CLI's own sources used to be, just outside `apps/cli`.
  //   - `.claude/skills/rename-app/SKILL.md` and
  //     `.claude/skills/rename-app/references/do-not-rename.md` are the
  //     rebranding instructions themselves: they necessarily discuss BOTH
  //     the current binary name and a hypothetical future one in the same
  //     breath, which a literal scan cannot tell apart from a hardcoded
  //     identity literal.
  //
  // WHAT THIS COSTS, STATED PLAINLY: `findOffenders` below skips an
  // allowlisted file ENTIRELY — for all four patterns at once, not just
  // `repoName`. So these 23 files are not merely exempt from matching
  // `kvox`; `productName` (`KVox`), `repoSlug` (`marinoscar/kvox`) and
  // `owner` (`marinoscar`) are unguarded in them too, and nothing here would
  // catch any of the four going stale. If a future fork renames the product
  // again, nothing will flag that these docs still say `kvox`.
  // `scripts/rename.mjs --cli-name` only rewrites `identity.json` and
  // `apps/cli/package.json` — the two files already allowlisted above
  // for exactly that reason — it does not touch a single word of
  // documentation. That is a manual step, and it is easy to forget:
  // `warnAboutCliRename()` is being updated to say so, listing
  // documentation as leftover work the operator still owns once the codemod
  // finishes.
  //
  // WHY WE ACCEPTED IT ANYWAY: the alternatives are worse. Renaming the
  // binary back to something neutral like `appctl` is rejected — the
  // product deliberately ships a command named after itself. Contorting
  // every doc to avoid ever naming the command it documents is rejected for
  // the same reason the docs below are allowlisted: it would make the
  // documentation worse, not the code safer.
  // ---------------------------------------------------------------------
  '.claude/skills/add-job-type/SKILL.md',
  '.claude/skills/add-settings-page/SKILL.md',
  '.claude/skills/rename-app/SKILL.md',
  '.claude/skills/rename-app/references/do-not-rename.md',
  '.github/workflows/ci.yml',
  // Assistant instructions (issue #456): they name the `kvox` binary and the
  // product the same way CLAUDE.md always did, and are its direct successors.
  'AGENTS.md',
  'CLAUDE.md',
  'apps/cli/AGENTS.md',
  'docs/ARCHITECTURE.md',
  'docs/DEVELOPMENT.md',
  'docs/DEVICE-AUTH.md',
  'docs/README.md',
  'docs/RENAMING.md',
  'docs/deployment/vps.md',
  'docs/deployment/worker-nodes.md',
  'docs/runbooks/database-restore.md',
  'docs/runbooks/maintenance-mode.md',
  'docs/specs/database-backup.md',
  // Added by `docs(docs): add a portable deploy CLI implementation spec`.
  // Same standing as `docs/specs/vps-deploy.md` directly below: an
  // implementation spec for a CLI whose command is named after the product
  // cannot document that command without naming it, and Markdown cannot
  // import from `@app/shared`.
  'docs/specs/deploy-spec.md',
  'docs/specs/vps-deploy.md',
  'docs/specs/worker-nodes.md',
  'packages/shared/README.md',
  // Platform-adoption baseline (issue #458): generated drift reports and the
  // hand-written module classification describe this repository by name (they
  // compare `kvox` against EnterpriseAppBase) and are frozen data, not rebrand
  // targets.
  'docs/platform-adoption/README.md',
  'docs/platform-adoption/drift-baseline-slices.json',
  'docs/platform-adoption/drift-baseline-slices.md',
  'docs/platform-adoption/drift-baseline.json',
  'docs/platform-adoption/drift-baseline.md',
  'docs/platform-adoption/module-classification.md',
  'scripts/platform-adoption/make-slice-view.sh',
  // Repository tooling for the platform adoption (issue #461): these files name
  // the `@marinoscar/platform-*` / `@marinoscar/kvox-*` npm scopes (an external
  // registry namespace, not a rebrand target) and the future workspace package
  // prefix, so a literal scan cannot tell them from a stale identity.
  '.changeset/README.md',
  'apps/api/package.json',
  'apps/web/package.json',
  'eslint.config.mjs',
  'package.json',
  'packages/kvox-slices.json',
  'scripts/check-platform-pin.mjs',
  'scripts/run-kvox-packages.mjs',
  'typedoc.base.json',

  // ---------------------------------------------------------------------
  // Added by issue #487 (epic #486), the `@marinoscar/kvox-*` package pipeline.
  //
  // The files under `packages/kvox-*/` and `scripts/kvox-packages/` are exempt
  // by prefix (`EXEMPT_PREFIXES` below). These are the pipeline's other files:
  // they name the published packages and their folders, the dist-tags, the
  // workflow files and branch the registry's trusted publisher is attached to
  // (`kvox-release.yml`, `npm-publish`), the repository slug in
  // `repository.url`, and the copyright holder of the MIT LICENSE. None of it
  // can be reworded without republishing under another name.
  // ---------------------------------------------------------------------
  '.changeset/kvox-packages-scaffold.md',
  '.github/workflows/kvox-packages.yml',
  '.github/workflows/kvox-release.yml',
  '.gitignore',
  'docs/PACKAGES.md',
  'docs/runbooks/release-kvox-packages.md',
  // Added by issue #490: the contract of the ports in `@marinoscar/kvox-api/ports`. It names the
  // package folders it documents (`packages/kvox-api/...`), on the same standing as PACKAGES.md.
  'docs/specs/kvox-ports.md',
  'LICENSE',

  // ---------------------------------------------------------------------
  // Added by issue #130 (epic #168), the VPS bootstrap script.
  //
  // `apps/cli/bootstrap-vps.sh` has exactly the standing of `install.sh`
  // above: it is fetched with curl and run on a fresh server BEFORE the
  // repository exists on disk, so it can never read the manifest — and it
  // wraps install.sh, so it names the same `kvox` binary and the same
  // `KVOX_SRC`/`KVOX_BIN_DIR` variables install.sh already hardcodes. It
  // carries no repository slug at all (`--repo` is a required argument with
  // no default, precisely so a fork never edits it); only the binary name
  // matches, and only because this fork's CLI is named after its repository.
  //
  // The two fixtures are that script's literal `--dry-run` output, compared
  // byte-for-byte by `bootstrap-vps.test.ts`. They inherit the exemption
  // because they ARE the script's text, not a second place the name is
  // spelled: regenerating them is the only way they change.
  // ---------------------------------------------------------------------
  'apps/cli/bootstrap-vps.sh',
  'apps/cli/src/__fixtures__/bootstrap-vps.dry-run.txt',
  'apps/cli/src/__fixtures__/bootstrap-vps.dry-run.update.txt',

  // ---------------------------------------------------------------------
  // Added by issue #463 (epic #462), the database baseline on platform-db.
  //
  // Every entry below names this repository, the `kvox` binary or the
  // `@marinoscar/platform-*` npm scope (an external registry namespace, not a
  // rebrand target), and none of them can import from `@app/shared`. As with
  // the blocks above, an allowlisted file is skipped for all four patterns.
  // ---------------------------------------------------------------------

  // Operator runbook for the baseline rehearsal: Markdown prose naming the
  // product, the `kvox` command and the platform package, like the other
  // runbooks above.
  'docs/runbooks/database-baseline.md',
  // Hand-written record of the declared deviations from the platform schema;
  // frozen data naming this repository, like the rest of docs/platform-adoption.
  'docs/platform-adoption/local-exceptions.md',
  // The platform-migration skill and its OpenCode twin (kept byte-identical by
  // the ai-assistant-config test): instructions that name the product, the
  // `kvox:` deviation ids and the `@marinoscar/platform-db` package.
  '.claude/skills/platform-migration/SKILL.md',
  '.opencode/skills/platform-migration/SKILL.md',
  // Baseline tooling: the `kvox:` deviation ids are PERMANENT identifiers
  // recorded in platform.lock and the drift allowlist (renaming them would
  // invalidate the recorded baseline), and platform-env.js resolves the real
  // `@marinoscar/platform-db` package at runtime.
  'apps/api/scripts/baseline-deviations.mjs',
  'apps/api/scripts/db-drift-kvox.mjs',
  'apps/api/scripts/platform-env.js',
  // Data written by the platform tooling and read back by the scripts above;
  // JSON cannot import from `@app/shared`, and the lock is regenerated by
  // `db:sync`, never hand-edited.
  'apps/api/prisma/platform.lock',
  'apps/api/prisma/drift-allowlist.json',
  // GENERATED by `npm run db:compose` from the platform fragments; never
  // hand-edited. Their comments cite `@marinoscar/platform-api/*` subpaths.
  'apps/api/prisma/schema/platform.ai.prisma',
  'apps/api/prisma/schema/platform.credentials.prisma',
  'apps/api/prisma/schema/platform.jobs.prisma',

  // ---------------------------------------------------------------------
  // Added by issue #465 (epic #462), the app adopting the platform packages.
  //
  // `@marinoscar/platform-*` / `@marinoscar/kvox-*` specifiers are NOT listed
  // here: `stripRegistryScopes` hides them from the scan, so source files that
  // merely import a platform package need no entry. Only the files below carry
  // a genuine product-name literal that cannot be reworded.
  // ---------------------------------------------------------------------

  // The `kvox:allowlist-reminders` deviation id is a PERMANENT identifier
  // recorded in platform.lock and the drift allowlist; renaming it would
  // invalidate the recorded baseline. The fragment is hand-edited, and the
  // schema file is composed from it by `npm run db:compose`.
  'apps/api/prisma/fragments/allowlist-reminders.prisma',
  'apps/api/prisma/schema/app.allowlist-reminders.prisma',
  // Applied migrations are immutable history (editing one breaks its checksum),
  // and SQL cannot import from `@app/shared`.
  'apps/api/prisma/migrations/20261015125136_kvox_allowlist_reminders/migration.sql',
  'apps/api/prisma/migrations/20261015125334_kvox_scope_domain_permissions/migration.sql',
  // Assistant instructions for apps/web, the same standing as AGENTS.md and
  // apps/cli/AGENTS.md above: Markdown naming the product, no `@app/shared`.
  'apps/web/AGENTS.md',

  // ---------------------------------------------------------------------
  // Added by issue #469 (epic #467), the storage slice.
  //
  // The application's own storage routes and folder are named after the
  // product (`GET /api/kvox/files`, `apps/api/src/kvox-objects/`, the
  // `kvox.transcripts.source` processor name), and the docs below must quote
  // those names to be of any use to an operator or a client author. Markdown
  // cannot import from `@app/shared`; a renamed fork edits these along with
  // the code.
  // ---------------------------------------------------------------------
  'docs/API.md',
  'docs/SECURITY-ARCHITECTURE.md',
  'docs/runbooks/s3-cors.md',
  'docs/runbooks/storage-configuration.md',

  // ---------------------------------------------------------------------
  // Added by issue #489 (epic #486), `@marinoscar/kvox-db` and `kvox-db sync`.
  //
  // `kvox.lock` and the `kvox.<slice>.prisma` fragment copies are named after
  // the `@marinoscar/kvox-db` package that writes them, and `kvox-db` is the
  // command it ships: names that are fixed by the package (an npm registry
  // namespace, like `@marinoscar/platform-*`), not by this fork's identity.
  // The package folder itself is exempt by prefix (`packages/kvox-`).
  // ---------------------------------------------------------------------

  // The lock `kvox-db sync` writes: JSON whose `originId` values are the
  // permanent `kvox:<migration id>` identifiers, like the `kvox:` deviation ids
  // in platform.lock.
  'apps/api/prisma/kvox.lock',
  // The wrapper that builds DATABASE_URL and runs the `kvox-db` bin, the twin
  // of platform-env.js above.
  'apps/api/scripts/kvox-db-env.js',
  // Operator runbook for authoring a domain migration with `kvox-db`: Markdown
  // quoting the command, the lock and the package, like the other runbooks.
  'docs/runbooks/kvox-domain-migration.md',
  // GENERATED by `npm run db:compose`: the composed models of the platform
  // carry `// composed from app:kvox.<slice>.prisma` comments for the domain
  // fragments' `extend model` blocks.
  'apps/api/prisma/schema/platform.identity.prisma',
  'apps/api/prisma/schema/platform.storage.prisma',
]);

// Deliberately NOT allowlisted, on purpose, spelled out so nobody "fixes" this
// guard by adding them back:
//   - apps/api/src/openapi/document.ts
//   - apps/api/src/openapi/description.ts
// Both now import `REPO_URL` from `@app/shared` instead of hardcoding the
// repository. This guard is what keeps them that way — allowlisting them
// would silently permit the regression it exists to catch.

const MANIFEST_FILE_LINE_RE = /\bkvox\.(?:settings-)?manifest(?:\.ts)?\b/;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Folders whose every file is exempt (issue #487): the `@marinoscar/kvox-*`
 * packages are named after the product by design (their folders, `bin` name,
 * `repository` fields, READMEs and the pipeline scripts that check them), and a
 * published package name is not a rebrand target. Listing each file would add
 * ~50 entries that every new package file must extend.
 */
// `apps/api/prisma/fragments/kvox.` and `apps/api/prisma/schema/app.kvox.` are the
// `kvox-db sync` copies of `packages/kvox-db/schema/*` and what `db:compose` makes
// of them: generated byte copies of an already-exempt folder.
const EXEMPT_PREFIXES: readonly string[] = [
  'packages/kvox-',
  'scripts/kvox-packages/',
  // Changesets for the published packages name them (`.changeset/kvox-*.md`).
  '.changeset/kvox-',
  'apps/api/prisma/fragments/kvox.',
  'apps/api/prisma/schema/app.kvox.',
];
const BINARY_EXT_RE = /\.(png|ico|jpg|jpeg|gif|woff2?|ttf|pdf|zip)$/i;
const EXTRA_EXEMPT: ReadonlySet<string> = new Set([
  // A generated lockfile, not authored prose; renaming rewrites it via
  // `npm install`, never via this codemod or this guard.
  'package-lock.json',
  // History is never rewritten.
  'CHANGELOG.md',
]);

/**
 * Enumerate every file the guard should consider.
 *
 * `git ls-files -z` rather than a filesystem walk, for three reasons stated
 * here because they are easy to lose on a later edit:
 *
 *   1. It respects `.gitignore` for free. `node_modules`, `dist`, and any
 *      build output never enter the scan, without this file having to know
 *      their names.
 *   2. It cannot wander into a directory that merely EXISTS on disk but was
 *      never committed — three build artifacts were untracked out of this
 *      repository and are still sitting on disk in some checkouts; a
 *      filesystem walk would happily scan them, a git-based one will not.
 *   3. It is what makes the non-vacuity check below meaningful: "scanned
 *      1059 tracked files" is a real claim about the repository, not an
 *      artifact of whatever happens to be present in this container.
 *
 * `-z` (NUL-separated) rather than newline-separated output, because a
 * filename could in principle contain a newline; NUL cannot appear in a path.
 *
 * If git itself fails, THIS TEST FAILS LOUDLY rather than falling back to an
 * empty list. A guard that silently scans nothing on a broken git and reports
 * green is worse than having no guard at all — it would look like protection
 * while providing none.
 */
function listTrackedFiles(): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    throw new Error(
      `template-identity guard: \`git ls-files -z\` failed, so this test cannot ` +
        `verify anything and must not report a pass. Underlying error: ${String(err)}`,
    );
  }
  return output.split('\0').filter(Boolean);
}

/** Escape regex metacharacters in a literal value. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a word-boundary pattern for one forbidden value.
 *
 * Plain substring matching would flag a product named `Bit` inside the word
 * `Bitmap`. `\b` is only meaningful next to a word character, so it is added
 * at an end of the pattern only when the value itself starts/ends with one
 * (a slug like `owner/repo` starts and ends with word characters; this still
 * does the right thing for values that don't).
 */
function wordBoundaryPattern(value: string): RegExp {
  const escaped = escapeRegExp(value);
  const lead = /^\w/.test(value) ? '\\b' : '';
  const tail = /\w$/.test(value) ? '\\b' : '';
  // Deliberately CASE-SENSITIVE (no `i` flag). This is what lets
  // `apps/api/src/common/crypto/secret-cipher.ts`'s HKDF label
  // `'enterpriseappbase:secret-cipher:v1:'` (lowercase) pass with no
  // allowlist entry — that label must NEVER change, because doing so makes
  // every already-stored credential permanently undecryptable. A
  // case-insensitive guard would force either rewriting that label (forbidden)
  // or adding a special-case allowlist entry to excuse it; case-sensitivity
  // needs neither.
  return new RegExp(`${lead}${escaped}${tail}`);
}

/**
 * Registry scope specifiers that are NOT identity literals (issue #465, epic #462).
 *
 * `@marinoscar/platform-*` (api, web, db, contract, ...) and `@marinoscar/kvox-*`
 * are npm packages published under an external registry namespace. The scope
 * belongs to the registry account that owns the packages, so a fork rename must
 * NEVER change it, and `scripts/rename.mjs` does not (its edits are literal,
 * URL-anchored finds that never match an `@scope/` specifier). Without this,
 * every source file that imports a platform package would match the `owner`
 * pattern and would need its own allowlist entry.
 *
 * Deliberately NARROW, hardcoded rather than derived from identity.json (the
 * scope does not follow the repository owner on a fork): only these two
 * package-name prefixes are removed. A bare `marinoscar`, the `marinoscar/kvox`
 * repo slug, a `github.com/marinoscar/...` URL and any other `@marinoscar/<x>`
 * scope are left in place and still flagged.
 */
const REGISTRY_SCOPE_RE = /@marinoscar\/(?:platform|kvox)-[\w-]*(?:\/[\w.-]+)*/g;

/** Remove registry scope specifiers from a line before identity matching. */
function stripRegistryScopes(lineText: string): string {
  return lineText.replace(REGISTRY_SCOPE_RE, '');
}

/**
 * Identifiers the storage adoption (issue #469, epic #467) fixes by name: the `kvox-objects/` module and
 * its classes, the `kvox_object_ownership` table, the `GET /api/kvox/files` route, the `kvox.transcripts.source`
 * processor name, the retired `kvox:storage-managed-by-part-size` deviation id and (#471) the
 * `20-kvox-extensions.sh` init script and `kvox.extensions` restore-gate id, and (#490) the
 * `platform-kvox/` folder of the web edition's port adapters and the paths inside it. They are stripped per
 * token, like the registry scopes above, so any other mention of the product name on the same line is
 * still flagged. A rename of the product renames these with the module directory.
 */
const STORAGE_ADOPTION_TOKEN_RE =
  /\bKvox(?:ManagedObjects|ObjectOwnership|Objects|Files|Multipart|S3PartLister)\w*|\bkvox(?:-objects|-managed-objects|-object-ownership|-s3-part-lister|-files|-multipart)[\w./-]*|\bkvox_object_ownership\b|\bkvoxOwnership\b|\/api\/kvox\/files|\bkvox:storage-managed-by-part-size\b|\bkvox\.transcripts\.source\b|\b20-kvox-extensions(?:\.sh)?\b|\bkvox\.extensions\b|\bkvox-ai[\w.-]*|\bplatform-kvox[\w./-]*/g;

function stripStorageAdoptionTokens(lineText: string): string {
  return lineText.replace(STORAGE_ADOPTION_TOKEN_RE, '');
}

interface Offender {
  file: string;
  line: number;
  text: string;
  value: string;
}

function findOffenders(files: string[], patterns: { value: string; re: RegExp }[]): Offender[] {
  const offenders: Offender[] = [];

  for (const file of files) {
    if (ALLOWLIST.has(file) || EXTRA_EXEMPT.has(file)) continue;
    if (EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    if (TEST_FILE_RE.test(file)) continue; // .test.ts/.spec.ts/.test.tsx/.spec.tsx — see below
    if (BINARY_EXT_RE.test(file)) continue;

    let content: string;
    try {
      content = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      // Unreadable (e.g. a binary file with an extension this list doesn't
      // know about, or a broken symlink) — nothing to scan as text.
      continue;
    }

    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      // `apps/api/src/kvox.manifest.ts` (issue #459) and `kvox.settings-manifest.ts` (#460) are the API's composition
      // root and every entry point imports it by that name. Its filename is a
      // permanent anchor on the same standing as the codemod anchors above:
      // a rename of the product renames that one file with `git mv` plus its
      // import lines, which a line-level scan for the file's name can find on
      // its own. Only lines that name that file are exempt; any other mention
      // of the product name on the same file is still flagged.
      if (MANIFEST_FILE_LINE_RE.test(lineText)) return;
      const scanned = stripStorageAdoptionTokens(stripRegistryScopes(lineText));
      for (const { value, re } of patterns) {
        if (re.test(scanned)) {
          offenders.push({ file, line: idx + 1, text: lineText.trim().slice(0, 160), value });
        }
      }
    });
  }

  return offenders;
}

describe('stripRegistryScopes (issue #465): the external npm scope is not an identity literal', () => {
  const ownerRe = wordBoundaryPattern('marinoscar');
  const flagged = (line: string): boolean => ownerRe.test(stripRegistryScopes(line));

  it.each([
    "import { x } from '@marinoscar/platform-api/identity';",
    'import { y } from "@marinoscar/platform-web";',
    "// see @marinoscar/platform-db and @marinoscar/platform-contract/schemas",
    "const p = require('@marinoscar/kvox-slices');",
  ])('hides %s', (line) => {
    expect(flagged(line)).toBe(false);
  });

  it('leaves the surrounding text intact', () => {
    expect(stripRegistryScopes("from '@marinoscar/platform-api/identity';")).toBe("from '';");
  });

  it.each([
    'see marinoscar/kvox for details',
    'owner: marinoscar',
    'https://github.com/marinoscar/anything',
    "import x from '@marinoscar/other-package';",
    "import x from '@marinoscar/platform';",
  ])('still flags %s', (line) => {
    expect(flagged(line)).toBe(true);
  });

  it('still flags a real literal on the same line as a scope specifier', () => {
    expect(flagged("from '@marinoscar/platform-api'; // github.com/marinoscar/kvox")).toBe(true);
  });
});

describe('no stale identity literal outside the allowlist (issue #343, epic #341)', () => {
  const identity = readManifest();

  // `split` is typed as possibly-sparse under `noUncheckedIndexedAccess`, so the
  // halves have to be narrowed rather than asserted. Throwing here is the right
  // failure: a repoSlug that is not `owner/name` means the guard would silently
  // scan for `undefined` and pass while protecting nothing, which is the one
  // outcome this file exists to prevent. The shape test above covers the same
  // ground with a readable message; this is the belt to its braces.
  const slugParts = identity.repoSlug.split('/');
  const [owner, repoName] = slugParts;
  if (slugParts.length !== 2 || !owner || !repoName) {
    throw new Error(
      `identity.json repoSlug must be "owner/name", got ${JSON.stringify(identity.repoSlug)}`,
    );
  }

  const patterns = [
    { value: identity.productName, re: wordBoundaryPattern(identity.productName) },
    { value: identity.repoSlug, re: wordBoundaryPattern(identity.repoSlug) },
    { value: owner, re: wordBoundaryPattern(owner) },
    { value: repoName, re: wordBoundaryPattern(repoName) },
  ];

  const files = listTrackedFiles();

  it('scans a real corpus (the guard is not vacuously green)', () => {
    // ~1059 tracked files at the time this guard was written.
    expect(files.length).toBeGreaterThan(500);
  });

  it('finds no occurrence of the product name, repo slug, owner, or repo name outside the allowlist', () => {
    const offenders = findOffenders(files, patterns);

    if (offenders.length > 0) {
      const report = offenders
        .map(
          (o) =>
            `  ${o.file}:${o.line}  [${o.value}]  ${o.text}\n` +
            `      -> import from '@app/shared' (APP_NAME/REPO_SLUG/REPO_URL/...) instead of ` +
            `hardcoding it, or add a one-line-reason allowlist entry to this test if the literal ` +
            `is genuinely not a rebrand target (e.g. a registry key or a permanent codemod anchor).`,
        )
        .join('\n');
      throw new Error(
        `Found ${offenders.length} stale identity literal(s) outside the allowlist:\n\n${report}`,
      );
    }

    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// The two hand-written SVGs
// =============================================================================
//
// `apps/web/scripts/generate-icons.py` explicitly does NOT rasterise these two
// files — rendering an SVG needs a toolchain this template refuses to require
// — so nothing else keeps their hardcoded colour in step with a rebrand. A
// rename that missed them would leave the browser tab (favicon) or the PWA's
// master icon on the old brand colour forever.
//
// This deliberately does NOT scan the repository generally for THEME_COLOR:
// `#1976d2` (and `#ffffff`) legitimately appear elsewhere on purpose —
// `OAuthButton.tsx`, `theme/light.ts`, `theme/dark.ts`,
// `email/templates/layout.ts`, and three contrast-ratio test utilities (~15
// hits today) — so a general scan would be unworkable noise, not a guard.
// `scripts/rename.mjs`'s own `residualScan` makes the identical decision for
// the identical reason. These two files are singled out instead, anchored on
// the exact `fill="..."` attribute `rename.mjs` edits on the background rect.
describe('the hand-written brand SVGs carry the current THEME_COLOR', () => {
  const identity = readManifest();

  it.each(['apps/web/public/favicon.svg', 'apps/web/public/icons/source.svg'])(
    '%s has fill="<THEME_COLOR>" on its background rect',
    (relPath) => {
      const content = readFileSync(join(REPO_ROOT, relPath), 'utf8');
      expect(content).toContain(`fill="${identity.themeColor}"`);
    },
  );
});
