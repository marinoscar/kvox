import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { APP_NAME } from '@app/shared';
import { CLI_NAME } from '../branding.js';

// =============================================================================
// `node service` — a systemd USER unit  (issue #276, epic #254)
// =============================================================================
//
// A worker installed by hand does not survive a reboot, and a worker that does
// not survive a reboot is one somebody has to remember. This writes the unit.
//
// -----------------------------------------------------------------------------
// A USER UNIT, NOT A SYSTEM ONE
// -----------------------------------------------------------------------------
//
// A system-wide unit needs root to install. A user unit does not, and a worker
// has no reason whatsoever to run as root — it reads a config file in the
// invoking user's home directory and talks HTTPS to one server. Installing it
// as the user who owns the credential is also the only way the unit finds that
// credential without a second copy of it somewhere readable by root.
//
// -----------------------------------------------------------------------------
// `Restart=on-failure` IS NOT DECORATION
// -----------------------------------------------------------------------------
//
// #277's memory watchdog EXITS DELIBERATELY when the heap crosses its
// threshold, after draining cleanly and writing a snapshot. Without a
// supervisor, that successful drain leaves the worker down — a self-healing
// mechanism that turns into an outage. The same is true of the container's
// `restart: unless-stopped` in #278.
//
// -----------------------------------------------------------------------------
// THE UNIT NAME IS DERIVED
// -----------------------------------------------------------------------------
//
// `<CLI_NAME>-node.service`, and the Description carries `APP_NAME`. Neither is
// written out, so a fork's rename reaches the unit file — and a test asserts
// exactly that, because the failure mode otherwise is a service called
// `appctl-node` on a product that has not been called that for a year.
// =============================================================================

/** `appctl-node.service`. Derived from `CLI_NAME`, never written out. */
export const SERVICE_UNIT_NAME = `${CLI_NAME}-node.service`;

export interface ServiceContext {
  home?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  /** Test seam for `systemctl`. */
  run?: ((args: string[]) => string) | undefined;
  /** Absolute path of the CLI entrypoint the unit should exec. */
  execPath?: string | undefined;
  scriptPath?: string | undefined;
}

/** `~/.config/systemd/user`. */
export function userUnitDir(ctx?: ServiceContext): string {
  return join(ctx?.home ?? homedir(), '.config', 'systemd', 'user');
}

export function userUnitPath(ctx?: ServiceContext): string {
  return join(userUnitDir(ctx), SERVICE_UNIT_NAME);
}

/** Render the unit file. Pure, so its derived names are directly assertable. */
export function renderUnit(ctx?: ServiceContext): string {
  const node = ctx?.execPath ?? process.execPath;
  const script = ctx?.scriptPath ?? process.argv[1] ?? '';

  return [
    '[Unit]',
    `Description=${APP_NAME} worker node (${CLI_NAME})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    // `--headless` so a systemd restart RE-ATTACHES to the existing node row
    // instead of leaking one per restart.
    `ExecStart=${node} ${script} node start --headless`,
    // Required by #277's memory valve, which exits on purpose. See the header.
    'Restart=on-failure',
    'RestartSec=10',
    // Long enough for a drain; systemd SIGKILLs after this.
    'TimeoutStopSec=300',
    'KillSignal=SIGTERM',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export type ServiceAction = 'installed' | 'uninstalled' | 'unsupported' | 'absent';

export interface ServiceResult {
  action: ServiceAction;
  unitPath: string;
  detail: string;
  /** Extra guidance, e.g. the linger tip or the Windows alternative. */
  guidance?: string | undefined;
}

/** Is there a user systemd on this machine? */
export function hasUserSystemd(ctx?: ServiceContext): boolean {
  if ((ctx?.platform ?? process.platform) !== 'linux') return false;
  const run = ctx?.run ?? defaultSystemctl;
  try {
    run(['--user', 'show', '--property=Version']);
    return true;
  } catch {
    return false;
  }
}

function defaultSystemctl(args: string[]): string {
  return execFileSync('systemctl', args, { encoding: 'utf8' });
}

/** Windows and no-user-systemd both get GUIDANCE, never a stack trace. */
function unsupported(ctx: ServiceContext | undefined, unitPath: string): ServiceResult | undefined {
  const platform = ctx?.platform ?? process.platform;

  if (platform === 'win32') {
    return {
      action: 'unsupported',
      unitPath,
      detail: 'Windows has no systemd.',
      guidance:
        `Run the worker in the background with \`${CLI_NAME} node start --daemon\`, or wrap it in a ` +
        'Scheduled Task set to run at startup with "Run whether user is logged on or not".',
    };
  }

  if (platform === 'darwin') {
    return {
      action: 'unsupported',
      unitPath,
      detail: 'macOS uses launchd, not systemd.',
      guidance: `Run \`${CLI_NAME} node start --daemon\`, or write a launchd agent that execs the same command.`,
    };
  }

  if (!hasUserSystemd(ctx)) {
    return {
      action: 'unsupported',
      unitPath,
      detail: 'No per-user systemd instance is available here.',
      guidance:
        'This is normal inside a container and inside WSL 1. On WSL 2, enable systemd by adding ' +
        '`[boot]\\nsystemd=true` to /etc/wsl.conf and running `wsl --shutdown`. ' +
        `Otherwise run \`${CLI_NAME} node start --daemon\`.`,
    };
  }

  return undefined;
}

export function installService(ctx?: ServiceContext): ServiceResult {
  const unitPath = userUnitPath(ctx);
  const blocked = unsupported(ctx, unitPath);
  if (blocked !== undefined) return blocked;

  mkdirSync(userUnitDir(ctx), { recursive: true });
  writeFileSync(unitPath, renderUnit(ctx), { encoding: 'utf8', mode: 0o644 });

  const run = ctx?.run ?? defaultSystemctl;
  run(['--user', 'daemon-reload']);
  run(['--user', 'enable', '--now', SERVICE_UNIT_NAME]);

  return {
    action: 'installed',
    unitPath,
    detail: `Installed and started ${SERVICE_UNIT_NAME}.`,
    // THE STEP PEOPLE MISS. Without lingering, a user unit stops when the last
    // session for that user ends — so a worker on a box you SSH into dies when
    // you log out, which reads as a crash rather than as policy.
    guidance:
      `Run \`loginctl enable-linger $USER\` so the worker keeps running after you log out, ` +
      `and survives a reboot without anybody logging in.`,
  };
}

export function uninstallService(ctx?: ServiceContext): ServiceResult {
  const unitPath = userUnitPath(ctx);
  const blocked = unsupported(ctx, unitPath);
  if (blocked !== undefined) return blocked;

  if (!existsSync(unitPath)) {
    return { action: 'absent', unitPath, detail: 'No unit is installed here.' };
  }

  const run = ctx?.run ?? defaultSystemctl;
  try {
    run(['--user', 'disable', '--now', SERVICE_UNIT_NAME]);
  } catch {
    // A unit that is already stopped, or was never enabled, must not make
    // uninstall fail — the file removal below is the part that matters.
  }
  rmSync(unitPath, { force: true });
  run(['--user', 'daemon-reload']);

  return { action: 'uninstalled', unitPath, detail: `Removed ${SERVICE_UNIT_NAME}.` };
}

export interface ServiceStatus {
  installed: boolean;
  /** systemd's own words: `active`, `inactive`, `failed`, … */
  activeState: string | undefined;
  enabled: boolean | undefined;
  unitPath: string;
  detail: string;
}

/** Reflects the REAL unit state, by asking systemd rather than by inference. */
export function serviceStatus(ctx?: ServiceContext): ServiceStatus {
  const unitPath = userUnitPath(ctx);
  const installed = existsSync(unitPath);
  const platform = ctx?.platform ?? process.platform;

  if (platform !== 'linux' || !hasUserSystemd(ctx)) {
    return {
      installed,
      activeState: undefined,
      enabled: undefined,
      unitPath,
      detail: unsupported(ctx, unitPath)?.detail ?? 'systemd is not available here.',
    };
  }

  const run = ctx?.run ?? defaultSystemctl;

  let activeState: string | undefined;
  try {
    activeState = run(['--user', 'show', SERVICE_UNIT_NAME, '--property=ActiveState', '--value']).trim();
  } catch {
    activeState = undefined;
  }

  let enabled: boolean | undefined;
  try {
    enabled = run(['--user', 'is-enabled', SERVICE_UNIT_NAME]).trim() === 'enabled';
  } catch {
    // `is-enabled` EXITS NON-ZERO for a disabled unit, which is an answer, not
    // an error — but it also exits non-zero for a unit that does not exist, so
    // the file check above is what distinguishes them.
    enabled = installed ? false : undefined;
  }

  return {
    installed,
    activeState,
    enabled,
    unitPath,
    detail: installed
      ? `${SERVICE_UNIT_NAME} is ${activeState ?? 'unknown'}${enabled === true ? ' and enabled' : ''}.`
      : 'No unit is installed here.',
  };
}
