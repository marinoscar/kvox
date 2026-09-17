import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLI_NAME } from '../branding.js';
import { PreconditionError, UsageError } from '../errors.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions } from './executor.js';
import {
  PROXY_MOUNTS,
  assertValidDomain,
  certbotArgv,
  certificateExpiry,
  certificateStatus,
  hasRenewalCron,
  installRenewalCron,
  installVhost,
  issueCertificate,
  jitteredMinute,
  listCertificates,
  parseRenewalOutput,
  probeAcmeRouting,
  removeVhost,
  renderRenewalCron,
  renderVhost,
  renewCertificates,
  renewalCronPath,
  stageRenewalCron,
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

const CONTAINER = 'proxy-nginx';

/** Options for a proxy that validates and reloads cleanly. */
function okOptions(calls?: string[][]) {
  return { runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls), proxyContainer: CONTAINER };
}

function writeCertificate(root: string, domain = 'app.example.test'): void {
  const live = join(root, 'letsencrypt', 'live', domain);
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, 'fullchain.pem'), 'cert');
  writeFileSync(join(live, 'cert.pem'), 'cert');
}

/**
 * A fetch that answers the probe the way a correctly routed proxy would: it
 * serves whatever file the URL names out of the proxy's own webroot.
 */
function routedFetch(root: string): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const file = join(root, 'webroot', url.pathname);
    return existsSync(file) ? new Response(readFileSync(file, 'utf8')) : new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
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

describe('PROXY_MOUNTS', () => {
  it('maps the two host directories to the paths the container sees', () => {
    expect(PROXY_MOUNTS.letsencrypt.host('/opt/infra/proxy')).toBe('/opt/infra/proxy/letsencrypt');
    expect(PROXY_MOUNTS.letsencrypt.container).toBe('/etc/letsencrypt');
    expect(PROXY_MOUNTS.webroot.host('/opt/infra/proxy')).toBe('/opt/infra/proxy/webroot');
    expect(PROXY_MOUNTS.webroot.container).toBe('/var/www/certbot');
  });

  it('feeds both the certbot argv and the vhost, so the two cannot disagree', () => {
    const argv = certbotArgv('/opt/infra/proxy', ['renew']);
    const rendered = renderVhost({ domain: 'app.example.test', bindPort: 3535, proxyRoot: '/opt/infra/proxy' });

    expect(argv).toContain(`/opt/infra/proxy/letsencrypt:${PROXY_MOUNTS.letsencrypt.container}`);
    expect(argv).toContain(`/opt/infra/proxy/webroot:${PROXY_MOUNTS.webroot.container}`);
    expect(rendered).toContain(`root ${PROXY_MOUNTS.webroot.container};`);
    expect(rendered).toContain(`ssl_certificate     ${PROXY_MOUNTS.letsencrypt.container}/live/app.example.test/fullchain.pem;`);
  });
});

/** The vhost for `target('/opt/infra/proxy')` with IPv6, byte for byte. */
const VHOST_WITH_IPV6 = `# Managed by appctl deploy. Edits will be overwritten.
# Application: app.example.test

server {
    listen 80;
    listen [::]:80;
    server_name app.example.test;

    # Left served over HTTP on purpose: renewal uses the same webroot
    # challenge, and redirecting it to HTTPS breaks every future renewal.
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name app.example.test;

    ssl_certificate     /etc/letsencrypt/live/app.example.test/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.test/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Matched to MAX_FILE_SIZE. Without this an upload fails at the edge with
    # a bare 413 that never reaches the application's own limits.
    client_max_body_size 100m;

    # No response headers are set here, deliberately. The application's own
    # nginx already sets HSTS, the CSP and the rest, and nginx REPLACES an
    # inherited header set rather than merging with it - so adding even one
    # here would silently delete all of them.

    location / {
        proxy_pass http://127.0.0.1:3535;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # The application forwards $scheme onward, so THIS is the value it
        # ultimately sees. Get it wrong and OAuth callbacks build http:// URLs
        # and the login redirect loops.
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  $host;

        # An upload part is at most STORAGE_PART_SIZE, but a slow link needs
        # headroom well past nginx's 60s default.
        proxy_connect_timeout 60s;
        proxy_send_timeout    600s;
        proxy_read_timeout    600s;
    }

    # Server-sent events: the notification stream and the two note streams.
    # The application's nginx already disables buffering for these; without
    # the same treatment at the edge, that care is undone one hop upstream and
    # events arrive in batches or not at all. Anchored and enumerated rather
    # than a wildcard on "/stream", so a future non-SSE path named stream does
    # not silently inherit hour-long timeouts.
    location ~ ^/api/(notifications|notes/[^/]+|note-generations/[^/]+)/stream$ {
        proxy_pass http://127.0.0.1:3535;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection        '';

        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
`;

describe('renderVhost', () => {
  const fixed: ProxyTarget = { domain: 'app.example.test', bindPort: 3535, proxyRoot: '/opt/infra/proxy' };
  const rendered = renderVhost(fixed);

  it('matches the snapshot byte for byte, with container paths', () => {
    // This is what `docker exec proxy-nginx nginx -t` reads. Host paths under
    // /opt/infra/proxy do not exist inside the container.
    expect(rendered).toBe(VHOST_WITH_IPV6);
    expect(rendered).not.toContain('/opt/infra/proxy');
  });

  it('omits exactly the two [::] listeners when IPv6 is off', () => {
    const without = renderVhost(fixed, { ipv6: false });

    expect(without).toBe(VHOST_WITH_IPV6.replace('    listen [::]:80;\n', '').replace('    listen [::]:443 ssl;\n', ''));
    expect(without).not.toContain('[::]');
  });

  it('keeps the [::] listeners when ipv6 is unknown', () => {
    expect(renderVhost(fixed, {})).toContain('listen [::]:443 ssl;');
  });

  it('keeps the management sentinel exactly', () => {
    // Parsed back by removeVhost; the old name is deliberate.
    expect(rendered.startsWith('# Managed by appctl deploy.')).toBe(true);
  });

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

  it('gives the three SSE endpoints one anchored unbuffered block', () => {
    const match = /location ~ (\S+) \{/.exec(rendered);
    const pattern = new RegExp(match?.[1] ?? '$never');

    expect(pattern.test('/api/notifications/stream')).toBe(true);
    expect(pattern.test('/api/notes/8b1c/stream')).toBe(true);
    expect(pattern.test('/api/note-generations/8b1c/stream')).toBe(true);
    // Not a wildcard: a future path that merely ends in "stream" is not SSE.
    expect(pattern.test('/api/notes/stream-settings')).toBe(false);
    expect(pattern.test('/api/notes/8b1c/stream/extra')).toBe(false);
    expect(pattern.test('/api/other/stream')).toBe(false);

    expect(rendered).toContain('proxy_buffering off;');
    expect(rendered).toContain('proxy_read_timeout 1h;');
  });

  it('gives an upload ten minutes rather than nginx\'s default minute', () => {
    expect(rendered).toContain('proxy_read_timeout    600s;');
    expect(rendered).toContain('proxy_send_timeout    600s;');
  });

  it('is deterministic, so a re-run produces no spurious diff', () => {
    expect(renderVhost(fixed)).toBe(rendered);
  });

  it('sizes client_max_body_size from the configured upload limit', () => {
    const sized = renderVhost(fixed, { maxBodyBytes: 10 * 1024 * 1024 });
    expect(sized).toContain('client_max_body_size 10m;');
  });

  it('refuses a hostile domain', () => {
    expect(() => renderVhost({ ...fixed, domain: 'a b;c' })).toThrow(UsageError);
  });
});

describe('installVhost', () => {
  it('writes, validates and reloads inside the container, in that order', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const result = await installVhost(target(root), okOptions(calls));

    expect(existsSync(result.path)).toBe(true);
    expect(calls).toEqual([
      ['docker', 'exec', CONTAINER, 'nginx', '-t'],
      ['docker', 'exec', CONTAINER, 'nginx', '-s', 'reload'],
    ]);
  });

  it('never runs a host nginx', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), okOptions(calls));

    // There is no host nginx on the target server, and a validation against
    // a config the real proxy never reads would be a check that lies.
    expect(calls.every((argv) => argv[0] === 'docker')).toBe(true);
  });

  it('reloads rather than restarts', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), okOptions(calls));

    // A restart drops connections for every other application on the box.
    expect(calls.flat()).not.toContain('restart');
  });

  it('round-trips maxBodyBytes into the file it writes', async () => {
    const root = makeProxyRoot();

    const result = await installVhost(target(root), {
      ...okOptions(),
      maxBodyBytes: 5 * 1024 * 1024 * 1024,
    });

    expect(readFileSync(result.path, 'utf8')).toContain('client_max_body_size 5120m;');
  });

  it('writes the vhost without [::] when told IPv6 is unavailable', async () => {
    const root = makeProxyRoot();

    const result = await installVhost(target(root), { ...okOptions(), ipv6: false });

    expect(readFileSync(result.path, 'utf8')).not.toContain('[::]');
  });

  it('does nothing when the vhost is already byte-identical', async () => {
    const root = makeProxyRoot();

    await installVhost(target(root), okOptions());
    const calls: string[][] = [];
    const second = await installVhost(target(root), okOptions(calls));

    expect(second.changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('removes the new vhost and re-validates through docker exec when nginx -t fails', async () => {
    const root = makeProxyRoot();
    const validations: string[][] = [];

    const error = await installVhost(target(root), {
      runCommand: fakeRunCommand((argv) => {
        if (argv.join(' ').endsWith('nginx -t')) {
          validations.push([...argv]);
          // Fails while the new vhost is present, passes once it is gone.
          return validations.length === 1
            ? { exitCode: 1, stderr: 'nginx: [emerg] invalid parameter' }
            : { exitCode: 0 };
        }
        return { exitCode: 0 };
      }),
      proxyContainer: CONTAINER,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('invalid parameter');
    expect((error as Error).message).toContain('restored');
    // The rollback validation is the same in-container command, not a host one.
    expect(validations).toEqual([
      ['docker', 'exec', CONTAINER, 'nginx', '-t'],
      ['docker', 'exec', CONTAINER, 'nginx', '-t'],
    ]);
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
        argv.join(' ').endsWith('nginx -t') ? { exitCode: 1, stderr: 'nope' } : { exitCode: 0 },
      ),
      proxyContainer: CONTAINER,
    }).catch(() => undefined);

    expect(readFileSync(path, 'utf8')).toBe(previous);
  });

  it('never reloads when validation failed', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), {
      runCommand: fakeRunCommand(
        (argv) => (argv.join(' ').endsWith('nginx -t') ? { exitCode: 1, stderr: 'no' } : { exitCode: 0 }),
        calls,
      ),
      proxyContainer: CONTAINER,
    }).catch(() => undefined);

    expect(calls.flat()).not.toContain('reload');
  });

  it('warns when the proxy was already broken before this run', async () => {
    const root = makeProxyRoot();

    const error = await installVhost(target(root), {
      // Fails even after the rollback: the problem predates this deployment.
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ').endsWith('nginx -t') ? { exitCode: 1, stderr: 'broken already' } : { exitCode: 0 },
      ),
      proxyContainer: CONTAINER,
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('already broken');
  });

  it('addresses whichever container it is given', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      proxyContainer: 'infra-proxy-1',
    });

    expect(calls[0]).toEqual(['docker', 'exec', 'infra-proxy-1', 'nginx', '-t']);
  });
});

describe('probeAcmeRouting', () => {
  function probeFiles(root: string): string[] {
    const directory = join(root, 'webroot', '.well-known', 'acme-challenge');
    return existsSync(directory) ? readdirSync(directory) : [];
  }

  it('passes when the domain serves the nonce back, and removes the file', async () => {
    const root = makeProxyRoot();
    const seen: string[] = [];
    const fetch = routedFetch(root);

    await expect(
      probeAcmeRouting(target(root), {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          seen.push(String(input));
          return fetch(input, init);
        }) as typeof globalThis.fetch,
      }),
    ).resolves.toBeUndefined();

    // The exact path certbot's HTTP-01 challenge takes: plain HTTP, the
    // public name, the ACME directory, no redirects followed.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(new RegExp(`^http://app\\.example\\.test/\\.well-known/acme-challenge/${CLI_NAME}-probe-[0-9a-f]{32}$`));
    expect(probeFiles(root)).toEqual([]);
  });

  it('never follows a redirect', async () => {
    const root = makeProxyRoot();
    let redirect: RequestRedirect | undefined;

    await probeAcmeRouting(target(root), {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        redirect = init?.redirect;
        return routedFetch(root)(input, init);
      }) as typeof globalThis.fetch,
    });

    // A 301 to https:// from somebody ELSE's server would otherwise look like
    // an answer.
    expect(redirect).toBe('manual');
  });

  it('fails naming the domain and the response when the body is not the nonce', async () => {
    const root = makeProxyRoot();

    const error = await probeAcmeRouting(target(root), {
      fetch: (async () => new Response('<html>some other site</html>', { status: 200 })) as typeof globalThis.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('app.example.test');
    expect((error as Error).message).toContain('HTTP 200');
    expect((error as Error).message).toContain('some other site');
    expect(probeFiles(root)).toEqual([]);
  });

  it('treats a redirect as a wrong answer, reporting its status', async () => {
    const root = makeProxyRoot();

    const error = await probeAcmeRouting(target(root), {
      fetch: (async () => new Response('', { status: 301, headers: { location: 'https://elsewhere.test/' } })) as typeof globalThis.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('HTTP 301');
  });

  it('fails on a timeout, and still removes the file', async () => {
    const root = makeProxyRoot();

    const error = await probeAcmeRouting(target(root), {
      timeoutMs: 20,
      // Honours the abort signal the probe passes, and never answers otherwise.
      fetch: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        })) as typeof globalThis.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('app.example.test');
    expect((error as Error).message).toContain('did not answer');
    expect(probeFiles(root)).toEqual([]);
  });

  it('writes the nonce where the proxy serves the ACME directory from', async () => {
    const root = makeProxyRoot();
    let written: string | undefined;

    await probeAcmeRouting(target(root), {
      fetch: (async (input: string | URL | Request) => {
        const name = basename(new URL(String(input)).pathname);
        const file = join(PROXY_MOUNTS.webroot.host(root), '.well-known', 'acme-challenge', name);
        written = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
        return new Response(written ?? '');
      }) as typeof globalThis.fetch,
    });

    expect(written).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('issueCertificate', () => {
  it('skips issuance and the probe when a certificate already exists', async () => {
    const root = makeProxyRoot();
    writeCertificate(root);

    const calls: string[][] = [];
    let probed = false;
    const result = await issueCertificate(target(root), {
      ...okOptions(calls),
      email: 'admin@example.test',
      fetch: (async () => {
        probed = true;
        return new Response('');
      }) as typeof globalThis.fetch,
    });

    // Re-issuing on every deploy spends the rate limit for nothing, and that
    // limit is shared with every other subdomain on the same server.
    expect(result.issued).toBe(false);
    expect(calls).toEqual([]);
    expect(probed).toBe(false);
  });

  it('runs certbot through docker with the proxy mounts and the webroot method', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await issueCertificate(target(root), {
      ...okOptions(calls),
      email: 'admin@example.test',
      fetch: routedFetch(root),
    });

    expect(calls).toEqual([
      [
        'docker', 'run', '--rm',
        '-v', `${root}/letsencrypt:/etc/letsencrypt`,
        '-v', `${root}/webroot:/var/www/certbot`,
        'certbot/certbot', 'certonly',
        '--webroot', '-w', '/var/www/certbot',
        '-d', 'app.example.test',
        '--non-interactive', '--agree-tos', '--no-eff-email',
        '--email', 'admin@example.test',
      ],
    ]);
  });

  it('passes --staging when asked', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await issueCertificate(target(root), {
      ...okOptions(calls),
      email: 'admin@example.test',
      staging: true,
      fetch: routedFetch(root),
    });

    expect(calls[0]).toContain('--staging');
  });

  it('fails at the self-probe, before certbot runs, when the domain is not routed here', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const error = await issueCertificate(target(root), {
      ...okOptions(calls),
      email: 'admin@example.test',
      fetch: (async () => new Response('wrong server', { status: 200 })) as typeof globalThis.fetch,
    }).catch((caught: unknown) => caught);

    // Before, not after: a wrong DNS record must cost no rate-limit budget.
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('app.example.test');
    expect(calls).toEqual([]);
  });

  it('reports rate limiting distinctly, because the fix is to wait', async () => {
    const root = makeProxyRoot();

    const error = await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({
        exitCode: 1,
        stderr: 'too many certificates already issued for exact set of domains',
      })),
      proxyContainer: CONTAINER,
      email: 'admin@example.test',
      fetch: routedFetch(root),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('rate-limiting');
    // Retrying is what put them there in the first place.
    expect((error as Error).message).toContain('--staging');
  });

  it('reports an absent certificate, checking the host path', () => {
    const root = makeProxyRoot();
    const status = certificateStatus(target(root));

    expect(status.exists).toBe(false);
    // The CLI can stat the host directory; the container path means nothing here.
    expect(status.path).toBe(join(root, 'letsencrypt', 'live', 'app.example.test', 'fullchain.pem'));
  });
});

describe('certificateExpiry and listCertificates', () => {
  it('lists the lineages under letsencrypt/live', () => {
    const root = makeProxyRoot();
    writeCertificate(root, 'b.example.test');
    writeCertificate(root, 'a.example.test');
    writeFileSync(join(root, 'letsencrypt', 'live', 'README'), 'not a lineage');

    expect(listCertificates(root)).toEqual(['a.example.test', 'b.example.test']);
    expect(listCertificates(join(root, 'nowhere'))).toEqual([]);
  });

  it('reads the expiry through openssl on the host path', async () => {
    const root = makeProxyRoot();
    writeCertificate(root);
    const calls: string[][] = [];
    const now = new Date('2026-01-01T00:00:00Z');

    const expiry = await certificateExpiry(
      target(root),
      fakeRunCommand(() => ({ exitCode: 0, stdout: 'notAfter=Jan 30 00:00:00 2026 GMT\n' }), calls),
      now,
    );

    expect(calls[0]).toEqual(['openssl', 'x509', '-enddate', '-noout', '-in', join(root, 'letsencrypt', 'live', 'app.example.test', 'cert.pem')]);
    expect(expiry.daysLeft).toBe(29);
  });

  it('answers with no expiry, rather than throwing, when there is nothing to read', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const expiry = await certificateExpiry(target(root), fakeRunCommand(() => ({ exitCode: 0 }), calls));

    expect(expiry.daysLeft).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('answers with no expiry when openssl fails or prints nonsense', async () => {
    const root = makeProxyRoot();
    writeCertificate(root);

    const failed = await certificateExpiry(target(root), fakeRunCommand(() => ({ exitCode: 1, stderr: 'unable to load' })));
    const nonsense = await certificateExpiry(target(root), fakeRunCommand(() => ({ exitCode: 0, stdout: 'hello' })));

    expect(failed.notAfter).toBeUndefined();
    expect(nonsense.notAfter).toBeUndefined();
  });
});

const RENEWED_OUTPUT = `Processing /etc/letsencrypt/renewal/app.example.test.conf
Renewing an existing certificate for app.example.test

Congratulations, all renewals succeeded:
  /etc/letsencrypt/live/app.example.test/fullchain.pem (success)
`;

const NOT_DUE_OUTPUT = `Processing /etc/letsencrypt/renewal/app.example.test.conf
Certificate not yet due for renewal

The following certificates are not due for renewal yet:
  /etc/letsencrypt/live/app.example.test/fullchain.pem expires on 2026-04-01 (skipped)
No renewals were attempted.
`;

describe('parseRenewalOutput', () => {
  it('names each renewed lineage', () => {
    expect(parseRenewalOutput(RENEWED_OUTPUT)).toEqual({ renewed: ['app.example.test'], anyRenewed: true });
  });

  it('reports nothing renewed when nothing was due', () => {
    expect(parseRenewalOutput(NOT_DUE_OUTPUT)).toEqual({ renewed: [], anyRenewed: false });
  });

  it('does not count a simulated renewal', () => {
    const dryRun = RENEWED_OUTPUT.replace('all renewals succeeded', 'all simulated renewals succeeded');
    expect(parseRenewalOutput(dryRun).anyRenewed).toBe(false);
  });
});

describe('renewCertificates', () => {
  function renewOptions(root: string, output: string, calls: string[][], extra: { dryRun?: boolean; certName?: string } = {}) {
    return {
      proxyRoot: root,
      proxyContainer: CONTAINER,
      runCommand: fakeRunCommand(
        (argv) => (argv.includes('certbot/certbot') ? { exitCode: 0, stdout: output } : { exitCode: 0 }),
        calls,
      ),
      ...extra,
    };
  }

  it('runs certbot renew through docker with the proxy mounts', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const result = await renewCertificates(renewOptions(root, NOT_DUE_OUTPUT, calls));

    expect(result.argv).toEqual([
      'docker', 'run', '--rm',
      '-v', `${root}/letsencrypt:/etc/letsencrypt`,
      '-v', `${root}/webroot:/var/www/certbot`,
      'certbot/certbot', 'renew',
      '--webroot', '-w', '/var/www/certbot',
      '--non-interactive',
    ]);
    expect(calls[0]).toEqual(result.argv);
  });

  it('reloads the proxy only when something was renewed', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const result = await renewCertificates(renewOptions(root, RENEWED_OUTPUT, calls));

    expect(result.renewed).toEqual(['app.example.test']);
    expect(result.reloaded).toBe(true);
    expect(calls[1]).toEqual(['docker', 'exec', CONTAINER, 'nginx', '-s', 'reload']);
  });

  it('does not reload when nothing was due', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const result = await renewCertificates(renewOptions(root, NOT_DUE_OUTPUT, calls));

    // A twice-daily cron must not reload a shared proxy twice a day for nothing.
    expect(result.reloaded).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('passes --dry-run through to certbot and never reloads', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];
    const simulated = RENEWED_OUTPUT.replace('all renewals succeeded', 'all simulated renewals succeeded');

    const result = await renewCertificates(renewOptions(root, simulated, calls, { dryRun: true }));

    expect(result.argv).toContain('--dry-run');
    expect(result.reloaded).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('limits itself to one lineage with --cert-name when asked', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const result = await renewCertificates(renewOptions(root, NOT_DUE_OUTPUT, calls, { certName: 'app.example.test' }));

    expect(result.argv.slice(-2)).toEqual(['--cert-name', 'app.example.test']);
  });

  it('refuses a hostile cert name before it reaches an argv', async () => {
    const root = makeProxyRoot();

    await expect(
      renewCertificates(renewOptions(root, NOT_DUE_OUTPUT, [], { certName: 'a b;c' })),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('reports the argv through onProgress for a dry run', async () => {
    const root = makeProxyRoot();
    const progress: string[] = [];

    await renewCertificates({
      ...renewOptions(root, NOT_DUE_OUTPUT, [], { dryRun: true }),
      hooks: { onProgress: (message) => progress.push(message) },
    });

    expect(progress[0]).toContain('certbot/certbot renew');
    expect(progress[0]).toContain('--dry-run');
  });
});

describe('installRenewalCron', () => {
  function cronOptions(cronDir: string) {
    return { name: 'demo', appsRoot: '/opt/infra/apps', kvoxPath: '/usr/local/bin/cli', cronDir };
  }

  it('writes a root cron.d entry that renews everything twice a day', () => {
    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-cron-'));

    const result = installRenewalCron(cronOptions(cronDir));

    expect(result.path).toBe(join(cronDir, `${CLI_NAME}-certs-demo`));
    expect(result.changed).toBe(true);
    const contents = readFileSync(result.path, 'utf8');
    const line = contents.split('\n').find((candidate) => /^\d+ 3,15 /.test(candidate));
    expect(line).toBe(
      `${jitteredMinute('demo')} 3,15 * * * root /usr/local/bin/cli deploy certs renew --all --apps-root /opt/infra/apps --name demo >> /var/log/${CLI_NAME}-certs-demo.log 2>&1`,
    );
  });

  it('ends with a newline and is 0644, or cron ignores it', () => {
    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-cron-'));

    const result = installRenewalCron(cronOptions(cronDir));

    expect(result.contents.endsWith('\n')).toBe(true);
    expect(statSync(result.path).mode & 0o777).toBe(0o644);
  });

  it('picks a minute within 0-59, stable for a name and spread across names', () => {
    for (const name of ['demo', 'kvox', 'another-app', 'x']) {
      const minute = jitteredMinute(name);
      expect(minute).toBeGreaterThanOrEqual(0);
      expect(minute).toBeLessThanOrEqual(59);
      expect(jitteredMinute(name)).toBe(minute);
    }
    expect(new Set(['demo', 'kvox', 'another-app', 'x', 'y', 'z'].map(jitteredMinute)).size).toBeGreaterThan(1);
  });

  it('is idempotent: a second call changes nothing', () => {
    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-cron-'));

    const first = installRenewalCron(cronOptions(cronDir));
    const second = installRenewalCron(cronOptions(cronDir));

    expect(second.changed).toBe(false);
    expect(readFileSync(second.path, 'utf8')).toBe(first.contents);
    expect(renderRenewalCron(cronOptions(cronDir))).toBe(first.contents);
  });

  it('rewrites when the binary path moves', () => {
    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-cron-'));

    installRenewalCron(cronOptions(cronDir));
    const moved = installRenewalCron({ ...cronOptions(cronDir), kvoxPath: '/opt/cli/bin/cli' });

    expect(moved.changed).toBe(true);
    expect(moved.contents).toContain('/opt/cli/bin/cli deploy certs renew');
  });

  it('names the file after the CLI so the renewal check recognises it', () => {
    expect(renewalCronPath('demo')).toBe(`/etc/cron.d/${CLI_NAME}-certs-demo`);
  });
});

describe('hasRenewalCron', () => {
  function cronOptions(cronDir: string, name = 'demo') {
    return { name, appsRoot: '/opt/infra/apps', kvoxPath: '/usr/local/bin/cli', cronDir };
  }

  it('answers for THIS deployment, not for the box', () => {
    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-cron-'));
    installRenewalCron(cronOptions(cronDir, 'other'));

    // A sibling's entry renews every certificate behind the shared proxy, but
    // it names the sibling's deploy root and goes when the sibling does (#261).
    expect(hasRenewalCron('other', cronDir)).toBe(true);
    expect(hasRenewalCron('demo', cronDir)).toBe(false);
  });

  it('sees an entry the moment one is written', () => {
    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-cron-'));

    expect(hasRenewalCron('demo', cronDir)).toBe(false);
    installRenewalCron(cronOptions(cronDir));
    expect(hasRenewalCron('demo', cronDir)).toBe(true);
  });

  it('answers "no entry" for a cron directory it cannot read, never throws', () => {
    // Which is the safe direction: the install then tries to write one and
    // reports what happened. Silence is the outcome #265 exists to prevent.
    expect(hasRenewalCron('demo', join(tmpdir(), 'appctl-cron-does-not-exist'))).toBe(false);
  });
});

describe('stageRenewalCron', () => {
  function cronOptions(cronDir: string) {
    return { name: 'demo', appsRoot: '/opt/infra/apps', kvoxPath: '/usr/local/bin/cli', cronDir };
  }

  it('stages the exact bytes installRenewalCron would have written', () => {
    // Derived from `renderRenewalCron`, never described in prose: an operator
    // finishing this by hand must end up with the file the CLI would have made.
    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-cron-'));
    const stageDir = mkdtempSync(join(tmpdir(), 'appctl-stage-'));

    const staged = stageRenewalCron(cronOptions(cronDir), stageDir);

    expect(readFileSync(staged.path, 'utf8')).toBe(renderRenewalCron(cronOptions(cronDir)));
    expect(staged.target).toBe(join(cronDir, `${CLI_NAME}-certs-demo`));
    expect(statSync(staged.path).mode & 0o777).toBe(0o644);
  });

  it('is a single line that survives being indented, and never suggests sudo <cli>', () => {
    // The report indents warnings by four. A `sudo tee` heredoc does not
    // survive that - the body keeps the spaces and an indented EOF does not
    // terminate it - so the command is one `install` line instead.
    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-cron-'));
    const stageDir = mkdtempSync(join(tmpdir(), 'appctl-stage-'));

    const staged = stageRenewalCron(cronOptions(cronDir), stageDir);

    expect(staged.command).toBe(`sudo install -m 644 ${staged.path} ${staged.target}`);
    expect(staged.command.split('\n')).toHaveLength(1);
    expect(staged.command).not.toContain('<<');
    expect(staged.command).not.toContain(`sudo ${CLI_NAME}`);
  });
});

describe('removeVhost', () => {
  it('refuses to remove a vhost kvox did not write', async () => {
    const root = makeProxyRoot();
    const path = vhostPath(target(root));
    writeFileSync(path, 'server { listen 80; } # somebody else wrote this\n');

    await expect(removeVhost(target(root), okOptions())).rejects.toBeInstanceOf(UsageError);

    expect(existsSync(path)).toBe(true);
  });

  it('removes one it did write, validating and reloading in the container', async () => {
    const root = makeProxyRoot();
    await installVhost(target(root), okOptions());
    const calls: string[][] = [];

    await removeVhost(target(root), okOptions(calls));

    expect(existsSync(vhostPath(target(root)))).toBe(false);
    expect(calls).toEqual([
      ['docker', 'exec', CONTAINER, 'nginx', '-t'],
      ['docker', 'exec', CONTAINER, 'nginx', '-s', 'reload'],
    ]);
  });

  it('is a no-op when there is nothing there', async () => {
    const root = makeProxyRoot();
    await expect(removeVhost(target(root), okOptions())).resolves.toBeUndefined();
  });
});

describe('validateProxy', () => {
  it('captures nginx output on failure', async () => {
    const result = await validateProxy({
      runCommand: fakeRunCommand(() => ({ exitCode: 1, stderr: 'nginx: [emerg] oops' })),
      proxyContainer: CONTAINER,
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('oops');
  });
});
