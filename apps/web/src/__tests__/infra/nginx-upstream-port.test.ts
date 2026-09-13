import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// =============================================================================
// The web container's listen port and the proxy's upstream port must agree
// =============================================================================
//
// These two files are edited by different people for different reasons and are
// four directories apart, so nothing but a test keeps them in sync.
//
// When they drifted, the symptom was specific and misleading: `base + prod`
// brought up a stack whose API answered every request normally while the site
// itself returned 502, because infra/nginx/nginx.conf proxied `/` to `web:5173`
// and the production image served on 80. Dev was unaffected — the dev server
// really does listen on 5173 — so the whole class of failure was invisible
// until something was deployed.
//
// This asserts the invariant rather than the number. Change the port in both
// places and the test still passes; change it in one and it fails naming both.
// =============================================================================

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/** The port the production web image listens on. */
function webListenPort(): string {
  const conf = read('apps/web/nginx.conf');
  // Ignore commented-out lines: the header explains the choice and mentions 80.
  const match = conf
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .match(/listen\s+(\d+)\s*;/);
  expect(match, 'no listen directive found in apps/web/nginx.conf').not.toBeNull();
  return match![1]!;
}

/** The port the compose proxy expects to reach the web container on. */
function webUpstreamPort(): string {
  const conf = read('infra/nginx/nginx.conf');
  const block = conf.match(/upstream\s+web_upstream\s*\{([^}]*)\}/);
  expect(block, 'no web_upstream block in infra/nginx/nginx.conf').not.toBeNull();
  const match = block![1]!.match(/server\s+web:(\d+)\s*;/);
  expect(match, 'no `server web:<port>` in the web_upstream block').not.toBeNull();
  return match![1]!;
}

describe('web container port and proxy upstream port', () => {
  it('agree, so the production stack serves the frontend', () => {
    expect(webListenPort()).toBe(webUpstreamPort());
  });

  it('are also the port the web Dockerfile exposes in production', () => {
    const dockerfile = read('apps/web/Dockerfile');
    const production = dockerfile.slice(dockerfile.indexOf('AS production'));
    const exposed = production.match(/^EXPOSE\s+(\d+)/m);

    expect(exposed, 'no EXPOSE in the production stage').not.toBeNull();
    expect(exposed![1]).toBe(webListenPort());
  });
});
