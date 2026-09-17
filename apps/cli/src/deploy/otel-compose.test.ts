import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// =============================================================================
// The uptrace service must plumb through every UPTRACE_* variable
// infra/otel/uptrace.yml interpolates  (issue #241)
// =============================================================================
//
// #241 found UPTRACE_REDIS_PASSWORD, UPTRACE_CH_USER and UPTRACE_CH_PASSWORD
// read by uptrace.yml's `${VAR}` interpolation but never passed into the
// container's environment by otel.compose.yml's `uptrace:` service - so
// setting one of them in .env did nothing, and the inline default baked into
// uptrace.yml always won regardless. That is the actual defect class, not any
// one variable: a value the CONFIG reads but the COMPOSE FILE never wires in.
//
// There is no docker in the test environment (see vps-compose.test.ts, the
// same pattern), so both files are read as text and compared as sets rather
// than run through `docker compose config`. This guards the class rather
// than the three names #241 fixed, so a variable added to uptrace.yml later
// and forgotten here fails this test instead of silently doing nothing in
// production.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(HERE, '..', '..', '..', '..', 'infra', 'compose', 'otel.compose.yml');
const UPTRACE_CONFIG_FILE = join(HERE, '..', '..', '..', '..', 'infra', 'otel', 'uptrace.yml');

/** Every `UPTRACE_*` name referenced as `${UPTRACE_X}` or `${UPTRACE_X:default}`. */
function referencedUptraceVars(body: string): Set<string> {
  const found = new Set<string>();
  for (const match of body.matchAll(/\$\{(UPTRACE_[A-Z0-9_]+)(?::[^}]*)?\}/g)) {
    found.add(match[1] as string);
  }
  return found;
}

/** The `uptrace:` service block, up to the next top-level service. */
function uptraceServiceBlock(body: string): string {
  const match = /^  uptrace:\n([\s\S]*?)(?=^ {2}\S|$(?![\s\S]))/m.exec(body);
  if (match === null) throw new Error('otel.compose.yml has no uptrace service');
  return match[1] as string;
}

/** Every `UPTRACE_*` name the uptrace SERVICE passes into its own container. */
function passedUptraceVars(serviceBlock: string): Set<string> {
  const found = new Set<string>();
  for (const match of serviceBlock.matchAll(/^\s+- (UPTRACE_[A-Z0-9_]+)=/gm)) {
    found.add(match[1] as string);
  }
  return found;
}

describe('the uptrace service passes through every UPTRACE_* variable uptrace.yml reads (#241)', () => {
  const referenced = referencedUptraceVars(readFileSync(UPTRACE_CONFIG_FILE, 'utf8'));
  const passed = passedUptraceVars(uptraceServiceBlock(readFileSync(COMPOSE_FILE, 'utf8')));

  it('finds at least one UPTRACE_* reference on each side, so the comparison below is not vacuous', () => {
    expect(referenced.size).toBeGreaterThan(0);
    expect(passed.size).toBeGreaterThan(0);
  });

  it('passes every UPTRACE_* variable uptrace.yml interpolates', () => {
    const missing = [...referenced].filter((name) => !passed.has(name)).sort();

    expect(missing).toEqual([]);
  });
});
