import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  composeFilesFor,
  telemetryEnabled,
  TELEMETRY_COMPOSE_FILE,
  VPS_COMPOSE_FILE,
  VPS_TELEMETRY_COMPOSE_FILE,
} from './compose-files.js';
import { metadataFor } from './env-metadata.js';
import { parseEnvExample } from './env-spec.js';
import { composeArgv } from './install.js';

// =============================================================================
// The platform telemetry overlay: its files, its variables and its order
// =============================================================================
//
// telemetry.compose.yml, vps.telemetry.compose.yml and
// infra/otel/otel-collector-config.yaml are copied from the platform's infra
// package and are never edited here, so this test does not re-check their
// contents. It guards the three things that connect them to THIS repository
// and that nothing else would notice drifting:
//
//   1. every variable the overlay reads is declared in .env.example, so the CLI
//      can offer it (the defect class of #241: a value the stack reads that
//      the template never mentions is silently unreachable);
//   2. every `${env:X}` the collector config reads reaches the collector
//      container, so setting it in .env actually does something;
//   3. the order the CLI hands the files to compose, which decides which ports
//      the VPS hardening can override.
//
// There is no docker in the test environment, so the files are read as text.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_DIR = join(HERE, '..', '..', '..', '..', 'infra', 'compose');
const OTEL_DIR = join(HERE, '..', '..', '..', '..', 'infra', 'otel');

const TELEMETRY_COMPOSE = readFileSync(join(COMPOSE_DIR, TELEMETRY_COMPOSE_FILE), 'utf8');
const VPS_TELEMETRY_COMPOSE = readFileSync(join(COMPOSE_DIR, VPS_TELEMETRY_COMPOSE_FILE), 'utf8');
const COLLECTOR_CONFIG = readFileSync(join(OTEL_DIR, 'otel-collector-config.yaml'), 'utf8');
const ENV_EXAMPLE = readFileSync(join(COMPOSE_DIR, '.env.example'), 'utf8');

/** Every name interpolated as `${NAME}`, `${NAME:-x}` or `${NAME:?x}`. */
function composeVariables(body: string): Set<string> {
  const found = new Set<string>();
  for (const match of body.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?:[:?-][^}]*)?\}/g)) {
    found.add(match[1] as string);
  }
  return found;
}

/** The `otel-collector:` service block, up to the next top-level service or key. */
function collectorBlock(body: string): string {
  const match = /^ {2}otel-collector:\n([\s\S]*?)(?=^ {2}\w[\w-]*:\n|^\w|$(?![\s\S]))/m.exec(body);
  if (match === null) throw new Error('telemetry.compose.yml has no otel-collector service');
  return match[1] as string;
}

/** Every `NAME=` the collector service sets in its own `environment`. */
function collectorEnvironment(block: string): Set<string> {
  const found = new Set<string>();
  for (const match of block.matchAll(/^\s+- ([A-Z][A-Z0-9_]*)=/gm)) {
    found.add(match[1] as string);
  }
  return found;
}

describe('the telemetry overlay files', () => {
  it('keeps the platform GENERATED header on every copied file', () => {
    for (const body of [TELEMETRY_COMPOSE, VPS_TELEMETRY_COMPOSE, COLLECTOR_CONFIG]) {
      expect(body.split('\n')[0]).toMatch(/^# GENERATED from @marinoscar\/platform-infra@\S+ \(telemetry\)/);
    }
  });

  it('has no leftover compose overlay or collector config from the previous stack', () => {
    expect(existsSync(join(COMPOSE_DIR, 'otel.compose.yml'))).toBe(false);
  });

  it('ships the app-owned collector overlay the platform collector reads second', () => {
    expect(existsSync(join(OTEL_DIR, 'app-collector.yaml'))).toBe(true);
    expect(TELEMETRY_COMPOSE).toContain('../otel/app-collector.yaml:/etc/otelcol/app.yaml:ro');
  });
});

describe('the variables the telemetry overlay reads', () => {
  const declared = new Set(parseEnvExample(ENV_EXAMPLE).map((spec) => spec.key));
  // Constants the overlay sets for itself, and values the stack derives.
  const NOT_FROM_ENV = new Set(['APP_URL']);

  it('are all declared in .env.example', () => {
    const read = new Set([
      ...composeVariables(TELEMETRY_COMPOSE),
      ...composeVariables(VPS_TELEMETRY_COMPOSE),
    ]);
    const missing = [...read].filter((name) => !declared.has(name) && !NOT_FROM_ENV.has(name)).sort();

    expect(missing).toEqual([]);
  });

  it('include every GREPTIME_* key the template documents for the API and the collector', () => {
    const read = composeVariables(TELEMETRY_COMPOSE);
    for (const key of [
      'GREPTIME_HOST',
      'GREPTIME_PG_PORT',
      'GREPTIME_DB',
      'GREPTIME_WRITER_USER',
      'GREPTIME_WRITER_PASSWORD',
      'GREPTIME_READER_USER',
      'GREPTIME_READER_PASSWORD',
      'GREPTIME_ADMIN_USER',
      'GREPTIME_ADMIN_PASSWORD',
    ]) {
      expect(read.has(key), key).toBe(true);
    }
  });

  it('reach the collector container for every ${env:X} its config reads', () => {
    const wanted = new Set<string>();
    for (const match of COLLECTOR_CONFIG.matchAll(/\$\{env:([A-Z][A-Z0-9_]*)(?=[:}])/g)) {
      wanted.add(match[1] as string);
    }
    const passed = collectorEnvironment(collectorBlock(TELEMETRY_COMPOSE));
    const missing = [...wanted].filter((name) => !passed.has(name)).sort();

    expect(wanted.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('are offered only to a deployment that opted into the observability group', () => {
    for (const key of [
      'GREPTIME_HOST',
      'GREPTIME_WRITER_PASSWORD',
      'GREPTIME_READER_PASSWORD',
      'GREPTIME_ADMIN_PASSWORD',
      'GREPTIME_BIND_PG_PORT',
    ]) {
      expect(metadataFor(key).group, key).toBe('observability');
    }
  });

  it('treat the three passwords as secrets that refuse the template placeholder', () => {
    for (const key of ['GREPTIME_WRITER_PASSWORD', 'GREPTIME_READER_PASSWORD', 'GREPTIME_ADMIN_PASSWORD']) {
      const metadata = metadataFor(key);
      expect(metadata.secret, key).toBe(true);
      expect(metadata.validate?.('change-me-writer'), key).toContain('placeholder');
    }
  });

  it('keep the application-role bootstrap keys out of a generated .env', () => {
    expect(metadataFor('APP_DB_USER').never).toBe(true);
    expect(metadataFor('APP_DB_PASSWORD').never).toBe(true);
    expect(metadataFor('APP_DB_PASSWORD').secret).toBe(true);
  });
});

describe('the compose file list for a deployment', () => {
  const withTelemetry = new Map([
    ['GREPTIME_WRITER_PASSWORD', 'w'],
    ['GREPTIME_READER_PASSWORD', 'r'],
    ['GREPTIME_ADMIN_PASSWORD', 'a'],
  ]);

  it('is base, prod, vps without telemetry, exactly as before', () => {
    expect(composeFilesFor(undefined)).toEqual(['base.compose.yml', 'prod.compose.yml', 'vps.compose.yml']);
    expect(composeFilesFor(new Map())).toEqual(['base.compose.yml', 'prod.compose.yml', 'vps.compose.yml']);
  });

  it('adds telemetry before vps and vps.telemetry last, the platform order for a VPS', () => {
    expect(composeFilesFor(withTelemetry)).toEqual([
      'base.compose.yml',
      'prod.compose.yml',
      'telemetry.compose.yml',
      'vps.compose.yml',
      'vps.telemetry.compose.yml',
    ]);
  });

  it('puts the VPS hardening of the telemetry services after everything it overrides', () => {
    const files = composeFilesFor(withTelemetry);

    expect(files.indexOf(TELEMETRY_COMPOSE_FILE)).toBeLessThan(files.indexOf(VPS_COMPOSE_FILE));
    expect(files.indexOf(VPS_TELEMETRY_COMPOSE_FILE)).toBe(files.length - 1);
  });

  it('needs all three passwords, because the overlay cannot be parsed without them', () => {
    for (const missing of withTelemetry.keys()) {
      const partial = new Map(withTelemetry);
      partial.delete(missing);

      expect(telemetryEnabled(partial), missing).toBe(false);
    }
    expect(telemetryEnabled(new Map([...withTelemetry, ['GREPTIME_ADMIN_PASSWORD', '  ']]))).toBe(false);
    expect(telemetryEnabled(withTelemetry)).toBe(true);
  });

  it('names only files that exist in infra/compose', () => {
    for (const file of composeFilesFor(withTelemetry)) {
      expect(existsSync(join(COMPOSE_DIR, file)), file).toBe(true);
    }
  });

  it('reaches the compose command line through composeArgv, in the same order', () => {
    const files = composeArgv('demo', ['up', '-d'], withTelemetry)
      .join(' ')
      .match(/-f (\S+)/g);

    expect(files).toEqual([
      '-f base.compose.yml',
      '-f prod.compose.yml',
      '-f telemetry.compose.yml',
      '-f vps.compose.yml',
      '-f vps.telemetry.compose.yml',
    ]);
    expect(composeArgv('demo', ['up', '-d']).join(' ')).toBe(
      'docker compose -p demo -f base.compose.yml -f prod.compose.yml -f vps.compose.yml up -d',
    );
  });
});
