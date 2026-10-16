import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_NAME, CLI_NAME, REPO_SLUG } from '@app/shared';
import type { CreateCliOptions } from '@marinoscar/platform-cli';

import { mediaAudioTranscodeExecutor } from './executors/media-audio-transcode.executor.js';
import { dockerNetworkCheck } from './extensions/docker-network.check.js';
import { dockerPortsCheck } from './extensions/docker-ports.check.js';
import { APP_ENV_SPEC } from './extensions/env-spec.js';

// =============================================================================
// This app's CLI, composed on the platform engine  (issue #482, epic #478)
// =============================================================================
//
// This app's CLI is `createCli()` with this file's options. Every command (`init`,
// `login`, `api`, `config`, `node`, `deploy`), the TUI, the deploy pipeline and
// the worker-node engine are `@marinoscar/platform-cli`'s; this app adds only
// what the platform does not have:
//
//   - the node executor for `media.audio.transcode` (with its `ffmpeg` and
//     `ffprobe` requirements, registered as the executor module loads);
//   - the shared host proxy's unbuffered, long-timeout locations for this app's
//     server-sent-event routes (`proxy.streamPaths`);
//   - the metadata of the `.env.example` keys that are this app's own;
//   - two deploy checks: `docker-network-devnet` (recommended: the external network
//     `base.compose.yml` needs, which install creates; the deploy end-to-end workflow
//     asserts it) and `bind-port-not-promised`: a host port Docker has
//     promised to a STOPPED container is not free;
//   - the pre-platform `deploy` flags the platform dropped are translated in
//     extensions/legacy-flags.ts before the platform parses them.
//
// The binary name, the config directory, the environment-variable prefix and
// the systemd unit all derive from `CLI_NAME` (`cliName` in packages/shared/identity.json). The
// deploy state file (`.appctl-deploy.json`) and the proxy sentinel are the
// platform's fixed literals on purpose: servers deployed by earlier versions of
// this CLI carry them and must keep being read.
// =============================================================================

/**
 * The package version, read at runtime from `apps/cli/package.json`, the only
 * place it lives.
 *
 * Not `import pkg from '../package.json'`: JSON import attributes are not
 * stable across the Node 20 line this package supports, and importing a file
 * from outside `src/` widens tsc's root and emits `dist/src/*.js`, which breaks
 * the `bin` path. Both `src/app.ts` (tsx, vitest) and `dist/app.js` (the built
 * CLI) sit one directory below the package root, so `../package.json` resolves
 * in both; nothing here may move into a subdirectory without revisiting that.
 *
 * It feeds `--version`, the User-Agent of every request, the `appctlVersion`
 * field of a deployment's state file and `deployedBy.version` of
 * `deploy-info/info.json`, which is how two installs stay distinguishable.
 */
export function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    // An unusual install is not a reason to refuse to run: every command still
    // works, and a placeholder version beats a stack trace at startup.
  }
  return '0.0.0-unknown';
}

/**
 * App routes the VPS host proxy must stream (no buffering, one hour).
 *
 * The platform's own three stream routes are already unbuffered; these are the
 * three this app adds, the same ones `infra/nginx/app.d/locations/app-streams.conf`
 * gives the inner nginx: `/api/notes/:id/stream`, `/api/note-generations/:id/stream`
 * and `/api/ask/messages/:id/stream`. The first two were carried by the vhost
 * this CLI rendered before the platform engine; the Ask stream never was, so it
 * was buffered and cut at 60 seconds at the edge (#483). The platform matches a
 * location by PREFIX, so the prefix is the closest it can express: the whole
 * family under each prefix streams, which is harmless for a JSON response and
 * keeps the route from being buffered and cut at the edge.
 */
export const APP_STREAM_PATHS: readonly string[] = ['/api/notes/', '/api/note-generations/', '/api/ask/messages/'];

export const APP_CLI_OPTIONS: CreateCliOptions = {
  identity: {
    name: CLI_NAME,
    displayName: `${APP_NAME} CLI`,
    productName: APP_NAME,
    repoSlug: REPO_SLUG,
  },
  version: readVersion(),
  nodeExecutors: [mediaAudioTranscodeExecutor],
  envSpecFragments: [APP_ENV_SPEC],
  deployChecks: [dockerPortsCheck, dockerNetworkCheck],
  proxy: { streamPaths: APP_STREAM_PATHS },
};
