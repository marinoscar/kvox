import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENV_METADATA,
  generateBase64Key,
  metadataFor,
  validateBase64Key32,
  validateEmail,
  validatePort,
} from './env-metadata.js';
import {
  diffEnv,
  parseEnvExample,
  parseEnvFile,
  serializeEnvFile,
  stripInlineComment,
  unquote,
  type EnvVarSpec,
} from './env-spec.js';

const REAL_TEMPLATE = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'infra',
  'compose',
  '.env.example',
);

/** A template exercising every parsing rule, including ones the real file
 *  happens not to use today. */
const FIXTURE = [
  '# ============================================================',
  '# Environment Variables Template',
  '# ============================================================',
  '# Copy this file to .env',
  '',
  '# ------------------------------------------------------------',
  '# Application',
  '# ------------------------------------------------------------',
  'NODE_ENV=development',
  '# The public URL.',
  '# Two lines of help.',
  'APP_URL=http://localhost:3535',
  '',
  '# ------------------------------------------------------------',
  '# Storage',
  '# ------------------------------------------------------------',
  'MAX_FILE_SIZE=10737418240  # 10GB in bytes',
  'HASH_MARK=a#b',
  'QUOTED="  spaced  "',
  'EMPTY=',
  '# Optional: for MinIO',
  '# S3_ENDPOINT=http://localhost:9000',
  '# Example: openssl rand -base64 32',
  '# Set this to true if needed:',
  'PLAIN=value',
].join('\n');

describe('stripInlineComment', () => {
  it('removes a comment that follows whitespace', () => {
    expect(stripInlineComment('10737418240  # 10GB in bytes')).toBe('10737418240');
  });

  it('keeps a # that is part of the value', () => {
    // A password may legitimately contain #, and PASSWORD=a#b means what it says.
    expect(stripInlineComment('a#b')).toBe('a#b');
  });

  it('keeps a # inside quotes', () => {
    expect(stripInlineComment('"a # b"')).toBe('"a # b"');
  });

  it('leaves a value with no comment alone', () => {
    expect(stripInlineComment('plain')).toBe('plain');
  });
});

describe('unquote', () => {
  it('removes a matching pair of double quotes', () => {
    expect(unquote('"value"')).toBe('value');
  });

  it('removes a matching pair of single quotes', () => {
    expect(unquote("'value'")).toBe('value');
  });

  it('leaves mismatched or absent quotes alone', () => {
    expect(unquote('"value')).toBe('"value');
    expect(unquote('value')).toBe('value');
  });
});

describe('parseEnvExample', () => {
  const specs = parseEnvExample(FIXTURE);
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));

  it('preserves file order', () => {
    expect(specs.map((spec) => spec.key)).toEqual([
      'NODE_ENV',
      'APP_URL',
      'MAX_FILE_SIZE',
      'HASH_MARK',
      'QUOTED',
      'EMPTY',
      'S3_ENDPOINT',
      'PLAIN',
    ]);
  });

  it('assigns each key its section banner', () => {
    expect(byKey.get('NODE_ENV')?.section).toBe('Application');
    expect(byKey.get('MAX_FILE_SIZE')?.section).toBe('Storage');
  });

  it('does not treat the file header block as a section', () => {
    // The header is fenced by ==== rules but has no keys under it; nothing
    // should inherit "Environment Variables Template" as its section.
    expect(specs.every((spec) => spec.section !== 'Environment Variables Template')).toBe(true);
  });

  it('collects the comment lines directly above a key as help', () => {
    expect(byKey.get('APP_URL')?.help).toBe('The public URL.\nTwo lines of help.');
  });

  it('does not attach help from before a blank line', () => {
    expect(byKey.get('NODE_ENV')?.help).toBe('');
  });

  it('strips a trailing inline comment from the default value', () => {
    // The bug behind #170: Compose does not strip these, so a generated .env
    // must not carry them either.
    expect(byKey.get('MAX_FILE_SIZE')?.defaultValue).toBe('10737418240');
  });

  it('keeps a # that belongs to the value', () => {
    expect(byKey.get('HASH_MARK')?.defaultValue).toBe('a#b');
  });

  it('unquotes a quoted default', () => {
    expect(byKey.get('QUOTED')?.defaultValue).toBe('  spaced  ');
  });

  it('treats an empty value as a real default, not an absent key', () => {
    expect(byKey.get('EMPTY')?.defaultValue).toBe('');
    expect(byKey.has('EMPTY')).toBe(true);
  });

  it('reads a commented-out assignment as an optional variable', () => {
    expect(byKey.get('S3_ENDPOINT')?.optional).toBe(true);
    expect(byKey.get('S3_ENDPOINT')?.defaultValue).toBe('http://localhost:9000');
  });

  it('marks an uncommented key as not optional', () => {
    expect(byKey.get('NODE_ENV')?.optional).toBe(false);
  });

  it('does not mistake prose containing punctuation for a key', () => {
    // "# Example: openssl rand -base64 32" and "# Set this to true if needed:"
    // are comments, not commented-out assignments.
    expect(byKey.has('Example')).toBe(false);
    expect(specs.filter((spec) => spec.key.includes(' '))).toHaveLength(0);
  });

  it('records a 1-based line number', () => {
    expect(byKey.get('NODE_ENV')?.line).toBe(9);
  });
});

describe('parseEnvExample against the real template', () => {
  const specs = parseEnvExample(readFileSync(REAL_TEMPLATE, 'utf8'));
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));

  it('finds the keys the deployment cannot work without', () => {
    for (const key of [
      'NODE_ENV',
      'APP_URL',
      'POSTGRES_HOST',
      'POSTGRES_PASSWORD',
      'JWT_SECRET',
      'COOKIE_SECRET',
      'SECRETS_ENCRYPTION_KEY',
      'GOOGLE_CLIENT_ID',
      'INITIAL_ADMIN_EMAIL',
    ]) {
      expect(byKey.has(key)).toBe(true);
    }
  });

  it('gives every key a section', () => {
    expect(specs.every((spec) => spec.section !== '')).toBe(true);
  });

  it('reads the Microsoft keys as optional', () => {
    expect(byKey.get('MICROSOFT_CLIENT_ID')?.optional).toBe(true);
  });

  it('keeps the long SECRETS_ENCRYPTION_KEY explanation as help', () => {
    const help = byKey.get('SECRETS_ENCRYPTION_KEY')?.help ?? '';
    expect(help.length).toBeGreaterThan(100);
    expect(help).toContain('32');
  });

  it('leaves no value carrying a trailing comment', () => {
    // Guards the #170 fix from the parser's side as well as the file's.
    expect(specs.filter((spec) => /\s#/.test(spec.defaultValue))).toEqual([]);
  });

  it('produces no duplicate keys', () => {
    const keys = specs.map((spec) => spec.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('parseEnvFile', () => {
  it('reads assignments and ignores comments and blanks', () => {
    const values = parseEnvFile(['# a comment', '', 'A=1', 'B=two'].join('\n'));

    expect([...values.entries()]).toEqual([
      ['A', '1'],
      ['B', 'two'],
    ]);
  });

  it('does not read a commented-out assignment as a value', () => {
    // In a real .env, a commented key is genuinely unset.
    expect(parseEnvFile('# A=1').has('A')).toBe(false);
  });

  it('strips inline comments and quotes', () => {
    const values = parseEnvFile(['A=1  # note', 'B="  x  "'].join('\n'));

    expect(values.get('A')).toBe('1');
    expect(values.get('B')).toBe('  x  ');
  });
});

describe('serializeEnvFile', () => {
  const specs = parseEnvExample(FIXTURE);

  it('round-trips through parseEnvFile', () => {
    const values = new Map([
      ['NODE_ENV', 'production'],
      ['APP_URL', 'https://app.example.test'],
      ['HASH_MARK', 'a#b'],
    ]);

    expect(parseEnvFile(serializeEnvFile(values, specs))).toEqual(values);
  });

  it('keeps section order and banners from the template', () => {
    const rendered = serializeEnvFile(
      new Map([
        ['MAX_FILE_SIZE', '1'],
        ['NODE_ENV', 'production'],
      ]),
      specs,
    );

    expect(rendered.indexOf('# Application')).toBeLessThan(rendered.indexOf('# Storage'));
    expect(rendered.indexOf('NODE_ENV=')).toBeLessThan(rendered.indexOf('MAX_FILE_SIZE='));
  });

  it('quotes a value that would otherwise be re-read as a comment', () => {
    const rendered = serializeEnvFile(new Map([['NODE_ENV', 'a # b']]), specs);

    expect(parseEnvFile(rendered).get('NODE_ENV')).toBe('a # b');
  });

  it('quotes a value with significant whitespace', () => {
    const rendered = serializeEnvFile(new Map([['NODE_ENV', ' padded ']]), specs);

    expect(parseEnvFile(rendered).get('NODE_ENV')).toBe(' padded ');
  });

  it('carries through a key the template does not know about', () => {
    // A fork's own variable, or something an operator added by hand. Dropping
    // it would silently lose a value someone deliberately set.
    const rendered = serializeEnvFile(new Map([['SENTRY_DSN', 'https://x']]), specs);

    expect(rendered).toContain('Not in .env.example');
    expect(parseEnvFile(rendered).get('SENTRY_DSN')).toBe('https://x');
  });

  it('omits keys with no value rather than writing blanks', () => {
    expect(serializeEnvFile(new Map(), specs)).toBe('\n');
  });
});

describe('diffEnv', () => {
  const specs = parseEnvExample(FIXTURE);

  it('reports a template key missing from the file', () => {
    const { missing } = diffEnv(specs, new Map([['NODE_ENV', 'production']]));

    expect(missing.map((spec) => spec.key)).toContain('APP_URL');
  });

  it('reports a file key unknown to the template', () => {
    const { unknown } = diffEnv(specs, new Map([['SENTRY_DSN', 'x']]));

    expect(unknown).toEqual(['SENTRY_DSN']);
  });

  it('reports nothing when the file covers the template', () => {
    const complete = new Map(specs.map((spec) => [spec.key, spec.defaultValue]));

    expect(diffEnv(specs, complete)).toEqual({ missing: [], unknown: [] });
  });
});

describe('env metadata', () => {
  it('falls back to an empty entry for a key it has never seen', () => {
    // THE template-safety property: a fork adding SENTRY_DSN gets a usable
    // prompt with no change to this CLI.
    expect(metadataFor('SENTRY_DSN_FROM_A_FORK')).toEqual({});
  });

  it('only annotates keys that exist in the real template', () => {
    const specs = parseEnvExample(readFileSync(REAL_TEMPLATE, 'utf8'));
    const known = new Set(specs.map((spec) => spec.key));

    // An entry for a key the template no longer has is dead weight that will
    // quietly stop applying; this catches a rename.
    expect(Object.keys(ENV_METADATA).filter((key) => !known.has(key))).toEqual([]);
  });

  it('forces NODE_ENV to production and never writes TEST_AUTH_ENABLED', () => {
    expect(metadataFor('NODE_ENV').fixed).toBe('production');
    // Setting it true in production fails startup by design.
    expect(metadataFor('TEST_AUTH_ENABLED').never).toBe(true);
  });

  it('derives the URLs that must agree with the certificate domain', () => {
    const context = { domain: 'app.example.test', answers: new Map<string, string>() };

    expect(metadataFor('APP_URL').derive?.(context)).toBe('https://app.example.test');
    expect(metadataFor('GOOGLE_CALLBACK_URL').derive?.(context)).toBe(
      'https://app.example.test/api/auth/google/callback',
    );
  });

  it('marks every credential secret', () => {
    for (const key of [
      'POSTGRES_PASSWORD',
      'JWT_SECRET',
      'COOKIE_SECRET',
      'SECRETS_ENCRYPTION_KEY',
      'GOOGLE_CLIENT_SECRET',
      'AWS_SECRET_ACCESS_KEY',
      'UPTRACE_ADMIN_PASSWORD',
    ]) {
      expect(metadataFor(key).secret).toBe(true);
    }
  });

  it('rejects a secret left at the template placeholder', () => {
    const validate = metadataFor('JWT_SECRET').validate;

    expect(validate?.('your-super-secret-key-min-32-characters-long')).toContain(
      'placeholder',
    );
    expect(validate?.(generateBase64Key())).toBeUndefined();
  });

  it('rejects a JWT secret under 32 characters', () => {
    expect(metadataFor('JWT_SECRET').validate?.('short')).toContain('32');
  });
});

describe('validateBase64Key32', () => {
  it('accepts a generated key', () => {
    expect(validateBase64Key32(generateBase64Key())).toBeUndefined();
  });

  it('accepts empty, since the key is optional until a credential is stored', () => {
    expect(validateBase64Key32('')).toBeUndefined();
  });

  it('rejects a key that decodes to the wrong length', () => {
    expect(validateBase64Key32(Buffer.alloc(31).toString('base64'))).toContain('32 bytes');
    expect(validateBase64Key32(Buffer.alloc(33).toString('base64'))).toContain('32 bytes');
  });

  it('rejects something that is not base64 at all', () => {
    expect(validateBase64Key32('not base64 !!!')).toBeDefined();
  });

  it('generates a distinct key each time', () => {
    expect(generateBase64Key()).not.toBe(generateBase64Key());
  });
});

describe('scalar validators', () => {
  it('validates an email address', () => {
    expect(validateEmail('admin@example.test')).toBeUndefined();
    expect(validateEmail('not-an-email')).toBeDefined();
  });

  it('validates a port', () => {
    expect(validatePort('5432')).toBeUndefined();
    expect(validatePort('0')).toBeDefined();
    expect(validatePort('70000')).toBeDefined();
    expect(validatePort('abc')).toBeDefined();
  });
});

describe('spec and metadata together', () => {
  it('leaves most template keys with no metadata entry', () => {
    const specs: EnvVarSpec[] = parseEnvExample(readFileSync(REAL_TEMPLATE, 'utf8'));
    const annotated = specs.filter((spec) => Object.keys(metadataFor(spec.key)).length > 0);

    // The registry is meant to be the exception. If it ever covers most keys,
    // the fallback that makes forks work has stopped being the common path.
    expect(annotated.length).toBeLessThan(specs.length);
  });
});
