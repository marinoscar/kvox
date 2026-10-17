// Tests of the scripts in scripts/kvox-packages/, run with
// `npm run test:kvox-scripts` (node --test). They exercise the pure functions
// and a small fixture repository (test/fixtures/clean); the real repository is
// checked too, so a package change that breaks a rule fails here as well as in
// the workflow.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkAllPackageDocs, checkSections, parseMarkdown, README_HEADINGS, relativeLinks } from '../check-package-docs.mjs';
import { checkManifest, checkTarball, exportTargets, promisedFiles } from '../check-package-pack.mjs';
import {
  checkSlicePeers,
  importSpecifiers,
  listPackages,
  packageNameOf,
  stripComments,
  withImplied,
} from '../check-slice-peers.mjs';
import { copyLicense } from '../copy-license.mjs';
import { expandGuards } from '../check-single-instance.mjs';
import { writeDistStubs } from '../write-dist-stubs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const FIXTURES = join(HERE, 'fixtures');

/** A throwaway copy of the clean fixture repository; the caller removes it. */
function fixtureCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'kvox-packages-'));
  cpSync(join(FIXTURES, 'clean'), dir, { recursive: true });
  return dir;
}

/** Copies a fixture file into a slice folder of the temp repository. */
function plant(dir, fixture, target) {
  const to = join(dir, target);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(FIXTURES, fixture), to);
}

const rulesOf = (violations) => violations.map((v) => v.rule);

// -----------------------------------------------------------------------------
// check-slice-peers: the rules
// -----------------------------------------------------------------------------

test('the clean fixture has no violation (an import quoted in a comment is not an import)', () => {
  const dir = fixtureCopy();
  try {
    assert.deepEqual(checkSlicePeers({ root: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-neutral: a kvox-api slice importing @marinoscar/platform-* fails, naming the file', () => {
  const dir = fixtureCopy();
  try {
    plant(dir, 'host-neutral/uses-platform.ts', 'packages/kvox-api/src/core/uses-platform.ts');
    const violations = checkSlicePeers({ root: dir });
    const hostNeutral = violations.filter((v) => v.rule === 'host-neutral');
    assert.equal(hostNeutral.length, 1);
    assert.match(hostNeutral[0].message, /packages\/kvox-api\/src\/core\/uses-platform\.ts/);
    assert.match(hostNeutral[0].message, /@marinoscar\/platform-api\/ai/);
    assert.match(hostNeutral[0].message, /platform-kvox/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-neutral: the same file under kvox-web fails too', () => {
  const dir = fixtureCopy();
  try {
    plant(dir, 'host-neutral/uses-platform.ts', 'packages/kvox-web/src/core/uses-platform.ts');
    assert.ok(rulesOf(checkSlicePeers({ root: dir })).includes('host-neutral'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-neutral: other kvox packages are not subject to the rule', () => {
  // kvox-db and kvox-contract are not in HOST_NEUTRAL_PACKAGES: the rule is about
  // the two packages a second host installs next to its own bindings.
  const dir = fixtureCopy();
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'packages/kvox-api/package.json'), 'utf8'));
    mkdirSync(join(dir, 'packages/kvox-db/src/bin'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/kvox-db/package.json'),
      JSON.stringify({ name: '@marinoscar/kvox-db', version: manifest.version, peerDependencies: { '@marinoscar/platform-db': '0.1.0-next.5' } })
    );
    writeFileSync(join(dir, 'packages/kvox-db/src/bin/index.ts'), "import '@marinoscar/platform-db';\n");
    const graph = JSON.parse(readFileSync(join(dir, 'packages/kvox-slices.json'), 'utf8'));
    graph['kvox-db'] = { bin: [] };
    writeFileSync(join(dir, 'packages/kvox-slices.json'), JSON.stringify(graph));
    const peers = JSON.parse(readFileSync(join(dir, 'packages/kvox-slice-peers.json'), 'utf8'));
    peers.$universal['kvox-db'] = ['bin'];
    peers['kvox-db'] = { bin: { peers: ['@marinoscar/platform-db'] } };
    writeFileSync(join(dir, 'packages/kvox-slice-peers.json'), JSON.stringify(peers));
    assert.deepEqual(checkSlicePeers({ root: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('imports: a package no peer entry lists fails', () => {
  const dir = fixtureCopy();
  try {
    plant(dir, 'imports/uses-undeclared-package.ts', 'packages/kvox-api/src/core/uses-undeclared-package.ts');
    const violations = checkSlicePeers({ root: dir });
    assert.deepEqual(rulesOf(violations), ['imports']);
    assert.match(violations[0].message, /lodash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('graph: a folder under src/ that no slice declares fails', () => {
  const dir = fixtureCopy();
  try {
    mkdirSync(join(dir, 'packages/kvox-api/src/stray'), { recursive: true });
    writeFileSync(join(dir, 'packages/kvox-api/src/stray/index.ts'), 'export {};\n');
    assert.ok(rulesOf(checkSlicePeers({ root: dir })).includes('graph'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest: a required peer that is optional in the manifest, and an unaccounted peer, fail', () => {
  const dir = fixtureCopy();
  try {
    const path = join(dir, 'packages/kvox-web/package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.peerDependenciesMeta = { react: { optional: true } };
    manifest.peerDependencies.mystery = '^1.0.0';
    writeFileSync(path, JSON.stringify(manifest));
    const messages = checkSlicePeers({ root: dir })
      .filter((v) => v.rule === 'manifest')
      .map((v) => v.message)
      .join('\n');
    assert.match(messages, /'react' is required by a universal slice but marked optional/);
    assert.match(messages, /'mystery' is in no slice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app-installs: an app importing a slice must list its peers', () => {
  const dir = fixtureCopy();
  try {
    mkdirSync(join(dir, 'apps/api/src'), { recursive: true });
    writeFileSync(join(dir, 'apps/api/package.json'), JSON.stringify({ name: 'api', dependencies: { '@marinoscar/kvox-api': '*' } }));
    writeFileSync(join(dir, 'apps/api/src/main.ts'), "import { NAME } from '@marinoscar/kvox-api/core';\n");
    const failing = checkSlicePeers({ root: dir, apps: ['apps/api'] });
    assert.deepEqual(rulesOf(failing), ['app-installs']);
    assert.match(failing[0].message, /'zod'/);
    writeFileSync(
      join(dir, 'apps/api/package.json'),
      JSON.stringify({ name: 'api', dependencies: { '@marinoscar/kvox-api': '*', zod: '^4.4.3' } })
    );
    assert.deepEqual(checkSlicePeers({ root: dir, apps: ['apps/api'] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app-installs: a peer named in `without` is not required of the app', () => {
  const dir = fixtureCopy();
  try {
    mkdirSync(join(dir, 'apps/api/src'), { recursive: true });
    writeFileSync(join(dir, 'apps/api/package.json'), JSON.stringify({ name: 'api', dependencies: { '@marinoscar/kvox-api': '*' } }));
    writeFileSync(join(dir, 'apps/api/src/main.ts'), "import { NAME } from '@marinoscar/kvox-api/core';\n");
    // Naming another package exempts nothing: zod is still missing.
    const stillFailing = checkSlicePeers({ root: dir, apps: ['apps/api'], without: ['pdfkit'] });
    assert.deepEqual(rulesOf(stillFailing), ['app-installs']);
    assert.match(stillFailing[0].message, /'zod'/);
    // Naming zod leaves the app clean without listing it.
    assert.deepEqual(checkSlicePeers({ root: dir, apps: ['apps/api'], without: ['zod'] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The clean fixture with a `ui` entry on kvox-web/core that may import MUI (optional peer). */
function withUiEntry(dir) {
  const peers = JSON.parse(readFileSync(join(dir, 'packages/kvox-slice-peers.json'), 'utf8'));
  peers['kvox-web'].core.entries = { ui: ['@mui/material'] };
  peers.$implies['@mui/material'] = ['react', 'react-dom'];
  writeFileSync(join(dir, 'packages/kvox-slice-peers.json'), JSON.stringify(peers));
  const manifest = JSON.parse(readFileSync(join(dir, 'packages/kvox-web/package.json'), 'utf8'));
  manifest.peerDependencies['@mui/material'] = '^9.1.0';
  manifest.peerDependenciesMeta = { '@mui/material': { optional: true } };
  writeFileSync(join(dir, 'packages/kvox-web/package.json'), JSON.stringify(manifest));
}

test('entries: a ui entry may import its extra peer, which stays optional although the slice is universal', () => {
  const dir = fixtureCopy();
  try {
    withUiEntry(dir);
    plant(dir, 'imports/ui-uses-mui.ts', 'packages/kvox-web/src/core/ui/uses-mui.ts');
    assert.deepEqual(checkSlicePeers({ root: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('entries: the same import in the headless entry fails twice (imports, headless)', () => {
  const dir = fixtureCopy();
  try {
    withUiEntry(dir);
    plant(dir, 'imports/ui-uses-mui.ts', 'packages/kvox-web/src/core/headless/uses-mui.ts');
    const violations = checkSlicePeers({ root: dir });
    assert.deepEqual(rulesOf(violations).sort(), ['headless', 'imports']);
    assert.ok(violations.every((v) => /headless\/uses-mui\.ts/.test(v.message)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('entries: an extra peer made required in the manifest fails the manifest rule', () => {
  const dir = fixtureCopy();
  try {
    withUiEntry(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'packages/kvox-web/package.json'), 'utf8'));
    delete manifest.peerDependenciesMeta;
    writeFileSync(join(dir, 'packages/kvox-web/package.json'), JSON.stringify(manifest));
    assert.ok(rulesOf(checkSlicePeers({ root: dir })).includes('manifest'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('headless: a headless file reaching into a ui folder fails', () => {
  const dir = fixtureCopy();
  try {
    mkdirSync(join(dir, 'packages/kvox-web/src/core/headless'), { recursive: true });
    mkdirSync(join(dir, 'packages/kvox-web/src/core/ui'), { recursive: true });
    writeFileSync(join(dir, 'packages/kvox-web/src/core/ui/index.ts'), 'export const UI = 1;\n');
    writeFileSync(join(dir, 'packages/kvox-web/src/core/headless/x.ts'), "export { UI } from '../ui/index.js';\n");
    assert.deepEqual(rulesOf(checkSlicePeers({ root: dir })), ['headless']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app-installs: importing a web slice entry needs the entry peers, the headless entry does not', () => {
  const dir = fixtureCopy();
  try {
    withUiEntry(dir);
    mkdirSync(join(dir, 'apps/web/src'), { recursive: true });
    const manifest = { name: 'web', dependencies: { '@marinoscar/kvox-web': '*', react: '^19.2.7', 'react-dom': '^19.2.7' } };
    writeFileSync(join(dir, 'apps/web/package.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'apps/web/src/main.ts'), "import { NAME } from '@marinoscar/kvox-web/core/headless';\n");
    assert.deepEqual(checkSlicePeers({ root: dir, apps: ['apps/web'] }), []);
    writeFileSync(join(dir, 'apps/web/src/main.ts'), "import { UI } from '@marinoscar/kvox-web/core/ui';\n");
    const failing = checkSlicePeers({ root: dir, apps: ['apps/web'] });
    assert.deepEqual(rulesOf(failing), ['app-installs']);
    assert.match(failing[0].message, /@mui\/material/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real repository satisfies every rule, for the packages and for both apps', () => {
  assert.deepEqual(checkSlicePeers({ root: REPO, apps: ['apps/api', 'apps/web'] }), []);
});

// -----------------------------------------------------------------------------
// check-slice-peers: helpers
// -----------------------------------------------------------------------------

test('importSpecifiers reads import, export-from, side-effect, dynamic and require forms and ignores comments', () => {
  const source = `
    // import 'commented-line';
    /* import 'commented-block'; */
    import a from 'one';
    import type { B } from "two";
    import {
      c,
      d,
    } from '@scope/three/sub';
    export * from 'four';
    export { e } from './relative';
    import 'five';
    const g = await import('six');
    const h = require('seven');
    const url = 'https://example.test/not-a-comment';
  `;
  assert.deepEqual(importSpecifiers(source).sort(), ['./relative', '@scope/three/sub', 'five', 'four', 'one', 'seven', 'six', 'two']);
  assert.ok(!stripComments(source).includes('commented-line'));
  assert.ok(stripComments(source).includes('https://example.test'));
});

test('importSpecifiers does not read the word import inside a string literal as a side-effect import', () => {
  const source = `
    export const kinds = z.enum(['extraction', 'import', 'resolution']);
    source: z.enum(['segment', 'note', 'import']).describe('the row came from a file'),
    import 'real-side-effect';
  `;
  assert.deepEqual(importSpecifiers(source), ['real-side-effect']);
});

test('packageNameOf maps specifiers to package names and drops relative paths and built-ins', () => {
  assert.equal(packageNameOf('@nestjs/common'), '@nestjs/common');
  assert.equal(packageNameOf('@nestjs/common/decorators'), '@nestjs/common');
  assert.equal(packageNameOf('rxjs/operators'), 'rxjs');
  assert.equal(packageNameOf('./local.js'), null);
  assert.equal(packageNameOf('../up'), null);
  assert.equal(packageNameOf('node:fs'), null);
  assert.equal(packageNameOf('fs'), null);
  assert.equal(packageNameOf('path/posix'), null);
});

test('withImplied follows $implies transitively', () => {
  const out = withImplied(new Set(['a']), { a: ['b'], b: ['c'] });
  assert.deepEqual([...out].sort(), ['a', 'b', 'c']);
});

// -----------------------------------------------------------------------------
// check-package-docs
// -----------------------------------------------------------------------------

test('the real packages satisfy the README standard (TypeDoc output is checked in CI, after docs:kvox-packages)', () => {
  const violations = checkAllPackageDocs(REPO).filter((v) => v.rule !== 'api-reference');
  assert.deepEqual(violations, []);
});

test('removing a README heading fails the README check', () => {
  const readme = readFileSync(join(REPO, 'packages/kvox-contract/README.md'), 'utf8');
  const parsed = parseMarkdown(readme);
  assert.deepEqual(checkSections(parsed, README_HEADINGS, 'README', 'readme-headings'), []);
  const without = parseMarkdown(readme.replace(/^## Observability\s*$/m, ''));
  const problems = checkSections(without, README_HEADINGS, 'README', 'readme-headings');
  assert.ok(problems.some((p) => /missing section '## Observability'/.test(p.message)));
});

test('an empty section and an out-of-order section fail', () => {
  const text = '# t\n\n## B\n\ntext\n\n## A\n\n## C\n\ntext\n';
  const problems = checkSections(parseMarkdown(text), ['A', 'B', 'C'], 'R', 'r');
  assert.ok(problems.some((p) => /out of order/.test(p.message)));
  assert.ok(problems.some((p) => /'## A' is empty/.test(p.message)));
});

test('headings inside code fences are not sections, and links are collected outside fences only', () => {
  const text = '# t\n\n## A\n\n```md\n## Fake\n[x](./nope.md)\n```\n\n[ok](../a.md#frag) [web](https://x.test) [anchor](#here)\n';
  const parsed = parseMarkdown(text);
  assert.deepEqual(parsed.sections.map((s) => s.heading), ['A']);
  assert.deepEqual(relativeLinks(text), ['../a.md']);
});

// -----------------------------------------------------------------------------
// check-package-pack
// -----------------------------------------------------------------------------

test('every real manifest passes the manifest rules', () => {
  for (const { dir, manifest } of listPackages(REPO)) assert.deepEqual(checkManifest(dir, manifest), [], dir);
});

test('exportTargets and promisedFiles list the files a manifest points at', () => {
  assert.deepEqual(exportTargets({ import: { types: './a.d.ts', default: './a.js' }, require: './b.cjs' }).sort(), ['a.d.ts', 'a.js', 'b.cjs']);
  const manifest = { main: './dist/index.js', bin: { x: './bin/x.js' }, exports: { '.': { default: './dist/index.js' }, './package.json': './package.json' } };
  assert.deepEqual(promisedFiles(manifest).sort(), ['bin/x.js', 'dist/index.js', 'package.json']);
});

test('checkTarball flags a missing export target, a stray source file and a missing LICENSE', () => {
  const manifest = {
    files: ['dist', 'README.md', 'CHANGELOG.md', 'LICENSE'],
    exports: { './core': { default: './dist/core/index.js' }, './package.json': './package.json' },
  };
  assert.deepEqual(checkTarball(manifest, ['package.json', 'README.md', 'LICENSE', 'dist/core/index.js']), []);
  const problems = checkTarball(manifest, ['package.json', 'README.md', 'src/core/index.ts']).join('\n');
  assert.match(problems, /missing 'LICENSE'/);
  assert.match(problems, /missing 'dist\/core\/index\.js'/);
  assert.match(problems, /holds 'src\/core\/index\.ts'/);
});

// -----------------------------------------------------------------------------
// the small scripts
// -----------------------------------------------------------------------------

test('writeDistStubs writes a module-format package.json into each dist tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kvox-stubs-'));
  try {
    mkdirSync(join(dir, 'dist/cjs'), { recursive: true });
    mkdirSync(join(dir, 'dist/esm'), { recursive: true });
    writeDistStubs(dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'dist/cjs/package.json'), 'utf8')), { type: 'commonjs' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'dist/esm/package.json'), 'utf8')), { type: 'module' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeDistStubs refuses to run before the build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kvox-stubs-'));
  try {
    assert.throws(() => writeDistStubs(dir), /run the build first/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copyLicense copies the root LICENSE and fails without one', () => {
  const root = mkdtempSync(join(tmpdir(), 'kvox-license-'));
  const pkg = join(root, 'pkg');
  try {
    mkdirSync(pkg);
    assert.throws(() => copyLicense(pkg, root), /no LICENSE/);
    writeFileSync(join(root, 'LICENSE'), 'MIT License\n');
    copyLicense(pkg, root);
    assert.equal(readFileSync(join(pkg, 'LICENSE'), 'utf8'), 'MIT License\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(existsSync(join(REPO, 'LICENSE')), 'the repository root has a LICENSE for prepack to copy');
});

test('expandGuards expands * patterns against the known names and keeps plain names', () => {
  const known = ['@marinoscar/kvox-api', '@marinoscar/kvox-web', '@marinoscar/platform-api', 'react'];
  assert.deepEqual(expandGuards(['@marinoscar/kvox-*'], known), ['@marinoscar/kvox-api', '@marinoscar/kvox-web']);
  assert.deepEqual(expandGuards(['@marinoscar/platform-*', 'react', 'not-installed'], known), ['@marinoscar/platform-api', 'react', 'not-installed']);
});
