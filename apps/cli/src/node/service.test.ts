import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APP_NAME } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLI_NAME } from '../branding.js';
import {
  SERVICE_UNIT_NAME,
  installService,
  renderUnit,
  serviceStatus,
  uninstallService,
  userUnitPath,
} from './service.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'appctl-service-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A `systemctl` that records rather than runs. */
function systemctl(): { calls: string[][]; run: (args: string[]) => string } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      if (args.includes('is-enabled')) return 'enabled\n';
      if (args.includes('--property=ActiveState')) return 'active\n';
      return '';
    },
  };
}

describe('the unit file (issue #276)', () => {
  it('derives its name and description rather than writing them out', () => {
    // A rename must reach the unit file. Otherwise a fork ends up with a
    // service called `appctl-node` for a product that has not been called that
    // in a year, and nothing fails.
    expect(SERVICE_UNIT_NAME).toBe(`${CLI_NAME}-node.service`);
    expect(renderUnit()).toContain(`Description=${APP_NAME} worker node (${CLI_NAME})`);
  });

  it('starts the worker headless so a restart re-attaches instead of leaking a node', () => {
    expect(renderUnit({ execPath: '/usr/bin/node', scriptPath: '/app/cli.js' })).toContain(
      'ExecStart=/usr/bin/node /app/cli.js node start --headless',
    );
  });

  it('sets Restart=on-failure — required by the memory valve, not decoration', () => {
    const unit = renderUnit();
    expect(unit).toContain('Restart=on-failure');
    // Long enough for a drain before systemd escalates to SIGKILL.
    expect(unit).toContain('TimeoutStopSec=300');
    expect(unit).toContain('KillSignal=SIGTERM');
  });
});

describe('installService', () => {
  it('writes the unit, reloads, enables it, and gives the linger tip', () => {
    const sc = systemctl();
    const result = installService({ home, platform: 'linux', run: sc.run, execPath: '/usr/bin/node', scriptPath: '/app/cli.js' });

    expect(result.action).toBe('installed');
    expect(readFileSync(userUnitPath({ home }), 'utf8')).toContain('[Service]');
    expect(sc.calls).toContainEqual(['--user', 'daemon-reload']);
    expect(sc.calls).toContainEqual(['--user', 'enable', '--now', SERVICE_UNIT_NAME]);
    // The step people miss: without lingering the unit dies when you log out.
    expect(result.guidance).toContain('enable-linger');
  });

  it('gives Windows guidance rather than a stack trace', () => {
    const result = installService({ home, platform: 'win32' });
    expect(result.action).toBe('unsupported');
    expect(result.guidance).toContain('--daemon');
    expect(existsSync(userUnitPath({ home }))).toBe(false);
  });

  it('gives macOS guidance rather than writing a systemd unit', () => {
    const result = installService({ home, platform: 'darwin' });
    expect(result.action).toBe('unsupported');
    expect(result.guidance).toContain('launchd');
  });

  it('gives WSL and linger guidance on a Linux box with no user systemd', () => {
    const result = installService({
      home,
      platform: 'linux',
      run: () => {
        throw new Error('Failed to connect to bus');
      },
    });

    expect(result.action).toBe('unsupported');
    expect(result.guidance).toContain('wsl.conf');
    expect(result.guidance).toContain('--daemon');
  });
});

describe('uninstallService', () => {
  it('disables and removes the unit', () => {
    const sc = systemctl();
    installService({ home, platform: 'linux', run: sc.run });
    const result = uninstallService({ home, platform: 'linux', run: sc.run });

    expect(result.action).toBe('uninstalled');
    expect(existsSync(userUnitPath({ home }))).toBe(false);
  });

  it('says so plainly when nothing is installed', () => {
    const result = uninstallService({ home, platform: 'linux', run: systemctl().run });
    expect(result.action).toBe('absent');
  });

  it('still removes the file when disabling fails', () => {
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(userUnitPath({ home }), 'stale');
    let calls = 0;

    const result = uninstallService({
      home,
      platform: 'linux',
      run: (args) => {
        calls += 1;
        if (args.includes('disable')) throw new Error('Unit not loaded');
        return '';
      },
    });

    expect(result.action).toBe('uninstalled');
    expect(existsSync(userUnitPath({ home }))).toBe(false);
    expect(calls).toBeGreaterThan(1);
  });
});

describe('serviceStatus', () => {
  it('reflects the real unit state from systemd, not an inference', () => {
    const sc = systemctl();
    installService({ home, platform: 'linux', run: sc.run });

    const status = serviceStatus({ home, platform: 'linux', run: sc.run });
    expect(status.installed).toBe(true);
    expect(status.activeState).toBe('active');
    expect(status.enabled).toBe(true);
    expect(status.detail).toContain('active');
  });

  it('treats a non-zero is-enabled as "disabled" for an installed unit', () => {
    const sc = systemctl();
    installService({ home, platform: 'linux', run: sc.run });

    const status = serviceStatus({
      home,
      platform: 'linux',
      run: (args) => {
        if (args.includes('is-enabled')) throw new Error('exit 1');
        if (args.includes('--property=ActiveState')) return 'inactive\n';
        return '';
      },
    });

    expect(status.enabled).toBe(false);
    expect(status.activeState).toBe('inactive');
  });

  it('reports the platform limitation instead of pretending', () => {
    const status = serviceStatus({ home, platform: 'win32' });
    expect(status.installed).toBe(false);
    expect(status.detail).toContain('Windows');
  });
});
