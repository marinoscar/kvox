import { runCommand as defaultRunCommand } from './executor.js';
import type { SiblingPort } from './layout.js';

// =============================================================================
// Every host port Docker has already promised to somebody  (issue #257)
// =============================================================================
//
// The port scan had two sources and both missed the same case. `siblingBindPorts`
// reads the STATE FILES of apps this CLI installed, so a shared proxy, a
// database, pgAdmin - anything installed by hand or by another tool - is
// invisible to it. `isLoopbackPortFree` is a live bind probe, so it only sees
// those while they are RUNNING. Between them, a STOPPED container this CLI did
// not install looks free: the port gets taken, and the other application breaks
// the next time somebody starts it, minutes or days later, with nothing linking
// the failure back to this install.
//
// This is the third source: what docker itself has been told to publish.
//
// `.HostConfig.PortBindings`, NOT `docker ps --format '{{.Ports}}'`. The
// difference is the whole point of this module. `HostConfig` is the container's
// CREATE-time configuration and is persisted regardless of run state;
// `NetworkSettings.Ports` (which is what the `ps` Ports column renders) is
// RUNTIME state and is `{}` for anything not running. Verified against a real
// daemon on a created-but-never-started container:
//
//     docker ps -a --format '{{.Ports}}'      ->  (empty)
//     .NetworkSettings.Ports                  ->  {}
//     .HostConfig.PortBindings                ->  80/tcp=:18080 81/tcp=127.0.0.1:18081
//
// Two more things that template has to survive, both confirmed the same way:
// a published RANGE (`-p 18090-18092:80-82`) is already expanded into one
// binding per port at create time, and an UNPUBLISHED mapping (`-p 80`, no host
// port) carries an EMPTY `HostPort` that means "docker picks one at start" and
// must not be read as a claim on port 0.
//
// DOCKER IS NOT A HARD REQUIREMENT. Every failure here - no binary, no socket,
// a timeout, output this cannot parse - answers an empty list, and the scan
// falls back to the two sources it always had. A server whose docker socket is
// briefly unavailable must still be able to install.
// =============================================================================

/** The compose project label, which is how a container names the app it belongs to. */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/**
 * Short by design. This runs inside the wizard, between two questions, and a
 * wedged docker socket must cost a few seconds rather than the install.
 */
export const DOCKER_QUERY_TIMEOUT_MS = 10_000;

/**
 * One line per container: name, compose project, then every published host port.
 *
 * `{{if .Config.Labels}}` guards a container created without any labels, whose
 * `Labels` is null rather than an empty map - `index` on nil renders
 * `<no value>` into the middle of the line otherwise.
 */
const INSPECT_FORMAT =
  '{{.Name}}|' +
  `{{if .Config.Labels}}{{index .Config.Labels "${COMPOSE_PROJECT_LABEL}"}}{{end}}|` +
  '{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{.HostPort}} {{end}}{{end}}';

/** A host port some container - running or not - has already been given. */
export interface DockerPortClaim extends SiblingPort {
  /**
   * The compose project the container belongs to, or undefined for one that
   * was not started by compose. This is what lets the pre-`up -d` re-check tell
   * THIS app's own containers (project == app name) from a foreign one, so a
   * `--resume` after a failed health step is not refused by its own stack.
   */
  project?: string | undefined;
}

export interface DockerPortOptions {
  /** Where the query runs. Any directory; docker does not care, `runCommand` does. */
  cwd: string;
  runCommand?: typeof defaultRunCommand | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Parses the `docker inspect` lines above into claims.
 *
 * Deliberately lenient: a line this does not understand is dropped rather than
 * failing the batch, because a docker version that renders one container oddly
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
    const ports = trimmed.slice(second + 1);

    if (name === '') continue;

    for (const token of ports.split(/\s+/)) {
      if (token === '') continue;
      const port = Number(token);
      // An empty HostPort never reaches here (the split drops it); anything
      // else non-numeric is output this does not understand.
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      claims.push({ name, port, ...(project === '' ? {} : { project }) });
    }
  }

  return claims;
}

/**
 * Every host port claimed by any container on this machine, stopped ones
 * included. An empty array means "docker could not tell us", which is the same
 * answer as "nothing is claimed" on purpose: both mean the caller falls back to
 * its other sources rather than refusing to suggest a port.
 */
export async function dockerPortClaims(
  options: DockerPortOptions,
): Promise<DockerPortClaim[]> {
  const run = options.runCommand ?? defaultRunCommand;
  const timeoutMs = options.timeoutMs ?? DOCKER_QUERY_TIMEOUT_MS;

  try {
    // `-aq`: every container, whatever its state. Ids rather than names because
    // `docker inspect` accepts either and an id can never be ambiguous.
    const listed = await run(['docker', 'ps', '-aq'], { cwd: options.cwd, timeoutMs });
    const ids = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (ids.length === 0) return [];

    // argv, never a shell string (executor.ts rule 1): the ids are appended as
    // separate arguments, not interpolated into a command line.
    const inspected = await run(
      ['docker', 'inspect', '--format', INSPECT_FORMAT, ...ids],
      { cwd: options.cwd, timeoutMs },
    );
    return parseDockerPortLines(inspected.stdout);
  } catch {
    // No docker, no socket, a timeout, a non-zero exit. All the same answer.
    return [];
  }
}
