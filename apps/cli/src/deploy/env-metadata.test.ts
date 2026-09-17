import { describe, expect, it } from 'vitest';

import {
  metadataFor,
  suggestApiMemoryLimit,
  suggestBindPort,
  suggestWebMemoryLimit,
  suggestWorkerConcurrency,
  validateBoolean,
  validateMemorySize,
  validatePositiveInteger,
  type DeriveContext,
} from './env-metadata.js';
import { unknownServerFacts, type ServerFacts } from './server-facts.js';

// =============================================================================
// The server-derived suggestions  (issue #127, epic #118)
// =============================================================================
// Each is a pure function of DeriveContext, so a fake server is one object.

const GIB = 1024 * 1024 * 1024;

function context(
  facts: Partial<ServerFacts> = {},
  extra: Partial<DeriveContext> = {},
): DeriveContext {
  return {
    domain: 'app.example.test',
    answers: new Map(),
    facts: { ...unknownServerFacts(), ...facts },
    siblingPorts: [],
    portFree: async () => true,
    ...extra,
  };
}

describe('APP_BIND_PORT suggestion', () => {
  it('offers 3535 when it is free and nobody has recorded it', async () => {
    const suggestion = await suggestBindPort(context());

    expect(suggestion?.value).toBe('3535');
    expect(suggestion?.reason).not.toBe('');
  });

  it('skips a port a sibling app recorded, even one that is not listening, and says whose it is', async () => {
    // A stopped app is invisible to a bind probe: the state file is the only
    // thing that knows the port is spoken for.
    const suggestion = await suggestBindPort(
      context({}, { siblingPorts: [{ name: 'demo', port: 3535 }] }),
    );

    expect(suggestion?.value).toBe('3536');
    expect(suggestion?.reason).toBe('3535 is used by demo');
  });

  it('skips a port something else is listening on', async () => {
    const suggestion = await suggestBindPort(
      context({}, { portFree: async (port) => port !== 3535 && port !== 3536 }),
    );

    expect(suggestion?.value).toBe('3537');
    expect(suggestion?.reason).toContain('3535 is in use');
    expect(suggestion?.reason).toContain('3536 is in use');
  });

  it('combines both reasons in scan order', async () => {
    const suggestion = await suggestBindPort(
      context(
        {},
        {
          siblingPorts: [{ name: 'alpha', port: 3535 }, { name: 'beta', port: 3537 }],
          portFree: async (port) => port !== 3536,
        },
      ),
    );

    expect(suggestion?.value).toBe('3538');
    expect(suggestion?.reason).toBe(
      '3535 is used by alpha, 3536 is in use on this server, 3537 is used by beta',
    );
  });

  it('gives up rather than scanning forever when every port is taken', async () => {
    expect(await suggestBindPort(context({}, { portFree: async () => false }))).toBeUndefined();
  });

  it('is wired to the APP_BIND_PORT key', () => {
    expect(metadataFor('APP_BIND_PORT').suggest).toBe(suggestBindPort);
  });
});

describe('JOBS_WORKER_CONCURRENCY suggestion', () => {
  it.each([
    [1, '1'],
    [2, '1'],
    [4, '3'],
    [8, '4'],
    [32, '4'],
  ])('with %i CPUs suggests %s', async (cpus, expected) => {
    const suggestion = await suggestWorkerConcurrency(context({ cpus }));

    expect(suggestion?.value).toBe(expected);
    expect(suggestion?.reason).toContain(`${cpus} CPU`);
  });

  it('has no opinion when the CPU count is unknown', async () => {
    expect(await suggestWorkerConcurrency(context())).toBeUndefined();
  });

  it('is wired to the JOBS_WORKER_CONCURRENCY key', () => {
    expect(metadataFor('JOBS_WORKER_CONCURRENCY').suggest).toBe(suggestWorkerConcurrency);
  });
});

describe('memory limit suggestions', () => {
  it.each([
    [2 * GIB, '512m', '128m'],
    [4 * GIB - 1, '512m', '128m'],
    [4 * GIB, '1g', '256m'],
    [8 * GIB - 1, '1g', '256m'],
    [8 * GIB, '2g', '256m'],
    [64 * GIB, '2g', '256m'],
  ])('with %i bytes suggests api %s and web %s', async (memoryBytes, api, web) => {
    expect((await suggestApiMemoryLimit(context({ memoryBytes })))?.value).toBe(api);
    expect((await suggestWebMemoryLimit(context({ memoryBytes })))?.value).toBe(web);
  });

  it('names the RAM it saw in the reason', async () => {
    const suggestion = await suggestApiMemoryLimit(context({ memoryBytes: 4 * GIB }));

    expect(suggestion?.reason).toBe('4 GiB RAM detected');
  });

  it('has no opinion when the RAM is unknown', async () => {
    expect(await suggestApiMemoryLimit(context())).toBeUndefined();
    expect(await suggestWebMemoryLimit(context())).toBeUndefined();
  });

  it('suggests values its own validator accepts', async () => {
    for (const memoryBytes of [1 * GIB, 4 * GIB, 16 * GIB]) {
      const api = await suggestApiMemoryLimit(context({ memoryBytes }));
      const web = await suggestWebMemoryLimit(context({ memoryBytes }));
      expect(metadataFor('API_MEM_LIMIT').validate?.(api?.value as string)).toBeUndefined();
      expect(metadataFor('WEB_MEM_LIMIT').validate?.(web?.value as string)).toBeUndefined();
    }
  });
});

describe('POSTGRES_SSL metadata (issue #127)', () => {
  it('is essential, so the wizard asks it', () => {
    expect(metadataFor('POSTGRES_SSL').essential).toBe(true);
  });

  it('accepts its template default unattended, since false is a real answer', () => {
    expect(metadataFor('POSTGRES_SSL').defaultAcceptable).toBe(true);
  });

  it('accepts only true or false', () => {
    expect(validateBoolean('true')).toBeUndefined();
    expect(validateBoolean('false')).toBeUndefined();
    expect(validateBoolean('yes')).toBeDefined();
    expect(validateBoolean('')).toBeDefined();
  });

  it('points at the database check in its help', () => {
    expect(metadataFor('POSTGRES_SSL').help).toContain('database check');
  });
});

describe('no database hostname is ever pre-filled (epic #118, decision 2)', () => {
  it('gives POSTGRES_HOST no derive, suggest, fixed or help naming a host', () => {
    const metadata = metadataFor('POSTGRES_HOST');

    expect(metadata.derive).toBeUndefined();
    expect(metadata.suggest).toBeUndefined();
    expect(metadata.fixed).toBeUndefined();
    expect(metadata.essential).toBe(true);
  });
});

describe('the resource validators', () => {
  it('accepts whole numbers above zero', () => {
    expect(validatePositiveInteger('1')).toBeUndefined();
    expect(validatePositiveInteger('0')).toBeDefined();
    expect(validatePositiveInteger('2.5')).toBeDefined();
    expect(validatePositiveInteger('two')).toBeDefined();
  });

  it('accepts Docker sizes in either case', () => {
    for (const value of ['512M', '512m', '1g', '1G', '2048', '1024k', '1gb']) {
      expect(validateMemorySize(value)).toBeUndefined();
    }
    expect(validateMemorySize('lots')).toBeDefined();
    expect(validateMemorySize('1.5g')).toBeDefined();
    expect(validateMemorySize('')).toBeDefined();
  });
});

describe('STORAGE_CSP_ORIGIN metadata (issue #255)', () => {
  it('allows a blank, because an empty CSP origin is a real answer', () => {
    // A data fix, not a logic one: relaxing the wizard's blank rule instead
    // would have let the three empty-default credentials through with it.
    expect(metadataFor('STORAGE_CSP_ORIGIN').allowBlank).toBe(true);
  });

  it('leaves the empty-default credentials failing closed', () => {
    for (const key of [
      'SECRETS_ENCRYPTION_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(metadataFor(key).allowBlank).toBeUndefined();
    }
  });
});
