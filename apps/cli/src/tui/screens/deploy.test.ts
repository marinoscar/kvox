import { describe, expect, it } from 'vitest';

import { parseEnvExample } from '../../deploy/env-spec.js';
import { fieldsForInstall } from './deploy.js';

// `ink-testing-library` is not a dependency (see status.test.ts), so screen
// tests assert the DATA a screen derives rather than the rendered frame.

const TEMPLATE = [
  '# ------------------------------------------------------------',
  '# Application',
  '# ------------------------------------------------------------',
  'NODE_ENV=development',
  'APP_URL=http://localhost:3535',
  'PORT=3000',
  '',
  '# ------------------------------------------------------------',
  '# Database',
  '# ------------------------------------------------------------',
  '# The database host.',
  'POSTGRES_HOST=localhost',
  'POSTGRES_USER=postgres',
  'POSTGRES_PASSWORD=postgres',
  'POSTGRES_DB=appdb',
  '',
  '# ------------------------------------------------------------',
  '# JWT / Session',
  '# ------------------------------------------------------------',
  'JWT_SECRET=your-super-secret-key-min-32-characters-long',
  '',
  '# ------------------------------------------------------------',
  '# Test Authentication',
  '# ------------------------------------------------------------',
  'TEST_AUTH_ENABLED=false',
  '',
  '# ------------------------------------------------------------',
  '# Storage',
  '# ------------------------------------------------------------',
  'S3_BUCKET=your-bucket-name',
].join('\n');

const FIELDS = fieldsForInstall(parseEnvExample(TEMPLATE));
const keys = FIELDS.map((field) => field.key);

describe('fieldsForInstall', () => {
  it('asks for the domain first, since everything else is derived from it', () => {
    expect(keys[0]).toBe('__domain');
  });

  it('asks only for the essential keys', () => {
    expect(keys).toEqual([
      '__domain',
      'POSTGRES_HOST',
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'POSTGRES_DB',
      'JWT_SECRET',
    ]);
  });

  it('does not ask for values that are derived from the domain', () => {
    // APP_URL restates information already given.
    expect(keys).not.toContain('APP_URL');
  });

  it('does not ask for values that are forced', () => {
    expect(keys).not.toContain('NODE_ENV');
  });

  it('never asks about test authentication', () => {
    // True in production fails startup by design.
    expect(keys).not.toContain('TEST_AUTH_ENABLED');
  });

  it('does not ask for an opt-in group', () => {
    expect(keys).not.toContain('S3_BUCKET');
  });

  it('marks secrets so the input is masked and the summary is not', () => {
    const secret = FIELDS.filter((field) => field.secret).map((field) => field.key);

    expect(secret).toEqual(['POSTGRES_PASSWORD', 'JWT_SECRET']);
  });

  it('carries the template comment through as help text', () => {
    expect(FIELDS.find((field) => field.key === 'POSTGRES_HOST')?.help).toBe(
      'The database host.',
    );
  });

  it('carries the validator, so a bad value is caught on the field', () => {
    const jwt = FIELDS.find((field) => field.key === 'JWT_SECRET');

    expect(jwt?.validate?.('short')).toContain('32');
    expect(jwt?.validate?.('a-perfectly-long-replacement-secret-value')).toBeUndefined();
  });

  it('rejects a domain that is not a hostname', () => {
    const domain = FIELDS[0];

    expect(domain?.validate?.('not a host')).toBeDefined();
    expect(domain?.validate?.('app.example.com')).toBeUndefined();
  });

  it('still asks for the domain when the template cannot be read', () => {
    // Before a first checkout there is nothing to parse, and the domain
    // question alone is enough to get started.
    expect(fieldsForInstall([]).map((field) => field.key)).toEqual(['__domain']);
  });
});
