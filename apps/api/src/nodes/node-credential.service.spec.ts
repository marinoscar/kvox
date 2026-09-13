// =============================================================================
// NodeCredentialService unit coverage (issue #267, epic #254)
// =============================================================================
//
// The four rejection paths in `validateToken` are the reason this file exists.
// Each of them is one `if` that, if inverted or dropped, produces a working
// credential where there should be none — and none of them would fail any
// happy-path test. They are therefore asserted one at a time, against a
// record that is otherwise perfectly valid, so a failure names exactly which
// check regressed.
//
// The `expiresAt: null` case gets its own group. It is the single most
// dangerous line in the service to get wrong: treating "no expiry" as
// "expired at the epoch" would take a whole fleet offline at once while every
// row still looked healthy in the database, and the only symptom would be
// jobs silently piling up unclaimed.
// =============================================================================

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { NodeCredentialService, NODE_TOKEN_PREFIX } from './node-credential.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { CreateNodeCredentialDto } from './dto/create-node-credential.dto';

describe('NodeCredentialService', () => {
  let service: NodeCredentialService;
  let mockPrisma: MockPrismaService;

  const userId = 'user-123';

  const activeUser = {
    id: userId,
    email: 'operator@example.com',
    isActive: true,
    userRoles: [
      {
        role: {
          id: 'role-1',
          name: 'admin',
          rolePermissions: [
            { permission: { id: 'p1', name: 'nodes:write', description: null } },
          ],
        },
      },
    ],
  };

  /** A credential row that passes every check, for individual sabotage below. */
  const liveCredential = {
    id: 'cred-1',
    userId,
    name: 'prod-worker-1',
    tokenHash: 'stored-hash',
    tokenPrefix: 'nod_abcd',
    expiresAt: null as Date | null,
    lastUsedAt: null as Date | null,
    createdAt: new Date(),
    revokedAt: null as Date | null,
    user: activeUser,
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodeCredentialService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(NodeCredentialService);
    (mockPrisma.nodeCredential.update as jest.Mock).mockResolvedValue({} as never);
  });

  // ===========================================================================
  // createCredential
  // ===========================================================================

  describe('createCredential', () => {
    function givenCreateEchoesInput() {
      (mockPrisma.nodeCredential.create as jest.Mock).mockImplementation(
        async ({ data }: any) =>
          ({
            id: 'cred-new',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            lastUsedAt: null,
            revokedAt: null,
            ...data,
          }) as never,
      );
    }

    it('mints a nod_ token of 32 random bytes and returns it in full', async () => {
      givenCreateEchoesInput();

      const result = await service.createCredential(userId, {
        name: 'prod-worker-1',
      } as CreateNodeCredentialDto);

      expect(result.token.startsWith(NODE_TOKEN_PREFIX)).toBe(true);
      // 64 hex characters = 32 bytes, the same entropy a PAT carries.
      expect(result.token.slice(NODE_TOKEN_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores only the sha256 hash, never the raw token', async () => {
      givenCreateEchoesInput();

      const result = await service.createCredential(userId, {
        name: 'prod-worker-1',
      } as CreateNodeCredentialDto);

      const written = (mockPrisma.nodeCredential.create as jest.Mock).mock.calls[0][0].data;

      expect(written.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
      // The raw value must appear nowhere in the row, under any key.
      expect(JSON.stringify(written)).not.toContain(result.token);
    });

    it('derives a short, non-secret display prefix from the token', async () => {
      givenCreateEchoesInput();

      const result = await service.createCredential(userId, {
        name: 'prod-worker-1',
      } as CreateNodeCredentialDto);

      expect(result.tokenPrefix).toBe(result.token.slice(0, NODE_TOKEN_PREFIX.length + 4));
      // Short enough to be useless: the prefix reveals 16 bits of 256.
      expect(result.tokenPrefix.length).toBeLessThan(result.token.length);
    });

    it('mints a DIFFERENT token every call', async () => {
      givenCreateEchoesInput();

      const a = await service.createCredential(userId, { name: 'a' } as CreateNodeCredentialDto);
      const b = await service.createCredential(userId, { name: 'b' } as CreateNodeCredentialDto);

      expect(a.token).not.toBe(b.token);
    });

    it('writes expiresAt: null when expiresInDays is omitted (never expires)', async () => {
      givenCreateEchoesInput();

      const result = await service.createCredential(userId, {
        name: 'unattended-box',
      } as CreateNodeCredentialDto);

      const written = (mockPrisma.nodeCredential.create as jest.Mock).mock.calls[0][0].data;

      expect(written.expiresAt).toBeNull();
      expect(result.expiresAt).toBeNull();
    });

    it('computes expiresAt from the SERVER clock when expiresInDays is given', async () => {
      givenCreateEchoesInput();
      const before = Date.now();

      await service.createCredential(userId, {
        name: 'temporary',
        expiresInDays: 7,
      } as CreateNodeCredentialDto);

      const written = (mockPrisma.nodeCredential.create as jest.Mock).mock.calls[0][0].data;
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

      expect(written.expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs);
      expect(written.expiresAt.getTime()).toBeLessThan(Date.now() + sevenDaysMs + 5_000);
    });
  });

  // ===========================================================================
  // listCredentials
  // ===========================================================================

  describe('listCredentials', () => {
    it('never selects tokenHash — the select is an allowlist, not an omission', async () => {
      (mockPrisma.nodeCredential.findMany as jest.Mock).mockResolvedValue([] as never);

      await service.listCredentials(userId);

      const args = (mockPrisma.nodeCredential.findMany as jest.Mock).mock.calls[0][0];

      expect(args.where).toEqual({ userId });
      expect(Object.keys(args.select).sort()).toEqual(
        ['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'revokedAt', 'tokenPrefix'].sort(),
      );
      expect(args.select.tokenHash).toBeUndefined();
    });

    it('scopes the listing to the caller and orders newest first', async () => {
      (mockPrisma.nodeCredential.findMany as jest.Mock).mockResolvedValue([] as never);

      await service.listCredentials(userId);

      const args = (mockPrisma.nodeCredential.findMany as jest.Mock).mock.calls[0][0];
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
    });
  });

  // ===========================================================================
  // revokeCredential
  // ===========================================================================

  describe('revokeCredential', () => {
    it('folds ownership into the lookup so "not yours" and "not found" cannot be told apart', async () => {
      (mockPrisma.nodeCredential.findFirst as jest.Mock).mockResolvedValue(null as never);

      await expect(service.revokeCredential(userId, 'cred-1')).rejects.toThrow(NotFoundException);

      const args = (mockPrisma.nodeCredential.findFirst as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ id: 'cred-1', userId });
    });

    it('stamps revokedAt on a live credential', async () => {
      (mockPrisma.nodeCredential.findFirst as jest.Mock).mockResolvedValue(
        { ...liveCredential } as never,
      );

      await service.revokeCredential(userId, 'cred-1');

      const args = (mockPrisma.nodeCredential.update as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ id: 'cred-1' });
      expect(args.data.revokedAt).toBeInstanceOf(Date);
    });

    it('refuses to re-revoke, so the first revocation timestamp survives', async () => {
      (mockPrisma.nodeCredential.findFirst as jest.Mock).mockResolvedValue({
        ...liveCredential,
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);

      await expect(service.revokeCredential(userId, 'cred-1')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.nodeCredential.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // validateToken — the four rejections, one at a time
  // ===========================================================================

  describe('validateToken', () => {
    const RAW = `${NODE_TOKEN_PREFIX}${'a'.repeat(64)}`;

    it('looks the credential up by sha256 hash, never by the raw value', async () => {
      (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue(null as never);

      await service.validateToken(RAW);

      const args = (mockPrisma.nodeCredential.findUnique as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({
        tokenHash: createHash('sha256').update(RAW).digest('hex'),
      });
    });

    it('returns the owning user for a live credential', async () => {
      (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue(
        { ...liveCredential } as never,
      );

      await expect(service.validateToken(RAW)).resolves.toBe(activeUser);
    });

    it('returns null for an unknown token', async () => {
      (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue(null as never);

      await expect(service.validateToken(RAW)).resolves.toBeNull();
    });

    it('returns null for a REVOKED credential', async () => {
      (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue({
        ...liveCredential,
        revokedAt: new Date(Date.now() - 1000),
      } as never);

      await expect(service.validateToken(RAW)).resolves.toBeNull();
    });

    it('returns null for an EXPIRED credential', async () => {
      (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue({
        ...liveCredential,
        expiresAt: new Date(Date.now() - 1000),
      } as never);

      await expect(service.validateToken(RAW)).resolves.toBeNull();
    });

    it('returns null when the OWNING USER IS INACTIVE', async () => {
      // A deactivated human must not keep authenticating through a machine
      // they set up before they were deactivated.
      (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue({
        ...liveCredential,
        user: { ...activeUser, isActive: false },
      } as never);

      await expect(service.validateToken(RAW)).resolves.toBeNull();
    });

    it('does NOT stamp lastUsedAt on any rejection', async () => {
      (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue({
        ...liveCredential,
        revokedAt: new Date(),
      } as never);

      await service.validateToken(RAW);

      expect(mockPrisma.nodeCredential.update).not.toHaveBeenCalled();
    });

    it('stamps lastUsedAt on success', async () => {
      (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue(
        { ...liveCredential } as never,
      );

      await service.validateToken(RAW);

      const args = (mockPrisma.nodeCredential.update as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ id: 'cred-1' });
      expect(args.data.lastUsedAt).toBeInstanceOf(Date);
    });

    it('still authenticates when the lastUsedAt stamp REJECTS (fire-and-forget)', async () => {
      // The `.catch(() => {})` is load-bearing: a telemetry write must never
      // fail an authentication that already succeeded, and must never surface
      // as an unhandled rejection on the path every worker request takes.
      (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue(
        { ...liveCredential } as never,
      );
      (mockPrisma.nodeCredential.update as jest.Mock).mockRejectedValue(
        new Error('connection reset') as never,
      );

      await expect(service.validateToken(RAW)).resolves.toBe(activeUser);
      // Let the swallowed rejection settle; an unhandled one would fail the run.
      await new Promise((resolve) => setImmediate(resolve));
    });

    // -------------------------------------------------------------------------
    // expiresAt: null — the divergence from PersonalAccessToken
    // -------------------------------------------------------------------------

    describe('expiresAt: null authenticates indefinitely', () => {
      it('accepts a credential with no expiry, however old', async () => {
        (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue({
          ...liveCredential,
          expiresAt: null,
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
        } as never);

        await expect(service.validateToken(RAW)).resolves.toBe(activeUser);
      });

      it('still refuses it once REVOKED — revocation, not a clock, is the control', async () => {
        (mockPrisma.nodeCredential.findUnique as jest.Mock).mockResolvedValue({
          ...liveCredential,
          expiresAt: null,
          revokedAt: new Date(),
        } as never);

        await expect(service.validateToken(RAW)).resolves.toBeNull();
      });
    });
  });
});
