import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from './executor.js';
import {
  collectHealth,
  composeArgs,
  describeFetchFailure,
  isHealthy,
  probe,
  waitForHealthy,
  type HealthReport,
} from './health.js';

type Canned = { exitCode: number; stdout?: string; stderr?: string };

function fakeRunCommand(
  respond: (argv: readonly string[]) => Canned | undefined,
): typeof import('./executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const canned = respond(argv) ?? { exitCode: 1, stderr: 'no' };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    const allowed = options.allowExitCodes ?? [];
    if (result.exitCode !== 0 && !allowed.includes(result.exitCode)) {
      throw new CommandFailedError(result.stderr || 'failed', result);
    }
    return result;
  }) as typeof import('./executor.js').runCommand;
}

function response(status: number): Response {
  return new Response('', { status });
}

const RUNNING_PS = JSON.stringify([
  { Name: 'demo-api-1', Service: 'api', State: 'running', Image: 'demo-api', Health: 'healthy' },
  { Name: 'demo-web-1', Service: 'web', State: 'running', Image: 'demo-web' },
  { Name: 'demo-nginx-1', Service: 'nginx', State: 'running', Image: 'nginx:1.30-alpine' },
]);

function healthyRunCommand(): typeof import('./executor.js').runCommand {
  return fakeRunCommand((argv) => {
    const line = argv.join(' ');
    if (line.includes(' ps ')) return { exitCode: 0, stdout: RUNNING_PS };
    if (line.includes('migrate status')) {
      return { exitCode: 0, stdout: '3 migrations found\nDatabase schema is up to date!' };
    }
    return { exitCode: 0 };
  });
}

function okFetch(): typeof globalThis.fetch {
  return (async () => response(200)) as typeof globalThis.fetch;
}

describe('probe', () => {
  it('reports a 2xx as ok, with a duration', async () => {
    const result = await probe('http://x/', { fetch: okFetch() });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a 503 as not ok, keeping the status', async () => {
    const result = await probe('http://x/', {
      fetch: (async () => response(503)) as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });
});

describe('describeFetchFailure', () => {
  it.each([
    ['ECONNREFUSED', 'connection refused'],
    ['ENOTFOUND', 'host does not resolve'],
    ['CERT_HAS_EXPIRED', 'the TLS certificate has expired'],
  ])('turns %s into something actionable', (code, expected) => {
    const error = Object.assign(new Error('fetch failed'), { cause: { code } });
    expect(describeFetchFailure(error)).toBe(expected);
  });

  it('recognises a timeout', () => {
    const error = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(describeFetchFailure(error)).toBe('timed out');
  });
});

describe('composeArgs', () => {
  it('pins the project name and layers base, prod and vps in that order', () => {
    // `-p demo` is what keeps `status` on this app rather than on whichever
    // app last ran `up` as the project `compose` (#119).
    expect(composeArgs('/opt/infra/apps/demo', 'demo').join(' ')).toBe(
      '-p demo -f base.compose.yml -f prod.compose.yml -f vps.compose.yml --project-directory /opt/infra/apps/demo/repo/infra/compose',
    );
  });
});

describe('collectHealth', () => {
  const base = {
    deployRoot: '/opt/infra/apps/demo',
    name: 'demo',
    bindPort: 3535,
  };

  it('runs every compose command under the pinned project name', async () => {
    const seen: string[][] = [];
    await collectHealth({
      ...base,
      runCommand: fakeRunCommand((argv) => {
        seen.push([...argv]);
        return { exitCode: 0, stdout: RUNNING_PS };
      }),
      fetch: okFetch(),
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const argv of seen) {
      expect(argv.slice(0, 4)).toEqual(['docker', 'compose', '-p', 'demo']);
    }
  });

  it('reports containers, probes and migration state', async () => {
    const report = await collectHealth({
      ...base,
      runCommand: healthyRunCommand(),
      fetch: okFetch(),
    });

    expect(report.containers.map((c) => c.service)).toEqual(['api', 'web', 'nginx']);
    expect(report.local.ready.ok).toBe(true);
    expect(report.migrations).toEqual({ known: true, applied: 3, pending: [] });
    expect(isHealthy(report)).toBe(true);
  });

  it('reads migration status through the env wrapper, not bare npx prisma', async () => {
    // DATABASE_URL is derived from the POSTGRES_* variables by
    // scripts/prisma-env.js and is set nowhere in the deployment, so bare
    // `npx prisma` fails config validation and this check silently degrades
    // to `known: false` - which isHealthy() treats as non-fatal. The spelling
    // is pinned here because a matcher on 'migrate status' alone passes
    // either way.
    const seen: string[][] = [];
    await collectHealth({
      ...base,
      runCommand: fakeRunCommand((argv) => {
        seen.push([...argv]);
        const line = argv.join(' ');
        if (line.includes(' ps ')) return { exitCode: 0, stdout: RUNNING_PS };
        if (line.includes('migrate status')) {
          return { exitCode: 0, stdout: '3 migrations found\nDatabase schema is up to date!' };
        }
        return { exitCode: 0 };
      }),
      fetch: okFetch(),
    });

    const migrate = seen.find((argv) => argv.includes('migrate') && argv.includes('status'));
    expect(migrate).toBeDefined();
    expect(migrate?.slice(-4)).toEqual(['node', 'scripts/prisma-env.js', 'migrate', 'status']);
    expect(migrate).not.toContain('npx');
  });

  it('probes the frontend separately from the API', async () => {
    const urls: string[] = [];
    await collectHealth({
      ...base,
      runCommand: healthyRunCommand(),
      fetch: (async (url: string | URL) => {
        urls.push(String(url));
        return response(200);
      }) as typeof globalThis.fetch,
    });

    // The frontend fails independently of the API - #169 is exactly the case
    // where every API check passes and the site serves nothing.
    expect(urls).toContain('http://127.0.0.1:3535/');
    expect(urls).toContain('http://127.0.0.1:3535/api/health/live');
    expect(urls).toContain('http://127.0.0.1:3535/api/health/ready');
  });

  it('adds an external check only when a domain is given', async () => {
    const without = await collectHealth({
      ...base,
      runCommand: healthyRunCommand(),
      fetch: okFetch(),
    });
    expect(without.external).toBeUndefined();

    const withDomain = await collectHealth({
      ...base,
      domain: 'app.example.test',
      runCommand: healthyRunCommand(),
      fetch: okFetch(),
    });
    expect(withDomain.external?.url).toBe('https://app.example.test/api/health/ready');
  });

  it('parses compose output emitted one object per line', async () => {
    const report = await collectHealth({
      ...base,
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ').includes(' ps ')
          ? {
              exitCode: 0,
              stdout: [
                '{"Name":"a","Service":"api","State":"running","Image":"i"}',
                '{"Name":"b","Service":"web","State":"exited","Image":"i"}',
              ].join('\n'),
            }
          : { exitCode: 0, stdout: 'Database schema is up to date!' },
      ),
      fetch: okFetch(),
    });

    expect(report.containers).toHaveLength(2);
  });

  it('reports unknown migration state rather than assuming it is fine', async () => {
    const report = await collectHealth({
      ...base,
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ').includes(' ps ') ? { exitCode: 0, stdout: RUNNING_PS } : undefined,
      ),
      fetch: okFetch(),
    });

    expect(report.migrations.known).toBe(false);
  });
});

describe('isHealthy', () => {
  function report(overrides: Partial<HealthReport> = {}): HealthReport {
    return {
      containers: [
        { name: 'demo-api-1', service: 'api', state: 'running', image: 'i' },
        { name: 'demo-web-1', service: 'web', state: 'running', image: 'i' },
      ],
      local: {
        live: { ok: true, status: 200, durationMs: 1 },
        ready: { ok: true, status: 200, durationMs: 1 },
        frontend: { ok: true, status: 200, durationMs: 1 },
      },
      migrations: { known: true, pending: [] },
      ...overrides,
    };
  }

  it('is healthy when everything is serving and the schema is current', () => {
    expect(isHealthy(report())).toBe(true);
  });

  it('is unhealthy when the web container is stopped, even with the API green', () => {
    // The #169 scenario: API answers, site serves nothing.
    expect(
      isHealthy(
        report({
          containers: [
            { name: 'demo-api-1', service: 'api', state: 'running', image: 'i' },
            { name: 'demo-web-1', service: 'web', state: 'exited', image: 'i' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('is unhealthy when a container is restarting', () => {
    expect(
      isHealthy(
        report({
          containers: [{ name: 'a', service: 'api', state: 'restarting', image: 'i' }],
        }),
      ),
    ).toBe(false);
  });

  it('is unhealthy with pending migrations even though readiness is green', () => {
    // /api/health/ready issues SELECT 1, which passes against an empty
    // database. A green probe is not proof that the schema is there.
    expect(
      isHealthy(report({ migrations: { known: true, pending: ['20260101000000_add_x'] } })),
    ).toBe(false);
  });

  it('is unhealthy when the frontend probe fails', () => {
    expect(
      isHealthy(
        report({
          local: {
            live: { ok: true, status: 200, durationMs: 1 },
            ready: { ok: true, status: 200, durationMs: 1 },
            frontend: { ok: false, status: 502, durationMs: 1 },
          },
        }),
      ),
    ).toBe(false);
  });

  it('is unhealthy when the external check fails', () => {
    expect(
      isHealthy(
        report({
          external: {
            url: 'https://x/api/health/ready',
            probe: { ok: false, durationMs: 1, error: 'the TLS certificate has expired' },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('waitForHealthy', () => {
  it('returns as soon as readiness answers', async () => {
    let calls = 0;
    const result = await waitForHealthy({
      deployRoot: '/x',
      name: 'x',
      bindPort: 3535,
      runCommand: healthyRunCommand(),
      fetch: (async () => {
        calls += 1;
        return response(calls >= 3 ? 200 : 503);
      }) as typeof globalThis.fetch,
      sleep: async () => undefined,
      intervalMs: 1,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('reports progress on each attempt', async () => {
    const progress: string[] = [];
    let calls = 0;

    await waitForHealthy({
      deployRoot: '/x',
      name: 'x',
      bindPort: 3535,
      runCommand: healthyRunCommand(),
      fetch: (async () => {
        calls += 1;
        return response(calls >= 2 ? 200 : 503);
      }) as typeof globalThis.fetch,
      sleep: async () => undefined,
      intervalMs: 1,
      hooks: { onProgress: (message) => progress.push(message) },
    });

    expect(progress.some((line) => line.includes('attempt 1'))).toBe(true);
    expect(progress.some((line) => line.includes('Ready after'))).toBe(true);
  });

  it('surfaces the last failure on timeout, not a generic message', async () => {
    const result = await waitForHealthy({
      deployRoot: '/x',
      name: 'x',
      bindPort: 3535,
      runCommand: healthyRunCommand(),
      fetch: (async () => {
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }) as typeof globalThis.fetch,
      sleep: async () => undefined,
      waitMs: 0,
      intervalMs: 1,
    });

    // "connection refused" and "503" send you to completely different places.
    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection refused');
  });
});

// =============================================================================
// A malformed response is not a dead server  (issue #259)
// =============================================================================
//
// `Missing expected LF after header value` names the parser's disappointment,
// not the operator's problem. The deployment that produced it was serving
// correctly - a stray carriage return in the Content-Security-Policy header
// made the response unparseable, and curl reported 200 throughout.
// =============================================================================

/** The real undici shape: a TypeError('fetch failed') wrapping HTTPParserError. */
function parserError(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: {
      code: 'HPE_LF_EXPECTED',
      message:
        'Response does not match the HTTP/1.1 protocol (Missing expected LF after header value)',
    },
  });
}

describe('describeFetchFailure on a protocol error (issue #259)', () => {
  it('says the response was malformed and points at the headers', () => {
    const described = describeFetchFailure(parserError());

    expect(described).toMatch(/malformed/i);
    expect(described).toMatch(/header/i);
  });

  it('warns that a lenient client will disagree', () => {
    // Without this the operator checks with curl, sees 200, and concludes the
    // CLI is wrong about a deployment that really is unreadable.
    expect(describeFetchFailure(parserError())).toMatch(/curl|browser/i);
  });

  it('keeps the underlying parser message for the record', () => {
    expect(describeFetchFailure(parserError())).toContain('Missing expected LF after header value');
  });

  it('does not use that wording for a connection error', () => {
    const refused = describeFetchFailure(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    );

    expect(refused).toBe('connection refused');
    expect(refused).not.toMatch(/malformed/i);
  });

  it('does not use that wording for a timeout', () => {
    expect(describeFetchFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).not.toMatch(
      /malformed/i,
    );
  });
});

describe('probe on a protocol error (issue #259)', () => {
  it('reports a malformed response rather than a status', async () => {
    const result = await probe('http://x/', {
      fetch: (() => Promise.reject(parserError())) as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.error).toMatch(/malformed/i);
  });

  it('does not describe a 503 as malformed', async () => {
    // A status code means the response parsed fine. Different problem.
    const result = await probe('http://x/', {
      fetch: (async () => response(503)) as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBeUndefined();
  });
});
