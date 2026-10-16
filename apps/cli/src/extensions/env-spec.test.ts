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

    expect(resolveEnvMetadata('STORAGE_CSP_ORIGIN')).toMatchObject({ allowBlank: true });
    expect(resolveEnvMetadata('API_MEM_LIMIT')).toBeDefined();
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
  });
});
