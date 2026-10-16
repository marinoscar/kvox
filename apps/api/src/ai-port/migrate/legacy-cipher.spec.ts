import { randomBytes } from 'node:crypto';

import { encryptSecret } from '@marinoscar/platform-api/core';

import { decryptSecret } from './legacy-cipher';

// The legacy copy must read what this application wrote before the cipher moved
// into the platform package, which the platform documents as byte-compatible.
// This is the same claim, held from the migration's side: a ciphertext written by
// the platform cipher under `'ai-key'` opens with the copy, and nothing else does.
describe('legacy-cipher decryptSecret', () => {
  const previousKey = process.env.SECRETS_ENCRYPTION_KEY;

  beforeAll(() => {
    // Both ciphers cache the master key on first use, so this must be set before
    // either is called. A spec file runs in its own module registry.
    process.env.SECRETS_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = previousKey;
  });

  it('opens a ciphertext written under the same purpose', () => {
    const ciphertext = encryptSecret('sk-test-legacy-roundtrip-0001', 'ai-key');
    expect(decryptSecret(ciphertext, 'ai-key')).toBe('sk-test-legacy-roundtrip-0001');
  });

  it('refuses a ciphertext written under another purpose', () => {
    const ciphertext = encryptSecret('sk-test-legacy-roundtrip-0002', 'smtp');
    expect(() => decryptSecret(ciphertext, 'ai-key')).toThrow(/Failed to decrypt secret/);
  });

  it('refuses a payload that is too short, without echoing it', () => {
    expect(() => decryptSecret('c2hvcnQ=', 'ai-key')).toThrow(/Malformed encrypted payload/);
    try {
      decryptSecret('c2hvcnQ=', 'ai-key');
    } catch (error) {
      expect((error as Error).message).not.toContain('c2hvcnQ=');
    }
  });

  it('refuses a tampered ciphertext', () => {
    const buffer = Buffer.from(encryptSecret('sk-test-legacy-roundtrip-0003', 'ai-key'), 'base64');
    buffer[buffer.length - 1] ^= 0xff;
    expect(() => decryptSecret(buffer.toString('base64'), 'ai-key')).toThrow(/Failed to decrypt secret/);
  });
});
