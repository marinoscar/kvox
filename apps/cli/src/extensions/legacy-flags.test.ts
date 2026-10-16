import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { translateLegacyArgs, type LegacyContext, type LegacyPlan } from './legacy-flags.js';

// =============================================================================
// The pre-platform `deploy` surface, translated  (issue #482, epic #478)
// =============================================================================
//
// Every flag in the README's "changed in 1.10" table is one test here: ignored
// with a note, aliased, ported or refused with a message that says what to do.
// The property that matters is the last one in each group: no flag is accepted
// and then not honoured.
// =============================================================================

const CLI = 'app';
const NOW = new Date('2026-10-16T12:00:00.000Z');

let work: string;
let appsRoot: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'legacy-flags-'));
  appsRoot = join(work, 'apps');
  mkdirSync(join(appsRoot, 'myapp', 'repo', '.git'), { recursive: true });
  writeFileSync(join(appsRoot, 'myapp', '.env'), 'POSTGRES_PASSWORD=s3cret\n');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function context(overrides: Partial<LegacyContext> = {}): LegacyContext {
  return { cli: CLI, cwd: work, now: () => NOW, ...overrides };
}

function run(argv: string[], overrides: Partial<LegacyContext> = {}): Extract<LegacyPlan, { kind: 'run' }> {
  const plan = translateLegacyArgs(argv, context(overrides));
  if (plan.kind !== 'run') throw new Error(`expected a run plan, got ${plan.kind}: ${JSON.stringify(plan)}`);
  return plan;
}

function refusal(argv: string[], overrides: Partial<LegacyContext> = {}): string {
  const plan = translateLegacyArgs(argv, context(overrides));
  if (plan.kind !== 'refuse') throw new Error(`expected a refusal, got ${plan.kind}`);
  return plan.message;
}

describe('arguments that are not the legacy surface pass through untouched', () => {
  it.each([
    [[]],
    [['--version']],
    [['-v']],
    [['--help']],
    [['api', 'GET', '/api/auth/me', '--skip-github']],
    [['node', 'start', '--headless']],
    [['deploy']],
    [['deploy', 'nonsense', '--fresh']],
    [['deploy', 'status', '--json', '--apps-root', '/srv/apps']],
    [['deploy', 'install', '--domain', 'app.example.com', '--non-interactive']],
    [['deploy', 'certs', '--renew', '--force']],
  ])('%j', (argv) => {
    const plan = run(argv);

    expect(plan.argv).toEqual(argv);
    expect(plan.notes).toEqual([]);
    expect(plan.before).toEqual([]);
  });

  it('never rewrites help, so --help describes the real surface', () => {
    expect(run(['deploy', 'install', '--fresh', '--help']).argv).toEqual(['deploy', 'install', '--fresh', '--help']);
  });

  it('only reads options after the subcommand as options', () => {
    // `--answer` takes a value; a value that looks like a legacy flag stays a value.
    const plan = run(['deploy', 'install', '--answer', '--skip-github', '--domain', 'x.example.com']);

    expect(plan.argv).toEqual(['deploy', 'install', '--answer', '--skip-github', '--domain', 'x.example.com']);
  });
});

describe('IGNORE: the platform does the equivalent itself', () => {
  it.each([['doctor'], ['install'], ['update']])('deploy %s --skip-github is dropped with a note', (sub) => {
    const plan = run(['deploy', sub, '--skip-github', '--json']);

    expect(plan.argv).toEqual(['deploy', sub, '--json']);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toContain('--skip-github is ignored');
  });

  it('deploy install --install-cron is dropped with a note', () => {
    const plan = run(['deploy', 'install', '--install-cron', '--domain', 'a.example.com']);

    expect(plan.argv).toEqual(['deploy', 'install', '--domain', 'a.example.com']);
    expect(plan.notes[0]).toContain('--install-cron is ignored');
  });

  it('deploy uninstall --non-interactive is dropped: uninstall never prompts', () => {
    const plan = run(['deploy', 'uninstall', '--dry-run', '--non-interactive']);

    expect(plan.argv).toEqual(['deploy', 'uninstall', '--dry-run']);
    expect(plan.notes[0]).toContain('--non-interactive is ignored');
  });

  it('deploy about --check and --server <url> are dropped, value included', () => {
    const plan = run(['deploy', 'about', '--check', '--server', 'https://api.example.com', '--json']);

    expect(plan.argv).toEqual(['deploy', 'about', '--json']);
    expect(plan.notes).toHaveLength(2);
  });

  it('accepts the =value spelling of a flag it consumes', () => {
    expect(run(['deploy', 'about', '--server=https://api.example.com']).argv).toEqual(['deploy', 'about']);
  });
});

describe('ALIAS: the platform has it under another name', () => {
  it('deploy install --no-install-cron is --skip-renewal', () => {
    const plan = run(['deploy', 'install', '--no-install-cron', '--domain', 'a.example.com']);

    expect(plan.argv).toEqual(['deploy', 'install', '--domain', 'a.example.com', '--skip-renewal']);
    expect(plan.notes[0]).toContain('--skip-renewal');
  });
});

describe('REFUSE: no equivalent, and ignoring the flag would change what the command does', () => {
  it.each([
    [['deploy', 'install', '--fresh'], /--fresh no longer exists.*deploy uninstall.*--reinstall/s],
    [['deploy', 'install', '--no-ipv6'], /--no-ipv6 no longer exists.*IPv6/s],
    [['deploy', 'doctor', '--skip-proxy'], /doctor --skip-proxy no longer exists/],
    [['deploy', 'doctor', '--public-ip', '203.0.113.10'], /doctor --public-ip no longer exists/],
    [['deploy', 'uninstall', '--certs'], /--certs no longer exists.*never removed/s],
    [['deploy', 'uninstall', '--keep-env'], /--keep-env no longer exists.*\.bak/s],
    [['deploy', 'uninstall', '--skip-proxy'], /uninstall --skip-proxy no longer exists/],
  ])('%j', (argv, message) => {
    expect(refusal(argv as string[])).toMatch(message as RegExp);
  });

  it('prefixes the message with the executable so a log line says who spoke', () => {
    expect(refusal(['deploy', 'install', '--fresh'])).toMatch(/^app: /);
  });
});

describe('PORT: deploy update --check', () => {
  it('becomes the update-check plan with the deployment selectors and --json', () => {
    const plan = translateLegacyArgs(
      ['deploy', 'update', '--apps-root', '/srv/apps', '--skip-proxy', '--skip-github', '--check', '--json'],
      context(),
    );

    expect(plan).toMatchObject({
      kind: 'update-check',
      selector: { appsRoot: '/srv/apps', root: undefined, name: undefined },
      json: true,
    });
    expect((plan as { notes: string[] }).notes[0]).toContain('--skip-github is ignored');
  });

  it('carries --ref, --name and --root', () => {
    const plan = translateLegacyArgs(
      ['deploy', 'update', '--check', '--ref', 'v1.2.0', '--name', 'myapp', '--root', '/srv/apps/myapp'],
      context(),
    );

    expect(plan).toMatchObject({
      kind: 'update-check',
      ref: 'v1.2.0',
      selector: { name: 'myapp', root: '/srv/apps/myapp' },
      json: false,
    });
  });

  it('leaves a plain update alone', () => {
    expect(run(['deploy', 'update', '--non-interactive', '--skip-seed']).argv).toEqual([
      'deploy',
      'update',
      '--non-interactive',
      '--skip-seed',
    ]);
  });
});

describe('PORT: deploy certs renew|status (a cron entry an older CLI wrote calls them)', () => {
  it('rewrites the exact line the old cron file runs', () => {
    // From the old renewal cron: `<cli> deploy certs renew --all --apps-root <dir> --name <app>`.
    const plan = run(['deploy', 'certs', 'renew', '--all', '--apps-root', '/opt/infra/apps', '--name', 'myapp']);

    expect(plan.argv).toEqual(['deploy', 'certs', '--renew', '--apps-root', '/opt/infra/apps', '--name', 'myapp']);
    expect(plan.notes.join('\n')).toContain('--all is ignored');
    expect(plan.notes.join('\n')).toContain('deploy certs --renew');
  });

  it('keeps --root, --proxy-root, --proxy-container and --json', () => {
    const plan = run([
      'deploy', 'certs', 'renew', '--root', '/srv/apps/myapp', '--proxy-root', '/srv/proxy',
      '--proxy-container', 'edge', '--json',
    ]);

    expect(plan.argv).toEqual([
      'deploy', 'certs', '--renew', '--root', '/srv/apps/myapp', '--proxy-root', '/srv/proxy',
      '--proxy-container', 'edge', '--json',
    ]);
  });

  it('renew --dry-run reports without renewing', () => {
    const plan = run(['deploy', 'certs', 'renew', '--dry-run', '--name', 'myapp']);

    expect(plan.argv).toEqual(['deploy', 'certs', '--name', 'myapp']);
    expect(plan.argv).not.toContain('--renew');
  });

  it('renew --install-cron is dropped with a note: install and update schedule renewal', () => {
    const plan = run(['deploy', 'certs', 'renew', '--install-cron']);

    expect(plan.argv).toEqual(['deploy', 'certs', '--renew']);
    expect(plan.notes.join('\n')).toContain('--install-cron is ignored');
  });

  it('status becomes the reporting form of certs', () => {
    const plan = run(['deploy', 'certs', 'status', '--apps-root', '/opt/infra/apps', '--json']);

    expect(plan.argv).toEqual(['deploy', 'certs', '--apps-root', '/opt/infra/apps', '--json']);
  });
});

describe('PORT: deploy uninstall names the deployment before it removes it', () => {
  const uninstall = (...extra: string[]): string[] => ['deploy', 'uninstall', '--apps-root', appsRoot, ...extra];

  it('refuses a real uninstall that does not type the deployment name', () => {
    const message = refusal(uninstall());

    expect(message).toContain('pass --confirm myapp');
    expect(message).toContain('--dry-run');
  });

  it('refuses a name that is not the deployment', () => {
    expect(refusal(uninstall('--confirm', 'other'))).toContain('Expected "myapp"');
  });

  it('accepts the right name and removes --confirm before the platform parses', () => {
    const plan = run(uninstall('--confirm', 'myapp', '--json'));

    expect(plan.argv).toEqual(['deploy', 'uninstall', '--apps-root', appsRoot, '--json']);
    expect(plan.before).toHaveLength(1);
  });

  it('a dry run needs no confirmation and takes no backup', () => {
    const plan = run(uninstall('--dry-run'));

    expect(plan.argv).toEqual(uninstall('--dry-run'));
    expect(plan.before).toEqual([]);
  });

  it('a dry run that still passes --confirm is accepted and loses the flag', () => {
    expect(run(uninstall('--dry-run', '--confirm', 'whatever')).argv).toEqual(uninstall('--dry-run'));
  });

  it('compares with the deployment --name selects, not with whatever is installed', () => {
    mkdirSync(join(appsRoot, 'second', 'repo', '.git'), { recursive: true });
    writeFileSync(join(appsRoot, 'second', '.env'), 'X=1\n');

    expect(refusal(uninstall('--confirm', 'myapp', '--name', 'second'))).toContain('Expected "second"');
    expect(run(uninstall('--confirm', 'second', '--name', 'second')).before).toHaveLength(1);
  });

  it('asks which deployment when several are installed and none is named', () => {
    mkdirSync(join(appsRoot, 'second', 'repo', '.git'), { recursive: true });
    writeFileSync(join(appsRoot, 'second', '.env'), 'X=1\n');

    expect(refusal(uninstall('--confirm', 'myapp'))).toContain('Pass --name');
  });

  it('copies the .env to <apps-root>/<name>.env.<timestamp>.bak (0600) before the platform deletes it', () => {
    const plan = run(uninstall('--confirm', 'myapp'));

    const [step] = plan.before;
    const line = step?.();

    const backups = readdirSync(appsRoot).filter((entry) => entry.endsWith('.bak'));
    expect(backups).toEqual(['myapp.env.2026-10-16T12-00-00-000Z.bak']);
    const path = join(appsRoot, backups[0] as string);
    expect(readFileSync(path, 'utf8')).toBe('POSTGRES_PASSWORD=s3cret\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(line).toContain('copied');
    // The original is the platform's to remove; the backup is not.
    expect(readFileSync(join(appsRoot, 'myapp', '.env'), 'utf8')).toBe('POSTGRES_PASSWORD=s3cret\n');
  });

  it('a half-removed deployment with no .env is not a failure', () => {
    rmSync(join(appsRoot, 'myapp', '.env'));

    const plan = run(uninstall('--confirm', 'myapp', '--name', 'myapp'));

    expect(plan.before[0]?.()).toBeUndefined();
    expect(readdirSync(appsRoot).filter((entry) => entry.endsWith('.bak'))).toEqual([]);
  });
});
