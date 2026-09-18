import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { UninstallResult } from '../../../deploy/uninstall.js';
import { deployMenuItems } from './index.js';
import {
  DEFAULT_UNINSTALL_CHOICES,
  bucketFrom,
  confirmSteps,
  databaseFrom,
  equivalentCommand,
  hasDestructiveExtras,
  inventoryLines,
  uninstallOptionRows,
  uninstallOutcome,
} from './uninstall-model.js';

// =============================================================================
// The Uninstall destination  (issue #268)
// =============================================================================
//
// `ink-testing-library` is not a dependency, so the screen is asserted two
// ways, the same two every other screen in this directory uses: its pure model
// as data, and its source for the structural properties a model cannot carry
// (that it calls the SHARED `runUninstall`, and that it runs non-interactively
// so readline never tries to prompt under ink's raw mode).
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));

const APP = 'demo';
const DEPLOY_ROOT = '/opt/infra/apps/demo';

function result(over: Partial<UninstallResult> = {}): UninstallResult {
  return {
    name: APP,
    deployRoot: DEPLOY_ROOT,
    dryRun: true,
    removed: [],
    kept: [],
    warnings: [],
    ...over,
  };
}

// =============================================================================
// 1. The destination itself
// =============================================================================

describe('the Uninstall destination', () => {
  it('appears in the deploy menu', () => {
    const items = deployMenuItems({ installed: true, loggedIn: true });

    expect(items.map((item) => item.value)).toContain('uninstall');
  });

  it('is annotated as unavailable when nothing is installed, never hidden', () => {
    // The menu's convention (screens/menu.tsx): a row that appears and
    // disappears teaches the operator nothing about why.
    const empty = deployMenuItems({ installed: false, loggedIn: true });
    const settled = deployMenuItems({ installed: true, loggedIn: true });

    expect(empty.find((item) => item.value === 'uninstall')?.label).toContain(
      '(nothing installed here)',
    );
    expect(settled.find((item) => item.value === 'uninstall')?.label).not.toContain(
      '(nothing installed here)',
    );
  });

  it('is LAST, so the row somebody lands on first is not the destructive one', () => {
    const items = deployMenuItems({ installed: true, loggedIn: true });

    expect(items.at(-1)?.value).toBe('uninstall');
    expect(items[0]?.value).toBe('doctor');
  });

  it('is mounted by the deploy screen rather than falling through to a placeholder', () => {
    const index = readFileSync(join(HERE, 'index.tsx'), 'utf8');

    expect(index).toContain("phase === 'uninstall'");
    expect(index).toContain('<UninstallScreen');
  });
});

// =============================================================================
// 2. It drives the SHARED runUninstall — there is no second teardown
// =============================================================================

describe('the screen drives the shared runUninstall', () => {
  const source = readFileSync(join(HERE, 'uninstall.tsx'), 'utf8');
  // The CODE only. This file's header quotes `compose down -v` while arguing
  // why the run is threaded through `withSignal`, and a check that counted
  // that as a reimplementation would be testing the prose.
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');

  it('calls `runUninstall`, the same function the subcommand calls', () => {
    const command = readFileSync(
      join(HERE, '..', '..', '..', 'commands', 'deploy.ts'),
      'utf8',
    );

    expect(source).toContain('runUninstall');
    expect(command).toContain('runUninstall');
  });

  it('reimplements none of the teardown', () => {
    // Every one of these is a thing this screen could have "just done itself",
    // and each would be a second removal path diverging from the first.
    for (const forbidden of [
      'removeDeployRoot',
      'removeVhost',
      'discardLocalState',
      'purgeStorage(',
      'dropDatabase(',
      'buildUninstallSteps',
      'down -v',
      'composeArgv',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('runs non-interactively: readline cannot prompt under ink raw mode', () => {
    expect(source).toContain('nonInteractive: true');
  });

  it('supplies each confirmation as its own field, so one cannot cover another', () => {
    // The TUI's typed values go through the very same requireConfirmation and
    // requireResourceConfirmation a scripted --non-interactive run does.
    expect(source).toContain("confirmation: answers['app']");
    expect(source).toContain("confirmBucket: answers['bucket']");
    expect(source).toContain("confirmDatabase: answers['database']");
  });

  it('gets its inventory from a REAL dry run, not from a second description', () => {
    expect(source).toContain('dryRun: true');
  });

  it('threads the abort signal into the executor rather than only holding one', () => {
    // #131's hazard: a controller that is aborted and passed nowhere leaves a
    // `compose down` running on a production server after Esc.
    expect(source).toContain('withSignal(controller.signal)');
    expect(source).toContain('runCommand:');
  });
});

// =============================================================================
// 3. The options, and the confirmations they imply
// =============================================================================

describe('the option rows', () => {
  it('start with every destructive extra OFF', () => {
    expect(DEFAULT_UNINSTALL_CHOICES).toEqual({
      certs: false,
      dropDatabase: false,
      purgeStorage: false,
    });
    expect(hasDestructiveExtras(DEFAULT_UNINSTALL_CHOICES)).toBe(false);
  });

  it('put the two unrecoverable rows last', () => {
    const rows = uninstallOptionRows(DEFAULT_UNINSTALL_CHOICES);

    expect(rows.map((row) => row.key)).toEqual(['certs', 'purgeStorage', 'dropDatabase']);
  });

  it('state the consequence rather than the mechanism, in both states', () => {
    const off = uninstallOptionRows(DEFAULT_UNINSTALL_CHOICES);
    const on = uninstallOptionRows({ certs: true, dropDatabase: true, purgeStorage: true });

    expect(off.find((row) => row.key === 'certs')?.note).toMatch(/5 a week/);
    expect(on.find((row) => row.key === 'dropDatabase')?.note).toMatch(/Unrecoverable/);
    expect(on.find((row) => row.key === 'purgeStorage')?.note).toMatch(/Unrecoverable/);
    expect(off.find((row) => row.key === 'purgeStorage')?.note).toMatch(/stay in the bucket/);
  });

  it('names the equivalent subcommand, including each flag’s own confirmation', () => {
    const line = equivalentCommand(APP, { certs: false, dropDatabase: true, purgeStorage: true });

    expect(line).toContain(`--confirm ${APP}`);
    expect(line).toContain('--purge-storage --confirm-bucket <bucket>');
    expect(line).toContain('--drop-database --confirm-database <database>');
  });
});

describe('confirmSteps', () => {
  it('always asks for the app name first, and only that when nothing else was chosen', () => {
    const steps = confirmSteps({
      name: APP,
      deployRoot: DEPLOY_ROOT,
      choices: DEFAULT_UNINSTALL_CHOICES,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]?.key).toBe('app');
    expect(steps[0]?.expected).toBe(APP);
  });

  it('adds one step per extra, in the order they will actually run', () => {
    const steps = confirmSteps({
      name: APP,
      deployRoot: DEPLOY_ROOT,
      choices: { certs: false, dropDatabase: true, purgeStorage: true },
      bucket: 'demo-bucket',
      database: 'appdb',
    });

    // App, then storage, then the database - `buildUninstallSteps`' own order.
    expect(steps.map((step) => step.key)).toEqual(['app', 'bucket', 'database']);
  });

  it('gives each step that resource’s OWN name and no other', () => {
    const steps = confirmSteps({
      name: APP,
      deployRoot: DEPLOY_ROOT,
      choices: { certs: false, dropDatabase: true, purgeStorage: true },
      bucket: 'demo-bucket',
      database: 'appdb',
    });

    const expected = Object.fromEntries(steps.map((step) => [step.key, step.expected]));
    expect(expected).toEqual({ app: APP, bucket: 'demo-bucket', database: 'appdb' });
    // Three distinct strings: no two steps can be satisfied by one word.
    expect(new Set(Object.values(expected)).size).toBe(3);
  });

  it('asks for nothing it could not read a real name for', () => {
    // A bucket that could not be listed has no name to type, and the step
    // reports the problem rather than destroying what it cannot describe.
    const steps = confirmSteps({
      name: APP,
      deployRoot: DEPLOY_ROOT,
      choices: { certs: false, dropDatabase: true, purgeStorage: true },
    });

    expect(steps.map((step) => step.key)).toEqual(['app']);
  });
});

// =============================================================================
// 4. The inventory the operator is shown before consenting
// =============================================================================

describe('inventoryLines', () => {
  it('is empty when neither extra was chosen', () => {
    expect(inventoryLines(result())).toEqual([]);
  });

  it('carries the per-prefix counts, the bytes and the foreign entries', () => {
    const lines = inventoryLines(
      result({
        storage: {
          inventory: {
            bucket: 'demo-bucket',
            region: 'eu-west-1',
            endpoint: '',
            versioning: 'Disabled',
            prefixes: [{ prefix: 'uploads/', objects: 2, bytes: 3000, versions: 0 }],
            foreign: [{ key: 'someone-elses-app/', kind: 'prefix' }],
            objects: 2,
            bytes: 3000,
            versions: 0,
          },
        },
      }),
    ).join('\n');

    expect(lines).toContain('demo-bucket');
    expect(lines).toContain('uploads/');
    expect(lines).toContain('3.0 kB');
    expect(lines).toContain('someone-elses-app/');
    expect(lines).toContain('NOT inspected and NOT deleted');
  });

  it('says plainly what a versioned bucket does with its versions', () => {
    const lines = inventoryLines(
      result({
        storage: {
          inventory: {
            bucket: 'demo-bucket',
            region: 'eu-west-1',
            endpoint: '',
            versioning: 'Enabled',
            prefixes: [{ prefix: 'uploads/', objects: 1, bytes: 10, versions: 2 }],
            foreign: [],
            objects: 1,
            bytes: 10,
            versions: 2,
          },
        },
      }),
    ).join('\n');

    expect(lines).toContain('Versioning is Enabled');
    expect(lines).toContain('deleted BY ID');
    expect(lines).toContain('2 older version(s)/marker(s)');
  });

  it('carries the database’s size and its open sessions', () => {
    const lines = inventoryLines(
      result({
        database: {
          facts: {
            database: 'appdb',
            host: 'db.internal',
            port: '5432',
            user: 'app',
            size: '42 MB',
            connections: 3,
          },
        },
      }),
    ).join('\n');

    expect(lines).toContain('appdb on db.internal:5432');
    expect(lines).toContain('42 MB');
    expect(lines).toContain('3 other connection(s) open right now');
  });

  it('says a number could not be read rather than showing zero', () => {
    const lines = inventoryLines(
      result({
        database: { facts: { database: 'appdb', host: 'db.internal', port: '5432', user: 'app' } },
      }),
    ).join('\n');

    // "0 connections" that actually means "I could not see them" is precisely
    // the reassurance that gets an operator to consent.
    expect(lines).toContain('could not be read');
    expect(lines).not.toContain('0 other connection(s)');
  });
});

describe('bucketFrom / databaseFrom', () => {
  it('answer undefined when the resource could not be read, so nothing is confirmed', () => {
    expect(bucketFrom(result({ storage: { problem: 'AccessDenied' } }))).toBeUndefined();
    expect(
      databaseFrom(
        result({
          database: {
            facts: {
              database: 'appdb',
              host: 'db.internal',
              port: '5432',
              user: 'app',
              problem: 'does not exist',
            },
          },
        }),
      ),
    ).toBeUndefined();
  });
});

// =============================================================================
// 5. The closing sentence
// =============================================================================

describe('uninstallOutcome', () => {
  it('names the extras that did NOT run, on a run that removed the deployment', () => {
    // The operator who has just watched a deployment disappear is exactly the
    // person about to assume the database went with it.
    expect(uninstallOutcome(result({ dryRun: false }))).toContain(
      'the object storage and the database were left alone',
    );
  });

  it('claims nothing about an extra that did run', () => {
    const out = uninstallOutcome(
      result({ dryRun: false, database: { outcome: { ok: true, detail: 'dropped appdb', terminated: 0 } } }),
    );

    expect(out).toContain('the object storage was left alone');
    expect(out).not.toContain('the database was left alone');
  });

  it('says nothing was changed after a dry run', () => {
    expect(uninstallOutcome(result())).toBe('Dry run complete. Nothing was changed.');
  });
});
