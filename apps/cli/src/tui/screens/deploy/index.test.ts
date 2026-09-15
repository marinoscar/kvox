import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Route } from '../../routes.js';
import { PLACEHOLDER_COMMANDS, deployMenuItems, type Phase } from './index.js';

// =============================================================================
// The deploy screen's menu  (issue #131, epic #118)
// =============================================================================
//
// `ink-testing-library` is not a dependency (see status.test.ts), so the menu
// is asserted as the rows it derives. The property worth protecting is the
// one screens/menu.tsx states: rows are ANNOTATED, never hidden — a row that
// appears and disappears with the login or install state teaches the operator
// nothing about why.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));

describe('deployMenuItems', () => {
  it('offers the same six destinations whatever the state', () => {
    const fresh = deployMenuItems({ installed: false, loggedIn: false }).map((item) => item.value);
    const settled = deployMenuItems({ installed: true, loggedIn: true }).map((item) => item.value);

    expect(fresh).toEqual(['doctor', 'install', 'update', 'status', 'certs', 'about']);
    expect(settled).toEqual(fresh);
  });

  it('annotates Install once something is installed, rather than removing it', () => {
    const before = deployMenuItems({ installed: false, loggedIn: false });
    const after = deployMenuItems({ installed: true, loggedIn: false });

    expect(before.find((item) => item.value === 'install')?.label).toBe('Install');
    expect(after.find((item) => item.value === 'install')?.label).toContain('(already installed)');
  });

  it('annotates the rows that need an installed app', () => {
    const before = deployMenuItems({ installed: false, loggedIn: true });

    for (const value of ['update', 'status', 'certs'] as const) {
      expect(before.find((item) => item.value === value)?.label, value).toContain(
        '(nothing installed here)',
      );
    }
  });

  it('annotates About when nothing is logged in — its API block needs a credential', () => {
    const out = deployMenuItems({ installed: true, loggedIn: false });
    const inn = deployMenuItems({ installed: true, loggedIn: true });

    expect(out.find((item) => item.value === 'about')?.label).toContain('(not logged in)');
    expect(inn.find((item) => item.value === 'about')?.label).not.toContain('(not logged in)');
  });

  it('never annotates Doctor: checking prerequisites is what a fresh server needs', () => {
    expect(deployMenuItems({ installed: false, loggedIn: false })[0]?.label).toBe(
      'Doctor  (check prerequisites)',
    );
  });

  it('gives every destination that is not yet a screen the command that does the same work', () => {
    const later: Array<Exclude<Phase, 'choose' | 'install'>> = [
      'update',
      'status',
      'certs',
      'about',
    ];

    for (const phase of later) {
      expect(PLACEHOLDER_COMMANDS[phase], phase).toBeTruthy();
    }
  });
});

describe('routing', () => {
  it('keeps one deploy route, mounted from the app root', () => {
    const routes = readFileSync(join(HERE, '..', '..', 'routes.ts'), 'utf8');
    const app = readFileSync(join(HERE, '..', '..', 'app.tsx'), 'utf8');
    const menu = readFileSync(join(HERE, '..', 'menu.tsx'), 'utf8');

    const route: Route = 'deploy';
    expect(routes).toContain(`'${route}'`);
    // The wizard's eleven steps are an index INSIDE this route, not eleven
    // routes: routes.ts has no history stack, so a step per route would
    // return to the top menu instead of one step back.
    expect(routes).not.toContain("'install'");
    expect(app).toContain(`case '${route}':`);
    expect(app).toContain('<DeployScreen');
    expect(menu).toContain(`value: '${route}'`);
  });

  it('threads the abort controller into the executor rather than only holding one', () => {
    // The screen this replaces created an AbortController and passed it
    // nowhere, so Esc "cancelled" a `docker compose build` that went on
    // running on a production server. The signal has to reach `runCommand`.
    const install = readFileSync(join(HERE, 'install.tsx'), 'utf8');

    expect(install).toContain('signal: controller.signal');
    expect(install).toContain('runCommand,');
  });

  it('runs the install non-interactively: readline cannot prompt under raw mode', () => {
    const install = readFileSync(join(HERE, 'install.tsx'), 'utf8');

    expect(install).toContain('nonInteractive: true');
  });

  it('calls the shared runInstall rather than reimplementing the pipeline', () => {
    const install = readFileSync(join(HERE, 'install.tsx'), 'utf8');
    const command = readFileSync(join(HERE, '..', '..', '..', 'commands', 'deploy.ts'), 'utf8');

    expect(install).toContain('runInstall');
    expect(command).toContain('runInstall');
    // And the layout constants come from one place, never a second copy.
    expect(install).not.toMatch(/const DEFAULT_APPS_ROOT\s*=/);
    expect(install).not.toMatch(/const DEFAULT_BIND_PORT\s*=/);
    expect(install).not.toMatch(/const DEFAULT_PROXY_ROOT\s*=/);
  });
});
