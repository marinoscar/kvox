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
  closureHostPlugins,
  HOST_PLUGIN_USES,
  importSpecifiers,
  listPackages,
  packageNameOf,
  peersTable,
  readGraph,
  readPeers,
  stripComments,
  withImplied,
} from '../check-slice-peers.mjs';
import { forbiddenIn, treeNames } from '../check-lean-install.mjs';
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

/** Adds a `brand` slice (no slice dependencies, no peers) to the kvox-web of a fixture copy. */
function addBrandSlice(dir) {
  const graph = JSON.parse(readFileSync(join(dir, 'packages/kvox-slices.json'), 'utf8'));
  graph['kvox-web'].brand = [];
  writeFileSync(join(dir, 'packages/kvox-slices.json'), JSON.stringify(graph));
  const peers = JSON.parse(readFileSync(join(dir, 'packages/kvox-slice-peers.json'), 'utf8'));
  peers['kvox-web'].brand = { peers: [] };
  writeFileSync(join(dir, 'packages/kvox-slice-peers.json'), JSON.stringify(peers));
}

test('host-neutral: the kvox-web brand slice may import exactly @marinoscar/platform-web/shell/headless', () => {
  const dir = fixtureCopy();
  try {
    addBrandSlice(dir);
    plant(dir, 'host-neutral/kvox-web-brand-allowed.ts', 'packages/kvox-web/src/brand/theme.ts');
    assert.deepEqual(
      checkSlicePeers({ root: dir }).filter((v) => v.rule === 'host-neutral'),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-neutral: the brand allowance is for the brand slice only, and for that one specifier only', () => {
  const dir = fixtureCopy();
  try {
    addBrandSlice(dir);
    plant(dir, 'host-neutral/kvox-web-brand-allowed.ts', 'packages/kvox-web/src/core/theme.ts');
    plant(dir, 'host-neutral/kvox-web-brand-forbidden.ts', 'packages/kvox-web/src/brand/forbidden.ts');
    const messages = checkSlicePeers({ root: dir })
      .filter((v) => v.rule === 'host-neutral')
      .map((v) => v.message);
    assert.equal(messages.length, 3);
    assert.ok(messages.some((m) => m.includes('src/core/theme.ts') && m.includes('shell/headless')));
    assert.ok(messages.some((m) => m.includes('src/brand/forbidden.ts') && m.includes('shell/ui')));
    assert.ok(messages.some((m) => m.includes('src/brand/forbidden.ts') && m.includes('identity/ui')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Adds a kvox-ai package (one universal `runtime` slice peering on the platform) to a fixture copy. */
function addKvoxAi(dir, pkg = 'kvox-ai') {
  mkdirSync(join(dir, `packages/${pkg}/src/runtime`), { recursive: true });
  writeFileSync(
    join(dir, `packages/${pkg}/package.json`),
    JSON.stringify({ name: `@marinoscar/${pkg}`, version: '0.0.0', peerDependencies: { '@marinoscar/platform-api': '0.1.0-next.5' } })
  );
  writeFileSync(join(dir, `packages/${pkg}/src/runtime/index.ts`), 'export const RUNTIME = 1;\n');
  const graph = JSON.parse(readFileSync(join(dir, 'packages/kvox-slices.json'), 'utf8'));
  graph[pkg] = { runtime: [] };
  writeFileSync(join(dir, 'packages/kvox-slices.json'), JSON.stringify(graph));
  const peers = JSON.parse(readFileSync(join(dir, 'packages/kvox-slice-peers.json'), 'utf8'));
  peers.$universal[pkg] = '*';
  peers[pkg] = { runtime: { peers: ['@marinoscar/platform-api'] } };
  writeFileSync(join(dir, 'packages/kvox-slice-peers.json'), JSON.stringify(peers));
}

test('host-neutral: a kvox-ai slice importing any other platform specifier fails, once per specifier (platform-api/ai/core, settings, bare)', () => {
  const dir = fixtureCopy();
  try {
    addKvoxAi(dir);
    plant(dir, 'host-neutral/kvox-ai-forbidden.ts', 'packages/kvox-ai/src/runtime/forbidden.ts');
    const hostNeutral = checkSlicePeers({ root: dir }).filter((v) => v.rule === 'host-neutral');
    assert.equal(hostNeutral.length, 3);
    for (const v of hostNeutral) assert.match(v.message, /packages\/kvox-ai\/src\/runtime\/forbidden\.ts/);
    assert.match(hostNeutral.map((v) => v.message).join('\n'), /'@marinoscar\/platform-api\/settings'/);
    assert.match(hostNeutral.map((v) => v.message).join('\n'), /'@marinoscar\/platform-api\/ai\/core'/);
    assert.match(hostNeutral.map((v) => v.message).join('\n'), /'@marinoscar\/platform-api'\./);
    assert.match(hostNeutral[0].message, /may import only '@marinoscar\/platform-ai-providers'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const hostNeutralOf = (dir) => checkSlicePeers({ root: dir }).filter((v) => v.rule === 'host-neutral');

test('host-neutral: kvox-ai and kvox-eval may import the lean @marinoscar/platform-ai-providers (value and type)', () => {
  for (const pkg of ['kvox-ai', 'kvox-eval']) {
    const dir = fixtureCopy();
    try {
      addKvoxAi(dir, pkg);
      plant(dir, 'host-neutral/kvox-ai-lean-allowed.ts', `packages/${pkg}/src/runtime/allowed.ts`);
      assert.deepEqual(hostNeutralOf(dir), [], pkg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('host-neutral: kvox-web may import @marinoscar/platform-web/ai/ui and nothing else of the platform', () => {
  const allowed = fixtureCopy();
  const forbidden = fixtureCopy();
  try {
    plant(allowed, 'host-neutral/kvox-web-platform-ai-ui-allowed.ts', 'packages/kvox-web/src/core/card.ts');
    assert.deepEqual(hostNeutralOf(allowed), []);
    plant(forbidden, 'host-neutral/kvox-web-platform-other-forbidden.ts', 'packages/kvox-web/src/core/hub.ts');
    const violations = hostNeutralOf(forbidden);
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /'@marinoscar\/platform-web\/settings\/ui'/);
    assert.match(violations[0].message, /may import only '@marinoscar\/platform-web\/ai\/ui'/);
  } finally {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(forbidden, { recursive: true, force: true });
  }
});

test('host-neutral: kvox-eval may import platform-ai-providers/openai', () => {
  const dir = fixtureCopy();
  try {
    addKvoxAi(dir, 'kvox-eval');
    plant(dir, 'host-neutral/kvox-eval-lean-allowed.ts', 'packages/kvox-eval/src/runtime/allowed.ts');
    assert.deepEqual(hostNeutralOf(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-neutral: kvox-ai may NOT import platform-ai-providers/openai (kvox-eval only)', () => {
  const dir = fixtureCopy();
  try {
    addKvoxAi(dir, 'kvox-ai');
    plant(dir, 'host-neutral/kvox-eval-openai-in-ai.ts', 'packages/kvox-ai/src/runtime/openai.ts');
    const violations = hostNeutralOf(dir);
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /'@marinoscar\/platform-ai-providers\/openai'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-neutral: importing @marinoscar/platform-api or platform-api/ai from kvox-ai or kvox-eval is a violation', () => {
  for (const pkg of ['kvox-ai', 'kvox-eval']) {
    const dir = fixtureCopy();
    try {
      addKvoxAi(dir, pkg);
      plant(dir, 'host-neutral/lean-forbidden-platform-api.ts', `packages/${pkg}/src/runtime/forbidden.ts`);
      const violations = hostNeutralOf(dir);
      const text = violations.map((v) => v.message).join('\n');
      assert.equal(violations.length, 2, `${pkg}: ${text}`);
      assert.match(text, /'@marinoscar\/platform-api\/ai'/);
      assert.match(text, /'@marinoscar\/platform-api'\./);
      assert.match(violations[0].message, /may import only '@marinoscar\/platform-ai-providers/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('host-neutral: kvox-api importing @marinoscar/platform-api is unchanged: still a rule-6 violation (its only platform home is apps/api/src/platform-kvox)', () => {
  const dir = fixtureCopy();
  try {
    plant(dir, 'host-neutral/lean-forbidden-platform-api.ts', 'packages/kvox-api/src/core/uses-platform-api.ts');
    const mine = hostNeutralOf(dir).filter((v) => v.message.includes('uses-platform-api.ts'));
    assert.equal(mine.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-neutral: the kvox-ai exception does not extend to kvox-api', () => {
  const dir = fixtureCopy();
  try {
    plant(dir, 'host-neutral/kvox-ai-lean-allowed.ts', 'packages/kvox-api/src/core/allowed.ts');
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

// -----------------------------------------------------------------------------
// check-slice-peers: rule 8, host-plugins ($hostPlugins)
// -----------------------------------------------------------------------------

const MULTIPART = { name: '@fastify/multipart', range: '^10.0.0', why: 'the slice reads uploads with request.file()' };
const PEERS_PATH = 'packages/kvox-slice-peers.json';
const GRAPH_PATH = 'packages/kvox-slices.json';

/** Edits the peers file of a fixture copy. */
function editPeers(dir, edit) {
  const peers = JSON.parse(readFileSync(join(dir, PEERS_PATH), 'utf8'));
  edit(peers);
  writeFileSync(join(dir, PEERS_PATH), JSON.stringify(peers));
}

/** Declares the multipart plugin on kvox-api/core. */
const declareOnCore = (dir) => editPeers(dir, (peers) => { peers.$hostPlugins = { 'kvox-api': { core: [{ ...MULTIPART }] } }; });

/** Writes a kvox-api source file into a slice folder. */
function writeSlice(dir, slice, name, text) {
  const to = join(dir, 'packages/kvox-api/src', slice, name);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, text);
}

/** Adds a slice `uploads` that depends on `core` (graph and peers entries). */
function addDependentSlice(dir) {
  const graph = JSON.parse(readFileSync(join(dir, GRAPH_PATH), 'utf8'));
  graph['kvox-api'].uploads = ['core'];
  writeFileSync(join(dir, GRAPH_PATH), JSON.stringify(graph));
  editPeers(dir, (peers) => { peers['kvox-api'].uploads = { peers: [] }; });
}

const hostPluginViolations = (dir, extra = {}) => checkSlicePeers({ root: dir, ...extra }).filter((v) => v.rule === 'host-plugins');
const peersDataMessages = (dir) => checkSlicePeers({ root: dir }).filter((v) => v.rule === 'peers-data').map((v) => v.message).join('\n');

test('host-plugins: a slice calling r.isMultipart() without a declaration fails, naming the file', () => {
  const dir = fixtureCopy();
  try {
    writeSlice(dir, 'core', 'upload.ts', 'export const ok = (r: { isMultipart(): boolean }) => r.isMultipart();\n');
    const found = hostPluginViolations(dir);
    assert.equal(found.length, 1);
    assert.match(found[0].message, /packages\/kvox-api\/src\/core\/upload\.ts/);
    assert.match(found[0].message, /@fastify\/multipart/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-plugins: the same file passes once the slice declares the plugin in $hostPlugins', () => {
  const dir = fixtureCopy();
  try {
    writeSlice(dir, 'core', 'upload.ts', 'export const ok = (r: { isMultipart(): boolean }) => r.isMultipart();\n');
    declareOnCore(dir);
    assert.deepEqual(checkSlicePeers({ root: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-plugins: a declaration inherited through a slice dependency passes', () => {
  const dir = fixtureCopy();
  try {
    addDependentSlice(dir);
    writeSlice(dir, 'uploads', 'upload.ts', 'export const ok = (request: { file(o: object): unknown }) => request.file({});\n');
    assert.equal(hostPluginViolations(dir).length, 1);
    declareOnCore(dir);
    assert.deepEqual(checkSlicePeers({ root: dir }), []);
    const peers = readPeers(dir);
    const closure = closureHostPlugins(readGraph(dir), peers, 'kvox-api', 'uploads');
    assert.equal(closure.get('@fastify/multipart').slice, 'core');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-plugins: mentions inside comments do not trigger', () => {
  const dir = fixtureCopy();
  try {
    writeSlice(
      dir,
      'core',
      'commented.ts',
      '// the host calls req.isMultipart() and request.file({}) before us\n/* x.saveRequestFiles() and request.parts() */\nexport const NAME = 1;\n'
    );
    assert.deepEqual(hostPluginViolations(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-plugins: the @fastify/multipart pattern matches the request decoration and nothing else', () => {
  const pattern = HOST_PLUGIN_USES['@fastify/multipart'];
  for (const code of ['req.file({})', 'request.parts()', 'x.saveRequestFiles()', 'x.isMultipart()', 'request.files()']) {
    assert.ok(pattern.test(code), `should match ${code}`);
  }
  for (const code of ['zip.files()', 'doc.parts()', 'archive.file(name)', 'const isMultipart = true']) {
    assert.ok(!pattern.test(code), `should not match ${code}`);
  }
});

test('peers-data: a malformed $hostPlugins is reported', () => {
  const cases = [
    ['a key that is not a package', (p) => { p.$hostPlugins = { nope: {} }; }, /\$hostPlugins names 'nope', which is not a package/],
    ['a slice no graph declares', (p) => { p.$hostPlugins = { 'kvox-api': { ghost: [{ ...MULTIPART }] } }; }, /'ghost', which .* does not declare/],
    ['a value that is not a list', (p) => { p.$hostPlugins = { 'kvox-api': { core: { ...MULTIPART } } }; }, /\$hostPlugins\.kvox-api\.core must be a list/],
    ['an empty range', (p) => { p.$hostPlugins = { 'kvox-api': { core: [{ ...MULTIPART, range: '' }] } }; }, /needs a non-empty string 'range'/],
    ['a blank why', (p) => { p.$hostPlugins = { 'kvox-api': { core: [{ ...MULTIPART, why: '  ' }] } }; }, /needs a non-empty string 'why'/],
    ['an unknown field', (p) => { p.$hostPlugins = { 'kvox-api': { core: [{ ...MULTIPART, extra: 1 }] } }; }, /unknown field\(s\) 'extra'/],
    ['a duplicate name', (p) => { p.$hostPlugins = { 'kvox-api': { core: [{ ...MULTIPART }, { ...MULTIPART }] } }; }, /lists '@fastify\/multipart' twice/],
  ];
  for (const [label, edit, expected] of cases) {
    const dir = fixtureCopy();
    try {
      editPeers(dir, edit);
      assert.match(peersDataMessages(dir), expected, label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('app-installs: an app importing a slice with a host plugin must list the plugin', () => {
  const dir = fixtureCopy();
  try {
    declareOnCore(dir);
    mkdirSync(join(dir, 'apps/api/src'), { recursive: true });
    writeFileSync(join(dir, 'apps/api/package.json'), JSON.stringify({ name: 'api', dependencies: { '@marinoscar/kvox-api': '*', zod: '^4.4.3' } }));
    writeFileSync(join(dir, 'apps/api/src/main.ts'), "import { NAME } from '@marinoscar/kvox-api/core';\n");
    const failing = checkSlicePeers({ root: dir, apps: ['apps/api'] });
    assert.deepEqual(rulesOf(failing), ['app-installs']);
    assert.match(failing[0].message, /'@fastify\/multipart'/);
    writeFileSync(
      join(dir, 'apps/api/package.json'),
      JSON.stringify({ name: 'api', dependencies: { '@marinoscar/kvox-api': '*', zod: '^4.4.3', '@fastify/multipart': '^10.0.0' } })
    );
    assert.deepEqual(checkSlicePeers({ root: dir, apps: ['apps/api'] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('peersTable: lists the host plugins of a package and of each slice', () => {
  const dir = fixtureCopy();
  try {
    declareOnCore(dir);
    const table = peersTable(dir);
    assert.match(table, /host plugins \(register on the Fastify app\): @fastify\/multipart@\^10\.0\.0 \(core\)/);
    assert.match(table, /core host plugins: @fastify\/multipart@\^10\.0\.0/);
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

test('lean-install: treeNames counts installed packages at any depth and skips an unmet optional peer', () => {
  const tree = {
    dependencies: {
      '@marinoscar/kvox-api': {
        version: '1.0.0',
        dependencies: { '@marinoscar/platform-api': {}, zod: { version: '4.4.3' } },
      },
    },
  };
  assert.deepEqual([...treeNames(tree)].sort(), ['@marinoscar/kvox-api', 'zod']);
  assert.deepEqual(forbiddenIn(treeNames(tree)), []);
});

test('lean-install: forbiddenIn flags @marinoscar/platform-api when it is installed, nested or not', () => {
  const tree = { dependencies: { a: { version: '1.0.0', dependencies: { '@marinoscar/platform-api': { version: '0.1.0-next.5' } } } } };
  assert.deepEqual(forbiddenIn(treeNames(tree)), ['@marinoscar/platform-api']);
});
