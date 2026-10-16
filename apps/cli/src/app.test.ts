import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLI_NAME } from '@app/shared';
import { configDirName, createCli, envPrefix, versionText } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS, readVersion } from './app.js';

// =============================================================================
// The CLI is `createCli()` with this app's identity  (issue #482, epic #478)
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, '..');
const REPO_ROOT = join(PACKAGE_DIR, '..', '..');

interface PackageJson {
  version: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as PackageJson;
}

beforeEach(() => {
  resetCliForTests();
});

describe('the version', () => {
  it('is read from package.json, the only place it lives', () => {
    expect(readVersion()).toBe(readPackageJson().version);
    expect(APP_CLI_OPTIONS.version).toBe(readPackageJson().version);
  });

  it('is a semantic version', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is printed by --version beside the platform engine version', () => {
    createCli(APP_CLI_OPTIONS);

    expect(versionText()).toMatch(new RegExp(`^${readVersion().replaceAll('.', '\\.')} \\(platform \\S+\\)$`));
  });
});

describe('the identity', () => {
  it('derives the config directory and the environment prefix from CLI_NAME', () => {
    createCli(APP_CLI_OPTIONS);

    expect(configDirName()).toBe(`.${CLI_NAME}`);
    expect(envPrefix()).toBe(`${CLI_NAME.toUpperCase().replaceAll('-', '_')}_`);
  });

  it('takes CLI_NAME from identity.json, the one place a fork edits', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', 'shared', 'identity.json'), 'utf8'),
    ) as { cliName: string };

    expect(CLI_NAME).toBe(manifest.cliName);
  });

  it("package.json's bin has exactly one key, and it equals CLI_NAME", () => {
    // THE ONE PLACE THE CONSTANT CANNOT REACH: npm reads package.json before any
    // code runs, so `bin` repeats the name as a literal. This is the guard
    // against that literal drifting from CLI_NAME.
    const bin = readPackageJson().bin ?? {};

    expect(Object.keys(bin)).toEqual([CLI_NAME]);
    expect(bin[CLI_NAME]).toBe('./dist/cli.js');
  });
});

describe('the command surface', () => {
  it('lists the six built-in commands', () => {
    const cli = createCli(APP_CLI_OPTIONS);

    expect(cli.program.commands.map((command) => command.name())).toEqual([
      'init',
      'login',
      'api',
      'config',
      'node',
      'deploy',
    ]);
  });

  it('keeps every deploy subcommand an operator scripts against', () => {
    const cli = createCli(APP_CLI_OPTIONS);
    const deploy = cli.program.commands.find((command) => command.name() === 'deploy');

    expect(deploy?.commands.map((command) => command.name()).sort()).toEqual(
      ['about', 'certs', 'doctor', 'install', 'list', 'status', 'uninstall', 'update'].sort(),
    );
  });

  it('keeps every node subcommand', () => {
    const cli = createCli(APP_CLI_OPTIONS);
    const node = cli.program.commands.find((command) => command.name() === 'node');

    expect(node?.commands.map((command) => command.name()).sort()).toEqual(
      [
        'config',
        'doctor',
        'enroll',
        'heap-snapshot',
        'install-deps',
        'logs',
        'register',
        'service',
        'set-concurrency',
        'start',
        'status',
        'stop',
      ].sort(),
    );
  });
});

describe('the dependency on the platform engine', () => {
  it('pins @marinoscar/platform-cli to one exact version', () => {
    const range = readPackageJson().dependencies?.['@marinoscar/platform-cli'];

    expect(range).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('does not depend on the engine\'s own libraries directly', () => {
    const dependencies = readPackageJson().dependencies ?? {};

    for (const name of ['commander', 'ink', 'ink-select-input', 'ink-spinner', 'ink-text-input']) {
      expect(dependencies, `${name} comes with @marinoscar/platform-cli`).not.toHaveProperty(name);
    }
  });
});

describe('no copy of a platform engine file', () => {
  // These are the files and folders this package carried before the CLI moved
  // onto the platform. Their return would be a second copy of the engine that
  // silently diverges from the one the package ships.
  it.each([
    'program.ts',
    'errors.ts',
    'output.ts',
    'prompt.ts',
    'config.ts',
    'api-client.ts',
    'device-auth.ts',
    'device-login.ts',
    'browser.ts',
    'request-body.ts',
    'branding.ts',
    'package-info.ts',
    'index.ts',
    'commands',
    'deploy',
    'node',
    'tui',
    'init',
  ])('src/%s does not exist', (name) => {
    expect(existsSync(join(HERE, name))).toBe(false);
  });
});
