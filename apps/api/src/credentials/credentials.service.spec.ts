import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';

import { CredentialsService } from './credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// =============================================================================
// CredentialsService — tests (issue #115, epic #108)
// =============================================================================
//
// Prisma is mocked, but not with one-off `mockResolvedValue` calls: most of
// what this file needs to prove (round trip, purpose isolation, blank-preserve
// semantics) depends on what a PREVIOUS call actually persisted. So the mock
// backs onto a small in-memory Map keyed by `(purpose, name)`, and the five
// Prisma methods the service calls (findUnique, findMany, upsert, update,
// deleteMany) read and write it exactly the way the service's own `select` /
// `where` / `data` shapes tell them to. There is still no real database — this
// is a unit test — but it lets "write then read" mean something, and lets the
// blank-preserve tests check the stored row rather than a mock call arg.
//
// secret-cipher.ts itself is NOT mocked and NOT re-tested here (see its own
// spec for #114). Round-tripping through the REAL cipher is what makes the
// no-plaintext-egress and purpose-isolation assertions below meaningful,
// rather than assertions about a stub that always agrees with itself.
// =============================================================================

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

// secret-cipher.ts caches its master key at module scope on first use (see
// the comment on `cachedMasterKey` there), so this must be set before the
// first encrypt/decrypt call in this file - which only happens inside a
// `setSecret`/`getSecret` call in the tests below, never at import time.
// Setting it once here, before any test runs, is enough. Restored in
// `afterAll` so it cannot leak into another spec file sharing this worker.
const ORIGINAL_KEY_ENV = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

afterAll(() => {
  if (ORIGINAL_KEY_ENV === undefined) {
    delete process.env.SECRETS_ENCRYPTION_KEY;
  } else {
    process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
  }
});

interface FakeRow {
  id: string;
  purpose: string;
  name: string;
  secret: string;
  hint: string | null;
  label: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowKey(purpose: string, name: string): string {
  return `${purpose}::${name}`;
}

/** Project a fake row down to the `select` shape the service asked Prisma for. */
function project(
  row: FakeRow,
  select: Record<string, boolean> | undefined,
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(select)) {
    if (select[field]) {
      out[field] = (row as unknown as Record<string, unknown>)[field];
    }
  }
  return out;
}

/** Apply a Prisma-shaped update/data object to a fake row, returning the next version. */
function applyUpdate(row: FakeRow, data: Record<string, unknown>): FakeRow {
  const next: FakeRow = { ...row, updatedAt: new Date() };
  if ('secret' in data) next.secret = data.secret as string;
  if ('hint' in data) next.hint = data.hint as string | null;
  if ('label' in data) next.label = data.label as string | null;
  if ('updatedByUser' in data) {
    const rel = data.updatedByUser as
      | { connect?: { id: string }; disconnect?: boolean }
      | undefined;
    if (rel?.connect) next.updatedByUserId = rel.connect.id;
    else if (rel?.disconnect) next.updatedByUserId = null;
  }
  return next;
}

/**
 * Flip one base64 character well inside the payload (never in trailing `=`
 * padding) so the underlying bytes change and GCM authentication fails on
 * decrypt - without ever constructing or touching plaintext.
 */
function corruptCiphertext(payload: string): string {
  const idx = 10;
  if (payload.length <= idx + 4) {
    throw new Error('test payload too short for corruptCiphertext');
  }
  const chars = payload.split('');
  chars[idx] = chars[idx] === 'A' ? 'B' : 'A';
  return chars.join('');
}

describe('CredentialsService', () => {
  let service: CredentialsService;
  let mockPrisma: MockPrismaService;
  let store: Map<string, FakeRow>;
  let nextId: number;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    store = new Map();
    nextId = 1;

    (mockPrisma.credential.findUnique as unknown as jest.Mock).mockImplementation(
      async (args: any) => {
        const { purpose, name } = args.where.purpose_name;
        const row = store.get(rowKey(purpose, name));
        return row ? project(row, args.select) : null;
      },
    );

    (mockPrisma.credential.findMany as unknown as jest.Mock).mockImplementation(
      async (args: any) => {
        const purpose = args.where?.purpose;
        const rows = Array.from(store.values())
          .filter((r) => r.purpose === purpose)
          .sort((a, b) => a.name.localeCompare(b.name));
        return rows.map((r) => project(r, args.select));
      },
    );

    (mockPrisma.credential.upsert as unknown as jest.Mock).mockImplementation(
      async (args: any) => {
        const { purpose, name } = args.where.purpose_name;
        const k = rowKey(purpose, name);
        const existing = store.get(k);

        if (existing) {
          const updated = applyUpdate(existing, args.update);
          store.set(k, updated);
          return { ...updated };
        }

        const now = new Date();
        const created: FakeRow = {
          id: `cred-${nextId++}`,
          purpose,
          name,
          secret: args.create.secret,
          hint: args.create.hint ?? null,
          label: args.create.label ?? null,
          updatedByUserId: args.create.updatedByUser?.connect?.id ?? null,
          createdAt: now,
          updatedAt: now,
        };
        store.set(k, created);
        return { ...created };
      },
    );

    (mockPrisma.credential.update as unknown as jest.Mock).mockImplementation(
      async (args: any) => {
        const existing = Array.from(store.values()).find(
          (r) => r.id === args.where.id,
        );
        if (!existing) {
          // Mirrors Prisma's P2025 for an update against a missing row.
          throw new Error('Simulated Prisma P2025: record not found');
        }
        const updated = applyUpdate(existing, args.data);
        store.set(rowKey(updated.purpose, updated.name), updated);
        return { ...updated };
      },
    );

    (mockPrisma.credential.deleteMany as unknown as jest.Mock).mockImplementation(
      async (args: any) => {
        const { purpose, name } = args.where;
        const k = rowKey(purpose, name);
        if (store.has(k)) {
          store.delete(k);
          return { count: 1 };
        }
        return { count: 0 };
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CredentialsService>(CredentialsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // Round trip and addressing
  // ==========================================================================

  describe('round trip and addressing', () => {
    it('returns the original plaintext from getSecret after setSecret', async () => {
      await service.setSecret('smtp', 'default', 'hunter2-Sup3r-Secret', {});

      await expect(service.getSecret('smtp', 'default')).resolves.toBe(
        'hunter2-Sup3r-Secret',
      );
    });

    it('is not readable under a different purpose, asserted through the store', async () => {
      await service.setSecret('smtp', 'default', 'smtp-only-secret-value', {});

      // Simulate a ciphertext lifted from one purpose's row into another's -
      // a SQL write, or a bug copying rows - which is exactly what #114's
      // purpose-bound sub-key derivation exists to defend against.
      const smtpRow = store.get(rowKey('smtp', 'default'))!;
      store.set(rowKey('oauth', 'default'), {
        ...smtpRow,
        id: 'copied-row',
        purpose: 'oauth',
        name: 'default',
      });

      await expect(service.getSecret('oauth', 'default')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('addresses distinct rows: the same name under two purposes is independent', async () => {
      await service.setSecret('smtp', 'default', 'smtp-secret-value', {});
      await service.setSecret('oauth', 'default', 'oauth-secret-value', {});

      await expect(service.getSecret('smtp', 'default')).resolves.toBe(
        'smtp-secret-value',
      );
      await expect(service.getSecret('oauth', 'default')).resolves.toBe(
        'oauth-secret-value',
      );
    });

    it('addresses distinct rows: different names under the same purpose are independent', async () => {
      await service.setSecret('smtp', 'primary', 'primary-secret-value', {});
      await service.setSecret('smtp', 'backup', 'backup-secret-value', {});

      await expect(service.getSecret('smtp', 'primary')).resolves.toBe(
        'primary-secret-value',
      );
      await expect(service.getSecret('smtp', 'backup')).resolves.toBe(
        'backup-secret-value',
      );
    });

    it('returns null for an address with nothing stored', async () => {
      await expect(service.getSecret('smtp', 'never-set')).resolves.toBeNull();
    });
  });

  // ==========================================================================
  // No plaintext egress
  // ==========================================================================

  describe('no plaintext egress', () => {
    it('describe never carries the secret, checked structurally', async () => {
      const plaintext = 'S3cr3t-Value-For-Egress-Check';
      await service.setSecret('smtp', 'default', plaintext, {
        label: 'Primary SMTP',
      });
      const ciphertext = store.get(rowKey('smtp', 'default'))!.secret;

      const info = await service.describe('smtp', 'default');
      const serialized = JSON.stringify(info);

      expect(serialized).not.toContain(plaintext);
      expect(serialized).not.toContain(ciphertext);
    });

    it('list never carries any secret, checked structurally', async () => {
      const plaintextA = 'first-secret-abcdefgh';
      const plaintextB = 'second-secret-ijklmnop';
      await service.setSecret('smtp', 'a', plaintextA, {});
      await service.setSecret('smtp', 'b', plaintextB, {});
      const ciphertextA = store.get(rowKey('smtp', 'a'))!.secret;
      const ciphertextB = store.get(rowKey('smtp', 'b'))!.secret;

      const list = await service.list('smtp');
      const serialized = JSON.stringify(list);

      expect(serialized).not.toContain(plaintextA);
      expect(serialized).not.toContain(plaintextB);
      expect(serialized).not.toContain(ciphertextA);
      expect(serialized).not.toContain(ciphertextB);
    });

    it('requests a select for describe that does not include secret', async () => {
      await service.setSecret('smtp', 'default', 'another-secret-value', {});
      (mockPrisma.credential.findUnique as unknown as jest.Mock).mockClear();

      await service.describe('smtp', 'default');

      const call = (mockPrisma.credential.findUnique as unknown as jest.Mock)
        .mock.calls[0][0];
      expect(call.select).toBeDefined();
      expect(call.select.secret).toBeUndefined();
    });

    it('requests a select for list that does not include secret', async () => {
      await service.setSecret('smtp', 'default', 'yet-another-secret', {});
      (mockPrisma.credential.findMany as unknown as jest.Mock).mockClear();

      await service.list('smtp');

      const call = (mockPrisma.credential.findMany as unknown as jest.Mock)
        .mock.calls[0][0];
      expect(call.select).toBeDefined();
      expect(call.select.secret).toBeUndefined();
    });

    it('a decrypt-failure error carries no plaintext, ciphertext, stack, or cause leakage', async () => {
      const plaintext = 'super-secret-for-decrypt-failure-test';
      await service.setSecret('smtp', 'default', plaintext, {});
      const row = store.get(rowKey('smtp', 'default'))!;
      const originalCiphertext = row.secret;
      const corrupted = corruptCiphertext(originalCiphertext);
      store.set(rowKey('smtp', 'default'), { ...row, secret: corrupted });

      let thrown: unknown;
      try {
        await service.getSecret('smtp', 'default');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(InternalServerErrorException);
      const err = thrown as InternalServerErrorException & {
        stack?: string;
        cause?: unknown;
      };
      const responseBody = JSON.stringify(err.getResponse());

      for (const secretMaterial of [plaintext, originalCiphertext, corrupted]) {
        expect(err.message).not.toContain(secretMaterial);
        expect(err.stack ?? '').not.toContain(secretMaterial);
        expect(responseBody).not.toContain(secretMaterial);
      }
      // The service deliberately swallows the underlying cipher error rather
      // than chaining it as `cause` - see the comment in getSecret().
      expect(err.cause).toBeUndefined();
    });

    it('a not-found (first-write blank secret) error carries no plaintext or ciphertext leakage', async () => {
      const unrelatedPlaintext = 'unrelated-value-from-a-different-address';
      await service.setSecret('smtp', 'default', unrelatedPlaintext, {});
      const unrelatedCiphertext = store.get(rowKey('smtp', 'default'))!.secret;

      let thrown: unknown;
      try {
        // Blank secret at a DIFFERENT address with no row yet - the
        // BadRequestException branch, not the decrypt-failure one.
        await service.setSecret('smtp', 'brand-new-address', '', {});
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      const err = thrown as BadRequestException & {
        stack?: string;
        cause?: unknown;
      };

      for (const secretMaterial of [unrelatedPlaintext, unrelatedCiphertext]) {
        expect(err.message).not.toContain(secretMaterial);
        expect(err.stack ?? '').not.toContain(secretMaterial);
      }
      expect(err.cause).toBeUndefined();
    });
  });

  // ==========================================================================
  // Blank preserves
  // ==========================================================================

  describe('blank preserves', () => {
    it('empty string on an existing row leaves ciphertext byte-identical while applying label/updatedByUserId', async () => {
      await service.setSecret('smtp', 'default', 'original-secret-value', {
        label: 'Old Label',
        updatedByUserId: 'user-1',
      });
      const before = store.get(rowKey('smtp', 'default'))!;

      await service.setSecret('smtp', 'default', '', {
        label: 'New Label',
        updatedByUserId: 'user-2',
      });
      const after = store.get(rowKey('smtp', 'default'))!;

      expect(after.secret).toBe(before.secret);
      expect(after.hint).toBe(before.hint);
      expect(after.label).toBe('New Label');
      expect(after.updatedByUserId).toBe('user-2');
      await expect(service.getSecret('smtp', 'default')).resolves.toBe(
        'original-secret-value',
      );
    });

    it('undefined on an existing row leaves ciphertext byte-identical while applying metadata', async () => {
      await service.setSecret('smtp', 'default', 'original-secret-value-2', {
        label: 'Old Label',
      });
      const before = store.get(rowKey('smtp', 'default'))!;

      await service.setSecret('smtp', 'default', undefined, {
        label: 'Updated Label Only',
      });
      const after = store.get(rowKey('smtp', 'default'))!;

      expect(after.secret).toBe(before.secret);
      expect(after.hint).toBe(before.hint);
      expect(after.label).toBe('Updated Label Only');
      await expect(service.getSecret('smtp', 'default')).resolves.toBe(
        'original-secret-value-2',
      );
    });

    it('empty string with no existing row throws BadRequestException instead of creating a row', async () => {
      await expect(
        service.setSecret('smtp', 'never-set', '', {}),
      ).rejects.toThrow(BadRequestException);

      expect(store.has(rowKey('smtp', 'never-set'))).toBe(false);
    });

    it('blank secret with no metadata does not write at all, so updatedAt is not bumped', async () => {
      await service.setSecret('smtp', 'default', 'a-secret-that-stays-put', {});
      const before = store.get(rowKey('smtp', 'default'))!;
      const updateSpy = mockPrisma.credential.update as unknown as jest.Mock;

      await service.setSecret('smtp', 'default', '', {});

      const after = store.get(rowKey('smtp', 'default'))!;
      expect(updateSpy).not.toHaveBeenCalled();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after).toEqual(before);
    });

    it('a non-blank secret replaces the stored ciphertext', async () => {
      await service.setSecret('smtp', 'default', 'first-secret-value', {});
      const before = store.get(rowKey('smtp', 'default'))!;

      await service.setSecret('smtp', 'default', 'second-different-value', {});
      const after = store.get(rowKey('smtp', 'default'))!;

      expect(after.secret).not.toBe(before.secret);
      await expect(service.getSecret('smtp', 'default')).resolves.toBe(
        'second-different-value',
      );
    });
  });

  // ==========================================================================
  // Address validation: whitespace is rejected, not trimmed
  // ==========================================================================

  describe('address validation', () => {
    it('rejects a purpose with leading whitespace', async () => {
      await expect(service.getSecret(' smtp', 'default')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getSecret(' smtp', 'default')).rejects.toThrow(
        /whitespace/i,
      );
    });

    it('rejects a purpose with trailing whitespace', async () => {
      await expect(service.getSecret('smtp ', 'default')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a name with surrounding whitespace', async () => {
      await expect(service.getSecret('smtp', ' default ')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('does not silently equate "smtp" and "smtp " - a value under one is unreadable under the other', async () => {
      await service.setSecret('smtp', 'default', 'value-under-real-smtp', {});
      await expect(service.getSecret('smtp', 'default')).resolves.toBe(
        'value-under-real-smtp',
      );

      // Rejected outright, before it ever reaches the cipher's key derivation.
      await expect(service.getSecret('smtp ', 'default')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('list rejects a purpose with surrounding whitespace', async () => {
      await expect(service.list(' smtp')).rejects.toThrow(BadRequestException);
    });

    it('setSecret rejects an address with whitespace even for a blank secret', async () => {
      await expect(
        service.setSecret('smtp ', 'default', '', {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('deleteSecret rejects an address with whitespace', async () => {
      await expect(service.deleteSecret(' smtp', 'default')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ==========================================================================
  // Hint derivation
  // ==========================================================================

  describe('hint derivation', () => {
    it('reveals the mask plus the last 4 characters for secrets of 8+ characters', async () => {
      await service.setSecret('smtp', 'default', 'password123', {}); // 11 chars
      const info = await service.describe('smtp', 'default');
      expect(info?.hint).toBe('••••d123');
    });

    it('shows the bare mask for secrets shorter than 8 characters', async () => {
      await service.setSecret('smtp', 'short', 'abc123', {}); // 6 chars
      const info = await service.describe('smtp', 'short');
      expect(info?.hint).toBe('••••');
    });

    it('boundary: exactly 8 characters reveals, exactly 7 stays masked', async () => {
      await service.setSecret('smtp', 'eight', '12345678', {}); // 8 chars
      await service.setSecret('smtp', 'seven', '1234567', {}); // 7 chars

      const eight = await service.describe('smtp', 'eight');
      const seven = await service.describe('smtp', 'seven');

      expect(eight?.hint).toBe('••••5678');
      expect(seven?.hint).toBe('••••');
    });

    it('counts Unicode code points for the length threshold, not UTF-16 units', async () => {
      const fourEmoji = '😀😀😀😀'; // 4 code points, but 8 UTF-16 units
      expect(fourEmoji.length).toBe(8); // sanity: this is exactly the trap
      expect(Array.from(fourEmoji).length).toBe(4);

      await service.setSecret('smtp', 'emoji-short', fourEmoji, {});
      const info = await service.describe('smtp', 'emoji-short');

      // A UTF-16-length check would see 8 and reveal; a code-point check sees
      // 4 and masks. Masking is correct here.
      expect(info?.hint).toBe('••••');
    });

    it('reveals whole code points, never a lone surrogate half, near an astral character', async () => {
      // Constructed so a naive `secret.slice(-4)` (UTF-16 units) would split
      // the emoji's surrogate pair and leave a dangling low surrogate:
      // 'abcde' + '😀' + 'XYZ' is 10 UTF-16 units, so the last 4 UNITS are
      // [low-surrogate, X, Y, Z] - not the last 4 CODE POINTS a correct
      // implementation reveals.
      const secret = 'abcde😀XYZ';
      expect(secret.length).toBe(10); // UTF-16 units: 5 + 2 (surrogate pair) + 3
      expect(Array.from(secret).length).toBe(9); // actual code points

      await service.setSecret('smtp', 'astral', secret, {});
      const info = await service.describe('smtp', 'astral');

      expect(info?.hint).toBe('••••😀XYZ');
      // Direct well-formedness check: a lone surrogate half (what a
      // UTF-16-unit `.slice(-4)` would produce here) fails this regex; a
      // hint built from whole code points never contains one.
      const LONE_SURROGATE =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      expect(info!.hint!).not.toMatch(LONE_SURROGATE);
    });
  });

  // ==========================================================================
  // deleteSecret
  // ==========================================================================

  describe('deleteSecret', () => {
    it('removes an existing credential', async () => {
      await service.setSecret('smtp', 'default', 'to-be-deleted', {});
      await service.deleteSecret('smtp', 'default');
      await expect(service.getSecret('smtp', 'default')).resolves.toBeNull();
    });

    it('is idempotent: deleting a non-existent credential does not throw', async () => {
      await expect(
        service.deleteSecret('smtp', 'never-existed'),
      ).resolves.toBeUndefined();
      await expect(
        service.deleteSecret('smtp', 'never-existed'),
      ).resolves.toBeUndefined();
    });
  });
});
