import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALL_CHECKS, type Check, type CompletedCheck } from '../checks/index.js';
import { ENV_METADATA, metadataFor } from '../env-metadata.js';
import { parseEnvExample } from '../env-spec.js';
import { unknownServerFacts } from '../server-facts.js';
import {
  DOMAIN_FIELD,
  GOOGLE_OAUTH_CHECK_ID,
  INSTALL_WIZARD_STEPS,
  STORAGE_CHECK_ID,
  essentialFields,
  googleRedirectUri,
  resolveSteps,
  runStepChecks,
  validateDomain,
  type StepCheckContext,
} from './steps.js';

// =============================================================================
// The wizard as data  (issue #127, epic #118)
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_TEMPLATE = join(HERE, '..', '..', '..', '..', '..', 'infra', 'compose', '.env.example');

const SPECS = parseEnvExample(readFileSync(REAL_TEMPLATE, 'utf8'));
const ALL_GROUPS = ['observability', 'storage', 'microsoft-oauth'] as const;

function stepOf(key: string, groups: readonly (typeof ALL_GROUPS)[number][] = ALL_GROUPS): string[] {
  return resolveSteps(INSTALL_WIZARD_STEPS, SPECS, { groups })
    .filter(({ fields }) => fields.includes(key))
    .map(({ step }) => step.id);
}

describe('INSTALL_WIZARD_STEPS against the real template', () => {
  it('starts with the domain and ends with the review', () => {
    const ids = INSTALL_WIZARD_STEPS.map((step) => step.id);

    expect(ids[0]).toBe('domain');
    expect(ids.at(-1)).toBe('review');
    expect(ids).toEqual([
      'domain',
      'database',
      'secrets',
      'oauth',
      'admin',
      'storage',
      'resources',
      'optional',
      'review',
    ]);
  });

  it('places every essential key in exactly one step, and never in the catch-all', () => {
    const essential = SPECS.filter((spec) => metadataFor(spec.key).essential === true);
    expect(essential.length).toBeGreaterThan(5);

    for (const spec of essential) {
      const owners = stepOf(spec.key);
      expect(owners, spec.key).toHaveLength(1);
      expect(owners[0], spec.key).not.toBe('optional');
    }
  });

  it('places every template key in exactly one step', () => {
    for (const spec of SPECS) {
      expect(stepOf(spec.key), spec.key).toHaveLength(1);
    }
  });

  it('puts the storage group in the storage step and every other group in the catch-all', () => {
    for (const [key, metadata] of Object.entries(ENV_METADATA)) {
      if (metadata.group === undefined) continue;
      expect(stepOf(key), key).toEqual([metadata.group === 'storage' ? 'storage' : 'optional']);
    }
  });

  it('asks nothing for a group the operator did not opt into', () => {
    const storage = resolveSteps(INSTALL_WIZARD_STEPS, SPECS).find(({ step }) => step.id === 'storage');

    expect(storage?.fields).toEqual([]);
  });

  it('names only checks that exist in the registry', () => {
    const known = new Set(ALL_CHECKS.map((check) => check.id));

    for (const step of INSTALL_WIZARD_STEPS) {
      for (const id of step.checkIds ?? []) {
        expect(known.has(id), `${step.id} names ${id}`).toBe(true);
      }
    }
  });

  it('verifies the domain and the database inline, with the checks the issue names', () => {
    const byId = new Map(INSTALL_WIZARD_STEPS.map((step) => [step.id, step]));

    expect(byId.get('domain')?.checkIds).toEqual(['dns-resolves', 'dns-points-here']);
    expect(byId.get('database')?.checkIds).toEqual([
      'database-reachable',
      'database-credentials',
      'database-exists',
      'database-privileges',
    ]);
    expect(byId.get('database')?.onLeave).toBeDefined();
  });

  it('never pre-fills a database hostname', () => {
    // Decision 2 of #118, from the step side: the database step names the
    // key and offers nothing for it.
    const database = INSTALL_WIZARD_STEPS.find((step) => step.id === 'database');
    const intro = database?.intro({ domain: undefined, answers: new Map(), facts: unknownServerFacts() }) ?? [];

    expect(intro.join('\n')).toContain('Nothing is pre-filled for the host');
    expect(metadataFor('POSTGRES_HOST').derive).toBeUndefined();
    expect(metadataFor('POSTGRES_HOST').suggest).toBeUndefined();
  });

  it('keeps every step ordered by the template within the catch-all', () => {
    const optional = resolveSteps(INSTALL_WIZARD_STEPS, SPECS, { groups: ALL_GROUPS }).find(
      ({ step }) => step.id === 'optional',
    );
    const order = new Map(SPECS.map((spec, index) => [spec.key, index]));
    const indices = (optional?.fields ?? []).map((key) => order.get(key) as number);

    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe('the OAuth intro', () => {
  it('prints the exact redirect URI for the domain, and APP_URL', () => {
    const oauth = INSTALL_WIZARD_STEPS.find((step) => step.id === 'oauth');
    const lines = oauth?.intro({
      domain: 'app.example.test',
      answers: new Map([['APP_URL', 'https://app.example.test']]),
      facts: unknownServerFacts(),
    });

    expect(lines?.join('\n')).toContain('https://app.example.test/api/auth/google/callback');
    expect(lines?.join('\n')).toContain('APP_URL will be https://app.example.test');
  });

  it('derives the redirect URI from the domain when APP_URL is not answered yet', () => {
    expect(
      googleRedirectUri({ domain: 'app.example.test', answers: new Map(), facts: unknownServerFacts() }),
    ).toBe('https://app.example.test/api/auth/google/callback');
  });

  it('has no URI without a domain', () => {
    expect(googleRedirectUri({ domain: undefined, answers: new Map(), facts: unknownServerFacts() })).toBeUndefined();
  });
});

describe('validateDomain', () => {
  it('accepts a hostname and rejects anything else', () => {
    expect(validateDomain('app.example.com')).toBeUndefined();
    expect(validateDomain('')).toBeDefined();
    expect(validateDomain('https://app.example.com')).toBeDefined();
    expect(validateDomain('app.example.com/path')).toBeDefined();
    expect(validateDomain('not a host')).toBeDefined();
  });
});

function fakeCheck(id: string, run: Check['run']): Check {
  return { id, title: id, severity: 'required', run };
}

function checkContext(overrides: Partial<StepCheckContext> = {}): StepCheckContext {
  return {
    domain: 'app.example.test',
    answers: new Map(),
    facts: unknownServerFacts(),
    checks: [],
    runChecks: async (checks, context) => {
      const results: CompletedCheck[] = [];
      for (const check of checks) {
        results.push({
          ...(await check.run(context)),
          id: check.id,
          title: check.title,
          severity: check.severity,
          durationMs: 0,
        });
      }
      return results;
    },
    probeTcp: async () => ({ ok: true, reason: undefined }),
    base: {
      runCommand: (async () => {
        throw new Error('no command should run');
      }) as unknown as StepCheckContext['base']['runCommand'],
      deployRoot: '/tmp/app',
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
    },
    ...overrides,
  };
}

describe('runStepChecks', () => {
  it('runs only the named checks, with the domain and the answers so far as the env', async () => {
    let seen: Parameters<Check['run']>[0] | undefined;
    const context = checkContext({
      answers: new Map([['POSTGRES_HOST', 'db.internal']]),
      checks: [
        fakeCheck('wanted', async (ctx) => {
          seen = ctx;
          return { status: 'pass', detail: 'ok' };
        }),
        fakeCheck('unwanted', async () => ({ status: 'fail', detail: 'must not run', remedy: 'x' })),
      ],
    });

    const results = await runStepChecks(['wanted'], context);

    expect(results.map((result) => result.id)).toEqual(['wanted']);
    expect(seen?.domain).toBe('app.example.test');
    expect(seen?.env?.get('POSTGRES_HOST')).toBe('db.internal');
    expect(seen?.bindPort).toBe(3535);
  });

  it('lets the typed APP_BIND_PORT outrank the base context', async () => {
    let seen: Parameters<Check['run']>[0] | undefined;
    const context = checkContext({
      answers: new Map([['APP_BIND_PORT', '3536']]),
      checks: [
        fakeCheck('port', async (ctx) => {
          seen = ctx;
          return { status: 'pass', detail: 'ok' };
        }),
      ],
    });

    await runStepChecks(['port'], context);

    expect(seen?.bindPort).toBe(3536);
  });

  it('ignores an id the registry does not have rather than failing', async () => {
    expect(await runStepChecks(['nope'], checkContext())).toEqual([]);
  });
});

describe('the storage step', () => {
  const storage = INSTALL_WIZARD_STEPS.find((step) => step.id === 'storage');

  it('probes nothing when no bucket is configured', async () => {
    expect(await storage?.onLeave?.(checkContext())).toEqual([]);
    expect(
      await storage?.onLeave?.(checkContext({ answers: new Map([['S3_BUCKET', 'your-bucket-name']]) })),
    ).toEqual([]);
  });

  it('probes the endpoint host and port when one is set', async () => {
    const probed: [string, number][] = [];
    const results = await storage?.onLeave?.(
      checkContext({
        answers: new Map([
          ['S3_BUCKET', 'uploads'],
          ['S3_ENDPOINT', 'http://minio.internal:9000'],
        ]),
        probeTcp: async (host, port) => {
          probed.push([host, port]);
          return { ok: true, reason: undefined };
        },
      }),
    );

    expect(probed).toEqual([['minio.internal', 9000]]);
    expect(results?.[0]).toMatchObject({ id: STORAGE_CHECK_ID, status: 'pass', severity: 'recommended' });
  });

  it('only ever warns, so an unreachable bucket never blocks the install', async () => {
    const results = await storage?.onLeave?.(
      checkContext({
        answers: new Map([
          ['S3_BUCKET', 'uploads'],
          ['S3_REGION', 'eu-west-1'],
        ]),
        probeTcp: async () => ({ ok: false, reason: 'timeout' }),
      }),
    );

    expect(results?.[0]?.status).toBe('warn');
    expect(results?.[0]?.detail).toContain('uploads.s3.eu-west-1');
    expect(results?.[0]?.remedy).toBeDefined();
  });
});

describe('essentialFields', () => {
  it('starts with the domain, then the essential keys in step order', () => {
    const keys = essentialFields(SPECS).map((field) => field.key);

    expect(keys[0]).toBe(DOMAIN_FIELD);
    // Database before secrets before OAuth before admin: the step order, which
    // is also the template order for these keys.
    expect(keys.indexOf('POSTGRES_SSL')).toBeGreaterThan(keys.indexOf('POSTGRES_HOST'));
    expect(keys.indexOf('JWT_SECRET')).toBeGreaterThan(keys.indexOf('POSTGRES_SSL'));
    expect(keys.indexOf('GOOGLE_CLIENT_ID')).toBeGreaterThan(keys.indexOf('JWT_SECRET'));
    expect(keys.indexOf('INITIAL_ADMIN_EMAIL')).toBeGreaterThan(keys.indexOf('GOOGLE_CLIENT_SECRET'));
  });

  it('appends the metadata help to the template comment', () => {
    const ssl = essentialFields(SPECS).find((field) => field.key === 'POSTGRES_SSL');

    expect(ssl?.help).toContain('true or false');
  });
});

// =============================================================================
// The oauth step's onLeave — googleOauthVerified  (issue #231)
// =============================================================================
//
// Driven through `INSTALL_WIZARD_STEPS.find((s) => s.id === 'oauth').onLeave`
// rather than an export of the function itself: that also pins the wiring
// (the oauth step really does call this probe on leave), exactly as the task
// asked. `fetchImpl` is a fake matching only the shape this probe reads
// (`.json()`) — the real Google response is never awaited on anything else.
// =============================================================================

function fakeFetch(payload: unknown): typeof fetch {
  return (async () => ({ json: async () => payload })) as unknown as typeof fetch;
}

const THROWING_FETCH: typeof fetch = (async () => {
  throw new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com');
}) as unknown as typeof fetch;

describe("the oauth step's onLeave (googleOauthVerified)", () => {
  const oauth = INSTALL_WIZARD_STEPS.find((step) => step.id === 'oauth');
  const WELL_FORMED_ID = '123456-abc.apps.googleusercontent.com';

  it('fails a client id that does not end .apps.googleusercontent.com, without ever calling fetch', async () => {
    let called = false;
    const results = await oauth?.onLeave?.(
      checkContext({
        answers: new Map([
          ['GOOGLE_CLIENT_ID', 'not-a-real-client-id'],
          ['GOOGLE_CLIENT_SECRET', 'super-secret'],
        ]),
        fetchImpl: (async () => {
          called = true;
          return { json: async () => ({}) } as unknown as Response;
        }) as unknown as typeof fetch,
      }),
    );

    expect(results?.[0]).toMatchObject({ id: GOOGLE_OAUTH_CHECK_ID, status: 'fail' });
    expect(called).toBe(false);
  });

  it('emits nothing for an empty client id — required-ness is the field validator\'s job', async () => {
    const results = await oauth?.onLeave?.(checkContext({ answers: new Map() }));

    expect(results).toEqual([]);
  });

  it('warns, never fails, for a well-formed id with no secret typed yet', async () => {
    const results = await oauth?.onLeave?.(
      checkContext({ answers: new Map([['GOOGLE_CLIENT_ID', WELL_FORMED_ID]]) }),
    );

    expect(results?.[0]?.status).toBe('warn');
  });

  it('fails when Google reports invalid_client — the pair is not real', async () => {
    const results = await oauth?.onLeave?.(
      checkContext({
        answers: new Map([
          ['GOOGLE_CLIENT_ID', WELL_FORMED_ID],
          ['GOOGLE_CLIENT_SECRET', 'wrong-project-secret'],
        ]),
        fetchImpl: fakeFetch({ error: 'invalid_client' }),
      }),
    );

    expect(results?.[0]?.status).toBe('fail');
  });

  it('passes when Google reports invalid_grant — the counter-intuitive case: the pair IS real', async () => {
    const results = await oauth?.onLeave?.(
      checkContext({
        domain: 'app.example.test',
        answers: new Map([
          ['GOOGLE_CLIENT_ID', WELL_FORMED_ID],
          ['GOOGLE_CLIENT_SECRET', 'a-real-secret'],
        ]),
        fetchImpl: fakeFetch({ error: 'invalid_grant' }),
      }),
    );

    expect(results?.[0]?.status).toBe('pass');
    // Says plainly what it does NOT claim: redirect-URI registration was
    // never checked.
    expect(results?.[0]?.detail).toContain('redirect URI registration cannot be checked');
  });

  it('warns, never fails, when fetch rejects — an operator on a restricted network must still install', async () => {
    const results = await oauth?.onLeave?.(
      checkContext({
        answers: new Map([
          ['GOOGLE_CLIENT_ID', WELL_FORMED_ID],
          ['GOOGLE_CLIENT_SECRET', 'a-real-secret'],
        ]),
        fetchImpl: THROWING_FETCH,
      }),
    );

    expect(results?.[0]?.status).toBe('warn');
  });
});
