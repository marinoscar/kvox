#!/usr/bin/env node
// =============================================================================
// scripts/rename.mjs — rebrand a fork of this template  (issue #343, epic #341)
// =============================================================================
//
// This repository is a starting point, never a destination. Renaming it used to
// mean editing `packages/shared/identity.json` and then hand-finding every
// identity string that no runtime read can reach. This script is that second
// half, made mechanical.
//
// -----------------------------------------------------------------------------
// THE TWO PROPERTIES THAT MATTER
// -----------------------------------------------------------------------------
//
// 1. IT IS IDEMPOTENT, because it reads the PREVIOUS values out of
//    `identity.json` rather than hardcoding an old name anywhere. That is what
//    makes it work on the tenth fork as well as on the first: a rename is
//    always "old value -> new value", and the old value is always knowable.
//    Running it twice with the same arguments changes nothing the second time.
//
// 2. EVERY EDIT DECLARES ITS EXPECTED HIT COUNT, and a mismatch is a hard
//    failure. A codemod whose pattern silently stops matching is worse than no
//    codemod at all: it reports success and leaves the old name in a published
//    OpenAPI document. If this script fails with a hit-count mismatch, the
//    right response is to fix the anchor here — never to loosen it.
//
// -----------------------------------------------------------------------------
// WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
// -----------------------------------------------------------------------------
//
//   - It does not commit. Commit granularity is a judgement call the repository
//     has rules about; a self-committing codemod produces exactly the "misc
//     fixes" bundle those rules forbid.
//   - It does not add keys to `infra/compose/.env.example`. That file is
//     validated by `apps/cli/src/deploy/env-spec.test.ts`, which counts even
//     COMMENTED `# KEY=value` lines as declarations. Changing a value is safe;
//     adding a key breaks the CLI's test suite.
//   - It does not regenerate the visual baselines, and cannot: they are only
//     ever produced inside a pinned Playwright container. It prints the command.
//   - It does not touch anything on the do-not-rename list. See DO_NOT_RENAME
//     below — one entry there is genuinely destructive to get wrong.
//
// Full guide: docs/RENAMING.md
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(REPO_ROOT, 'packages', 'shared', 'identity.json');

// -----------------------------------------------------------------------------
// Things that must never be renamed, restated here so the script is the place
// somebody looks. `docs/RENAMING.md` carries the same table with fuller
// consequences; `.claude/skills/rename-app/references/do-not-rename.md` carries
// it for an agent.
// -----------------------------------------------------------------------------
const DO_NOT_RENAME = [
  ['apps/api/src/common/crypto/secret-cipher.ts', "the HKDF label 'enterpriseappbase:secret-cipher:v1:' — changing it makes every stored credential permanently undecryptable"],
  ['apps/api/src/common/exceptions/verbatim-error-body.exception.ts', 'a cross-realm Symbol.for() registry key'],
  ['apps/cli/src/deploy/proxy.ts', "the '# Managed by appctl deploy' sentinel, which is written AND parsed on live servers"],
  ['apps/cli/src/deploy/state.ts', "the '.appctl-deploy.json' filename, read from live servers"],
];

// =============================================================================
// Argument parsing
// =============================================================================

const USAGE = `
Rebrand this template.

  node scripts/rename.mjs --name "Acme Hub" [options]

Options:
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
Full guide: docs/RENAMING.md
`.trimStart();

function parseArgs(argv) {
  const opts = { dryRun: false, force: false };
  const takesValue = {
    '--name': 'name', '--repo': 'repo', '--theme': 'theme',
    '--background': 'background', '--tagline': 'tagline', '--cli-name': 'cliName',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--force') { opts.force = true; continue; }
    const key = takesValue[arg];
    if (!key) die(`Unknown argument: ${arg}\n\n${USAGE}`);
    const value = argv[++i];
    if (value === undefined) die(`${arg} needs a value.`);
    opts[key] = value;
  }
  return opts;
}

function die(message) {
  console.error(`\nrename: ${message}\n`);
  process.exit(1);
}

// =============================================================================
// Validation
//
// Each rule exists because something downstream enforces it, not for tidiness.
// =============================================================================

const HEX = /^#[0-9a-f]{6}$/i;
const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;
// The constraint documented in apps/cli/src/branding.ts: the CLI name seeds a
// config directory name and an environment-variable prefix, so it must survive
// both `.${name}` and `${NAME.toUpperCase()}_` intact.
const CLI_NAME = /^[a-z][a-z0-9-]*$/;

function validate(opts) {
  if (opts.theme !== undefined && !HEX.test(opts.theme)) {
    die(`--theme must be a 6-digit hex colour like #7c3aed, got: ${opts.theme}\n` +
        `A PWA manifest's theme_color is parsed by the platform rather than by a CSS\n` +
        `engine, and the 3-digit and rgb() forms are not reliably accepted there.`);
  }
  if (opts.background !== undefined && !HEX.test(opts.background)) {
    die(`--background must be a 6-digit hex colour like #ffffff, got: ${opts.background}`);
  }
  if (opts.repo !== undefined && !REPO_SLUG.test(opts.repo)) {
    die(`--repo must be owner/name, got: ${opts.repo}`);
  }
  if (opts.cliName !== undefined && !CLI_NAME.test(opts.cliName)) {
    die(`--cli-name must be lowercase letters, digits and hyphens, starting with a\n` +
        `letter (it becomes ~/.${opts.cliName || 'name'} and ${(opts.cliName || 'NAME').toUpperCase()}_), got: ${opts.cliName}`);
  }
  if (opts.name !== undefined && opts.name.trim() === '') {
    die('--name cannot be empty.');
  }
  if (opts.name !== undefined && slugify(opts.name) === NEUTRAL_SLUG) {
    console.warn(
      `\nrename: warning — "${opts.name}" slugifies to nothing, so the slug falls back to\n` +
      `  "${NEUTRAL_SLUG}". The OpenTelemetry service name will be "${NEUTRAL_SLUG}-api".\n` +
      `  That is survivable but not distinctive; consider a name with Latin letters or digits.\n`);
  }
}

// =============================================================================
// Derivations — byte-for-byte the rule in packages/shared/index.js
// =============================================================================

const NEUTRAL_SLUG = 'app';

function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : NEUTRAL_SLUG;
}

/** Everything downstream of one identity, so old and new are computed the same way. */
function derive(identity, cliName) {
  const slug = slugify(identity.productName);
  return {
    ...identity,
    slug,
    serviceName: `${slug}-api`,
    // Postgres identifiers cannot carry a hyphen unquoted.
    testDb: `${slug.replace(/-/g, '_')}_test`,
    testContainer: `${slug}-db-test`,
    repoUrl: `https://github.com/${identity.repoSlug}`,
    rawUrl: `https://raw.githubusercontent.com/${identity.repoSlug}`,
    cloneUrl: `https://github.com/${identity.repoSlug}.git`,
    repoName: identity.repoSlug.split('/')[1],
    cliName,
  };
}

// =============================================================================
// The edit plan
//
// Every entry is a literal find/replace with a declared hit count. Literal, not
// regex, so nothing can match more than it means to.
// =============================================================================

function buildPlan(old, next) {
  /** @type {{file: string, find: string, replace: string, expectedHits: number, why: string}[]} */
  const edits = [];
  const add = (file, find, replace, expectedHits, why) => {
    if (find !== replace) edits.push({ file, find, replace, expectedHits, why });
  };

  // --- The product name -------------------------------------------------
  // Only the README carries it as prose; docs/ was deliberately made generic so
  // that it needs no codemod and no guard allowlist entry.
  add('README.md', `# ${old.productName}\n`, `# ${next.productName}\n`, 1,
      'the README title is the product name');
  add('README.md', old.tagline, next.tagline, 1,
      'the README subtitle');

  // --- The repository slug ----------------------------------------------
  // install.sh can never read the manifest: it is fetched and run via
  // `curl | bash` BEFORE the repository exists on disk. Permanent codemod target.
  add('install.sh', old.rawUrl, next.rawUrl, 1, 'the curl|bash install URL in the header comment');
  add('install.sh', old.cloneUrl, next.cloneUrl, 2, 'the APPCTL_REPO default and its documentation');
  add('apps/cli/README.md', old.rawUrl, next.rawUrl, 2, 'the install and uninstall one-liners');
  add('apps/cli/README.md', old.cloneUrl, next.cloneUrl, 1, 'the APPCTL_REPO default in the env table');
  add('README.md', `https://github.com/${old.repoSlug}/actions`, `https://github.com/${next.repoSlug}/actions`, 2,
      'the CI badge image and its link target');
  add('README.md', `cd ${old.repoName}\n`, `cd ${next.repoName}\n`, 1, 'the clone instructions');
  add('README.md', `${old.repoName}/\n`, `${next.repoName}/\n`, 1, 'the root of the directory tree');

  // --- The OpenTelemetry service name -----------------------------------
  // The code fallback follows APP_SLUG (see common/otel/service-name.ts); these
  // two are Compose defaults, which no JavaScript read can reach.
  add('infra/compose/.env.example', `OTEL_SERVICE_NAME=${old.serviceName}`, `OTEL_SERVICE_NAME=${next.serviceName}`, 1,
      'the documented default — note: a VALUE change only, never a new key, or env-spec.test.ts fails');
  add('infra/compose/base.compose.yml', `OTEL_SERVICE_NAME:-${old.serviceName}`, `OTEL_SERVICE_NAME:-${next.serviceName}`, 1,
      'the Compose fallback');

  // --- Test database and container --------------------------------------
  add('infra/compose/test.compose.yml', `container_name: ${old.testContainer}`, `container_name: ${next.testContainer}`, 1,
      'the test database container name');
  add('infra/compose/test.compose.yml', `POSTGRES_DB: ${old.testDb}`, `POSTGRES_DB: ${next.testDb}`, 1,
      'the test database name');
  add('apps/api/.env.test', old.testDb, next.testDb, 2, 'POSTGRES_DB and the DATABASE_URL built from it');
  add('scripts/dev.ps1', `"${old.testDb}"`, `"${next.testDb}"`, 1, 'the test database the dev script points at');

  // --- The npm workspace root name --------------------------------------
  // npm reads this before any of our code runs, so it cannot derive.
  add('package.json', `"name": "${old.slug}",`, `"name": "${next.slug}",`, 1,
      'the workspace root name — remember `npm install` afterwards, the lockfile carries it too');

  // --- Brand colour in the two hand-written vectors ----------------------
  // generate-icons.py reads the manifest now, but it deliberately does NOT
  // rasterise these two: rendering an SVG needs a toolchain this template
  // refuses to require. Anchored on the `fill` attribute of the background
  // rect so the white mark in the same file is never repainted.
  add('apps/web/public/favicon.svg', `fill="${old.themeColor}"`, `fill="${next.themeColor}"`, 1,
      'the favicon background plate');
  add('apps/web/public/icons/source.svg', `fill="${old.themeColor}"`, `fill="${next.themeColor}"`, 1,
      'the icon master background plate');

  // --- The CLI binary, only when explicitly asked for --------------------
  if (next.cliName !== old.cliName) {
    add('apps/cli/src/branding.ts', `export const CLI_NAME = '${old.cliName}';`, `export const CLI_NAME = '${next.cliName}';`, 1,
        'the CLI identity seed');
    add('apps/cli/package.json', `"${old.cliName}": "./dist/cli.js"`, `"${next.cliName}": "./dist/cli.js"`, 1,
        'the bin key — branding.test.ts asserts this equals CLI_NAME');
  }

  return edits;
}

// =============================================================================
// Execution
// =============================================================================

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { count++; i = haystack.indexOf(needle, i + needle.length); }
  return count;
}

function applyPlan(edits, { dryRun }) {
  const problems = [];
  const applied = [];

  for (const edit of edits) {
    const path = join(REPO_ROOT, edit.file);
    if (!existsSync(path)) {
      problems.push(`${edit.file}: file not found`);
      continue;
    }
    const before = readFileSync(path, 'utf8');
    const hits = countOccurrences(before, edit.find);

    if (hits !== edit.expectedHits) {
      // Already-applied is not a failure: it is what idempotency looks like.
      const alreadyDone = hits === 0 && countOccurrences(before, edit.replace) >= edit.expectedHits;
      if (alreadyDone) {
        applied.push({ ...edit, hits: 0, skipped: true });
        continue;
      }
      problems.push(
        `${edit.file}: expected ${edit.expectedHits} occurrence(s) of ${JSON.stringify(edit.find)}, found ${hits}\n` +
        `      (${edit.why})`);
      continue;
    }

    if (!dryRun) writeFileSync(path, before.split(edit.find).join(edit.replace));
    applied.push({ ...edit, hits, skipped: false });
  }

  return { applied, problems };
}

function writeManifest(next, { dryRun }) {
  const out = {
    productName: next.productName,
    tagline: next.tagline,
    repoSlug: next.repoSlug,
    themeColor: next.themeColor,
    backgroundColor: next.backgroundColor,
  };
  if (!dryRun) writeFileSync(MANIFEST, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/**
 * Look for anything still carrying an OLD value.
 *
 * This lives here rather than in a committed test because the previous value is
 * only knowable at rename time — a test in the repository can only ever guard
 * the CURRENT name (which `template-identity.test.ts` does).
 */
function residualScan(old, next) {
  // The theme colour is deliberately NOT scanned for. Unlike a product name it
  // is an ambiguous token: `#1976d2` legitimately appears in an OAuth button, in
  // contrast-ratio test fixtures and in doc comments that use it as an example,
  // so scanning for it produces half a dozen false positives on every run and
  // trains the reader to skim past the list. The two places that genuinely must
  // follow it are the SVGs, which have explicit anchors above and a dedicated
  // assertion in template-identity.test.ts.
  const stale = [
    [old.productName, next.productName],
    [old.repoSlug, next.repoSlug],
    [old.repoName, next.repoName],
    [old.serviceName, next.serviceName],
    [old.testDb, next.testDb],
  ].filter(([o, n]) => o !== n).map(([o]) => o);

  if (stale.length === 0) return [];

  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch {
    console.warn('rename: could not list git files, skipping the residual scan.');
    return [];
  }

  // CHANGELOG.md is history and is never rewritten. The do-not-rename files
  // hold values that only LOOK like identity.
  const exempt = new Set(['CHANGELOG.md', ...DO_NOT_RENAME.map(([f]) => f)]);
  const findings = [];

  // Match on word boundaries rather than as a bare substring, so a product name
  // does not flag a longer word that merely starts with it (a product called
  // "Bit" would otherwise flag every "Bitmap" in the repository). `\b` is only meaningful next to a word character, so it is
  // applied per end of the pattern.
  const patterns = stale.map((value) => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lead = /^\w/.test(value) ? '\\b' : '';
    const tail = /\w$/.test(value) ? '\\b' : '';
    return new RegExp(`${lead}${escaped}${tail}`);
  });

  for (const file of files) {
    if (exempt.has(file)) continue;
    if (/\.(png|ico|jpg|jpeg|gif|woff2?|ttf|pdf|zip)$/i.test(file)) continue;
    // Test files hold identity literals ON PURPOSE — as assertions that a name
    // is absent, or as sample inputs to a slugify rule. Same carve-out, and the
    // same reason, as template-identity.test.ts and env-prefix.test.ts.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    let text;
    try { text = readFileSync(join(REPO_ROOT, file), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      for (const pattern of patterns) {
        if (pattern.test(line)) findings.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return findings;
}

// =============================================================================
// Main
// =============================================================================

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }

  const changing = ['name', 'repo', 'theme', 'background', 'tagline', 'cliName']
    .some((k) => opts[k] !== undefined);
  if (!changing) die(`nothing to change.\n\n${USAGE}`);

  validate(opts);

  if (!opts.dryRun && !opts.force) {
    let dirty = '';
    try {
      dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch {
      die('not a git repository (or git is unavailable). Re-run with --force to skip this check.');
    }
    if (dirty) {
      die('the working tree has uncommitted changes.\n' +
          '  This script rewrites files in place, and a clean tree is what makes\n' +
          '  `git checkout .` a complete undo. Commit or stash first, or pass --force.');
    }
  }

  if (!existsSync(MANIFEST)) die(`manifest not found at ${MANIFEST}`);
  const current = JSON.parse(readFileSync(MANIFEST, 'utf8'));

  const oldCliName = readCliName();
  const old = derive(current, oldCliName);
  const next = derive({
    productName: opts.name ?? current.productName,
    tagline: opts.tagline ?? current.tagline,
    repoSlug: opts.repo ?? current.repoSlug,
    themeColor: (opts.theme ?? current.themeColor).toLowerCase(),
    backgroundColor: (opts.background ?? current.backgroundColor).toLowerCase(),
  }, opts.cliName ?? oldCliName);

  if (next.cliName !== old.cliName) warnAboutCliRename(old.cliName, next.cliName);

  const edits = buildPlan(old, next);
  const { applied, problems } = applyPlan(edits, opts);

  console.log(`\n${opts.dryRun ? 'Planned' : 'Applied'} edits (${old.productName} -> ${next.productName}):\n`);
  for (const e of applied) {
    console.log(e.skipped
      ? `  = ${e.file}  (already applied)`
      : `  ${opts.dryRun ? '~' : '*'} ${e.file}  ${e.hits}x  ${JSON.stringify(e.find.slice(0, 60))}`);
  }
  if (applied.length === 0) console.log('  (none — every target already carries the new values)');

  if (problems.length > 0) {
    console.error(`\nrename: ${problems.length} anchor(s) did not match as declared:\n`);
    for (const p of problems) console.error(`    ${p}`);
    console.error(
      `\n  Nothing has been written${opts.dryRun ? '' : ' for these files'}. An anchor that stops matching means the\n` +
      `  file changed shape since this script was written. Fix the anchor in\n` +
      `  scripts/rename.mjs — do NOT loosen it, because a codemod that silently\n` +
      `  matches nothing is how the old name ends up in a published OpenAPI document.\n`);
    process.exit(1);
  }

  const written = writeManifest(next, opts);
  console.log(`\n  ${opts.dryRun ? '~' : '*'} packages/shared/identity.json  (structured write)`);
  for (const [k, v] of Object.entries(written)) console.log(`      ${k}: ${JSON.stringify(v)}`);

  if (!opts.dryRun) {
    regenerateIcons(old, next);
    const residual = residualScan(old, next);
    if (residual.length > 0) {
      console.log(`\nStill carrying an old value (${residual.length} line(s)) — review each:\n`);
      for (const line of residual.slice(0, 40)) console.log(`    ${line}`);
      if (residual.length > 40) console.log(`    ... and ${residual.length - 40} more`);
    } else {
      console.log('\nResidual scan: clean.');
    }
  }

  printChecklist(old, next, opts);
}

function readCliName() {
  const path = join(REPO_ROOT, 'apps', 'cli', 'src', 'branding.ts');
  if (!existsSync(path)) return null;
  const match = readFileSync(path, 'utf8').match(/^export const CLI_NAME = '([^']+)';/m);
  return match ? match[1] : null;
}

function warnAboutCliRename(from, to) {
  console.warn(`
  ────────────────────────────────────────────────────────────────────────────
  RENAMING THE CLI BINARY: ${from} -> ${to}

  This is a bigger change than renaming the product, and it is deliberately a
  separate decision — a product called "Acme" may still ship a binary called
  "${from}".

  It will leave work behind that this script does not do:

    - ~6 CLI test files assert literal ${from.toUpperCase()}_ environment names
      (apps/cli/src/tui/tty.test.ts among them). They are MEANT to break on a
      rename; fix them by hand.
    - apps/cli/Dockerfile declares 14 ENV ${from.toUpperCase()}_* variables.
    - infra/compose/worker.compose.yml carries the same prefix.
    - Machines already running this CLI have ~/.${from}/ and a systemd unit
      under the old name. They are not migrated for you.
  ────────────────────────────────────────────────────────────────────────────
`);
}

function regenerateIcons(old, next) {
  if (old.themeColor === next.themeColor && old.backgroundColor === next.backgroundColor) return;
  const cmd = 'python3 apps/web/scripts/generate-icons.py';
  try {
    execFileSync('python3', ['apps/web/scripts/generate-icons.py'], { cwd: REPO_ROOT, stdio: 'inherit' });
    console.log('\nRegenerated the brand icons.');
  } catch {
    console.warn(
      `\n  SKIPPED: icon regeneration. Run it yourself:\n` +
      `      pip install --user 'Pillow>=10'\n` +
      `      ${cmd}\n` +
      `  The icons are committed PIXELS, so until this runs they keep the old colour —\n` +
      `  including the icon and badge on every OS-level notification, which is the one\n` +
      `  brand surface a user sees without opening the app.`);
  }
}

function printChecklist(old, next, opts) {
  const lines = [];
  if (next.slug !== old.slug) {
    lines.push([
      'Refresh the lockfile',
      '`npm install` — package-lock.json carries the workspace root name too, and',
      '`npm ci` (which CI and all three Dockerfiles run first) fails if they disagree.',
    ]);
  }
  lines.push([
    'Regenerate the visual baselines',
    'The app name is rendered into pixel baselines that run at maxDiffPixels: 4, so',
    'CI WILL BE RED until this is done. That is expected, not a regression.',
    '',
    '  docker run --rm -it -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.62.1-noble \\',
    '    npx playwright test --config=tests/visual/playwright.config.ts --update-snapshots',
  ]);
  if (next.repoSlug !== old.repoSlug) {
    lines.push([
      'Re-point the repository',
      'Rename it on GitHub, then: git remote set-url origin ' + next.cloneUrl,
    ]);
  }
  lines.push([
    'Update the OAuth redirect URIs',
    'In the Google Cloud console (and any other provider), so the callback still',
    'matches APP_URL. Nothing in this repository can do that for you.',
  ]);

  console.log('\n' + '='.repeat(78));
  console.log('STILL TO DO BY HAND');
  console.log('='.repeat(78));
  lines.forEach(([title, ...rest], i) => {
    console.log(`\n${i + 1}. ${title}`);
    rest.forEach((l) => console.log(l ? `   ${l}` : ''));
  });
  console.log('\nFull guide: docs/RENAMING.md');
  if (opts.dryRun) console.log('\n(--dry-run: nothing was written.)');
  console.log('');
}

main();
