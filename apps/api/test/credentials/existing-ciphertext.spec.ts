// =============================================================================
// Existing ciphertext still decrypts (issue #466, epic #462)
// =============================================================================
//
// KVox's own AES-256-GCM cipher (`common/crypto/secret-cipher.ts`) was deleted in
// favour of the platform's `core/crypto/secret-cipher`. The two are byte-compatible
// for every plain purpose (the platform only ADDS the `user:` / `org:` domain
// prefixes), which is why #466 needs no data migration. This spec proves it with
// bytes the deleted cipher actually produced.
//
// The fixture `test/fixtures/credentials/legacy-kvox-ciphertext.json` was generated
// ONCE by the deleted file (recovered from `ee835a2^`) under a throwaway TEST key,
// for the purposes KVox stores: `transcription`, `smtp`, `push_vapid` and `ai-key`.
// It must never be regenerated with the platform cipher: that would test nothing.
//
// A credential's PURPOSE is its sub-key domain, so a ciphertext decrypts only under
// the purpose it was written under; the cross-purpose cases pin that.
// =============================================================================

import { Logger } from '@nestjs/common';
import { decryptSecret } from '@marinoscar/platform-api/core';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { SMTP_CREDENTIAL_PURPOSE } from '@marinoscar/platform-api/email';
import { PUSH_VAPID_CREDENTIAL_PURPOSE } from '@marinoscar/platform-api/notifications';
import { AI_CREDENTIAL_PURPOSE } from '../../src/ai/ai-credential.constants';
import { TRANSCRIPTION_CREDENTIAL_PURPOSE } from '../../src/transcription/transcription-credential.constants';
import '../../src/kvox.manifest';
import '../../src/app-registrations/registrations';
import fixture from '../fixtures/credentials/legacy-kvox-ciphertext.json';

// The platform cipher caches its master key at module scope on first use, and
// nothing in this file touches it before the tests run. Set the fixture's key
// here, restore it afterwards so it cannot leak into a spec sharing this worker.
const ORIGINAL_KEY_ENV = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY = fixture.encryptionKeyBase64;

afterAll(() => {
  if (ORIGINAL_KEY_ENV === undefined) {
    delete process.env.SECRETS_ENCRYPTION_KEY;
  } else {
    process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
  }
});

type Row = (typeof fixture.rows)[number];

function row(purpose: string): Row {
  const found = fixture.rows.find((r) => r.purpose === purpose);
  if (!found) throw new Error(`fixture has no row for purpose "${purpose}"`);
  return found;
}

/** A minimal in-memory `credentials` table: only what `getSecret` reads. */
function serviceHolding(rows: readonly Row[]): CredentialsService {
  const prisma = {
    credential: {
      findUnique: jest.fn(async (args: { where: { purpose_name: { purpose: string; name: string } } }) => {
        const { purpose, name } = args.where.purpose_name;
        const hit = rows.find((r) => r.purpose === purpose && r.name === name);
        return hit ? { secret: hit.ciphertext } : null;
      }),
    },
  };
  return new CredentialsService(prisma as never);
}

describe('ciphertext written by the deleted KVox cipher', () => {
  it('fixture covers the four purposes KVox stores', () => {
    expect(fixture.rows.map((r) => r.purpose).sort()).toEqual(
      [AI_CREDENTIAL_PURPOSE, PUSH_VAPID_CREDENTIAL_PURPOSE, SMTP_CREDENTIAL_PURPOSE, TRANSCRIPTION_CREDENTIAL_PURPOSE].sort(),
    );
  });

  describe('core decryptSecret', () => {
    it.each(fixture.rows)('decrypts the "$purpose" row unchanged', (r) => {
      expect(decryptSecret(r.ciphertext, r.purpose)).toBe(r.plaintext);
    });

    it.each(fixture.rows)('rejects the "$purpose" row under every other purpose', (r) => {
      for (const other of fixture.rows.filter((o) => o.purpose !== r.purpose)) {
        expect(() => decryptSecret(r.ciphertext, other.purpose)).toThrow(/Failed to decrypt secret/);
      }
    });

    it('rejects a ciphertext decrypted under a user: or org: scoped purpose', () => {
      const r = row('ai-key');
      expect(() => decryptSecret(r.ciphertext, `user:${r.purpose}`)).toThrow();
      expect(() => decryptSecret(r.ciphertext, `org:${r.purpose}`)).toThrow();
    });
  });

  describe('platform CredentialsService.getSecret', () => {
    // `ai-key` is not a `credentials` purpose (AI keys live in `user_ai_credentials`,
    // decrypted with core `decryptSecret`), so only the three stored purposes go here.
    const stored = fixture.rows.filter((r) => r.purpose !== AI_CREDENTIAL_PURPOSE);

    it.each(stored)('returns the plaintext of an existing "$purpose" row', async (r) => {
      const service = serviceHolding(fixture.rows);
      await expect(service.getSecret(r.purpose, r.name)).resolves.toBe(r.plaintext);
    });

    it('refuses a row whose ciphertext was written under a different purpose', async () => {
      const smtp = row('smtp');
      // The same bytes, filed under the transcription purpose.
      const misfiled: Row = { ...smtp, purpose: 'transcription', name: 'openai' };
      const service = serviceHolding([misfiled]);
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await expect(service.getSecret('transcription', 'openai')).rejects.toThrow();
      logged.mockRestore();
    });

    it('returns null for an address with no row', async () => {
      const service = serviceHolding([]);
      await expect(service.getSecret('smtp', 'default')).resolves.toBeNull();
    });
  });
});
