import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadTemplateSpecs } from './install.js';

// =============================================================================
// loadTemplateSpecs — scoped to the app being installed  (issue #229)
// =============================================================================
//
// Before the fix this pins, `loadTemplateSpecs` enumerated EVERY directory
// under the apps root and returned the first `infra/compose/.env.example`
// found, in `readdirSync` order. On a host running one app that bug is
// invisible; on a host running two it hands the wizard a different product's
// variable list. There is deliberately no fallback to a sibling any more —
// see the doc comment on `loadTemplateSpecs` in `install.tsx`.
//
// CWD CAVEAT. `templateCandidates` also walks upward from `process.cwd()` as
// a SECOND candidate, for the "run from inside a checkout" case. This repo's
// own `infra/compose/.env.example` sits a few directories above `apps/cli`
// (this suite's ordinary cwd), so a bare `expect(loadTemplateSpecs(...))
// .toEqual([])` would depend on where the test runner happens to be invoked
// from, not on the behaviour being pinned — flaky in exactly the way the task
// warned about. Two different fixes are used below, chosen per test:
//
//   - Where the assertion only needs to show a SIBLING'S key is absent
//     (mine-vs-other, and the "no name" case), no cwd control is needed: the
//     fixture apps root is unrelated to whatever the cwd walk might also
//     find, so the sibling's key can never appear either way.
//   - Where the assertion is the exact regression the issue describes — "when
//     only the sibling has a clone, the result is `[]`, full stop" — cwd is
//     driven into an empty temp directory for the one assertion that needs
//     it, and restored immediately after in a `finally`. That makes the `[]`
//     unambiguous evidence of "no sibling fallback" rather than a coincidence
//     of the invoking shell's working directory.
// =============================================================================

const createdRoots: string[] = [];

function appsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-tmpl-'));
  createdRoots.push(root);
  return root;
}

function writeTemplate(root: string, name: string, body: string): void {
  const dir = join(root, name, 'repo', 'infra', 'compose');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env.example'), body);
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('loadTemplateSpecs (issue #229)', () => {
  it("reads the named app's own template, never a sibling's", () => {
    const root = appsRoot();
    writeTemplate(root, 'mine', 'MINE_ONLY_KEY=1\n');
    writeTemplate(root, 'other', 'OTHER_ONLY_KEY=1\n');

    const keys = loadTemplateSpecs(root, 'mine').map((spec) => spec.key);

    expect(keys).toContain('MINE_ONLY_KEY');
    expect(keys).not.toContain('OTHER_ONLY_KEY');
  });

  it('is [] when only a sibling has a clone — the app being installed has none yet', () => {
    // This is the exact regression: under the old readdirSync-order
    // enumeration, this apps root has exactly one candidate directory
    // ('other'), so the old code would have returned OTHER's keys for an
    // install of 'mine'. The fixed function must answer [], never a
    // sibling's variable list.
    const root = appsRoot();
    writeTemplate(root, 'other', 'OTHER_ONLY_KEY=1\n');

    const emptyCwd = mkdtempSync(join(tmpdir(), 'appctl-cwd-'));
    createdRoots.push(emptyCwd);
    const originalCwd = process.cwd();
    process.chdir(emptyCwd);
    try {
      expect(loadTemplateSpecs(root, 'mine')).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('does not read any app folder when name is omitted', () => {
    const root = appsRoot();
    writeTemplate(root, 'mine', 'MINE_ONLY_KEY=1\n');

    // No cwd control needed: the fixture root is not on the cwd walk's path,
    // so MINE_ONLY_KEY can only appear here via the (forbidden) app-folder
    // candidate.
    const keys = loadTemplateSpecs(root).map((spec) => spec.key);

    expect(keys).not.toContain('MINE_ONLY_KEY');
  });
});
