import { dirname } from 'node:path';

import { CLI_NAME } from '../../branding.js';
import { probe } from './probe.js';
import type { Check, CheckContext, CheckFs, CheckResult } from './types.js';
import {
  contextFs,
  contextMemory,
  contextPortFree,
  contextPortListening,
  skippedByProxyFlag,
} from './types.js';

// =============================================================================
// Is this server able to run the application?  (issue #176, epic #168)
// =============================================================================
//
// Everything here is READ-ONLY, and everything probes for a CAPABILITY rather
// than for how it was installed. `docker info` succeeding is the fact that
// matters; whether docker came from apt, from get.docker.com or from a
// snap is not. Checking for `systemctl` or for a package name would make these
// checks Ubuntu-specific for no gain - the target is Ubuntu, but nothing here
// needs it to be.
// =============================================================================

/** Below this, an image build is the thing that will fail, confusingly. */
const MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024;

/** Below this, the web build gets OOM-killed on a small VPS. */
const MIN_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

/** apps/cli's own floor. The build runs on this host. */
const MIN_NODE_MAJOR = 20;

/** Keeps a one-line detail scannable; the journal keeps the whole thing. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}...`;
}

function formatBytes(bytes: number): string {
  const gigabytes = bytes / (1024 * 1024 * 1024);
  return `${gigabytes.toFixed(1)} GB`;
}

const dockerInstalled: Check = {
  id: 'docker-installed',
  title: 'Docker installed',
  severity: 'required',
  async run(context) {
    const { ok, stdout, stderr } = await probe(context, ['docker', '--version']);
    if (!ok) {
      return {
        status: 'fail',
        detail: stderr.split('\n')[0] ?? 'not installed',
        remedy: 'Install Docker Engine: curl -fsSL https://get.docker.com | sh',
      };
    }
    return { status: 'pass', detail: stdout.replace(/^Docker version /, '') };
  },
};

const dockerDaemon: Check = {
  id: 'docker-daemon',
  title: 'Docker daemon reachable',
  severity: 'required',
  requires: ['docker-installed'],
  async run(context) {
    const { ok, stderr } = await probe(context, ['docker', 'info', '--format', '{{.ServerVersion}}']);
    if (ok) return { status: 'pass', detail: 'reachable' };

    // Installed-but-unreachable is the common case, and it splits three ways
    // with three different remedies. Collapsing them into "cannot connect"
    // throws away the only useful information the error carried.
    if (/permission denied/i.test(stderr)) {
      return {
        status: 'fail',
        detail: 'permission denied on the Docker socket',
        remedy: `Run as root, or add this user to the docker group: usermod -aG docker $USER (then log in again)`,
      };
    }
    // Docker has worded this several ways across versions ("Cannot connect to
    // the Docker daemon", "failed to connect to the docker API"); match the
    // socket instead, which every wording mentions and which is the actual
    // symptom.
    if (
      /cannot connect|failed to connect|is the docker daemon running|docker\.sock/i.test(
        stderr,
      )
    ) {
      return {
        status: 'fail',
        detail: 'daemon is not running or the socket is unreachable',
        remedy: 'Start it: systemctl start docker (or start Docker Desktop)',
      };
    }
    return {
      status: 'fail',
      // Truncated: some of these run to several hundred characters and the
      // checklist is meant to be scannable. The full text is in the journal.
      detail: truncate(stderr.split('\n')[0] ?? 'unreachable', 90),
      remedy: 'Check the daemon with: docker info',
    };
  },
};

const dockerComposeV2: Check = {
  id: 'docker-compose-v2',
  title: 'Compose v2 plugin',
  severity: 'required',
  requires: ['docker-installed'],
  async run(context) {
    const { ok, stdout } = await probe(context, ['docker', 'compose', 'version']);
    if (ok) {
      return { status: 'pass', detail: stdout.split('\n')[0] ?? 'available' };
    }

    // The legacy standalone binary is NOT a substitute: this deployment uses
    // `!override` and the long-form env_file, neither of which v1 understands.
    const legacy = await probe(context, ['docker-compose', '--version']);
    if (legacy.ok) {
      return {
        status: 'fail',
        detail: 'only the legacy docker-compose v1 binary is present',
        remedy: 'Install the v2 plugin: apt-get install docker-compose-plugin',
      };
    }

    return {
      status: 'fail',
      detail: 'not installed',
      remedy: 'Install the v2 plugin: apt-get install docker-compose-plugin',
    };
  },
};

/**
 * The external Docker network every app on the host joins.
 *
 * base.compose.yml declares it `external: true`, so compose never creates it
 * and `up -d` on a box without it fails with a message that names the
 * network but not the command. Install creates it (the one thing besides
 * directories it is allowed to create); doctor only reports it.
 */
export const DEVNET_NETWORK = 'devnet';
export const DEVNET_CHECK_ID = 'docker-network-devnet';

/**
 * The shared network - reported, never demanded  (issue #251)
 *
 * `recommended`, not `required`, because INSTALL CREATES IT. The pipeline's
 * `network` step runs an idempotent `docker network create`, and its own
 * comment calls it "the one thing install is allowed to create that the
 * doctor only reports". Failing a host over it told the operator to run a
 * command by hand to satisfy a prerequisite the very next command satisfies
 * for them.
 *
 * The install wizard already knew this - `welcomeChecks()` filters this id
 * out of its gate, "failing on its absence would refuse the very install that
 * fixes it" - so standalone `doctor` was the only surface still failing on
 * it, and the two disagreed about the same host.
 *
 * ⚠ The network is still genuinely needed, for a reason worth keeping
 * straight: `base.compose.yml` attaches `api` to it unconditionally as an
 * `external` network, and Compose refuses to start a service on an external
 * network that is absent. So it is required by the COMPOSE FILE, not by the
 * deployment's database topology - on a deployment using external PostgreSQL,
 * which is this template's documented shape, it is an empty network that
 * exists only to satisfy that attachment. Do not "fix" this by deleting the
 * check; it is the thing that explains an otherwise cryptic compose failure.
 */
const dockerNetworkDevnet: Check = {
  id: DEVNET_CHECK_ID,
  title: `Docker network ${DEVNET_NETWORK}`,
  severity: 'recommended',
  requires: ['docker-daemon'],
  async run(context) {
    const { ok } = await probe(context, ['docker', 'network', 'inspect', DEVNET_NETWORK]);
    return ok
      ? { status: 'pass', detail: 'exists' }
      : {
          status: 'warn',
          detail: 'does not exist',
          remedy: `Nothing to do: install creates it. To create it ahead of time, docker network create ${DEVNET_NETWORK}`,
        };
  },
};

const gitInstalled: Check = {
  id: 'git-installed',
  title: 'git installed',
  severity: 'required',
  async run(context) {
    const { ok, stdout, stderr } = await probe(context, ['git', '--version']);
    return ok
      ? { status: 'pass', detail: stdout.replace(/^git version /, '') }
      : {
          status: 'fail',
          detail: stderr.split('\n')[0] ?? 'not installed',
          remedy: 'Install git: apt-get install git',
        };
  },
};

const nodeVersion: Check = {
  id: 'node-version',
  title: 'Node version',
  severity: 'recommended',
  async run() {
    const major = Number(process.versions.node.split('.')[0]);
    return major >= MIN_NODE_MAJOR
      ? { status: 'pass', detail: `v${process.versions.node}` }
      : {
          status: 'warn',
          detail: `v${process.versions.node}`,
          remedy: `${CLI_NAME} targets Node ${MIN_NODE_MAJOR} or newer; upgrade before relying on this host to build.`,
        };
  },
};

const diskSpace: Check = {
  id: 'disk-space',
  title: 'Free disk space',
  severity: 'required',
  async run(context) {
    // -P for POSIX output (one line per filesystem, no wrapping) and -k so the
    // unit is known rather than inferred from a human-readable suffix.
    const { ok, stdout, stderr } = await probe(context, ['df', '-Pk', context.deployRoot]);

    if (!ok) {
      // The directory may not exist yet on a first install; ask about its parent.
      const parent = await probe(context, ['df', '-Pk', '/']);
      if (!parent.ok) {
        return {
          status: 'fail',
          detail: stderr.split('\n')[0] ?? 'could not determine free space',
          remedy: 'Check free space by hand: df -h',
        };
      }
      return evaluateDf(parent.stdout);
    }

    return evaluateDf(stdout);
  },
};

export interface DfReading {
  /** The filesystem's size. */
  totalBytes: number;
  availableBytes: number;
}

/**
 * Reads `df -Pk` output: one header line, then `<fs> <1024-blocks> <used>
 * <available> <capacity> <mount>`. Shared with server-facts.ts (#120), which
 * reports the size while this check judges the free space, so the two never
 * parse the same line differently.
 */
export function parseDf(output: string): DfReading | undefined {
  const line = output.trim().split('\n')[1];
  const columns = line?.trim().split(/\s+/) ?? [];
  const total = Number(columns[1]);
  const available = Number(columns[3]);

  if (!Number.isFinite(total) || !Number.isFinite(available)) return undefined;

  return { totalBytes: total * 1024, availableBytes: available * 1024 };
}

/** Reads `df -Pk` output. Exported for its test. */
export function evaluateDf(output: string): CheckResult {
  const reading = parseDf(output);

  if (reading === undefined) {
    return {
      status: 'fail',
      detail: 'could not parse df output',
      remedy: 'Check free space by hand: df -h',
    };
  }

  const bytes = reading.availableBytes;
  return bytes >= MIN_FREE_DISK_BYTES
    ? { status: 'pass', detail: `${formatBytes(bytes)} free` }
    : {
        status: 'fail',
        detail: `${formatBytes(bytes)} free`,
        remedy: `Image builds need roughly ${formatBytes(MIN_FREE_DISK_BYTES)}. Free space, or use a larger volume. \`docker system prune\` often recovers a lot.`,
      };
}

const memory: Check = {
  id: 'memory',
  title: 'Memory',
  severity: 'recommended',
  async run(context) {
    const bytes = contextMemory(context);
    return bytes >= MIN_MEMORY_BYTES
      ? { status: 'pass', detail: formatBytes(bytes) }
      : {
          status: 'warn',
          detail: formatBytes(bytes),
          remedy: `The web build can be OOM-killed under ${formatBytes(MIN_MEMORY_BYTES)}. Add swap, or build the images elsewhere.`,
        };
  },
};

const bindPortFree: Check = {
  id: 'bind-port-free',
  title: 'Loopback port available',
  severity: 'required',
  async run(context) {
    const free = await contextPortFree(context)(context.bindPort);
    if (free) {
      return { status: 'pass', detail: `127.0.0.1:${context.bindPort} is free` };
    }

    // An UPDATE finds its own nginx on this port, which is not a conflict. A
    // doctor run that reports a false failure against a healthy deployment is
    // how operators learn to ignore doctor.
    const owner = await probe(context, [
      'docker',
      'ps',
      '--filter',
      `publish=${context.bindPort}`,
      '--format',
      '{{.Names}}',
    ]);
    // Compose names containers `<project>-<service>-<n>`, and the project is
    // pinned to the app name (#119). A prefix match, not a substring one: an
    // app called `app` must not claim `other-app-nginx-1`.
    const names = owner.stdout.split('\n').filter((name) => name !== '');
    const own = context.name === undefined ? undefined : `${context.name}-`;

    if (own !== undefined && names.some((name) => name.startsWith(own))) {
      return {
        status: 'pass',
        detail: `held by this deployment (${names.join(', ')})`,
      };
    }

    return {
      status: 'fail',
      detail:
        names.length > 0
          ? `in use by ${names.join(', ')}`
          : `something is already listening on 127.0.0.1:${context.bindPort}`,
      remedy: `Choose another port with APP_BIND_PORT, or stop whatever holds it.`,
    };
  },
};

// -----------------------------------------------------------------------------
// The shared reverse proxy  (issue #122, epic #118)
// -----------------------------------------------------------------------------
//
// THE PROXY IS A CONTAINER, and it is only ever addressed through `docker
// exec` (epic #118, decision 3). There is no host nginx and no host certbot on
// the target server, and there are deliberately no host-binary fallbacks
// here: a check that validates a config the real proxy never reads is a check
// that lies. `certbot-installed` and the host `nginx -t` branch were retired,
// not kept.
//
// The container is resolved ONCE, by `proxy-container`, in this order: the
// name the operator gave (`--proxy-container`, or state), else whichever
// container publishes :443, else the conventional name below. The result is
// written into the context so every later check - and, through install and
// update, the publisher - talks to the same container.
//
// Under `--skip-proxy` every check in this section answers `skip`. That flag
// is how the pipeline runs where there is no proxy at all (CI, #133), and a
// preflight that fails on a proxy it was told to ignore is not a preflight.
// -----------------------------------------------------------------------------

/**
 * The proxy's conventional name, tried last when nothing publishes :443.
 *
 * A proxy running with `network_mode: host` has no published ports for the
 * filter to find, which is exactly the configuration the vhost needs (it
 * forwards to 127.0.0.1). So the name is a real fallback, not a guess.
 */
export const DEFAULT_PROXY_CONTAINER = 'proxy-nginx';

/** The image certificates are issued and renewed with (`docker run --rm`). */
export const CERTBOT_IMAGE = 'certbot/certbot';

/**
 * The deepest ancestor of `path` that exists, or undefined.
 *
 * `mkdirSync(..., { recursive: true })` does not need the target to exist - it
 * needs WRITE PERMISSION ON THE DEEPEST EXISTING ANCESTOR, because that is the
 * directory it must add an entry to. On a first install the deploy root is
 * exactly what does not exist yet, so testing it directly would answer about
 * the wrong path.
 */
function deepestExisting(fs: CheckFs, path: string): string | undefined {
  let current = path;
  for (;;) {
    if (fs.isDirectory(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Can this deployment create its own directory?  (issue #245)
 *
 * The apps root is commonly root-owned while the CLI is run as an ordinary
 * user - the ordinary shape, because `gh` authentication is per-user and
 * elevating to fix this trades an EACCES here for a logged-out `gh` at
 * `checkout` (#236). Without this check that mismatch surfaced as the FIRST
 * WRITE of the run, after the whole wizard had been answered and confirmed,
 * and before the journal existed to record which step it was.
 *
 * Doctor was thorough about the shared proxy's directory and silent about its
 * own, which is the one it is certain to touch.
 */
const deployRootWritable: Check = {
  id: 'deploy-root-writable',
  title: 'Deploy directory writable',
  severity: 'required',
  async run(context) {
    const fs = contextFs(context);
    const existing = deepestExisting(fs, context.deployRoot);

    if (existing === undefined) {
      return {
        status: 'fail',
        detail: `no part of ${context.deployRoot} exists`,
        remedy: `Create it: sudo install -d -o $USER -g $USER ${context.deployRoot}`,
      };
    }

    if (fs.isWritable(existing)) {
      return {
        status: 'pass',
        detail: existing === context.deployRoot ? existing : `${existing} (will create ${context.deployRoot})`,
      };
    }

    // Deliberately NOT `chown -R` on the apps root: a host running several
    // apps would have its siblings' ownership rewritten to fix this one. And
    // deliberately not "use sudo" - see the header.
    return {
      status: 'fail',
      detail: `${existing} is not writable by this user`,
      remedy: `Create this app's own directory instead of widening the parent: sudo install -d -o $USER -g $USER ${context.deployRoot}`,
    };
  },
};

const proxyRoot: Check = {
  id: 'proxy-root',
  title: 'Shared proxy directory',
  severity: 'required',
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    const fs = contextFs(context);
    return fs.isDirectory(context.proxyRoot)
      ? { status: 'pass', detail: context.proxyRoot }
      : {
          status: 'fail',
          detail: `${context.proxyRoot} does not exist`,
          remedy: `Set up the shared reverse proxy first, or point at it with --proxy-root.`,
        };
  },
};

const proxyConfWritable: Check = {
  id: 'proxy-conf-writable',
  title: 'Proxy conf.d writable',
  severity: 'required',
  requires: ['proxy-root'],
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    const fs = contextFs(context);
    const confd = `${context.proxyRoot}/nginx/conf.d`;

    if (!fs.isDirectory(confd)) {
      return {
        status: 'fail',
        detail: `${confd} does not exist`,
        remedy: `Create it, or point --proxy-root at the proxy that owns the vhosts.`,
      };
    }
    return fs.isWritable(confd)
      ? { status: 'pass', detail: confd }
      : {
          status: 'fail',
          detail: `${confd} is not writable`,
          remedy: 'Run the deployment as a user that can write the vhost, or fix its permissions.',
        };
  },
};

const acmeWebroot: Check = {
  id: 'acme-webroot',
  title: 'ACME challenge webroot',
  severity: 'required',
  requires: ['proxy-root'],
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    const fs = contextFs(context);
    const webroot = `${context.proxyRoot}/webroot`;

    if (!fs.isDirectory(webroot)) {
      return {
        status: 'fail',
        detail: `${webroot} does not exist`,
        remedy: `Certificates are issued with certbot's webroot method; create ${webroot} and serve it from the proxy's default server.`,
      };
    }
    return fs.isWritable(webroot)
      ? { status: 'pass', detail: webroot }
      : {
          status: 'fail',
          detail: `${webroot} is not writable`,
          remedy: 'certbot writes the challenge file here; fix its permissions.',
        };
  },
};

/** True when a container of that name exists and is running. */
async function isRunning(context: CheckContext, name: string): Promise<boolean> {
  const { ok, stdout } = await probe(context, [
    'docker', 'inspect', '--format', '{{.State.Running}}', name,
  ]);
  return ok && stdout === 'true';
}

const proxyContainer: Check = {
  id: 'proxy-container',
  title: 'Shared proxy container',
  severity: 'required',
  requires: ['docker-daemon'],
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    const remedy = `Start the shared proxy: cd ${context.proxyRoot} && docker compose up -d`;

    // An operator who named the container is asking about THAT one; finding a
    // different container on :443 would not answer their question.
    if (context.proxyContainer !== undefined) {
      const name = context.proxyContainer;
      return (await isRunning(context, name))
        ? { status: 'pass', detail: name }
        : {
            status: 'fail',
            detail: `${name} is not running`,
            remedy: `${remedy} (or pass the right name with --proxy-container)`,
          };
    }

    // The port the vhost depends on, before the name it conventionally has.
    const published = await probe(context, [
      'docker', 'ps', '--filter', 'publish=443', '--format', '{{.Names}}',
    ]);
    const names = published.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const found = names[0];

    if (found !== undefined) {
      context.proxyContainer = found;
      return {
        status: 'pass',
        detail: names.length === 1 ? found : `${found} (also publishing 443: ${names.slice(1).join(', ')})`,
      };
    }

    if (await isRunning(context, DEFAULT_PROXY_CONTAINER)) {
      context.proxyContainer = DEFAULT_PROXY_CONTAINER;
      return { status: 'pass', detail: DEFAULT_PROXY_CONTAINER };
    }

    return {
      status: 'fail',
      detail: `no container publishes port 443 and ${DEFAULT_PROXY_CONTAINER} is not running`,
      remedy: `${remedy} (or name it with --proxy-container)`,
    };
  },
};

const proxyNetworkMode: Check = {
  id: 'proxy-network-mode',
  title: 'Proxy on the host network',
  severity: 'recommended',
  requires: ['proxy-container'],
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    const name = context.proxyContainer ?? DEFAULT_PROXY_CONTAINER;
    const { ok, stdout, stderr } = await probe(context, [
      'docker', 'inspect', '--format', '{{.HostConfig.NetworkMode}}', name,
    ]);

    if (!ok) {
      return {
        status: 'warn',
        detail: stderr.split('\n')[0] ?? `could not inspect ${name}`,
        remedy: `Inspect it by hand: docker inspect ${name}`,
      };
    }
    if (stdout === 'host') return { status: 'pass', detail: `${name} uses network_mode: host` };

    return {
      status: 'warn',
      detail: `${name} uses network mode "${stdout}"`,
      // The vhost forwards to the loopback address of the HOST; from a bridge
      // network 127.0.0.1 is the proxy container itself.
      remedy: `The vhost targets 127.0.0.1:${context.bindPort}, which a bridged proxy cannot reach. Run the proxy with network_mode: host (in ${context.proxyRoot}/compose.yml, then docker compose up -d).`,
    };
  },
};

const proxyConfigValid: Check = {
  id: 'proxy-config-valid',
  title: 'Proxy config currently valid',
  severity: 'recommended',
  requires: ['proxy-container'],
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    const name = context.proxyContainer ?? DEFAULT_PROXY_CONTAINER;
    // Inside the container, because that is the only nginx that will ever
    // read this configuration. There is no host-binary branch on purpose.
    const result = await probe(context, ['docker', 'exec', name, 'nginx', '-t']);
    if (result.ok) return { status: 'pass', detail: `nginx -t passes in ${name}` };

    return {
      status: 'warn',
      detail: result.stderr.split('\n').find((line) => line.includes('nginx:')) ?? `nginx -t failed in ${name}`,
      remedy:
        'The shared proxy is already misconfigured. Fix it before deploying, or the reload at the end of the install will fail for every site on this host.',
    };
  },
};

const certbotImage: Check = {
  id: 'certbot-image',
  title: 'certbot image present',
  severity: 'required',
  requires: ['docker-daemon'],
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    // Inspect, never pull: rule 4 - doctor is read-only, and a pull is a
    // network download that belongs in the remedy, not in the check.
    const { ok, stdout } = await probe(context, [
      'docker', 'image', 'inspect', CERTBOT_IMAGE, '--format', '{{index .RepoTags 0}}',
    ]);
    return ok
      ? { status: 'pass', detail: stdout === '' ? CERTBOT_IMAGE : stdout }
      : {
          status: 'fail',
          detail: `${CERTBOT_IMAGE} has not been pulled`,
          remedy: `Pull it: docker pull ${CERTBOT_IMAGE}`,
        };
  },
};

const proxyIpv6: Check = {
  id: 'proxy-ipv6',
  title: 'IPv6 available to the proxy',
  severity: 'recommended',
  requires: ['proxy-container'],
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    const name = context.proxyContainer ?? DEFAULT_PROXY_CONTAINER;

    // What the proxy can bind is what matters; under network_mode: host it
    // is the host's own table, and the host file is the second opinion.
    const inside = await probe(context, ['docker', 'exec', name, 'sh', '-c', 'cat /proc/net/if_inet6']);
    const host = contextFs(context).readFile?.('/proc/net/if_inet6') ?? '';

    if ((inside.ok && inside.stdout !== '') || host.trim() !== '') {
      context.ipv6 = true;
      return { status: 'pass', detail: 'an IPv6 address is configured' };
    }

    context.ipv6 = false;
    return {
      status: 'warn',
      detail: `no IPv6 address on the host or in ${name}`,
      // nginx -t passes on a `listen [::]:443` with IPv6 disabled; the RELOAD
      // is what fails, and it fails for every site on the box.
      remedy: `The vhost binds [::]:80 and [::]:443, and the reload fails without IPv6 even though nginx -t passes. Enable IPv6 on the host, or render the vhost without it: ${CLI_NAME} deploy install --no-ipv6`,
    };
  },
};

const portListening = (port: number, purpose: string): Check => ({
  id: `port-${port}-listening`,
  title: `Port ${port} served`,
  severity: 'recommended',
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    const listening = await contextPortListening(context)(port);
    return listening
      ? { status: 'pass', detail: `something is serving ${port}` }
      : {
          status: 'warn',
          detail: `nothing is listening on ${port}`,
          remedy: `${purpose} Start the shared proxy before issuing a certificate.`,
        };
  },
});

/** Reads `ufw status` output. Exported for its test. */
export function evaluateUfw(output: string): CheckResult {
  if (/^Status:\s*inactive/im.test(output)) {
    return { status: 'pass', detail: 'ufw is inactive; nothing is filtered' };
  }

  const allowed = (port: number): boolean =>
    output.split('\n').some(
      (line) =>
        /ALLOW/i.test(line) &&
        // "80/tcp", "80,443/tcp", "80" alone, or the named profiles.
        (new RegExp(`(^|[\\s,])${port}(/tcp)?([\\s,]|$)`).test(line) ||
          /Nginx Full|WWW Full/i.test(line)),
    );

  const missing = [80, 443].filter((port) => !allowed(port));
  return missing.length === 0
    ? { status: 'pass', detail: '80 and 443 are allowed' }
    : {
        status: 'warn',
        detail: `ufw is active and port(s) ${missing.join(', ')} are not allowed`,
        remedy: `Allow them: ufw allow 80/tcp && ufw allow 443/tcp`,
      };
}

const ufwPorts: Check = {
  id: 'ufw-ports',
  title: 'Firewall allows 80 and 443',
  severity: 'recommended',
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;

    const { ok, stdout, stderr } = await probe(context, ['ufw', 'status']);
    if (ok) return evaluateUfw(stdout);

    if (/root|permission/i.test(stderr)) {
      return {
        status: 'warn',
        detail: 'ufw status needs root',
        remedy: 'Check by hand: sudo ufw status',
      };
    }
    // No ufw is not a finding: a box may use nftables, a cloud firewall, or nothing.
    return { status: 'skip', detail: 'ufw is not installed' };
  },
};

export const HOST_CHECKS: readonly Check[] = [
  dockerInstalled,
  dockerDaemon,
  dockerComposeV2,
  dockerNetworkDevnet,
  gitInstalled,
  nodeVersion,
  diskSpace,
  memory,
  bindPortFree,
  deployRootWritable,
  proxyRoot,
  proxyConfWritable,
  acmeWebroot,
  proxyContainer,
  proxyNetworkMode,
  proxyIpv6,
  certbotImage,
  portListening(80, "Let's Encrypt's HTTP-01 challenge needs port 80."),
  portListening(443, 'HTTPS traffic needs port 443.'),
  proxyConfigValid,
  ufwPorts,
];
