import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Route } from '../routes.js';

// =============================================================================
// The node screen  (issue #279, epic #254)
// =============================================================================
//
// `ink-testing-library` is not a dependency (see status.test.ts), so screen
// tests assert the DATA a screen derives, or a STRUCTURAL property of its
// source, rather than a rendered frame.
//
// The criterion here is explicitly structural: "the screens reuse the same
// functions as the commands — no duplicated logic (asserted structurally, not
// by review)". A drift-prone rule stated only in a comment is a rule that gets
// broken by the next person in a hurry, so it is checked.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREEN = readFileSync(join(HERE, 'node.tsx'), 'utf8');
const COMMAND = readFileSync(join(HERE, '..', '..', 'commands', 'node.ts'), 'utf8');

/** The shared, UI-free entry points. Both renderers must call THESE. */
const SHARED_ENTRY_POINTS = [
  'registerNode',
  'enrollNode',
  'runDoctor',
  'spawnDetachedDaemon',
  'resolveNodeConfig',
  'HttpNodeApi',
] as const;

describe('the node screen reuses the command layer', () => {
  it.each(SHARED_ENTRY_POINTS)('calls the shared %s rather than reimplementing it', (symbol) => {
    expect(SCREEN, `node.tsx should use ${symbol}`).toContain(symbol);
    expect(COMMAND, `commands/node.ts should use ${symbol}`).toContain(symbol);
  });

  it('renders the dashboard through the shared source rather than its own socket code', () => {
    expect(SCREEN).toContain('NodeDashboardSource');
    // No hand-rolled transport in a React component: framing, reconnection and
    // teardown all live in the source, where they are testable without ink.
    expect(SCREEN).not.toContain("from 'node:net'");
    expect(SCREEN).not.toContain('NdjsonParser');
  });

  it('never sends an IPC command from the UI — attaching stays read-only', () => {
    // A TUI that can stop a fleet member from a highlighted row is a
    // liability; `set-concurrency` and `stop` remain one-line commands.
    expect(SCREEN).not.toContain("type: 'stop'");
    expect(SCREEN).not.toContain("type: 'set-concurrency'");
    expect(SCREEN).not.toContain("type: 'drain'");
  });

  it('spawns the DETACHED daemon rather than running the engine in-process', () => {
    // An interactive process cannot re-exec itself to raise its heap ceiling
    // without destroying raw-mode input, so an in-process engine would
    // silently run at the low default limit — the least suitable configuration
    // for exactly the long jobs a node exists to take.
    expect(SCREEN).toContain('spawnDetachedDaemon');
    expect(SCREEN).not.toContain('new NodeEngine');
  });

  it('detaches on unmount, so no timer outlives the screen', () => {
    expect(SCREEN).toContain('sourceRef.current?.stop()');
  });
});

describe('routing', () => {
  it('declares the node route and mounts it from the app root', () => {
    const routes = readFileSync(join(HERE, '..', 'routes.ts'), 'utf8');
    const app = readFileSync(join(HERE, '..', 'app.tsx'), 'utf8');
    const menu = readFileSync(join(HERE, 'menu.tsx'), 'utf8');

    const route: Route = 'node';
    expect(routes).toContain(`'${route}'`);
    // A route added without a case in app.tsx renders the unknown-screen
    // fallback, which looks like a hung app.
    expect(app).toContain(`case '${route}':`);
    expect(app).toContain('<NodeScreen');
    // And one added without a menu entry is unreachable from the TUI at all.
    expect(menu).toContain(`value: '${route}'`);
  });
});
