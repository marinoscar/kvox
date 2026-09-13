#!/usr/bin/env node
// =============================================================================
// scripts/new-project.mjs — turn a fresh fork into a new product  (issue #344)
// =============================================================================
//
// `scripts/rename.mjs` changes the identity. This changes the STATE: the release
// history, the version numbers and the licence — the things that are true of the
// template and false of the product built from it.
//
// -----------------------------------------------------------------------------
// WHAT THIS SCRIPT DOES NOT DO, AND WHY THAT IS DELIBERATE
// -----------------------------------------------------------------------------
//
// It does not delete the example job handlers, and it should not.
//
// They look like disposable demo code and they are not. `example.checksum` is
// the canonical NODE-ELIGIBLE job type — the one handler implementing both
// `process` and `nodeResultSchema`/`persistNodeResult` — and the jobs and worker
// node test suites use it and `example.echo` as their fixtures throughout
// (job-claim, job-admin, job-insights, job-stuck, the registry, and five node
// integration suites). Their coupling to production code is only comments and
// two registrations; their coupling to the TEST SUITE is real and deep.
//
// Deleting them automatically would hand a new project a broken test suite in
// its first hour, which is the worst possible introduction to a codebase. They
// are also the worked examples that `apps/api/src/jobs/handlers/README.md` and
// CLAUDE.md teach from.
//
// So this script REPORTS them instead. Removing them is a deliberate refactor
// somebody should choose, with the test suite green before and after — not a
// side effect of a bootstrap command.
//
// The same reasoning applies to squashing migrations and resetting git history:
// both are one-way, neither is reversible by `git checkout .`, and neither
// belongs behind the same flag as "set the version to 0.1.0". The
// `/new-project` skill walks a human through those.
//
// Full guide: docs/RENAMING.md
// =============================================================================

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(REPO_ROOT, 'packages', 'shared', 'identity.json');

const USAGE = `
Prepare a fresh fork of this template as a new product.

  node scripts/new-project.mjs [options]

Options:
  --audit                Report what a new project should consider. Default.
  --reset-release        CHANGELOG -> Unreleased + 0.1.0, and all versions -> 0.1.0.
  --license <id>         Write a LICENSE file. One of: mit, proprietary.
  --holder <string>      Copyright holder, for --license. Required with it.
  --dry-run              Show what would change; write nothing.
  --force                Skip the "this is still the template" safety check.
  -h, --help             This message.

Rename first: node scripts/rename.mjs --name "..." --repo owner/name
Full guide: docs/RENAMING.md
`.trimStart();

function die(message) {
  console.error(`\nnew-project: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { audit: false, resetRelease: false, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '-h': case '--help': return { help: true };
      case '--audit': opts.audit = true; break;
      case '--reset-release': opts.resetRelease = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--force': opts.force = true; break;
      case '--license': opts.license = argv[++i]; break;
      case '--holder': opts.holder = argv[++i]; break;
      default: die(`Unknown argument: ${argv[i]}\n\n${USAGE}`);
    }
  }
  if (!opts.resetRelease && !opts.license) opts.audit = true;
  return opts;
}

// =============================================================================
// Safety: is this still the template?
//
// Every action below is one a fork wants and the template does not. Running
// --reset-release in the template itself would discard its real release history
// and renumber four packages, so the default is to refuse.
// =============================================================================

function assertNotTemplate(identity, { force, dryRun }) {
  if (force || dryRun) return;
  let origin = '';
  try {
    origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return; // No remote is a perfectly normal state for a fresh fork.
  }
  const slug = identity.repoSlug;
  if (slug && origin.includes(slug)) {
    die(`this checkout still points at the repository named in identity.json:\n` +
        `    origin:      ${origin}\n` +
        `    identity:    ${slug}\n\n` +
        `  That means it is the template itself, not a fork of it — and these actions\n` +
        `  discard release history and renumber packages.\n\n` +
        `  Run scripts/rename.mjs first (it sets repoSlug), re-point the remote, or\n` +
        `  pass --force if you really mean to do this here.`);
  }
}

// =============================================================================
// Actions
// =============================================================================

const WORKSPACE_MANIFESTS = [
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/cli/package.json',
  'packages/shared/package.json',
];

function resetRelease(identity, { dryRun }) {
  const changed = [];

  // --- versions -----------------------------------------------------------
  for (const rel of WORKSPACE_MANIFESTS) {
    const path = join(REPO_ROOT, rel);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    // Text edit rather than JSON.parse/stringify, so key order, indentation and
    // every comment-like formatting choice in these files survives untouched.
    const after = before.replace(/^(\s*"version":\s*)"[^"]*"/m, '$1"0.1.0"');
    if (after === before) continue;
    if (!dryRun) writeFileSync(path, after);
    changed.push(`${rel}  version -> 0.1.0`);
  }

  // --- CHANGELOG ----------------------------------------------------------
  const changelogPath = join(REPO_ROOT, 'CHANGELOG.md');
  if (existsSync(changelogPath)) {
    const today = new Date().toISOString().slice(0, 10);
    const fresh = `# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - ${today}

### Added

- Initial project, started from the application foundation template.
`;
    if (!dryRun) writeFileSync(changelogPath, fresh);
    changed.push('CHANGELOG.md  reset to [Unreleased] + [0.1.0]');
  }

  return changed;
}

const LICENSES = {
  mit: (holder, year) => `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  proprietary: (holder, year) => `Copyright (c) ${year} ${holder}. All rights reserved.

This software and its source code are proprietary and confidential. No part of
it may be reproduced, distributed, or transmitted in any form or by any means,
or stored in a database or retrieval system, without the prior written
permission of the copyright holder.

Unauthorized copying of this file, via any medium, is strictly prohibited.
`,
};

function writeLicense(opts) {
  const id = String(opts.license).toLowerCase();
  const build = LICENSES[id];
  if (!build) {
    die(`unknown --license "${opts.license}". Supported: ${Object.keys(LICENSES).join(', ')}.\n` +
        `  Only these two are built in, because embedding the full text of every licence\n` +
        `  would make this script mostly licence text. For anything else — Apache-2.0,\n` +
        `  BSD, GPL — copy the official text from https://choosealicense.com into\n` +
        `  ./LICENSE yourself; nothing else in this repository depends on which you pick.`);
  }
  if (!opts.holder) die('--license also needs --holder "Your Name or Company".');

  const path = join(REPO_ROOT, 'LICENSE');
  if (existsSync(path) && !opts.force) {
    die('a LICENSE file already exists. Remove it first, or pass --force.');
  }
  const text = build(opts.holder, new Date().getFullYear());
  if (!opts.dryRun) writeFileSync(path, text);

  const changed = [`LICENSE  written (${id})`];

  // The README ships a "[Your License Here]" placeholder; leaving it in place
  // beside a real LICENSE file is worse than having neither.
  const readmePath = join(REPO_ROOT, 'README.md');
  if (existsSync(readmePath)) {
    const before = readFileSync(readmePath, 'utf8');
    const label = id === 'mit' ? 'MIT' : 'Proprietary';
    const after = before.replace(/\[Your License Here\]/g, `${label} — see [LICENSE](LICENSE).`);
    if (after !== before) {
      if (!opts.dryRun) writeFileSync(readmePath, after);
      changed.push('README.md  licence placeholder replaced');
    }
  }
  return changed;
}

// =============================================================================
// The audit — everything that needs a human decision
// =============================================================================

function countRefs(patterns, pathspec) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-l', '-E', patterns, '--', ...pathspec],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function audit() {
  const items = [];

  const exampleFiles = [
    'apps/api/src/jobs/handlers/example-echo.handler.ts',
    'apps/api/src/jobs/handlers/example-checksum.handler.ts',
    'apps/api/src/jobs/contracts/example-checksum.contract.ts',
    'apps/api/src/storage/processing/processors/example-metadata.processor.ts',
  ].filter((f) => existsSync(join(REPO_ROOT, f)));

  if (exampleFiles.length > 0) {
    const refs = countRefs('example-(echo|checksum|metadata)|example\\.(echo|checksum)', ['apps/api']);
    items.push({
      title: 'Example job handlers and storage processor',
      recommendation: 'KEEP unless you deliberately refactor',
      detail: [
        `${exampleFiles.length} example file(s), referenced by ${refs.length} file(s) under apps/api.`,
        '',
        'These are NOT disposable demo code. `example.checksum` is the canonical',
        'node-eligible job type — the only handler implementing both `process` and',
        '`nodeResultSchema`/`persistNodeResult` — and the jobs and worker-node test',
        'suites use it and `example.echo` as fixtures throughout. Their coupling to',
        'production code is only comments and two registrations; their coupling to the',
        'TEST SUITE is real and deep.',
        '',
        'Deleting them is a refactor to do deliberately, with the suite green before and',
        'after — not a bootstrap step. They are also the worked examples that',
        'apps/api/src/jobs/handlers/README.md and CLAUDE.md teach from.',
      ],
    });
  }

  if (!existsSync(join(REPO_ROOT, 'LICENSE'))) {
    items.push({
      title: 'No LICENSE file',
      recommendation: 'decide, then --license',
      detail: ['The README carries a "[Your License Here]" placeholder.',
               'Run with --license mit --holder "..." (or proprietary), or add your own.'],
    });
  }

  const deploy = join(REPO_ROOT, '.github/workflows/deploy.yml');
  if (existsSync(deploy) && readFileSync(deploy, 'utf8').includes('example.com')) {
    items.push({
      title: 'deploy.yml staging/production jobs are stubs',
      recommendation: 'fill in or delete',
      detail: ['They target https://example.com and their deploy step is an `echo`.',
               'They also expect GitHub Environments named staging and production to exist.',
               'The image build above them is already fork-following (IMAGE_NAME uses',
               'github.repository), so only the deploy steps need attention.'],
    });
  }

  const specsDir = join(REPO_ROOT, 'docs/specs');
  if (existsSync(specsDir)) {
    const specs = readdirSync(specsDir).filter((f) => f.endsWith('.md'));
    items.push({
      title: `docs/specs/ holds ${specs.length} framework design records`,
      recommendation: 'keep, but know what they are',
      detail: ['They are keyed to the TEMPLATE\'s issue numbers, so cross-references like',
               '"epic #254" resolve to unrelated issues in your fork. The documents',
               'themselves are accurate and worth keeping; only the issue links are stale.',
               'If you want docs/specs/ for your own product specs, move these to',
               'docs/specs/framework/ and update the references in CLAUDE.md.'],
    });
  }

  let migrations = [];
  const migDir = join(REPO_ROOT, 'apps/api/prisma/migrations');
  if (existsSync(migDir)) migrations = readdirSync(migDir).filter((f) => /^\d/.test(f));
  if (migrations.length > 1) {
    items.push({
      title: `${migrations.length} Prisma migrations carried over from the template`,
      recommendation: 'optional, one-way',
      detail: ['A new product with no deployed database can squash these into a single',
               'initial migration. Only do this BEFORE any environment has run them —',
               'afterwards it desynchronises every deployed _prisma_migrations table.'],
    });
  }

  return items;
}

// =============================================================================
// Main
// =============================================================================

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }

  if (!existsSync(MANIFEST)) die(`manifest not found at ${MANIFEST}`);
  const identity = JSON.parse(readFileSync(MANIFEST, 'utf8'));

  if (opts.resetRelease || opts.license) assertNotTemplate(identity, opts);

  const changed = [];
  if (opts.resetRelease) changed.push(...resetRelease(identity, opts));
  if (opts.license) changed.push(...writeLicense(opts));

  if (changed.length > 0) {
    console.log(`\n${opts.dryRun ? 'Would change' : 'Changed'}:\n`);
    for (const c of changed) console.log(`  ${opts.dryRun ? '~' : '*'} ${c}`);
  }

  if (opts.audit) {
    const items = audit();
    console.log(`\n${'='.repeat(78)}\nFOR A NEW PROJECT — ${items.length} thing(s) to decide\n${'='.repeat(78)}`);
    items.forEach((item, i) => {
      console.log(`\n${i + 1}. ${item.title}`);
      console.log(`   -> ${item.recommendation}\n`);
      for (const line of item.detail) console.log(line ? `   ${line}` : '');
    });
    console.log('\nNothing above was changed. Each is a judgement call.');
  }

  console.log(`\nSee docs/RENAMING.md for the full guide.${opts.dryRun ? '\n(--dry-run: nothing was written.)' : ''}\n`);
}

main();
