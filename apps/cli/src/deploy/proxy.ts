import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { PreconditionError, UsageError } from '../errors.js';
import { CERTBOT_IMAGE } from './checks/host.js';
import { readNotAfter } from './checks/tls.js';
import type { runCommand } from './executor.js';
import type { DeployHooks } from './hooks.js';
import type { Redactor } from './journal.js';

// =============================================================================
// Publishing the app through the shared proxy  (issue #181, epic #168;
// proxy v2: issue #125, epic #118)
// =============================================================================
//
// The application stack terminates no TLS and, behind vps.compose.yml, binds
// 127.0.0.1 only - it is not reachable from outside the server at all. This
// module is what publishes it on https://<domain>.
//
// THE PROXY IS SHARED, AND THAT IS THE WHOLE DIFFICULTY. A malformed vhost
// written here does not break one application; it breaks `nginx -t` for the
// entire server, and the next reload takes every site down with it. So:
//
//   - The certificate is issued BEFORE the vhost is written. A vhost naming an
//     ssl_certificate that does not exist FAILS nginx -t, which would leave
//     the shared proxy unable to reload for anybody.
//   - The vhost is validated before it is used, and REMOVED AND RE-VALIDATED
//     if validation fails, restoring whatever it overwrote.
//   - Reload, never restart. A restart drops connections for every other
//     application on the box.
//   - A vhost this tool did not write is never touched.
//
// THE PROXY IS A CONTAINER (epic #118, decision 3). There is no host nginx and
// no host certbot on the target server. nginx is only ever addressed through
// `docker exec <container>`, certificates are issued and renewed by `docker run
// --rm certbot/certbot` against the proxy's own mounts, and the vhost is
// rendered with the paths those mounts have INSIDE the container - the only
// place it will ever be read. There are deliberately no host-binary fallbacks:
// a validation against a config the real proxy never reads is a check that
// lies, and a vhost naming host paths fails `nginx -t` in the one nginx that
// matters.
// =============================================================================

export interface ProxyTarget {
  domain: string;
  bindPort: number;
  /** Default /opt/infra/proxy. */
  proxyRoot: string;
}

/**
 * The proxy's two bind mounts, declared ONCE (epic #118, decision 4).
 *
 * The certbot `docker run` argv mounts these host directories at these
 * container paths, and the vhost names the container paths - both read this
 * table, so the two cannot disagree. `certificateStatus` and the self-probe
 * use the HOST side, because that is where this process can stat and write.
 */
export const PROXY_MOUNTS = {
  letsencrypt: {
    host: (proxyRoot: string): string => join(proxyRoot, 'letsencrypt'),
    container: '/etc/letsencrypt',
  },
  webroot: {
    host: (proxyRoot: string): string => join(proxyRoot, 'webroot'),
    container: '/var/www/certbot',
  },
} as const;

export interface ProxyOptions {
  runCommand: typeof runCommand;
  hooks?: DeployHooks | undefined;
  /**
   * The run journal's redactor (issue #156).
   *
   * Wherever `onLog` is wired, this must be too: `executor.ts` rule 5 masks
   * an output line as it is assembled, so a `runCommand` given no redactor
   * streams raw text to the terminal while the log file on disk is masked.
   * certbot is the least likely of this CLI's subprocesses to echo an
   * application secret - it is handed a domain and an email, not the `.env` -
   * but "unlikely to" is not the guarantee this module is supposed to make,
   * and `install`/`update` have the redactor in hand at every call site.
   *
   * Optional because `kvox deploy certs` runs with no journal open (nothing
   * collected this deployment's secret VALUES, so a redactor built there
   * would be the identity function).
   */
  redact?: Redactor | undefined;
  /**
   * The container the shared proxy runs in. REQUIRED: `nginx -t` and the
   * reload run inside it, and there is no host nginx to fall back to.
   * Resolved once by the `proxy-container` check (or `--proxy-container`) and
   * recorded in the state file.
   */
  proxyContainer: string;
  /** Upload cap, matched to MAX_FILE_SIZE so uploads do not 413 at the edge. */
  maxBodyBytes?: number | undefined;
  /**
   * Whether the vhost may bind `[::]`. `false` omits the IPv6 listeners; on a
   * host without IPv6 `nginx -t` passes on them and the RELOAD fails, for
   * every site on the box. Anything else renders them (the `proxy-ipv6` check
   * writes it; `--no-ipv6` forces it).
   */
  ipv6?: boolean | undefined;
}

export type FetchLike = typeof globalThis.fetch;

export interface CertificateOptions extends ProxyOptions {
  /** Registration address; the admin email is the sensible default. */
  email: string;
  /** Use Let's Encrypt's staging environment. */
  staging?: boolean | undefined;
  /** Injected so the self-probe is testable without a public DNS record. */
  fetch?: FetchLike | undefined;
}

/** A hostname, and nothing that could break out of a config or a command. */
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

export function assertValidDomain(domain: string): void {
  // Validated before it reaches a config file OR an argv. Neither is a shell,
  // but a newline in a domain would let a vhost be extended with arbitrary
  // directives, which is the same class of problem.
  if (!HOSTNAME.test(domain)) {
    throw new UsageError(
      `"${domain}" is not a valid hostname, so it will not be written into the proxy configuration.`,
    );
  }
}

export function vhostPath(target: ProxyTarget): string {
  return join(target.proxyRoot, 'nginx', 'conf.d', `${target.domain}.conf`);
}

/** The certificate file on the HOST: what this process can stat. */
export function livePath(target: ProxyTarget, file: string): string {
  return join(PROXY_MOUNTS.letsencrypt.host(target.proxyRoot), 'live', target.domain, file);
}

/** The same file as the proxy container sees it: what the vhost must name. */
export function containerLivePath(domain: string, file: string): string {
  return posix.join(PROXY_MOUNTS.letsencrypt.container, 'live', domain, file);
}

export interface RenderOptions {
  maxBodyBytes?: number | undefined;
  ipv6?: boolean | undefined;
}

/**
 * Renders the vhost.
 *
 * Deterministic: the same input produces byte-identical output, so re-running
 * an install produces no spurious diff and no needless reload.
 *
 * EVERY PATH IN IT IS A CONTAINER PATH. `root` and `ssl_certificate` name
 * `/var/www/certbot` and `/etc/letsencrypt/...`, from PROXY_MOUNTS, because
 * the nginx that reads this file runs inside the proxy container and sees the
 * proxy directory only through those mounts.
 *
 * WHAT IS DELIBERATELY ABSENT: security headers. infra/nginx/nginx.conf
 * already sets HSTS, the CSP, X-Frame-Options and the rest, and nginx's
 * add_header REPLACES the inherited set rather than merging with it - so
 * adding any header here would silently delete the application's CSP.
 */
export function renderVhost(target: ProxyTarget, options?: RenderOptions): string {
  assertValidDomain(target.domain);

  const maxBody = options?.maxBodyBytes;
  const clientMaxBody = maxBody === undefined ? '100m' : `${Math.ceil(maxBody / (1024 * 1024))}m`;
  const ipv6 = options?.ipv6 !== false;

  // THE SENTINEL KEEPS THE OLD `appctl` NAME ON PURPOSE. The binary is called
  // `kvox` now, but this marker is WRITTEN INTO vhost files on live servers and
  // PARSED BACK by `removeVhost` below. Rename it and the CLI stops recognising
  // the vhosts it wrote itself under the old marker: it refuses to manage them,
  // and an operator has to edit every server by hand to recover. There is
  // deliberately no migration — see .claude/skills/rename-app/references/do-not-rename.md.
  return `# Managed by appctl deploy. Edits will be overwritten.
# Application: ${target.domain}

server {
    listen 80;
${ipv6 ? '    listen [::]:80;\n' : ''}    server_name ${target.domain};

    # Left served over HTTP on purpose: renewal uses the same webroot
    # challenge, and redirecting it to HTTPS breaks every future renewal.
    location /.well-known/acme-challenge/ {
        root ${PROXY_MOUNTS.webroot.container};
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
${ipv6 ? '    listen [::]:443 ssl;\n' : ''}    http2 on;
    server_name ${target.domain};

    ssl_certificate     ${containerLivePath(target.domain, 'fullchain.pem')};
    ssl_certificate_key ${containerLivePath(target.domain, 'privkey.pem')};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Matched to MAX_FILE_SIZE. Without this an upload fails at the edge with
    # a bare 413 that never reaches the application's own limits.
    client_max_body_size ${clientMaxBody};

    # No response headers are set here, deliberately. The application's own
    # nginx already sets HSTS, the CSP and the rest, and nginx REPLACES an
    # inherited header set rather than merging with it - so adding even one
    # here would silently delete all of them.

    location / {
        proxy_pass http://127.0.0.1:${target.bindPort};
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
        proxy_pass http://127.0.0.1:${target.bindPort};
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
}

export interface CertInfo {
  exists: boolean;
  path: string;
}

/** Checks the HOST path: that is where this process can stat. */
export function certificateStatus(target: ProxyTarget): CertInfo {
  const path = livePath(target, 'fullchain.pem');
  return { exists: existsSync(path), path };
}

/** Every domain with a certificate under `<proxyRoot>/letsencrypt/live/`. */
export function listCertificates(proxyRoot: string): string[] {
  const live = join(PROXY_MOUNTS.letsencrypt.host(proxyRoot), 'live');
  try {
    return readdirSync(live, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export interface CertificateExpiry {
  domain: string;
  /** Absent when there is no certificate, or openssl could not read it. */
  notAfter?: Date | undefined;
  /** Whole days until expiry; negative once expired. */
  daysLeft?: number | undefined;
}

/**
 * Reads the expiry from the certificate on disk, through openssl, so it works
 * before the vhost is live. Never throws: no answer is an absent field.
 */
export async function certificateExpiry(
  target: ProxyTarget,
  run: typeof runCommand,
  now: Date = new Date(),
): Promise<CertificateExpiry> {
  const path = livePath(target, 'cert.pem');
  if (!existsSync(path)) return { domain: target.domain };

  try {
    const result = await run(['openssl', 'x509', '-enddate', '-noout', '-in', path], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    const notAfter = readNotAfter(result.stdout);
    if (notAfter === undefined) return { domain: target.domain };
    return {
      domain: target.domain,
      notAfter,
      daysLeft: Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000),
    };
  } catch {
    return { domain: target.domain };
  }
}

/**
 * The `docker run --rm` prefix every certbot invocation shares (epic #118,
 * decision 5): the proxy's letsencrypt and webroot directories mounted where
 * PROXY_MOUNTS says the container sees them.
 */
export function certbotArgv(proxyRoot: string, args: readonly string[]): string[] {
  return [
    'docker', 'run', '--rm',
    '-v', `${PROXY_MOUNTS.letsencrypt.host(proxyRoot)}:${PROXY_MOUNTS.letsencrypt.container}`,
    '-v', `${PROXY_MOUNTS.webroot.host(proxyRoot)}:${PROXY_MOUNTS.webroot.container}`,
    CERTBOT_IMAGE,
    ...args,
  ];
}

/** How long the self-probe waits for the domain to answer. */
export const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeOptions {
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  hooks?: DeployHooks | undefined;
}

/**
 * Proves that `http://<domain>/.well-known/acme-challenge/` reaches THIS
 * proxy's webroot - the exact path certbot's HTTP-01 challenge will take -
 * before any rate-limit budget is spent on it (epic #118, decision 6).
 *
 * A nonce file is written under the host webroot, fetched over the public
 * name with no redirects followed, and removed again whatever happens. A
 * mismatch is reported naming the domain and what actually answered, because
 * "certbot failed" an hour later says neither.
 */
export async function probeAcmeRouting(target: ProxyTarget, options: ProbeOptions = {}): Promise<void> {
  assertValidDomain(target.domain);

  const nonce = randomBytes(16).toString('hex');
  const name = `${CLI_NAME}-probe-${nonce}`;
  const directory = join(PROXY_MOUNTS.webroot.host(target.proxyRoot), '.well-known', 'acme-challenge');
  const file = join(directory, name);
  const url = `http://${target.domain}/.well-known/acme-challenge/${name}`;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  mkdirSync(directory, { recursive: true });
  writeFileSync(file, nonce, { mode: 0o644 });
  options.hooks?.onProgress?.(`Checking that ${target.domain} routes to this proxy`);

  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new PreconditionError(
        `${url} did not answer (${reason}). Let's Encrypt would fail the same way, so no certificate was requested. Check that the DNS record for ${target.domain} points at this server and that port 80 reaches the shared proxy.`,
      );
    }

    const body = (await response.text().catch(() => '')).trim();
    if (response.status !== 200 || body !== nonce) {
      const excerpt = body === '' ? 'an empty body' : `"${body.slice(0, 80)}"`;
      throw new PreconditionError(
        `${url} answered HTTP ${response.status} with ${excerpt} instead of the probe written to this proxy's webroot, so ${target.domain} is not routed to this server. No certificate was requested. Fix the DNS record (or the proxy's default server for /.well-known/acme-challenge/) and re-run.`,
      );
    }
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * Issues a certificate, unless a usable one already exists.
 *
 * Skipping when one exists is not an optimisation: re-issuing on every deploy
 * spends the rate limit (50 certificates per registered domain per week) for
 * nothing, and that limit is per DOMAIN, so it is shared with every other
 * subdomain on the same server. For the same reason the routing self-probe
 * runs first: a wrong DNS record must fail before certbot does.
 */
export async function issueCertificate(
  target: ProxyTarget,
  options: CertificateOptions,
): Promise<{ issued: boolean; path: string }> {
  assertValidDomain(target.domain);

  const status = certificateStatus(target);
  if (status.exists) {
    options.hooks?.onProgress?.(`Certificate for ${target.domain} already exists`);
    return { issued: false, path: status.path };
  }

  await probeAcmeRouting(target, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });

  const argv = certbotArgv(target.proxyRoot, [
    'certonly',
    '--webroot', '-w', PROXY_MOUNTS.webroot.container,
    '-d', target.domain,
    '--non-interactive', '--agree-tos', '--no-eff-email',
    '--email', options.email,
    ...(options.staging === true ? ['--staging'] : []),
  ]);

  options.hooks?.onProgress?.(`Requesting a certificate for ${target.domain}`);

  try {
    await options.runCommand(argv, {
      cwd: target.proxyRoot,
      timeoutMs: 5 * 60_000,
      ...(options.redact === undefined ? {} : { redact: options.redact }),
      ...(options.hooks?.onLog === undefined
        ? {}
        : { onLine: (line: string) => options.hooks?.onLog?.(line) }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Rate limiting needs its own remedy: the fix is to WAIT, and retrying is
    // what put the operator there in the first place.
    if (/too many certificates|rateLimited|rate limit/i.test(message)) {
      throw new UsageError(
        `Let's Encrypt is rate-limiting this domain. Wait before trying again — retrying now makes it worse. Use --staging while working out the rest of the setup.\n${message}`,
      );
    }
    throw error;
  }

  return { issued: true, path: livePath(target, 'fullchain.pem') };
}

export interface RenewOptions {
  proxyRoot: string;
  proxyContainer: string;
  runCommand: typeof runCommand;
  hooks?: DeployHooks | undefined;
  /** The run journal's redactor. See `ProxyOptions.redact` (issue #156). */
  redact?: Redactor | undefined;
  /** Only this certificate; every one under the proxy when absent. */
  certName?: string | undefined;
  /** certbot's own `--dry-run`: a rehearsal against staging, nothing written. */
  dryRun?: boolean | undefined;
}

export interface RenewResult {
  argv: string[];
  /** Domains certbot reported as renewed. */
  renewed: string[];
  /** Whether the proxy was reloaded, which happens only when something was renewed. */
  reloaded: boolean;
  output: string;
}

/**
 * What certbot's `renew` said it did. Exported for its test.
 *
 * Every renewed lineage is listed as `/etc/letsencrypt/live/<name>/fullchain.pem
 * (success)` under "Congratulations, all renewals succeeded"; a certificate
 * that is not due is "not yet due for renewal" and nothing was attempted. A
 * `--dry-run` reports "simulated renewals", which is not a renewal.
 */
export function parseRenewalOutput(output: string): { renewed: string[]; anyRenewed: boolean } {
  const renewed: string[] = [];
  for (const match of output.matchAll(/\/live\/([^/\s]+)\/fullchain\.pem\s*\(success\)/g)) {
    if (match[1] !== undefined && !renewed.includes(match[1])) renewed.push(match[1]);
  }
  const simulated = /simulated renewal/i.test(output);
  const anyRenewed =
    !simulated && (renewed.length > 0 || /all renewals succeeded/i.test(output));
  return { renewed, anyRenewed };
}

/**
 * Renews through `docker run --rm certbot/certbot renew`, and reloads the
 * proxy ONLY when certbot reports a change: a twice-daily cron must not reload
 * a shared proxy twice a day for nothing.
 */
export async function renewCertificates(options: RenewOptions): Promise<RenewResult> {
  if (options.certName !== undefined) assertValidDomain(options.certName);

  const argv = certbotArgv(options.proxyRoot, [
    'renew',
    '--webroot', '-w', PROXY_MOUNTS.webroot.container,
    '--non-interactive',
    ...(options.certName === undefined ? [] : ['--cert-name', options.certName]),
    ...(options.dryRun === true ? ['--dry-run'] : []),
  ]);

  options.hooks?.onProgress?.(
    options.dryRun === true ? `Dry run: ${argv.join(' ')}` : `Renewing certificates: ${argv.join(' ')}`,
  );

  const result = await options.runCommand(argv, {
    cwd: options.proxyRoot,
    timeoutMs: 10 * 60_000,
    ...(options.redact === undefined ? {} : { redact: options.redact }),
    ...(options.hooks?.onLog === undefined
      ? {}
      : { onLine: (line: string) => options.hooks?.onLog?.(line) }),
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const parsed = parseRenewalOutput(output);

  if (options.dryRun === true || !parsed.anyRenewed) {
    options.hooks?.onProgress?.(
      options.dryRun === true ? 'Dry run complete; nothing was renewed or reloaded' : 'No certificate was due for renewal',
    );
    return { argv, renewed: parsed.renewed, reloaded: false, output: output.trim() };
  }

  // A renewed certificate is read only on reload; until then the proxy keeps
  // serving the old one.
  await reloadProxy({ runCommand: options.runCommand, proxyContainer: options.proxyContainer });
  options.hooks?.onProgress?.(
    `Renewed ${parsed.renewed.length > 0 ? parsed.renewed.join(', ') : 'certificate(s)'}; proxy reloaded`,
  );

  return { argv, renewed: parsed.renewed, reloaded: true, output: output.trim() };
}

export interface RenewalCronOptions {
  /** The app's name; the cron file and its log are named after it. */
  name: string;
  appsRoot: string;
  /** Absolute path of the binary cron should run. */
  kvoxPath: string;
  /** Default /etc/cron.d; tests point it elsewhere. */
  cronDir?: string | undefined;
}

export interface RenewalCronResult {
  path: string;
  changed: boolean;
  contents: string;
}

/**
 * The command the cron line runs.
 *
 * The global link (`/usr/local/bin/<cli>`, which the bootstrap script
 * creates) when it exists, because it outlives a moved checkout; otherwise
 * this very process's script, prefixed with its node when it is a script
 * rather than a launcher - cron's PATH does not reliably reach `node`.
 */
export function defaultCliPath(): string {
  const linked = `/usr/local/bin/${CLI_NAME}`;
  if (existsSync(linked)) return linked;

  const script = process.argv[1];
  if (script === undefined) return CLI_NAME;
  const resolved = resolve(script);
  return /\.[cm]?js$/.test(resolved) ? `${process.execPath} ${resolved}` : resolved;
}

export function renewalCronPath(name: string, cronDir = '/etc/cron.d'): string {
  return join(cronDir, `${CLI_NAME}-certs-${name}`);
}

/**
 * A minute in 0-59 chosen from the app's name, so every app on a box gets a
 * stable jitter rather than all of them hitting Let's Encrypt at :00 - and so
 * the file is byte-identical on every run, which is what makes it idempotent.
 */
export function jitteredMinute(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
  return hash % 60;
}

/** The cron file's contents. Exported so the test can pin the shape. */
export function renderRenewalCron(options: RenewalCronOptions): string {
  const minute = jitteredMinute(options.name);
  const log = `/var/log/${CLI_NAME}-certs-${options.name}.log`;
  // `--all` on purpose: the proxy is shared, and one entry renewing every
  // lineage under it serves every app this CLI manages. The name is still
  // passed so the state (proxy root, container) is read from this app.
  return [
    `# Managed by ${CLI_NAME} deploy. Renews the Let's Encrypt certificates behind the shared proxy.`,
    `# Written by \`${CLI_NAME} deploy certs renew --install-cron\`; re-running it rewrites this file.`,
    'SHELL=/bin/sh',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `${minute} 3,15 * * * root ${options.kvoxPath} deploy certs renew --all --apps-root ${options.appsRoot} --name ${options.name} >> ${log} 2>&1`,
    '',
  ].join('\n');
}

/** Writes `/etc/cron.d/<cli>-certs-<name>`, 0644, only when it would change. */
export function installRenewalCron(options: RenewalCronOptions): RenewalCronResult {
  const path = renewalCronPath(options.name, options.cronDir);
  const contents = renderRenewalCron(options);

  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (previous === contents) return { path, changed: false, contents };

  mkdirSync(options.cronDir ?? '/etc/cron.d', { recursive: true });
  // cron ignores a file in cron.d that is group/world-writable, so the mode is
  // part of the contract, not a nicety.
  writeFileSync(path, contents, { mode: 0o644 });
  return { path, changed: true, contents };
}

export interface InstallVhostResult {
  path: string;
  changed: boolean;
}

/**
 * Writes, validates and activates the vhost, rolling back on failure.
 *
 * The rollback is the reason this function exists rather than a `writeFileSync`
 * at the call site.
 */
export async function installVhost(
  target: ProxyTarget,
  options: ProxyOptions,
): Promise<InstallVhostResult> {
  assertValidDomain(target.domain);

  const path = vhostPath(target);
  const rendered = renderVhost(target, {
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.ipv6 === undefined ? {} : { ipv6: options.ipv6 }),
  });

  const existed = existsSync(path);
  const previous = existed ? readFileSync(path, 'utf8') : undefined;

  if (previous === rendered) {
    // Byte-identical, so there is nothing to validate and nothing to reload.
    options.hooks?.onProgress?.(`Vhost for ${target.domain} is already current`);
    return { path, changed: false };
  }

  mkdirSync(join(target.proxyRoot, 'nginx', 'conf.d'), { recursive: true });
  writeFileSync(path, rendered, { mode: 0o644 });

  const validation = await validateProxy(options);
  if (!validation.ok) {
    // Put the proxy back EXACTLY as it was found, then confirm that actually
    // worked before reporting - a rollback that leaves nginx broken is worse
    // than the original failure.
    if (previous === undefined) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, previous, { mode: 0o644 });
    }

    const after = await validateProxy(options);
    const restored = after.ok
      ? 'The proxy has been restored and still validates.'
      : 'WARNING: the proxy does not validate even after rolling back; it was already broken before this run.';

    throw new UsageError(
      `The vhost for ${target.domain} did not pass nginx -t in ${options.proxyContainer}, so it was removed.\n${validation.output}\n${restored}`,
    );
  }

  await reloadProxy(options);
  options.hooks?.onProgress?.(`Published ${target.domain}`);

  return { path, changed: true };
}

export interface ValidationResult {
  ok: boolean;
  output: string;
}

/** Runs `nginx -t` inside the proxy container - the only nginx that reads the vhost. */
export async function validateProxy(
  options: Pick<ProxyOptions, 'runCommand' | 'proxyContainer'>,
): Promise<ValidationResult> {
  const argv = ['docker', 'exec', options.proxyContainer, 'nginx', '-t'];

  try {
    const result = await options.runCommand(argv, { cwd: process.cwd(), timeoutMs: 60_000 });
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    const failure = error as { result?: { stdout?: string; stderr?: string } };
    return {
      ok: false,
      output:
        `${failure.result?.stdout ?? ''}${failure.result?.stderr ?? ''}`.trim() ||
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Reloads, never restarts: a restart drops every other site's connections. */
export async function reloadProxy(
  options: Pick<ProxyOptions, 'runCommand' | 'proxyContainer'>,
): Promise<void> {
  const argv = ['docker', 'exec', options.proxyContainer, 'nginx', '-s', 'reload'];

  await options.runCommand(argv, { cwd: process.cwd(), timeoutMs: 60_000 });
}

/** Removes a vhost this tool wrote. Used only to undo a failed install. */
export async function removeVhost(
  target: ProxyTarget,
  options: ProxyOptions,
): Promise<void> {
  const path = vhostPath(target);
  if (!existsSync(path)) return;

  // Only ever a file this tool wrote: the header is the marker, and a vhost
  // without it belongs to somebody else. The marker still says `appctl` even
  // though the binary is `kvox` — see renderVhost above; it is read back off
  // servers provisioned before the rename and must never be "fixed".
  const contents = readFileSync(path, 'utf8');
  if (!contents.startsWith('# Managed by appctl deploy')) {
    throw new UsageError(
      `${path} was not written by ${CLI_NAME}, so it will not be removed. Remove it by hand if that is really what you want.`,
    );
  }

  rmSync(path, { force: true });
  const validation = await validateProxy(options);
  if (validation.ok) await reloadProxy(options);
}
