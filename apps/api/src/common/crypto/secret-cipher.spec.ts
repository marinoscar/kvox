import { randomBytes } from 'node:crypto';

// =============================================================================
// AES-256-GCM Secret Cipher — tests (issue #114)
// =============================================================================
//
// The module under test caches its master key at module scope by design (see
// the comment on `cachedMasterKey` in secret-cipher.ts): once
// `SECRETS_ENCRYPTION_KEY` has been read, later mutations of `process.env` are
// silently ignored for the lifetime of that module instance. So any test that
// needs a *different* key (or no key) from the rest of the suite cannot just
// set `process.env` and call the already-imported functions — it must
// `jest.resetModules()` and `require()` a fresh module instance after setting
// the env var, which loads and caches the key it sees at that moment.
//
// `loadCipher()` below does exactly that and is used everywhere in this file,
// including for the "happy path" suites, so every test starts from a known,
// uncached module state regardless of what earlier tests configured.
// =============================================================================

type SecretCipherModule = typeof import('./secret-cipher');

const ENV_VAR = 'SECRETS_ENCRYPTION_KEY';
const MODULE_PATH = './secret-cipher';

/** A deterministic, valid 32-byte key (base64-encoded) for tests that don't care about the key's value. */
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * Reset the module registry, optionally set `SECRETS_ENCRYPTION_KEY`, and
 * `require` a fresh instance of secret-cipher.ts so it caches whatever key
 * (or absence of one) is configured right now.
 */
function loadCipher(key: string | undefined): SecretCipherModule {
  if (key === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = key;
  }
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(MODULE_PATH) as SecretCipherModule;
}

describe('secret-cipher', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalEnv;
    }
    jest.resetModules();
  });

  describe('round-trip correctness', () => {
    let cipher: SecretCipherModule;

    beforeEach(() => {
      cipher = loadCipher(VALID_KEY);
    });

    it('round-trips a normal string', () => {
      const plaintext = 'super-secret-smtp-password-123!';
      const payload = cipher.encryptSecret(plaintext, 'smtp');
      expect(cipher.decryptSecret(payload, 'smtp')).toBe(plaintext);
    });

    it('round-trips an empty string', () => {
      const payload = cipher.encryptSecret('', 'smtp');
      expect(cipher.decryptSecret(payload, 'smtp')).toBe('');
    });

    it('round-trips a unicode string', () => {
      const plaintext = '🔐 pässwörd with 日本語 and emoji 🎉 — mixed graphemes';
      const payload = cipher.encryptSecret(plaintext, 'smtp');
      expect(cipher.decryptSecret(payload, 'smtp')).toBe(plaintext);
    });

    it('round-trips a large (~10KB) string', () => {
      const plaintext = randomBytes(10_000).toString('hex'); // 20,000 chars, ~10KB source of entropy
      const payload = cipher.encryptSecret(plaintext, 'smtp');
      expect(cipher.decryptSecret(payload, 'smtp')).toBe(plaintext);
    });

    it('produces a payload whose byte length is exactly 12 (iv) + 16 (tag) + ciphertext', () => {
      const plaintext = 'hello world';
      const payload = cipher.encryptSecret(plaintext, 'smtp');
      const buf = Buffer.from(payload, 'base64');

      // AES-GCM is a stream cipher mode: ciphertext length equals plaintext length.
      const expectedLength = 12 + 16 + Buffer.byteLength(plaintext, 'utf8');
      expect(buf.length).toBe(expectedLength);
    });

    it('encrypts the same plaintext to two different payloads (fresh IV per call)', () => {
      const plaintext = 'identical-value';
      const first = cipher.encryptSecret(plaintext, 'smtp');
      const second = cipher.encryptSecret(plaintext, 'smtp');

      expect(first).not.toBe(second);
      // Both must still decrypt back to the same plaintext.
      expect(cipher.decryptSecret(first, 'smtp')).toBe(plaintext);
      expect(cipher.decryptSecret(second, 'smtp')).toBe(plaintext);
    });

    it('produces unique IVs across many encryptions', () => {
      const iterations = 2000;
      const ivs = new Set<string>();

      for (let i = 0; i < iterations; i++) {
        const payload = cipher.encryptSecret('same plaintext every time', 'smtp');
        const iv = Buffer.from(payload, 'base64').subarray(0, 12).toString('hex');
        ivs.add(iv);
      }

      expect(ivs.size).toBe(iterations);
    });
  });

  describe('security properties', () => {
    let cipher: SecretCipherModule;

    beforeEach(() => {
      cipher = loadCipher(VALID_KEY);
    });

    describe('purpose binding (cross-purpose decryption)', () => {
      it('fails to decrypt a payload encrypted under "smtp" when decrypting under "oauth"', () => {
        const payload = cipher.encryptSecret('leaked-if-this-succeeds', 'smtp');
        expect(() => cipher.decryptSecret(payload, 'oauth')).toThrow();
      });

      it('fails to decrypt a payload encrypted under "oauth" when decrypting under "smtp"', () => {
        const payload = cipher.encryptSecret('leaked-if-this-succeeds', 'oauth');
        expect(() => cipher.decryptSecret(payload, 'smtp')).toThrow();
      });

      it('succeeds when the purpose matches exactly (sanity check for the above)', () => {
        const payload = cipher.encryptSecret('value', 'smtp');
        expect(cipher.decryptSecret(payload, 'smtp')).toBe('value');
      });
    });

    describe('tamper detection', () => {
      it('throws for a bit flip at every single byte/bit position across IV, tag, and ciphertext regions', () => {
        // Short plaintext keeps the exhaustive sweep cheap while still covering
        // all three regions: iv[0..12), tag[12..28), ciphertext[28..).
        const plaintext = 'ab';
        const payload = cipher.encryptSecret(plaintext, 'smtp');
        const original = Buffer.from(payload, 'base64');

        // Sanity: the untampered payload must actually decrypt cleanly.
        expect(cipher.decryptSecret(payload, 'smtp')).toBe(plaintext);
        expect(original.length).toBe(12 + 16 + 2);

        let checked = 0;
        for (let byteIndex = 0; byteIndex < original.length; byteIndex++) {
          for (let bit = 0; bit < 8; bit++) {
            const tampered = Buffer.from(original);
            tampered[byteIndex] ^= 1 << bit;
            const tamperedPayload = tampered.toString('base64');

            expect(() => cipher.decryptSecret(tamperedPayload, 'smtp')).toThrow();
            checked++;
          }
        }

        expect(checked).toBe(original.length * 8);
      });
    });

    describe('no leakage in thrown errors', () => {
      it('does not leak plaintext or key material on a wrong-purpose failure', () => {
        const plaintext = 'MARKER-PLAINTEXT-do-not-leak-me';
        const payload = cipher.encryptSecret(plaintext, 'smtp');

        expect.assertions(4);
        try {
          cipher.decryptSecret(payload, 'oauth');
        } catch (err) {
          const e = err as Error & { cause?: unknown };
          expect(e.message).not.toContain(plaintext);
          expect(e.stack ?? '').not.toContain(plaintext);
          expect(e.message).not.toContain(VALID_KEY);
          expect(e.cause).toBeUndefined();
        }
      });

      it('does not leak plaintext or key material on a corrupt-payload failure', () => {
        const plaintext = 'MARKER-PLAINTEXT-do-not-leak-me-either';
        const payload = cipher.encryptSecret(plaintext, 'smtp');
        const buf = Buffer.from(payload, 'base64');
        buf[buf.length - 1] ^= 0xff; // corrupt the last ciphertext byte
        const corrupted = buf.toString('base64');

        expect.assertions(4);
        try {
          cipher.decryptSecret(corrupted, 'smtp');
        } catch (err) {
          const e = err as Error & { cause?: unknown };
          expect(e.message).not.toContain(plaintext);
          expect(e.stack ?? '').not.toContain(plaintext);
          expect(e.message).not.toContain(VALID_KEY);
          expect(e.cause).toBeUndefined();
        }
      });
    });
  });

  describe('malformed input', () => {
    let cipher: SecretCipherModule;

    beforeEach(() => {
      cipher = loadCipher(VALID_KEY);
    });

    it('throws a clear error for a payload shorter than 28 bytes', () => {
      const shortPayload = Buffer.alloc(10).toString('base64');
      expect(() => cipher.decryptSecret(shortPayload, 'smtp')).toThrow(/28 bytes/);
      expect(() => cipher.decryptSecret(shortPayload, 'smtp')).toThrow(/got 10/);
    });

    it('does NOT throw for a legitimate 28-byte payload (the empty-string ciphertext)', () => {
      const payload = cipher.encryptSecret('', 'smtp');
      const buf = Buffer.from(payload, 'base64');

      expect(buf.length).toBe(28);
      expect(() => cipher.decryptSecret(payload, 'smtp')).not.toThrow();
      expect(cipher.decryptSecret(payload, 'smtp')).toBe('');
    });

    it('throws for an empty payload', () => {
      expect(() => cipher.decryptSecret('', 'smtp')).toThrow();
    });

    it('rejects an empty purpose on encrypt', () => {
      expect(() => cipher.encryptSecret('value', '')).toThrow(/non-empty purpose/);
    });

    it('rejects a non-string purpose on encrypt', () => {
      expect(() => cipher.encryptSecret('value', undefined as any)).toThrow(/non-empty purpose/);
      expect(() => cipher.encryptSecret('value', null as any)).toThrow(/non-empty purpose/);
      expect(() => cipher.encryptSecret('value', 42 as any)).toThrow(/non-empty purpose/);
    });

    it('rejects an empty purpose on decrypt', () => {
      const payload = cipher.encryptSecret('value', 'smtp');
      expect(() => cipher.decryptSecret(payload, '')).toThrow(/non-empty purpose/);
    });

    it('rejects a non-string purpose on decrypt', () => {
      const payload = cipher.encryptSecret('value', 'smtp');
      expect(() => cipher.decryptSecret(payload, undefined as any)).toThrow(/non-empty purpose/);
      expect(() => cipher.decryptSecret(payload, 42 as any)).toThrow(/non-empty purpose/);
    });
  });

  describe('key configuration', () => {
    // Every test here loads its own fresh module instance via loadCipher(),
    // because the master key is cached at module scope for the lifetime of a
    // module instance (see the file-level comment above).

    it('throws naming SECRETS_ENCRYPTION_KEY and the openssl generation command when the key is missing', () => {
      const cipher = loadCipher(undefined);
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/SECRETS_ENCRYPTION_KEY/);
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/openssl rand -base64 32/);
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/is not set/);
    });

    it('throws for an obviously non-base64 key', () => {
      const cipher = loadCipher('not a real key!!!');
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/SECRETS_ENCRYPTION_KEY/);
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/not valid base64/);
    });

    it('throws for a key containing an invalid character that Buffer.from would otherwise silently skip, even though the remaining valid characters would decode to exactly 32 bytes', () => {
      const validBytes = Buffer.alloc(32, 9);
      const validKey = validBytes.toString('base64');
      // Splice a character outside the base64 alphabet into the middle of an
      // otherwise-valid key, without removing any of the original characters.
      const keyWithJunk = `${validKey.slice(0, 20)}!${validKey.slice(20)}`;

      // Prove the premise: naively decoding this (skipping the invalid char)
      // really would land on 32 bytes identical to the intended key. This is
      // exactly the silent-typo scenario BASE64_PATTERN exists to reject.
      expect(Buffer.from(keyWithJunk, 'base64').length).toBe(32);
      expect(Buffer.from(keyWithJunk, 'base64').equals(validBytes)).toBe(true);

      const cipher = loadCipher(keyWithJunk);
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/not valid base64/);
    });

    it('throws for a 24-byte key and reports the decoded byte count', () => {
      const shortKey = Buffer.alloc(24, 1).toString('base64');
      const cipher = loadCipher(shortKey);
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/SECRETS_ENCRYPTION_KEY/);
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/decoded to 24 bytes/);
    });

    it('throws for a 64-byte key and reports the decoded byte count', () => {
      const longKey = Buffer.alloc(64, 1).toString('base64');
      const cipher = loadCipher(longKey);
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/SECRETS_ENCRYPTION_KEY/);
      expect(() => cipher.encryptSecret('x', 'smtp')).toThrow(/decoded to 64 bytes/);
    });

    it('accepts a valid key with surrounding whitespace and a trailing newline', () => {
      const cipher = loadCipher(`  ${VALID_KEY}\n`);
      let payload = '';
      expect(() => {
        payload = cipher.encryptSecret('value', 'smtp');
      }).not.toThrow();
      expect(cipher.decryptSecret(payload, 'smtp')).toBe('value');
    });

    describe('assertEncryptionKeyConfigured', () => {
      it('throws for a missing key', () => {
        const cipher = loadCipher(undefined);
        expect(() => cipher.assertEncryptionKeyConfigured()).toThrow(/SECRETS_ENCRYPTION_KEY/);
      });

      it('throws for a malformed key', () => {
        const cipher = loadCipher('definitely-not-base64!!!');
        expect(() => cipher.assertEncryptionKeyConfigured()).toThrow(/SECRETS_ENCRYPTION_KEY/);
      });

      it('returns cleanly for a well-formed key', () => {
        const cipher = loadCipher(VALID_KEY);
        expect(() => cipher.assertEncryptionKeyConfigured()).not.toThrow();
      });
    });
  });
});
