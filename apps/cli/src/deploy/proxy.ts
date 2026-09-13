import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { UsageError } from '../errors.js';
import type { runCommand } from './executor.js';
import type { DeployHooks } from './hooks.js';

// =============================================================================
// Publishing the app through the shared proxy  (issue #181, epic #168)
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
// =============================================================================

export interface ProxyTarget {
  domain: string;
  bindPort: number;
  /** Default /opt/infra/proxy. */
  proxyRoot: string;
}

export interface ProxyOptions {
  runCommand: typeof runCommand;
  hooks?: DeployHooks | undefined;
  /** Container the proxy runs in, when it is containerised. */
  proxyContainer?: string | undefined;
  /** Upload cap, matched to MAX_FILE_SIZE so uploads do not 413 at the edge. */
  maxBodyBytes?: number | undefined;
}

export interface CertificateOptions extends ProxyOptions {
  /** Registration address; the admin email is the sensible default. */
  email: string;
  /** Use Let's Encrypt's staging environment. */
  staging?: boolean | undefined;
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

export function livePath(target: ProxyTarget, file: string): string {
  return join(target.proxyRoot, 'letsencrypt', 'live', target.domain, file);
}

/**
 * Renders the vhost.
 *
 * Deterministic: the same input produces byte-identical output, so re-running
 * an install produces no spurious diff and no needless reload.
 *
 * WHAT IS DELIBERATELY ABSENT: security headers. infra/nginx/nginx.conf
 * already sets HSTS, the CSP, X-Frame-Options and the rest, and nginx's
 * add_header REPLACES the inherited set rather than merging with it - so
 * adding any header here would silently delete the application's CSP.
 */
export function renderVhost(target: ProxyTarget, options?: { maxBodyBytes?: number | undefined }): string {
  assertValidDomain(target.domain);

  const maxBody = options?.maxBodyBytes;
  const clientMaxBody = maxBody === undefined ? '100m' : `${Math.ceil(maxBody / (1024 * 1024))}m`;

  return `# Managed by appctl deploy. Edits will be overwritten.
# Application: ${target.domain}

server {
    listen 80;
    listen [::]:80;
    server_name ${target.domain};

    # Left served over HTTP on purpose: renewal uses the same webroot
    # challenge, and redirecting it to HTTPS breaks every future renewal.
    location /.well-known/acme-challenge/ {
        root ${join(target.proxyRoot, 'webroot')};
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${target.domain};

    ssl_certificate     ${livePath(target, 'fullchain.pem')};
    ssl_certificate_key ${livePath(target, 'privkey.pem')};
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

        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }

    # Server-sent events. The application's nginx already disables buffering
    # for this path; without the same treatment at the edge, that care is
    # undone one hop upstream and events arrive in batches or not at all.
    location /api/notifications/stream {
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

export function certificateStatus(target: ProxyTarget): CertInfo {
  const path = livePath(target, 'fullchain.pem');
  return { exists: existsSync(path), path };
}

/**
 * Issues a certificate, unless a usable one already exists.
 *
 * Skipping when one exists is not an optimisation: re-issuing on every deploy
 * spends the rate limit (50 certificates per registered domain per week) for
 * nothing, and that limit is per DOMAIN, so it is shared with every other
 * subdomain on the same server.
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

  const webroot = join(target.proxyRoot, 'webroot');
  const argv = [
    'certbot', 'certonly',
    '--webroot', '--webroot-path', webroot,
    '-d', target.domain,
    '--non-interactive', '--agree-tos',
    '--email', options.email,
    '--config-dir', join(target.proxyRoot, 'letsencrypt'),
    '--work-dir', join(target.proxyRoot, 'letsencrypt', 'work'),
    '--logs-dir', join(target.proxyRoot, 'letsencrypt', 'logs'),
    ...(options.staging === true ? ['--staging'] : []),
  ];

  options.hooks?.onProgress?.(`Requesting a certificate for ${target.domain}`);

  try {
    await options.runCommand(argv, {
      cwd: target.proxyRoot,
      timeoutMs: 5 * 60_000,
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
      `The vhost for ${target.domain} did not pass nginx -t, so it was removed.\n${validation.output}\n${restored}`,
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

/** Runs `nginx -t`, in the container when the proxy is containerised. */
export async function validateProxy(options: ProxyOptions): Promise<ValidationResult> {
  const argv =
    options.proxyContainer === undefined
      ? ['nginx', '-t']
      : ['docker', 'exec', options.proxyContainer, 'nginx', '-t'];

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
export async function reloadProxy(options: ProxyOptions): Promise<void> {
  const argv =
    options.proxyContainer === undefined
      ? ['nginx', '-s', 'reload']
      : ['docker', 'exec', options.proxyContainer, 'nginx', '-s', 'reload'];

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
  // without it belongs to somebody else.
  const contents = readFileSync(path, 'utf8');
  if (!contents.startsWith('# Managed by appctl deploy')) {
    throw new UsageError(
      `${path} was not written by appctl, so it will not be removed. Remove it by hand if that is really what you want.`,
    );
  }

  rmSync(path, { force: true });
  const validation = await validateProxy(options);
  if (validation.ok) await reloadProxy(options);
}
