import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCli } from '@marinoscar/platform-cli';
import { resolveEnvMetadata } from '@marinoscar/platform-cli/core';
import { parseEnvExample } from '@marinoscar/platform-cli/deploy';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from '../app.js';
import { APP_ENV_SPEC } from './env-spec.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const check = (key: string, value: string): string | undefined =>
  APP_ENV_SPEC.metadata[key]?.validate?.(value);

beforeEach(() => {
  resetCliForTests();
});

describe('the app environment keys', () => {
  it('are the ones infra/compose/app.env.example declares, and nothing retired is declared', () => {
    const appKeys = parseEnvExample(readFileSync(join(REPO_ROOT, 'infra', 'compose', 'app.env.example'), 'utf8')).map(
      (spec) => spec.key,
    );
    expect(appKeys.sort()).toEqual(['API_MEM_LIMIT', 'KG_MIGRATE_SCHEDULE_ENABLED', 'WEB_MEM_LIMIT']);

    const template = readFileSync(join(REPO_ROOT, 'infra', 'compose', '.env.example'), 'utf8');
    // Storage, Web Push and tracing backends are runtime-configured or gone: no variable names them.
    for (const retired of ['STORAGE_PROVIDER', 'S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'STORAGE_CSP_ORIGIN', 'STORAGE_STALE_UPLOAD_HOURS', 'UPTRACE_']) {
      expect(template, retired).not.toMatch(new RegExp(`^#?\\s*${retired}[A-Z_]*=`, 'm'));
    }
    expect(template).not.toMatch(/^#?\s*VAPID_(PUBLIC_KEY|PRIVATE_KEY|SUBJECT)=/m);
  });

  it('only describe keys the template declares (a renamed key must not leave dead metadata)', () => {
    const declared = new Set(
      parseEnvExample(readFileSync(join(REPO_ROOT, 'infra', 'compose', '.env.example'), 'utf8')).map((spec) => spec.key),
    );

    for (const key of Object.keys(APP_ENV_SPEC.metadata)) {
      expect(declared.has(key), `${key} is not in infra/compose/.env.example`).toBe(true);
    }
  });

  it('are registered with the CLI, and resolve through the platform registry', () => {
    createCli(APP_CLI_OPTIONS);

    expect(resolveEnvMetadata('API_MEM_LIMIT')).toBeDefined();
    expect(resolveEnvMetadata('KG_MIGRATE_SCHEDULE_ENABLED')).toBeDefined();
  });

  it('validate the sizings the wizard no longer suggests', () => {
    expect(check('APP_BIND_PORT', '3535')).toBeUndefined();
    expect(check('APP_BIND_PORT', '70000')).toBeDefined();
    expect(check('JOBS_WORKER_CONCURRENCY', '4')).toBeUndefined();
    expect(check('JOBS_WORKER_CONCURRENCY', '0')).toBeDefined();
    expect(check('API_MEM_LIMIT', '2g')).toBeUndefined();
    expect(check('WEB_MEM_LIMIT', '256M')).toBeUndefined();
    expect(check('WEB_MEM_LIMIT', 'lots')).toBeDefined();
    expect(check('POSTGRES_SSL', 'true')).toBeUndefined();
    expect(check('POSTGRES_SSL', 'yes')).toBeDefined();
    expect(check('KG_MIGRATE_SCHEDULE_ENABLED', 'false')).toBeUndefined();
    expect(check('KG_MIGRATE_SCHEDULE_ENABLED', 'off')).toBeDefined();
  });
});
