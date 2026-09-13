import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { PUSH_CONFIG_KEY, PushConfigService } from './push-config.service';
import { DEFAULT_VAPID_SUBJECT } from './push-config.schema';
import {
  PUSH_VAPID_CREDENTIAL_LABEL,
  PUSH_VAPID_CREDENTIAL_NAME,
  PUSH_VAPID_CREDENTIAL_PURPOSE,
} from './push-vapid-credential.constants';

// =============================================================================
// PushConfigService — tests (issue #355)
// =============================================================================
//
// Mirrors `../email/email-settings.service.spec.ts`'s structure and mocking
// conventions (createMockPrismaService + a hand-rolled CredentialsService
// stub). `web-push`'s `generateVAPIDKeys` is mocked deterministically so
// assertions can pin exact key values rather than "a string was generated".
//
// Four things this suite exists to guarantee, in the order the plan lists
// them:
//
//   1. generate()/rotate()/update()/remove() each enforce their own guard
//      (409/400/409) and, on the happy path, write the credential and the
//      settings row in the documented order — CREDENTIAL FIRST for generate
//      (an orphaned credential is inert; a row claiming keys with none behind
//      it is not), CREDENTIAL FIRST for remove's delete too (the opposite
//      order's failure mode reactivates push on stale env vars).
//   2. resolveActiveVapidConfig() implements the full four-case env/DB
//      precedence documented in the file's own header.
//   3. describeForAdmin() never returns a field capable of carrying the
//      plaintext private key — asserted on the FULL key set, not a few named
//      fields, so a future accidental spread cannot silently add one.
// =============================================================================

jest.mock('web-push', () => ({
  generateVAPIDKeys: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = jest.requireMock('web-push') as {
  generateVAPIDKeys: jest.Mock;
};

const USER_ID = 'admin-user-id';

const FIRST_KEYS = { publicKey: 'first-public-key', privateKey: 'first-private-key' };
const ROTATED_KEYS = { publicKey: 'rotated-public-key', privateKey: 'rotated-private-key' };

function credentialInfo(overrides: Partial<{
  hint: string | null;
  updatedByUserId: string | null;
}> = {}) {
  return {
    purpose: PUSH_VAPID_CREDENTIAL_PURPOSE,
    name: PUSH_VAPID_CREDENTIAL_NAME,
    hint: '••••priv',
    label: PUSH_VAPID_CREDENTIAL_LABEL,
    updatedByUserId: USER_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function settingsRow(overrides: Partial<{
  version: number;
  value: unknown;
  updatedAt: Date;
  updatedByUser: { id: string; email: string } | null;
}> = {}) {
  return {
    id: 'settings-webPush',
    key: PUSH_CONFIG_KEY,
    version: 1,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedByUserId: USER_ID,
    updatedByUser: { id: USER_ID, email: 'admin@example.com' },
    value: { enabled: true, publicKey: 'stored-public-key', subject: null },
    ...overrides,
  };
}

describe('PushConfigService', () => {
  let service: PushConfigService;
  let mockPrisma: MockPrismaService;
  let mockConfig: { get: jest.Mock };
  let mockCredentials: {
    describe: jest.Mock;
    setSecret: jest.Mock;
    getSecret: jest.Mock;
    deleteSecret: jest.Mock;
  };

  beforeEach(() => {
    mockPrisma = createMockPrismaService();
    mockConfig = { get: jest.fn().mockReturnValue(undefined) };
    mockCredentials = {
      describe: jest.fn().mockResolvedValue(null),
      setSecret: jest.fn().mockResolvedValue(undefined),
      getSecret: jest.fn().mockResolvedValue(null),
      deleteSecret: jest.fn().mockResolvedValue(undefined),
    };

    service = new PushConfigService(
      mockPrisma as unknown as PrismaService,
      mockConfig as unknown as ConfigService,
      mockCredentials as unknown as CredentialsService,
    );

    mockPrisma.auditEvent.create.mockResolvedValue({} as never);
    webpush.generateVAPIDKeys.mockReturnValue(FIRST_KEYS);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // generate()
  // ==========================================================================

  describe('generate()', () => {
    it('on first-time setup, writes the credential BEFORE the settings row', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(null);
      mockPrisma.systemSettings.upsert.mockResolvedValue(
        settingsRow({ version: 1, value: { enabled: true, publicKey: FIRST_KEYS.publicKey, subject: null } }) as never,
      );

      await service.generate({}, USER_ID);

      expect(mockCredentials.setSecret).toHaveBeenCalledTimes(1);
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledTimes(1);

      // Call ORDER, not just "both were called" — the partial-failure-safe
      // ordering the header documents.
      const setSecretOrder = mockCredentials.setSecret.mock.invocationCallOrder[0];
      const upsertOrder = mockPrisma.systemSettings.upsert.mock.invocationCallOrder[0];
      expect(setSecretOrder).toBeLessThan(upsertOrder);
    });

    it('writes the generated private key under the push_vapid credential address, and enables push', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(null);
      mockPrisma.systemSettings.upsert.mockResolvedValue(settingsRow() as never);

      await service.generate({ subject: 'mailto:ops@example.com' }, USER_ID);

      expect(mockCredentials.setSecret).toHaveBeenCalledWith(
        PUSH_VAPID_CREDENTIAL_PURPOSE,
        PUSH_VAPID_CREDENTIAL_NAME,
        FIRST_KEYS.privateKey,
        expect.objectContaining({
          label: PUSH_VAPID_CREDENTIAL_LABEL,
          updatedByUserId: USER_ID,
        }),
      );
      const [args] = mockPrisma.systemSettings.upsert.mock.calls[0] as [
        { create: { value: Record<string, unknown> } },
      ];
      expect(args.create.value).toEqual({
        enabled: true,
        publicKey: FIRST_KEYS.publicKey,
        subject: 'mailto:ops@example.com',
      });
    });

    it('409s when a private-key credential already exists, even with no settings row', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(credentialInfo());

      await expect(service.generate({}, USER_ID)).rejects.toThrow(ConflictException);
      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
      expect(mockPrisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('409s when a settings row already stores a public key, even with no credential', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: false, publicKey: 'already-there', subject: null },
      } as never);
      mockCredentials.describe.mockResolvedValue(null);

      await expect(service.generate({}, USER_ID)).rejects.toThrow(ConflictException);
      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // rotate()
  // ==========================================================================

  describe('rotate()', () => {
    function existingConfigured() {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: true, publicKey: FIRST_KEYS.publicKey, subject: 'mailto:old@example.com' },
      } as never);
      mockCredentials.describe.mockResolvedValue(credentialInfo());
    }

    it('overwrites both the credential and the row publicKey, and bumps the version', async () => {
      existingConfigured();
      webpush.generateVAPIDKeys.mockReturnValue(ROTATED_KEYS);
      mockPrisma.systemSettings.upsert.mockResolvedValue(
        settingsRow({
          version: 2,
          value: { enabled: true, publicKey: ROTATED_KEYS.publicKey, subject: 'mailto:old@example.com' },
        }) as never,
      );

      const view = await service.rotate({ confirmation: 'ROTATE' }, USER_ID);

      expect(mockCredentials.setSecret).toHaveBeenCalledWith(
        PUSH_VAPID_CREDENTIAL_PURPOSE,
        PUSH_VAPID_CREDENTIAL_NAME,
        ROTATED_KEYS.privateKey,
        expect.objectContaining({ updatedByUserId: USER_ID }),
      );
      const [args] = mockPrisma.systemSettings.upsert.mock.calls[0] as [
        { update: { value: Record<string, unknown> } },
      ];
      expect(args.update.value).toMatchObject({ publicKey: ROTATED_KEYS.publicKey });
      expect(view.publicKey).toBe(ROTATED_KEYS.publicKey);
      expect(view.version).toBe(2);
    });

    it('preserves the current enabled flag — rotation is not a decision about whether push is on', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: false, publicKey: FIRST_KEYS.publicKey, subject: null },
      } as never);
      mockCredentials.describe.mockResolvedValue(credentialInfo());
      webpush.generateVAPIDKeys.mockReturnValue(ROTATED_KEYS);
      mockPrisma.systemSettings.upsert.mockResolvedValue(settingsRow() as never);

      await service.rotate({ confirmation: 'ROTATE' }, USER_ID);

      const [args] = mockPrisma.systemSettings.upsert.mock.calls[0] as [
        { update: { value: Record<string, unknown> } },
      ];
      expect(args.update.value).toMatchObject({ enabled: false });
    });

    it('an omitted subject keeps the CURRENTLY stored subject rather than clearing it', async () => {
      existingConfigured();
      webpush.generateVAPIDKeys.mockReturnValue(ROTATED_KEYS);
      mockPrisma.systemSettings.upsert.mockResolvedValue(settingsRow() as never);

      await service.rotate({ confirmation: 'ROTATE' }, USER_ID);

      const [args] = mockPrisma.systemSettings.upsert.mock.calls[0] as [
        { update: { value: Record<string, unknown> } },
      ];
      expect(args.update.value).toMatchObject({ subject: 'mailto:old@example.com' });
    });

    it('400s when nothing is configured yet (no row at all)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(null);

      await expect(
        service.rotate({ confirmation: 'ROTATE' }, USER_ID),
      ).rejects.toThrow(BadRequestException);
      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
      expect(mockPrisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('400s when a row exists but has no publicKey, even if a credential is present', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: false, publicKey: null, subject: null },
      } as never);
      mockCredentials.describe.mockResolvedValue(credentialInfo());

      await expect(
        service.rotate({ confirmation: 'ROTATE' }, USER_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('400s when a publicKey is stored but the credential is missing', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: true, publicKey: FIRST_KEYS.publicKey, subject: null },
      } as never);
      mockCredentials.describe.mockResolvedValue(null);

      await expect(
        service.rotate({ confirmation: 'ROTATE' }, USER_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================================================
  // update()
  // ==========================================================================

  describe('update()', () => {
    it('409s when enabling with no key pair configured yet', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(null);

      await expect(
        service.update({ enabled: true, subject: null }, USER_ID),
      ).rejects.toThrow(ConflictException);
      expect(mockPrisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('a version/If-Match conflict throws 409 rather than silently overwriting', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        version: 3,
        value: { enabled: true, publicKey: FIRST_KEYS.publicKey, subject: null },
      } as never);

      await expect(
        service.update({ enabled: true, subject: null }, USER_ID, 1),
      ).rejects.toThrow(/version mismatch/i);
      expect(mockPrisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('a subject-only edit preserves the stored publicKey, and never touches the credential store', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        version: 1,
        value: { enabled: true, publicKey: FIRST_KEYS.publicKey, subject: 'mailto:old@example.com' },
      } as never);
      mockCredentials.describe.mockResolvedValue(credentialInfo());
      mockPrisma.systemSettings.upsert.mockResolvedValue(
        settingsRow({
          version: 2,
          value: { enabled: true, publicKey: FIRST_KEYS.publicKey, subject: 'mailto:new@example.com' },
        }) as never,
      );

      const view = await service.update(
        { enabled: true, subject: 'mailto:new@example.com' },
        USER_ID,
        1,
      );

      expect(view.publicKey).toBe(FIRST_KEYS.publicKey);
      const [args] = mockPrisma.systemSettings.upsert.mock.calls[0] as [
        { update: { value: Record<string, unknown> } },
      ];
      expect(args.update.value).toMatchObject({ publicKey: FIRST_KEYS.publicKey, subject: 'mailto:new@example.com' });
      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
      expect(mockCredentials.deleteSecret).not.toHaveBeenCalled();
    });

    it('disabling is always allowed, even with no key pair configured', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.systemSettings.upsert.mockResolvedValue(
        settingsRow({ value: { enabled: false, publicKey: null, subject: null } }) as never,
      );

      await expect(
        service.update({ enabled: false, subject: null }, USER_ID),
      ).resolves.toMatchObject({ enabled: false });
    });
  });

  // ==========================================================================
  // remove()
  // ==========================================================================

  describe('remove()', () => {
    it('deletes both the credential and the settings row', async () => {
      mockPrisma.systemSettings.deleteMany.mockResolvedValue({ count: 1 } as never);
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(null);

      await service.remove({ confirmation: 'REMOVE' }, USER_ID);

      expect(mockCredentials.deleteSecret).toHaveBeenCalledWith(
        PUSH_VAPID_CREDENTIAL_PURPOSE,
        PUSH_VAPID_CREDENTIAL_NAME,
      );
      expect(mockPrisma.systemSettings.deleteMany).toHaveBeenCalledWith({
        where: { key: PUSH_CONFIG_KEY },
      });
    });

    it('deletes the credential BEFORE the row — the safer partial-failure order', async () => {
      mockPrisma.systemSettings.deleteMany.mockResolvedValue({ count: 1 } as never);
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(null);

      await service.remove({ confirmation: 'REMOVE' }, USER_ID);

      const deleteSecretOrder = mockCredentials.deleteSecret.mock.invocationCallOrder[0];
      const deleteManyOrder = mockPrisma.systemSettings.deleteMany.mock.invocationCallOrder[0];
      expect(deleteSecretOrder).toBeLessThan(deleteManyOrder);
    });

    it('returns the resulting (now empty) configuration view', async () => {
      mockPrisma.systemSettings.deleteMany.mockResolvedValue({ count: 1 } as never);
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(null);

      const view = await service.remove({ confirmation: 'REMOVE' }, USER_ID);

      expect(view.configured).toBe(false);
      expect(view.publicKey).toBeNull();
    });

    it('is idempotent when nothing is configured: no audit event, no throw', async () => {
      mockPrisma.systemSettings.deleteMany.mockResolvedValue({ count: 0 } as never);
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(null);

      await expect(service.remove({ confirmation: 'REMOVE' }, USER_ID)).resolves.toBeDefined();
      expect(mockPrisma.auditEvent.create).not.toHaveBeenCalled();
      // The credential delete is still attempted unconditionally — deleteSecret
      // on an already-empty address is a no-op at the store layer, not an error.
      expect(mockCredentials.deleteSecret).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // resolveActiveVapidConfig() — the four-case env/DB precedence matrix
  // ==========================================================================

  describe('resolveActiveVapidConfig()', () => {
    function withEnv(values: Record<string, string | undefined>) {
      mockConfig.get.mockImplementation((key: string) => values[key]);
    }

    it('case 1 — no row at all: falls back to the env vars', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      withEnv({
        'push.vapidPublicKey': 'env-public',
        'push.vapidPrivateKey': 'env-private',
        'push.vapidSubject': 'mailto:env@example.com',
      });

      await expect(service.resolveActiveVapidConfig()).resolves.toEqual({
        publicKey: 'env-public',
        privateKey: 'env-private',
        subject: 'mailto:env@example.com',
      });
    });

    it('case 1b — no row, and no env vars either: null', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      withEnv({});

      await expect(service.resolveActiveVapidConfig()).resolves.toBeNull();
    });

    it('case 2 — row enabled and complete: the DB wins, even with env vars ALSO set', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: true, publicKey: 'db-public', subject: 'mailto:db@example.com' },
      } as never);
      mockCredentials.getSecret.mockResolvedValue('db-private');
      withEnv({
        'push.vapidPublicKey': 'env-public',
        'push.vapidPrivateKey': 'env-private',
        'push.vapidSubject': 'mailto:env@example.com',
      });

      await expect(service.resolveActiveVapidConfig()).resolves.toEqual({
        publicKey: 'db-public',
        privateKey: 'db-private',
        subject: 'mailto:db@example.com',
      });
    });

    it('case 3 — row disabled: null, regardless of env vars being set (no fallback)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: false, publicKey: 'db-public', subject: null },
      } as never);
      withEnv({
        'push.vapidPublicKey': 'env-public',
        'push.vapidPrivateKey': 'env-private',
      });

      await expect(service.resolveActiveVapidConfig()).resolves.toBeNull();
      // The credential is never even consulted for a disabled row.
      expect(mockCredentials.getSecret).not.toHaveBeenCalled();
    });

    it('case 4 — row enabled but the credential is missing: null (never falls back to env), and logs a warning', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: true, publicKey: 'db-public', subject: null },
      } as never);
      mockCredentials.getSecret.mockResolvedValue(null);
      withEnv({
        'push.vapidPublicKey': 'env-public',
        'push.vapidPrivateKey': 'env-private',
      });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(service.resolveActiveVapidConfig()).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('credential'));

      warnSpy.mockRestore();
    });

    it('falls back to the generic default subject when none is stored or configured', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: true, publicKey: 'db-public', subject: null },
      } as never);
      mockCredentials.getSecret.mockResolvedValue('db-private');

      const result = await service.resolveActiveVapidConfig();

      expect(result?.subject).toBe(DEFAULT_VAPID_SUBJECT);
    });
  });

  // ==========================================================================
  // describeForAdmin() — never a plaintext-key-shaped response
  // ==========================================================================

  describe('describeForAdmin()', () => {
    it('the FULL key set is exactly the documented admin-view shape — no extra field could be a leaked key', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(settingsRow() as never);
      mockCredentials.describe.mockResolvedValue(credentialInfo());

      const result = await service.describeForAdmin();

      expect(Object.keys(result).sort()).toEqual(
        [
          'enabled',
          'publicKey',
          'subject',
          'configured',
          'privateKeyStatus',
          'settingsError',
          'version',
          'updatedAt',
          'updatedBy',
        ].sort(),
      );
    });

    it('privateKeyStatus itself carries no field capable of holding the plaintext', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(settingsRow() as never);
      mockCredentials.describe.mockResolvedValue(credentialInfo());

      const result = await service.describeForAdmin();

      expect(Object.keys(result.privateKeyStatus).sort()).toEqual(
        ['configured', 'hint', 'updatedAt', 'updatedByUserId'].sort(),
      );
    });

    it('never calls getSecret (the plaintext read) on the admin describe path', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(settingsRow() as never);
      mockCredentials.describe.mockResolvedValue(credentialInfo());

      await service.describeForAdmin();

      expect(mockCredentials.getSecret).not.toHaveBeenCalled();
    });

    it('never leaks a known plaintext-shaped value: JSON.stringify of the view never contains it', async () => {
      const suspiciousPlaintext = 'do-not-leak-this-vapid-private-key-Xk9!q2';
      mockPrisma.systemSettings.findUnique.mockResolvedValue(settingsRow() as never);
      mockCredentials.describe.mockResolvedValue(
        credentialInfo({ hint: '••••q2' }),
      );

      const result = await service.describeForAdmin();

      expect(JSON.stringify(result)).not.toContain(suspiciousPlaintext);
    });

    it('degrades on a stored-but-invalid row: does not throw, returns defaults plus settingsError', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        version: 4,
        updatedAt: new Date(),
        updatedByUser: null,
        value: { enabled: 'not-a-boolean', publicKey: 123, subject: null },
      } as never);
      mockCredentials.describe.mockResolvedValue(null);

      const result = await service.describeForAdmin();

      expect(result.enabled).toBe(false);
      expect(result.publicKey).toBeNull();
      expect(result.settingsError).toEqual(expect.any(String));
      expect(result.version).toBe(4);
    });
  });
});
