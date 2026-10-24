import { execFile } from 'node:child_process';
import { basename } from 'node:path';

import { isPathUnder, type DeployCheck } from '@marinoscar/platform-cli/deploy';

// =============================================================================
// Every host port Docker has already promised to somebody  (issue #257, ported by #482)
// =============================================================================
//
// The platform's `bind-port-free` check sees what is LISTENING (a bind probe
// plus `docker ps --filter publish=`), so a STOPPED container this CLI did not
// install looks free: the port gets taken, and the other application breaks the
// next time somebody starts it, minutes or days later, with nothing linking the
// failure back to this install. This check is the other source: what Docker
// itself has been told to publish, running or not.
//
// `.HostConfig.PortBindings`, NOT `docker ps --format '{{.Ports}}'`. HostConfig
// is the container's CREATE-time configuration and is persisted whatever its
// run state; `NetworkSettings.Ports` (what the `ps` Ports column renders) is
// RUNTIME state and is `{}` for anything not running. A published range is
// already expanded to one binding per port at create time, and an UNPUBLISHED
// mapping (`-p 80`, no host port) carries an empty `HostPort` that means
// "Docker picks one at start" and is not a claim on port 0.
//
// A container of THIS deployment never counts, so a `--resume` or an update of a
// stopped stack is not refused by its own containers. "This deployment" is its
// recorded compose project (`context.composeProject`); the folder name is only
// the fallback when that is absent. The two differ on a legacy server, whose
// deployment runs under the project `compose` while its folder carries the app name, and
// comparing against the folder name there refused an update over the stack's own
// nginx. The project name is a record, though, and a record can be wrong (a
// pre-platform CLI ran compose with an app-named `-p` project and wrote none,
// issue #736). The platform engine now derives the project from the running
// containers and records it before `deploy update|status|doctor`, but only when
// it can ask Docker; this check is the second line. A container whose compose
// WORKING DIR label is inside the deployment's folder is also its own, whatever
// project it carries: that is Docker's own ground truth for where the stack was
// started (`isPathUnder` is the platform's, shared with its project detection).
// Docker being unavailable is a skip, not a failure: it must not cost an
// install on a host whose socket is briefly unreachable.
// =============================================================================

/** The compose project label, which is how a container names the app it belongs to. */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** The directory compose was run from, which is how a container names the checkout it came from. */
export const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

/** Short by design: a wedged Docker socket must cost seconds, not the install. */
export const DOCKER_QUERY_TIMEOUT_MS = 10_000;

/**
 * One line per container: name, compose project, every published host port, then
 * the compose working directory. The directory comes LAST and is read as the
 * whole remainder of the line, so a path is never split and a line without it
 * still parses.
 *
 * `{{if .Config.Labels}}` guards a container created without any labels, whose
 * `Labels` is null rather than an empty map (`index` on nil renders
 * `<no value>` into the middle of the line otherwise).
 */
const INSPECT_FORMAT =
  '{{.Name}}|' +
  `{{if .Config.Labels}}{{index .Config.Labels "${COMPOSE_PROJECT_LABEL}"}}{{end}}|` +
  '{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{.HostPort}} {{end}}{{end}}|' +
  `{{if .Config.Labels}}{{index .Config.Labels "${COMPOSE_WORKING_DIR_LABEL}"}}{{end}}`;

/** A host port some container, running or not, has already been given. */
export interface DockerPortClaim {
  name: string;
  port: number;
  /** The compose project, or undefined for a container compose did not start. */
  project?: string | undefined;
  /** The directory compose was run from, or undefined when the container has no such label. */
  workingDir?: string | undefined;
}

/** Runs `docker <args>` and answers stdout; rejects on any failure. */
export type DockerRunner = (args: readonly string[]) => Promise<string>;

const runDocker: DockerRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('docker', [...args], { timeout: DOCKER_QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });

/**
 * Parses the `docker inspect` lines above into claims.
 *
 * Lenient on purpose: a line this does not understand is dropped rather than
 * failing the batch, because a Docker version that renders one container oddly
 * must not cost the scan the other nine.
 */
export function parseDockerPortLines(output: string): DockerPortClaim[] {
  const claims: DockerPortClaim[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const separator = trimmed.indexOf('|');
    if (separator === -1) continue;
    const second = trimmed.indexOf('|', separator + 1);
    if (second === -1) continue;

    // Docker prefixes every container name with a slash.
    const name = trimmed.slice(0, separator).replace(/^\//, '').trim();
    const project = trimmed.slice(separator + 1, second).trim();
    if (name === '') continue;

    // Ports, then optionally `|<working dir>` (the rest of the line, so a path is never split).
    const rest = trimmed.slice(second + 1);
    const third = rest.indexOf('|');
    const portsField = third === -1 ? rest : rest.slice(0, third);
    const workingDir = third === -1 ? '' : rest.slice(third + 1).trim();

    for (const token of portsField.split(/\s+/)) {
      if (token === '') continue;
      const port = Number(token);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      claims.push({
        name,
        port,
        ...(project === '' ? {} : { project }),
        ...(workingDir === '' ? {} : { workingDir }),
      });
    }
  }

  return claims;
}

/**
 * Every host port claimed by any container on this machine, stopped ones
 * included; `undefined` when Docker could not be asked.
 */
export async function dockerPortClaims(run: DockerRunner = runDocker): Promise<DockerPortClaim[] | undefined> {
  try {
    // `-aq`: every container, whatever its state. Ids, which can never be ambiguous.
    const ids = (await run(['ps', '-aq']))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (ids.length === 0) return [];

    // argv, never a shell string: the ids are separate arguments.
    return parseDockerPortLines(await run(['inspect', '--format', INSPECT_FORMAT, ...ids]));
  } catch {
    return undefined;
  }
}

/** Builds the check; the Docker runner is a seam for the tests. */
export function createDockerPortsCheck(run: DockerRunner = runDocker): DeployCheck {
  return {
    id: 'bind-port-not-promised',
    title: 'Loopback port not promised to another container',
    severity: 'required',
    requires: ['docker-daemon'],
    async run(context) {
      const claims = await dockerPortClaims(run);
      if (claims === undefined) {
        return { status: 'skip', detail: 'Docker could not be asked which ports its containers publish' };
      }

      const project = context.composeProject ?? basename(context.deployRoot);
      const foreign = claims.filter(
        (claim) =>
          claim.port === context.bindPort &&
          claim.project !== project &&
          !(claim.workingDir !== undefined && isPathUnder(claim.workingDir, context.deployRoot)),
      );

      if (foreign.length === 0) {
        return { status: 'pass', detail: `no other container is configured to publish ${context.bindPort}` };
      }

      const names = [...new Set(foreign.map((claim) => claim.name))].join(', ');
      return {
        status: 'fail',
        detail: `${names} ${foreign.length === 1 ? 'is' : 'are'} configured to publish ${context.bindPort} (running or not)`,
        remedy:
          `Choose another port with --port, or remove that container. A stopped container keeps its ` +
          `port promise and would fail to start the next time it is started.`,
      };
    },
  };
}

/** The check `createCli({ deployChecks })` registers. */
export const dockerPortsCheck: DeployCheck = createDockerPortsCheck();
