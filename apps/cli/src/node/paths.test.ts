import { describe, expect, it } from 'vitest';

import { CLI_NAME, CONFIG_DIR_NAME } from '../branding.js';
import {
  logsDir,
  nodeLogPath,
  nodePidPath,
  nodeSocketPath,
  nodeStateDir,
  nodeTmpDir,
  snapshotsDir,
} from './paths.js';
import { WORKER_ENV } from './worker-env.js';

const HOME = '/home/tester';

describe('node state paths (issue #272)', () => {
  it('defaults beneath the CLI config directory', () => {
    const dir = nodeStateDir({ home: HOME, env: {} });
    expect(dir).toBe(`${HOME}/${CONFIG_DIR_NAME}/node`);
  });

  it('honours the state-dir override, which is how a container mounts a volume', () => {
    const dir = nodeStateDir({ home: HOME, env: { [WORKER_ENV.stateDir]: '/var/lib/worker' } });
    expect(dir).toBe('/var/lib/worker');
  });

  it('ignores a blank override rather than resolving to the empty path', () => {
    // A compose file with `APPCTL_STATE_DIR=` sets the variable to an empty
    // string. Treating that as a directory would put the pidfile at `/node.pid`.
    expect(nodeStateDir({ home: HOME, env: { [WORKER_ENV.stateDir]: '   ' } })).toBe(
      `${HOME}/${CONFIG_DIR_NAME}/node`,
    );
  });

  it('resolves the pidfile, logs, snapshots and tmp beneath the state directory', () => {
    const ctx = { home: HOME, env: { [WORKER_ENV.stateDir]: '/state' } };
    expect(nodePidPath(ctx)).toBe('/state/node.pid');
    expect(logsDir(ctx)).toBe('/state/logs');
    expect(nodeLogPath(ctx)).toBe('/state/logs/node.log');
    expect(snapshotsDir(ctx)).toBe('/state/heap-snapshots');
    expect(nodeTmpDir(ctx)).toBe('/state/tmp');
  });

  it('puts the socket under the state directory on POSIX', () => {
    expect(nodeSocketPath({ home: HOME, env: { [WORKER_ENV.stateDir]: '/state' }, platform: 'linux' })).toBe(
      '/state/node.sock',
    );
  });

  it('uses a named pipe on Windows, namespaced by the CLI name', () => {
    // The pipe namespace is machine-wide and flat, so two forks of this
    // template on one box must not collide.
    expect(nodeSocketPath({ home: HOME, env: {}, platform: 'win32' })).toBe(`\\\\.\\pipe\\${CLI_NAME}-node`);
  });
});
