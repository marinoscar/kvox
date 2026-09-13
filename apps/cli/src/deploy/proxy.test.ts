import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions } from './executor.js';
import {
  assertValidDomain,
  certificateStatus,
  installVhost,
  issueCertificate,
  removeVhost,
  renderVhost,
  validateProxy,
  vhostPath,
  type ProxyTarget,
} from './proxy.js';

type Canned = { exitCode: number; stdout?: string; stderr?: string };

function fakeRunCommand(
  respond: (argv: readonly string[]) => Canned | undefined,
  log?: string[][],
): typeof import('./executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    log?.push([...argv]);
    const canned = respond(argv) ?? { exitCode: 0 };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) throw new CommandFailedError(result.stderr || 'failed', result);
    return result;
  }) as typeof import('./executor.js').runCommand;
}

function makeProxyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-proxy-'));
  mkdirSync(join(root, 'nginx', 'conf.d'), { recursive: true });
  mkdirSync(join(root, 'webroot'), { recursive: true });
  return root;
}

function target(proxyRoot: string): ProxyTarget {
  return { domain: 'app.example.test', bindPort: 3535, proxyRoot };
}

describe('assertValidDomain', () => {
  it('accepts a normal hostname', () => {
    expect(() => assertValidDomain('app.example.test')).not.toThrow();
  });

  it.each([
    'has spaces.example',
    'semi;colon.example',
    'new\nline.example',
    '../escape',
    '-leading-hyphen.example',
    '',
  ])('rejects %j before it reaches a config file', (domain) => {
    // Not a shell, but a newline in a domain would let a vhost be extended
    // with arbitrary directives - the same class of problem.
    expect(() => assertValidDomain(domain)).toThrow(UsageError);
  });
});

describe('renderVhost', () => {
  const root = makeProxyRoot();
  const rendered = renderVhost(target(root));

  it('redirects HTTP to HTTPS', () => {
    expect(rendered).toContain('return 301 https://$host$request_uri;');
  });

  it('keeps the ACME challenge on HTTP so renewal keeps working', () => {
    const acme = rendered.indexOf('/.well-known/acme-challenge/');
    const redirect = rendered.indexOf('return 301');

    expect(acme).toBeGreaterThan(-1);
    // It must come BEFORE the catch-all redirect, or renewal 301s away.
    expect(acme).toBeLessThan(redirect);
  });

  it('proxies to the loopback port', () => {
    expect(rendered).toContain('proxy_pass http://127.0.0.1:3535;');
  });

  it('sets X-Forwarded-Proto to https, not $scheme', () => {
    // The application forwards $scheme onward, so this is the value it
    // ultimately sees; $scheme here would make it build http:// URLs and the
    // OAuth login redirect would loop.
    expect(rendered).toContain('proxy_set_header X-Forwarded-Proto https;');
  });

  it('adds no headers of its own', () => {
    // nginx's add_header REPLACES the inherited set, so any header here would
    // silently delete the application's CSP and HSTS.
    expect(rendered).not.toContain('add_header');
  });

  it('gives the SSE endpoint its own unbuffered block', () => {
    expect(rendered).toContain('/api/notifications/stream');
    expect(rendered).toContain('proxy_buffering off;');
    expect(rendered).toContain('proxy_read_timeout 1h;');
  });

  it('is deterministic, so a re-run produces no spurious diff', () => {
    expect(renderVhost(target(root))).toBe(rendered);
  });

  it('sizes client_max_body_size from the configured upload limit', () => {
    const sized = renderVhost(target(root), { maxBodyBytes: 10 * 1024 * 1024 });
    expect(sized).toContain('client_max_body_size 10m;');
  });

  it('refuses a hostile domain', () => {
    expect(() => renderVhost({ ...target(root), domain: 'a b;c' })).toThrow(UsageError);
  });
});

describe('installVhost', () => {
  it('writes, validates and reloads, in that order', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const result = await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
    });

    expect(existsSync(result.path)).toBe(true);
    expect(calls.map((argv) => argv.join(' '))).toEqual(['nginx -t', 'nginx -s reload']);
  });

  it('reloads rather than restarts', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
    });

    // A restart drops connections for every other application on the box.
    expect(calls.flat()).not.toContain('restart');
  });

  it('does nothing when the vhost is already byte-identical', async () => {
    const root = makeProxyRoot();
    const options = { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) };

    await installVhost(target(root), options);
    const calls: string[][] = [];
    const second = await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
    });

    expect(second.changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('removes the new vhost and re-validates when nginx -t fails', async () => {
    const root = makeProxyRoot();
    let validations = 0;

    const error = await installVhost(target(root), {
      runCommand: fakeRunCommand((argv) => {
        if (argv.join(' ') === 'nginx -t') {
          validations += 1;
          // Fails while the new vhost is present, passes once it is gone.
          return validations === 1
            ? { exitCode: 1, stderr: 'nginx: [emerg] invalid parameter' }
            : { exitCode: 0 };
        }
        return { exitCode: 0 };
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('invalid parameter');
    expect((error as Error).message).toContain('restored');
    // The proxy must be left exactly as it was found.
    expect(existsSync(vhostPath(target(root)))).toBe(false);
  });

  it('restores the previous contents when it overwrote one', async () => {
    const root = makeProxyRoot();
    const path = vhostPath(target(root));
    const previous = '# Managed by appctl deploy\n# an older version\n';
    writeFileSync(path, previous);

    await installVhost(target(root), {
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ') === 'nginx -t' ? { exitCode: 1, stderr: 'nope' } : { exitCode: 0 },
      ),
    }).catch(() => undefined);

    expect(readFileSync(path, 'utf8')).toBe(previous);
  });

  it('never reloads when validation failed', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), {
      runCommand: fakeRunCommand(
        (argv) => (argv.join(' ') === 'nginx -t' ? { exitCode: 1, stderr: 'no' } : { exitCode: 0 }),
        calls,
      ),
    }).catch(() => undefined);

    expect(calls.flat()).not.toContain('reload');
  });

  it('warns when the proxy was already broken before this run', async () => {
    const root = makeProxyRoot();

    const error = await installVhost(target(root), {
      // Fails even after the rollback: the problem predates this deployment.
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ') === 'nginx -t' ? { exitCode: 1, stderr: 'broken already' } : { exitCode: 0 },
      ),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('already broken');
  });

  it('uses docker exec when the proxy is containerised', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      proxyContainer: 'infra-proxy-1',
    });

    expect(calls[0]).toEqual(['docker', 'exec', 'infra-proxy-1', 'nginx', '-t']);
  });
});

describe('issueCertificate', () => {
  it('skips issuance when a certificate already exists', async () => {
    const root = makeProxyRoot();
    const live = join(root, 'letsencrypt', 'live', 'app.example.test');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'fullchain.pem'), 'cert');

    const calls: string[][] = [];
    const result = await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
    });

    // Re-issuing on every deploy spends the rate limit for nothing, and that
    // limit is shared with every other subdomain on the same server.
    expect(result.issued).toBe(false);
    expect(calls).toEqual([]);
  });

  it('requests one with the webroot method when there is none', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
    });

    const argv = calls[0]?.join(' ') ?? '';
    expect(argv).toContain('certbot certonly');
    expect(argv).toContain('--webroot');
    expect(argv).toContain('-d app.example.test');
    expect(argv).toContain('--non-interactive');
  });

  it('passes --staging when asked', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
      staging: true,
    });

    expect(calls[0]).toContain('--staging');
  });

  it('reports rate limiting distinctly, because the fix is to wait', async () => {
    const root = makeProxyRoot();

    const error = await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({
        exitCode: 1,
        stderr: 'too many certificates already issued for exact set of domains',
      })),
      email: 'admin@example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('rate-limiting');
    // Retrying is what put them there in the first place.
    expect((error as Error).message).toContain('--staging');
  });

  it('reports an absent certificate', () => {
    const root = makeProxyRoot();
    expect(certificateStatus(target(root)).exists).toBe(false);
  });
});

describe('removeVhost', () => {
  it('refuses to remove a vhost appctl did not write', async () => {
    const root = makeProxyRoot();
    const path = vhostPath(target(root));
    writeFileSync(path, 'server { listen 80; } # somebody else wrote this\n');

    await expect(
      removeVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) }),
    ).rejects.toBeInstanceOf(UsageError);

    expect(existsSync(path)).toBe(true);
  });

  it('removes one it did write', async () => {
    const root = makeProxyRoot();
    await installVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) });

    await removeVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) });

    expect(existsSync(vhostPath(target(root)))).toBe(false);
  });

  it('is a no-op when there is nothing there', async () => {
    const root = makeProxyRoot();
    await expect(
      removeVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) }),
    ).resolves.toBeUndefined();
  });
});

describe('validateProxy', () => {
  it('captures nginx output on failure', async () => {
    const result = await validateProxy({
      runCommand: fakeRunCommand(() => ({ exitCode: 1, stderr: 'nginx: [emerg] oops' })),
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('oops');
  });
});
