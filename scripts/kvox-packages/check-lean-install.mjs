#!/usr/bin/env node
// =============================================================================
// Lean-install smoke for @marinoscar/kvox-ai (issue #578)
// =============================================================================
//
// kvox-ai depends on the lean @marinoscar/platform-ai-providers, NOT on
// @marinoscar/platform-api, so a host with no Nest platform (KVox Desktop) can
// install it. A source-level rule (check-slice-peers, rule 6) guards the imports;
// this script guards the INSTALL: it packs the three packages kvox-ai needs, installs
// them into an empty temporary project with only their peers (the lean provider
// package, openai, zod), and asserts:
//
//   1. @marinoscar/platform-api is not in the installed tree (`npm ls --all` and
//      the node_modules folder). It is an OPTIONAL peer of kvox-api, which npm does
//      not install on its own; if that ever stops being true this fails, and it is a
//      finding, not something to relax.
//   2. An OpenAI adapter built by createOpenAiAdapter (platform-ai-providers/openai)
//      goes through createDirectRuntime (kvox-ai) with a stub key resolver: readiness
//      answers from the resolver, and a call with no key is refused `key_missing`
//      before any adapter or network call.
//
// Needs: `npm run build:kvox-packages` first, and the npm registry for
// @marinoscar/platform-ai-providers, openai and zod (the tarballs are local).
//
// Usage: node scripts/kvox-packages/check-lean-install.mjs [--keep]
// Exit: 0 clean, 1 violation, 2 usage or setup error.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The workspace packages kvox-ai needs installed: itself, its port peer and that peer's contract. */
export const PACKED = Object.freeze(['kvox-contract', 'kvox-api', 'kvox-ai']);
/** Packages that must NOT appear anywhere in the installed tree. */
export const FORBIDDEN_PACKAGES = Object.freeze(['@marinoscar/platform-api']);

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Every INSTALLED package name in an `npm ls --all --json` tree (nested
 * `dependencies`). An unmet optional peer is listed without a `version` and is not
 * installed, so it does not count.
 */
export function treeNames(node, out = new Set()) {
  for (const [name, child] of Object.entries(node?.dependencies ?? {})) {
    if (child?.version !== undefined) out.add(name);
    treeNames(child, out);
  }
  return out;
}

/** The forbidden packages present in a name set. */
export function forbiddenIn(names) {
  return FORBIDDEN_PACKAGES.filter((name) => names.has(name));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', ...options });
  if (options.allowFail !== true && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result;
}

/** The smoke program run inside the temporary project (CommonJS, as the packages are). */
const SMOKE = `
const assert = require('node:assert/strict');
const { createDirectRuntime, isAiError } = require('@marinoscar/kvox-ai');
const { AiError } = require('@marinoscar/platform-ai-providers');
const { createOpenAiAdapter } = require('@marinoscar/platform-ai-providers/openai');

assert.throws(() => require.resolve('@marinoscar/platform-api'), /Cannot find module/, 'platform-api must not resolve');
assert.equal(isAiError(new AiError('AI_RATE_LIMITED', 'x')), true);

(async () => {
  const adapter = createOpenAiAdapter();
  assert.equal(adapter.id, 'openai');
  assert.ok(adapter.responses, 'the OpenAI adapter carries a responses port');

  let asked = [];
  let key = { apiKey: 'sk-stub-0000000000000000' };
  const runtime = createDirectRuntime({
    adapters: { openai: adapter },
    keys: async (provider) => { asked.push(provider); return key; },
  });

  assert.deepEqual(await runtime.readiness({ userId: 'u1', feature: 'note_generate', provider: 'openai' }), { hasKey: true });
  key = null;
  assert.deepEqual(await runtime.readiness({ userId: 'u1', feature: 'note_generate', provider: 'openai' }), { hasKey: false });

  // No key: refused before the adapter is reached, so no network call.
  await assert.rejects(
    runtime.create({ userId: 'u1', feature: 'note_generate', provider: 'openai', model: 'gpt-x' }, { input: 'hi' }),
    (error) => error.name === 'KvoxAiError' && error.errorClass === 'key_missing',
  );
  assert.deepEqual(asked, ['openai', 'openai', 'openai']);
  console.log('lean-install smoke: ok');
})().catch((error) => { console.error(error); process.exit(1); });
`;

function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const unknown = argv.filter((a) => a !== '--keep');
  if (unknown.length > 0) {
    console.error(`check-lean-install: unknown argument '${unknown[0]}'\nUsage: node scripts/kvox-packages/check-lean-install.mjs [--keep]`);
    process.exit(2);
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const name of PACKED) {
    if (!existsSync(join(repo, 'packages', name, 'dist'))) {
      console.error(`check-lean-install: packages/${name}/dist is missing. Build first: npm run build:kvox-packages`);
      process.exit(2);
    }
  }

  const kvoxAi = JSON.parse(readFileSync(join(repo, 'packages', 'kvox-ai', 'package.json'), 'utf8'));
  const providers = kvoxAi.peerDependencies['@marinoscar/platform-ai-providers'];
  const work = mkdtempSync(join(tmpdir(), 'kvox-lean-install-'));
  const tarballs = join(work, 'tarballs');
  const app = join(work, 'app');
  mkdirSync(tarballs);
  mkdirSync(app);
  let failed = false;
  try {
    const files = {};
    for (const name of PACKED) {
      const out = run(NPM, ['pack', '-w', `@marinoscar/${name}`, '--pack-destination', tarballs, '--json'], { cwd: repo });
      files[name] = join(tarballs, JSON.parse(out.stdout)[0].filename.replace(/^.*\//, ''));
    }
    const dependencies = {
      '@marinoscar/kvox-ai': `file:${files['kvox-ai']}`,
      '@marinoscar/kvox-api': `file:${files['kvox-api']}`,
      '@marinoscar/kvox-contract': `file:${files['kvox-contract']}`,
      '@marinoscar/platform-ai-providers': providers,
      openai: kvoxAi.devDependencies?.openai ?? '^7.23.0',
      zod: kvoxAi.peerDependencies.zod,
    };
    // kvox-ai and kvox-api resolve each other through the tarballs; keep npm from
    // fetching the registry copies of the workspace packages.
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'lean-install-smoke', version: '0.0.0', private: true, dependencies, overrides: Object.fromEntries(PACKED.map((n) => [`@marinoscar/${n}`, `file:${files[n]}`])) }, null, 2),
    );
    console.log('check-lean-install: npm install (packed tarballs + peers only)');
    run(NPM, ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: app });

    const ls = run(NPM, ['ls', '--all', '--json'], { cwd: app, allowFail: true });
    const names = treeNames(JSON.parse(ls.stdout || '{}'));
    const onDisk = FORBIDDEN_PACKAGES.filter((name) => existsSync(join(app, 'node_modules', name)));
    const present = [...new Set([...forbiddenIn(names), ...onDisk])];
    if (present.length > 0) {
      failed = true;
      console.error(`check-lean-install: FAILED. The lean install pulled in ${present.join(', ')}.`);
      const why = run(NPM, ['explain', present[0]], { cwd: app, allowFail: true });
      console.error(why.stdout || why.stderr);
    } else {
      const platform = readdirSync(join(app, 'node_modules', '@marinoscar')).filter((n) => n.startsWith('platform-'));
      console.log(`check-lean-install: no platform-api in the tree (platform packages installed: ${platform.join(', ')}).`);
    }

    writeFileSync(join(app, 'smoke.cjs'), SMOKE);
    const smoke = run(process.execPath, ['smoke.cjs'], { cwd: app, allowFail: true });
    process.stdout.write(smoke.stdout ?? '');
    if (smoke.status !== 0) {
      failed = true;
      console.error(smoke.stderr);
    }
  } catch (error) {
    console.error(`check-lean-install: ${error.message}`);
    process.exitCode = 2;
    return;
  } finally {
    if (keep) console.log(`check-lean-install: kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
  console.log('check-lean-install: passed.');
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) main();
