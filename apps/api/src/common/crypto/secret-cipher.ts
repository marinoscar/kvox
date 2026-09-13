import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

// =============================================================================
// AES-256-GCM Secret Cipher  (issues #114, epic #108)
// =============================================================================
//
// The primitive underneath every runtime-configured secret this application
// will ever store. Deploy-time secrets (JWT_SECRET, AWS_SECRET_ACCESS_KEY,
// GOOGLE_CLIENT_SECRET) correctly live in the environment; this module exists
// for the other kind — an SMTP password an administrator types into a form,
// which cannot come from an env var because it needs a redeploy to change.
//
// Payload layout (concatenated, then base64-encoded into one opaque string):
//
//     [iv: 12 bytes][authTag: 16 bytes][ciphertext: variable]
//
// Self-describing on purpose: a single `text` column holds the whole thing, so
// the IV and the auth tag can never be stored in separate columns and drift
// away from the ciphertext they authenticate.
//
// Key source: SECRETS_ENCRYPTION_KEY, a base64-encoded 32 bytes.
// Generate with: openssl rand -base64 32
//
// THIS MODULE MUST NOT LOG. Every value passing through it is either a secret,
// a key, or a key-derived value; a Logger here is a plaintext leak waiting for
// someone to raise the log level. Errors carry lengths and variable names only.
// =============================================================================

/**
 * 96 bits. The GCM-standard IV size, and not an arbitrary choice: at exactly 12
 * bytes the spec uses the IV directly as the initial counter block, while any
 * other length is folded through GHASH first. Twelve is the well-analysed path
 * and the one every other implementation interoperates on.
 */
const IV_LENGTH = 12;

/**
 * 128 bits — the full GCM tag. Node will happily accept a truncated tag (as
 * short as 4 bytes) via `setAuthTag`, and a shorter tag means proportionally
 * cheaper forgery. We always write and read exactly 16.
 */
const AUTH_TAG_LENGTH = 16;

/** AES-256 key size, for both the master key and every derived sub-key. */
const KEY_LENGTH = 32;

const KEY_ENV_VAR = 'SECRETS_ENCRYPTION_KEY';

/**
 * Fixed, versioned label prefix for sub-key derivation. The `v1` is the hook
 * for ever changing the derivation scheme: bumping it changes every derived
 * key, which makes existing ciphertexts undecryptable, so it must only move
 * together with a re-encryption migration.
 */
const SUBKEY_LABEL_PREFIX = 'enterpriseappbase:secret-cipher:v1:';

/**
 * Strict base64 (standard alphabet, canonical padding). We validate the *text*
 * rather than trusting the decode, because `Buffer.from(x, 'base64')` silently
 * skips characters it does not recognise — `"not a real key!!!"` decodes to
 * some bytes rather than failing, and a typo'd key that happened to decode to
 * 32 bytes would be accepted as valid and silently encrypt everything under
 * the wrong key.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Build the operator-facing error for a bad key. The audience is someone
 * configuring a deployment, not someone reading this source, so the message
 * names the variable and hands over the exact generation command.
 *
 * `reason` describes the *shape* of the failure (absent, not base64, wrong
 * length) and may contain a byte count, never any bytes: an operator needs to
 * know "24 bytes, expected 32" to fix their key, and a length is not key
 * material. Nothing derived from the key value itself may appear here.
 */
function keyConfigError(reason: string): Error {
  return new Error(
    `${KEY_ENV_VAR} ${reason}. It must be a base64-encoded ${KEY_LENGTH}-byte key. ` +
      `Generate one with: openssl rand -base64 ${KEY_LENGTH}`,
  );
}

/**
 * The master key, read once and cached for the life of the process.
 *
 * Caching is deliberate — the key cannot change without a restart, and re-
 * reading `process.env` on every decrypt would only add a way for a late
 * mutation of the environment to silently split the ciphertexts written before
 * it from the ones written after.
 *
 * Consequence for tests: changing `process.env.SECRETS_ENCRYPTION_KEY` after
 * this module has been touched has no effect. Use `jest.resetModules()` and
 * re-`require` the module to exercise a different key.
 */
let cachedMasterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  const raw = process.env[KEY_ENV_VAR];
  if (!raw) {
    throw keyConfigError('is not set');
  }

  // .env files and container orchestrators routinely leave a trailing newline
  // or stray space on a value. That is an operator typo we can absorb safely —
  // whitespace carries no information for a base64 key — and refusing it would
  // burn someone's afternoon on an invisible character.
  const trimmed = raw.trim();

  if (!BASE64_PATTERN.test(trimmed)) {
    throw keyConfigError('is not valid base64');
  }

  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw keyConfigError(`decoded to ${key.length} bytes`);
  }

  cachedMasterKey = key;
  return cachedMasterKey;
}

/**
 * Derived sub-keys, cached by purpose.
 *
 * A derived key is a pure function of two values that are both fixed for the
 * life of the process (the master key and the purpose string), so the cache
 * can never go stale — and it is only ever populated through `deriveKey`,
 * which resolves the master key first, so an unconfigured key still throws
 * before anything lands here.
 *
 * The purpose set is a small, closed vocabulary chosen by callers in code
 * ('smtp', 'oauth', …), not user input, so this Map cannot grow unboundedly.
 */
const derivedKeyCache = new Map<string, Buffer>();

/**
 * Derive the 32-byte key actually used for a given purpose.
 *
 * WHY NOT JUST USE THE MASTER KEY: domain separation. Every purpose gets an
 * independent key, so a ciphertext lifted out of one column and pasted into
 * another — an attacker with a SQL write but not the key, or a bug that copies
 * a row across tables — fails authentication instead of decrypting into a
 * context where it means something else. Without this, the only thing standing
 * between an SMTP password blob and being read as, say, an OAuth client secret
 * is whichever code happens to parse it. That is a lateral-movement control,
 * and it is the whole reason `purpose` is a required parameter rather than an
 * option with a default.
 *
 * WHY HMAC-SHA256 AND NOT scrypt/argon2/PBKDF2: those are *password* KDFs, and
 * their slowness exists to punish guessing a low-entropy input. The input here
 * is already 32 bytes of `openssl rand` output — there is nothing to brute
 * force — so a slow KDF would buy zero security and add latency to every
 * decrypt. HMAC over a fixed label keyed by a full-entropy secret is the
 * standard construction for exactly this case (it is HKDF's extract step).
 *
 * WHY THE LABEL IS SAFE TO CONCATENATE: `purpose` is the final field of the
 * label, so distinct purposes always produce distinct labels — the prefix is
 * constant and cannot be shifted into it. If a second variable field were ever
 * added *after* the purpose, this would need explicit length-prefixing to stop
 * ('ab', 'c') and ('a', 'bc') from colliding onto one key.
 */
function deriveKey(purpose: string): Buffer {
  // An empty or non-string purpose would silently collapse every domain onto a
  // single key, quietly removing the separation above while everything still
  // appeared to work. Reject it loudly. The check is a runtime one despite the
  // `string` type because a plain-JS caller, a JSON round-trip, or an
  // undefined config value can all deliver something else here.
  if (typeof purpose !== 'string' || purpose.length === 0) {
    throw new Error(
      'encryptSecret/decryptSecret require a non-empty purpose string (e.g. "smtp").',
    );
  }

  const cached = derivedKeyCache.get(purpose);
  if (cached) return cached;

  const derived = createHmac('sha256', getMasterKey())
    .update(`${SUBKEY_LABEL_PREFIX}${purpose}`)
    .digest();

  derivedKeyCache.set(purpose, derived);
  return derived;
}

/**
 * Encrypt `plaintext` under the purpose-bound sub-key for `purpose`.
 *
 * Returns a base64 string carrying its own IV and auth tag — safe to put
 * straight into a `text` column.
 *
 * @throws if the key is missing/malformed, or `purpose` is empty.
 */
export function encryptSecret(plaintext: string, purpose: string): string {
  const key = deriveKey(purpose);

  // A FRESH RANDOM IV ON EVERY CALL — never a counter, never a hash of the
  // plaintext, never reused. This is the single most destructive mistake
  // available in GCM: reusing an IV under the same key does not merely leak
  // the XOR of the two plaintexts, it exposes the GHASH subkey and lets an
  // attacker forge auth tags for that key outright. Deriving the IV from the
  // plaintext would do exactly that for two equal secrets.
  //
  // It is also what keeps the store from leaking equality: two credentials
  // holding the same password must not produce the same ciphertext, or the
  // table answers "do these two accounts share a password?" to anyone who can
  // read it.
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // getAuthTag() is only valid after final(); reading it earlier returns a tag
  // that does not cover the whole message.
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Decrypt a payload produced by `encryptSecret` under the SAME `purpose`.
 *
 * Any tampering — a flipped bit in the IV, the tag, or the ciphertext — and
 * any purpose mismatch fails here rather than returning plausible garbage.
 * That is the entire reason this is GCM and not CBC: an unauthenticated mode
 * would hand back corrupted bytes that then get used as an SMTP password.
 *
 * @throws if the key is missing/malformed, `purpose` is empty, the payload is
 *         truncated, or authentication fails.
 */
export function decryptSecret(payload: string, purpose: string): string {
  const key = deriveKey(purpose);

  // Invalid base64 is not rejected up front here (unlike the key, where a typo
  // must be caught at configuration time): `Buffer.from` skips unrecognised
  // characters, and whatever survives is caught by the length check below or
  // by the auth tag. The tag — not input parsing — is what makes a payload
  // trustworthy, so there is nothing to gain by pre-screening the encoding.
  const buf = Buffer.from(payload, 'base64');

  // A payload shorter than the header cannot be ours. Check BEFORE slicing:
  // `subarray` clamps out-of-range indices instead of throwing, so a truncated
  // input would silently yield a short IV and an empty tag and fail somewhere
  // deeper with a far less obvious error. Equality is allowed — a 28-byte
  // payload is the legitimate encryption of an empty string.
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error(
      `Malformed encrypted payload: expected at least ${
        IV_LENGTH + AUTH_TAG_LENGTH
      } bytes, got ${buf.length}.`,
    );
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(), // verifies the auth tag; throws if it does not match
    ]).toString('utf8');
  } catch {
    // Deliberately swallow the underlying error and throw a flat one instead.
    //
    // Two reasons. First, a caught error can be logged by a caller along with
    // its `cause`, and we will not risk anything derived from the key or the
    // partially-decrypted plaintext travelling out of this module in a stack.
    // Second, a wrong purpose, a wrong key and a tampered byte are all the
    // same event to the caller — "this payload is not readable here" — and
    // distinguishing them only helps someone probing.
    //
    // The empty catch binding is intentional: there is nothing here we are
    // willing to inspect or forward.
    throw new Error(
      'Failed to decrypt secret: the payload is corrupt, was encrypted under a different purpose, or the encryption key has changed.',
    );
  }
}

/**
 * Throw unless `SECRETS_ENCRYPTION_KEY` is present and well-formed.
 *
 * Exists so startup can fail on a bad key instead of the first administrator
 * who tries to save a credential — a misconfiguration should surface in the
 * deploy logs, not as a 500 weeks later. Wiring this into bootstrap is #116;
 * this issue only provides the check.
 *
 * Also warms the cache, so the first real encrypt does not pay for validation.
 */
export function assertEncryptionKeyConfigured(): void {
  getMasterKey();
}
