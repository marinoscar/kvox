import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEPLOY_INFO_DIRNAME, DEPLOY_INFO_FILENAME } from './deploy-info.js';

// =============================================================================
// The deploy-info mount in vps.compose.yml  (issue #120, epic #118)
// =============================================================================
//
// A compose file cannot import TypeScript, so the directory and file names
// deploy-info.ts writes are spelled out a second time in vps.compose.yml.
// Nothing fails at build or run time if the two drift - the API just reads an
// empty mount and the About page says "absent" - so the duplication is
// guarded here, in the style of node/worker-env.test.ts. There is no docker
// in the test environment, so this reads the file as text and asserts the
// RULES the mount has to satisfy rather than running `docker compose config`.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(HERE, '..', '..', '..', '..', 'infra', 'compose', 'vps.compose.yml');

/** The `api:` block, up to the next top-level service. */
function apiBlock(body: string): string {
  const match = /^  api:\n([\s\S]*?)(?=^  \w+:|$(?![\s\S]))/m.exec(body);
  if (match === null) throw new Error('vps.compose.yml has no api service');
  return match[1] as string;
}

describe('the deploy-info mount (issue #120)', () => {
  const body = readFileSync(COMPOSE_FILE, 'utf8');
  const api = apiBlock(body);

  it('mounts the deploy-info DIRECTORY, read-only, at /app/deploy-info', () => {
    // The directory, never the file: a temp-and-rename replaces the inode,
    // and a single-file bind mount would keep the container on the old one.
    expect(api).toMatch(
      new RegExp(`^\\s+- \\$\\{DEPLOY_ROOT:-\\.\\./\\.\\./\\.\\.\\}/${DEPLOY_INFO_DIRNAME}:/app/${DEPLOY_INFO_DIRNAME}:ro$`, 'm'),
    );
  });

  it('points the API at info.json inside that mount', () => {
    expect(api).toMatch(
      new RegExp(`^\\s+- DEPLOY_INFO_PATH=/app/${DEPLOY_INFO_DIRNAME}/${DEPLOY_INFO_FILENAME}$`, 'm'),
    );
  });

  it('merges with base.compose.yml rather than overriding it', () => {
    // `!override` on `environment` would drop every default base.compose.yml
    // gives the api service; on `volumes` it is unnecessary, since base gives
    // it none. Either would be a silent regression.
    expect(api).not.toMatch(/volumes: !override/);
    expect(api).not.toMatch(/environment: !override/);
  });

  it('defaults the mount source to the app root relative to the compose directory', () => {
    // repo/infra/compose is three levels below <root>, so the default is
    // right for every deployment; DEPLOY_ROOT in .env is belt and braces.
    expect(api).toContain('${DEPLOY_ROOT:-../../..}');
  });

  it('mounts it exactly once, on the api service alone', () => {
    // The header comment and the api comment mention it in prose, so count
    // the mount lines themselves rather than the name.
    const mountLines = body.split('\n').filter((line) => /^\s+- .*deploy-info:\/app/.test(line));
    expect(mountLines).toHaveLength(1);
    expect(apiBlock(body)).toContain(mountLines[0] as string);
  });
});
