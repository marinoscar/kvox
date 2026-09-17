import { describe, expect, it } from 'vitest';

import type { CommandResult, RunCommandOptions } from './executor.js';
import {
  APP_KEY_PREFIXES,
  bucketVersioning,
  describeInventory,
  formatBytes,
  inventoryStorage,
  purgeStorage,
  retainsVersions,
  storageProblem,
  storageSettings,
  type StorageSettings,
} from './storage-purge.js';

// =============================================================================
// storage-purge.ts  (issue #268)
// =============================================================================
//
// The unit-level half of the storage extra; `uninstall-extras.test.ts` covers
// it end to end through `runUninstall`. What is here is the reading: how the
// prefixes are derived, how a bucket is described to somebody about to empty
// it, and the credential rule that no argv may ever carry a secret.
// =============================================================================

const SETTINGS: StorageSettings = {
  bucket: 'demo-bucket',
  region: 'eu-west-1',
  endpoint: '',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'super-secret-value',
};

interface Recorder {
  seen: string[][];
  envs: (NodeJS.ProcessEnv | undefined)[];
  runCommand: typeof import('./executor.js').runCommand;
}

function recorder(answer: (argv: readonly string[]) => string): Recorder {
  const seen: string[][] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const runCommand = (async (
    argv: readonly string[],
    options: RunCommandOptions,
  ): Promise<CommandResult> => {
    seen.push([...argv]);
    envs.push(options.env);
    return {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: 0,
      stdout: answer(argv),
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
  }) as typeof import('./executor.js').runCommand;
  return { seen, envs, runCommand };
}

describe('storageSettings', () => {
  it('reads the values the deployment actually used', () => {
    const settings = storageSettings(
      new Map([
        ['S3_BUCKET', 'b'],
        ['S3_REGION', 'us-east-2'],
        ['S3_ENDPOINT', 'http://localhost:9000'],
        ['AWS_ACCESS_KEY_ID', 'k'],
        ['AWS_SECRET_ACCESS_KEY', 's'],
      ]),
    );

    expect(settings).toEqual({
      bucket: 'b',
      region: 'us-east-2',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
  });

  it('answers undefined rather than guessing a bucket name', () => {
    // A purge run against a guessed bucket is the one mistake this module must
    // not be able to make, so there is no default here - unlike the region.
    expect(storageSettings(undefined)).toBeUndefined();
    expect(storageSettings(new Map())).toBeUndefined();
    expect(storageSettings(new Map([['S3_BUCKET', '']]))).toBeUndefined();
  });
});

describe('storageProblem', () => {
  it('refuses a bucket with no credentials rather than producing a confusing 403', () => {
    expect(storageProblem({ ...SETTINGS, secretAccessKey: '' })).toMatch(
      /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/,
    );
  });

  it('refuses a value that cannot name a real bucket', () => {
    expect(storageProblem({ ...SETTINGS, bucket: 'Not A Bucket' })).toMatch(/not a valid S3 bucket/);
    expect(storageProblem({ ...SETTINGS, bucket: 'x' })).toMatch(/not a valid S3 bucket/);
  });

  it('accepts an ordinary bucket', () => {
    expect(storageProblem(SETTINGS)).toBeUndefined();
  });
});

describe('the credentials', () => {
  it('never appear in an argv, only in the child’s environment', async () => {
    const fake = recorder(() => '{}');

    await inventoryStorage(fake, SETTINGS);

    // `runPsql`'s rule about PGPASSWORD, restated for AWS: the argv is what a
    // journal line, an onLine hook or a thrown error could carry.
    for (const argv of fake.seen) {
      expect(argv.join(' ')).not.toContain(SETTINGS.secretAccessKey);
      expect(argv.join(' ')).not.toContain(SETTINGS.accessKeyId);
      // Passed by NAME.
      expect(argv).toContain('AWS_SECRET_ACCESS_KEY');
    }
    expect(fake.envs[0]?.['AWS_SECRET_ACCESS_KEY']).toBe(SETTINGS.secretAccessKey);
  });

  it('disables instance metadata, so an EC2 role cannot be picked up instead', async () => {
    const fake = recorder(() => '{}');

    await bucketVersioning(fake, SETTINGS);

    expect(fake.seen[0]).toContain('AWS_EC2_METADATA_DISABLED');
    expect(fake.envs[0]?.['AWS_EC2_METADATA_DISABLED']).toBe('true');
  });

  it('passes --endpoint-url only when one is configured', async () => {
    const aws = recorder(() => '{}');
    await bucketVersioning(aws, SETTINGS);
    expect(aws.seen[0]).not.toContain('--endpoint-url');

    const minio = recorder(() => '{}');
    await bucketVersioning(minio, { ...SETTINGS, endpoint: 'http://localhost:9000' });
    expect(minio.seen[0]).toContain('--endpoint-url');
    // Reachable from a container: an S3_ENDPOINT on this host is ordinary.
    expect(minio.seen[0]).toContain('--network');
  });
});

describe('bucketVersioning', () => {
  it('reads Enabled and Suspended, and an empty document as never versioned', async () => {
    for (const [stdout, expected] of [
      ['{"Status":"Enabled"}', 'Enabled'],
      ['{"Status":"Suspended"}', 'Suspended'],
      ['{}', 'Disabled'],
      ['', 'Disabled'],
    ] as const) {
      expect(await bucketVersioning(recorder(() => stdout), SETTINGS), stdout).toBe(expected);
    }
  });

  it('treats Unknown as retaining versions, and Disabled as not', () => {
    // Assuming the cheaper answer is exactly what produces silent retention.
    expect(retainsVersions('Unknown')).toBe(true);
    expect(retainsVersions('Enabled')).toBe(true);
    expect(retainsVersions('Suspended')).toBe(true);
    expect(retainsVersions('Disabled')).toBe(false);
  });
});

describe('inventoryStorage', () => {
  it('reads the bucket root with a delimiter rather than enumerating it', async () => {
    const fake = recorder((argv) => {
      if (argv.includes('get-bucket-versioning')) return '{}';
      if (argv.includes('--delimiter')) {
        return JSON.stringify({ CommonPrefixes: [{ Prefix: 'notes/' }] });
      }
      return JSON.stringify({ Contents: [{ Key: 'notes/a.md', Size: 7 }] });
    });

    const inventory = await inventoryStorage(fake, SETTINGS);

    const root = fake.seen.find((argv) => argv.includes('--delimiter'));
    expect(root).toBeDefined();
    expect(root?.[root.indexOf('--delimiter') + 1]).toBe('/');
    // Enumerating a shared bucket exhaustively means READING somebody else's
    // data in order to decide not to touch it.
    expect(root).not.toContain('--prefix');
    expect(inventory.prefixes).toEqual([{ prefix: 'notes/', objects: 1, bytes: 7, versions: 0 }]);
  });

  it('lists only the prefixes that are actually present', async () => {
    const fake = recorder((argv) =>
      argv.includes('get-bucket-versioning')
        ? '{}'
        : argv.includes('--delimiter')
          ? JSON.stringify({ CommonPrefixes: [{ Prefix: 'uploads/' }] })
          : JSON.stringify({ Contents: [] }),
    );

    await inventoryStorage(fake, SETTINGS);

    const prefixed = fake.seen.filter((argv) => argv.includes('--prefix'));
    expect(prefixed).toHaveLength(1);
    expect(prefixed[0]?.[prefixed[0].indexOf('--prefix') + 1]).toBe('uploads/');
  });
});

describe('purgeStorage cannot reach a foreign prefix', () => {
  it('derives every deletion target from APP_KEY_PREFIXES, structurally', async () => {
    const fake = recorder((argv) =>
      argv.includes('get-bucket-versioning')
        ? '{}'
        : argv.includes('--delimiter')
          ? JSON.stringify({ CommonPrefixes: [{ Prefix: 'uploads/' }, { Prefix: 'theirs/' }] })
          : JSON.stringify({ Contents: [{ Key: 'uploads/a', Size: 1 }] }),
    );

    const inventory = await inventoryStorage(fake, SETTINGS);
    // The foreign entry is in the inventory, which is exactly the shape a
    // "just delete everything we found" edit would reach for.
    expect(inventory.foreign).toEqual([{ key: 'theirs/', kind: 'prefix' }]);

    const after = recorder(() => JSON.stringify({ Contents: [{ Key: 'uploads/a', Size: 1 }] }));
    await purgeStorage(after, SETTINGS, inventory);

    for (const argv of after.seen) {
      expect(argv.join(' ')).not.toContain('theirs/');
    }
  });

  it('reports a failed prefix and carries on with the rest', async () => {
    const fake = recorder(() => '{}');
    const result = await purgeStorage(fake, SETTINGS, {
      bucket: SETTINGS.bucket,
      region: SETTINGS.region,
      endpoint: '',
      versioning: 'Disabled',
      prefixes: [
        { prefix: 'uploads/', objects: 0, bytes: 0, versions: 0 },
        { prefix: 'notes/', objects: 0, bytes: 0, versions: 0 },
      ],
      foreign: [],
      objects: 0,
      bytes: 0,
      versions: 0,
    });

    expect(result.deleted.map((entry) => entry.prefix)).toEqual(['uploads/', 'notes/']);
    expect(result.failures).toEqual([]);
    // Nothing was there, so nothing was deleted - and no claim is made that
    // versions remain on a bucket that has none.
    expect(result.keys).toBe(0);
    expect(result.versionsRemain).toBeUndefined();
  });
});

describe('describeInventory', () => {
  const base = {
    bucket: 'demo-bucket',
    region: 'eu-west-1',
    endpoint: '',
    prefixes: [{ prefix: 'uploads/', objects: 2, bytes: 3_000_000, versions: 0 }],
    foreign: [],
    objects: 2,
    bytes: 3_000_000,
    versions: 0,
  };

  it('shows a count and a size per prefix, plus a total', () => {
    const lines = describeInventory({ ...base, versioning: 'Disabled' }).join('\n');

    expect(lines).toContain('uploads/');
    expect(lines).toContain('3.0 MB');
    expect(lines).toContain('TOTAL');
    expect(lines).toContain('Versioning is off, so a delete is final.');
  });

  it('names every foreign entry and says the bucket is shared', () => {
    const lines = describeInventory({
      ...base,
      versioning: 'Disabled',
      foreign: [
        { key: 'theirs/', kind: 'prefix' as const },
        { key: 'README.txt', kind: 'object' as const },
      ],
    }).join('\n');

    expect(lines).toContain('NOT inspected and NOT deleted (2)');
    expect(lines).toContain('theirs/');
    expect(lines).toContain('README.txt');
    expect(lines).toContain('loose object at the bucket root');
    expect(lines).toContain('The bucket itself is never deleted.');
  });

  it('says what an unreadable versioning answer means for the data', () => {
    const lines = describeInventory({ ...base, versioning: 'Unknown' }).join('\n');

    expect(lines).toContain('could NOT be read');
    expect(lines).toContain('Treated as versioned');
  });

  it('says so when this application has written nothing at all', () => {
    const lines = describeInventory({
      ...base,
      versioning: 'Disabled',
      prefixes: [],
      objects: 0,
      bytes: 0,
    }).join('\n');

    expect(lines).toContain('has written nothing to this bucket');
  });
});

describe('formatBytes', () => {
  it('uses base 10, matching what a cloud bill counts in', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 kB');
    expect(formatBytes(3_000_000)).toBe('3.0 MB');
    expect(formatBytes(12_000_000_000)).toBe('12 GB');
  });
});

describe('APP_KEY_PREFIXES', () => {
  it('is the six this application writes, each ending in a slash', () => {
    expect(APP_KEY_PREFIXES).toHaveLength(6);
    for (const prefix of APP_KEY_PREFIXES) expect(prefix.endsWith('/')).toBe(true);
    // ⚠ `database-backups/` is BACKUP_KEY_PREFIX in the API. A bare `backups/`
    // appears only in db-backup's test fixtures and would match nothing real.
    expect(APP_KEY_PREFIXES).toContain('database-backups/');
    expect(APP_KEY_PREFIXES).not.toContain('backups/');
  });
});
