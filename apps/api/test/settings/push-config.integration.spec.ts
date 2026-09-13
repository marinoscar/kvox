import request from 'supertest';
import { JwtService } from '@nestjs/jwt';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { PushConfigController } from '../../src/notifications/push-config.controller';
import { PushConfigService } from '../../src/notifications/push-config.service';

// =============================================================================
// Push Configuration Integration (issue #355)
// =============================================================================
//
// HTTP-level coverage for the five `/api/admin/push-config*` endpoints,
// mirroring `email-settings.integration.spec.ts`'s structure and
// `db-backup-restore.integration.spec.ts`'s RBAC/confirmation-literal style:
//
//   * RBAC: `push:read` gates the GET, `push:write` gates every write —
//     asserted both as declared metadata (drift-proof against a route that
//     silently changes its guard) and by driving real 403s.
//   * The typed confirmation literals (`ROTATE`/`REMOVE`) are enforced by the
//     Zod DTO layer BEFORE the handler body runs — proven with a spy on the
//     real `PushConfigService` instance the module wires, so "nothing started"
//     is asserted at the service boundary, not just "responded 400".
//   * An end-to-end happy path: generate -> GET reflects configured -> rotate
//     -> GET reflects the new public key.
//
// `CredentialsService` is overridden with a controllable, STATEFUL stub (so
// generate/rotate/remove genuinely change what a later `describe()` call
// reports) while `PushConfigController`/`PushConfigService` are the REAL
// classes `AppModule` wires — the same boundary a production request crosses.
// =============================================================================

const BASE = '/api/admin/push-config';

describe('Push Configuration Integration', () => {
  let context: TestContext;
  let mockCredentials: {
    describe: jest.Mock;
    setSecret: jest.Mock;
    getSecret: jest.Mock;
    deleteSecret: jest.Mock;
  };

  beforeAll(async () => {
    mockCredentials = {
      describe: jest.fn().mockResolvedValue(null),
      setSecret: jest.fn().mockResolvedValue(undefined),
      getSecret: jest.fn().mockResolvedValue(null),
      deleteSecret: jest.fn().mockResolvedValue(undefined),
    };

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: CredentialsService, useValue: mockCredentials }],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    mockCredentials.describe.mockReset().mockResolvedValue(null);
    mockCredentials.setSecret.mockReset().mockResolvedValue(undefined);
    mockCredentials.getSecret.mockReset().mockResolvedValue(null);
    mockCredentials.deleteSecret.mockReset().mockResolvedValue(undefined);

    context.prismaMock.systemSettings.findUnique.mockResolvedValue(null);
    context.prismaMock.auditEvent.create.mockResolvedValue({} as never);
  });

  /** A user holding ONLY `push:read` — no write. */
  async function createPushReadOnlyUser(): Promise<{ accessToken: string; email: string }> {
    const jwtService = context.module.get<JwtService>(JwtService);
    const id = 'push-read-only-admin';
    const email = 'push-read-only-admin@example.com';

    context.prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.id !== id && where?.email !== email) return null;
      return {
        id,
        email,
        displayName: null,
        providerDisplayName: 'Push Read Only Admin',
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [
          {
            role: {
              id: 'role-push-readonly',
              name: 'push-readonly',
              description: 'Read-only push configuration access',
              rolePermissions: [
                {
                  permission: {
                    id: 'perm-push-read',
                    name: 'push:read',
                    description: 'View the Web Push (VAPID) configuration',
                  },
                },
              ],
            },
          },
        ],
      };
    });

    const accessToken = jwtService.sign({ sub: id, email, roles: ['push-readonly'] });
    return { accessToken, email };
  }

  // ==========================================================================
  // RBAC — declared metadata (drift-proof)
  // ==========================================================================

  describe('declared permission metadata', () => {
    it.each([
      ['getConfig', 'push:read'],
      ['replaceConfig', 'push:write'],
      ['generate', 'push:write'],
      ['rotate', 'push:write'],
      ['remove', 'push:write'],
    ] as Array<[keyof PushConfigController, string]>)(
      '%s requires exactly %s',
      (handler, permission) => {
        const target = PushConfigController.prototype[handler];
        expect(Reflect.getMetadata(PERMISSIONS_KEY, target)).toEqual([permission]);
      },
    );
  });

  // ==========================================================================
  // RBAC — driven through real requests
  // ==========================================================================

  describe('RBAC: a caller lacking the required permission is refused with 403', () => {
    it.each([
      ['GET', BASE, {}],
      ['PUT', BASE, { enabled: false, subject: null }],
      ['POST', `${BASE}/generate`, {}],
      ['POST', `${BASE}/rotate`, { confirmation: 'ROTATE' }],
      ['DELETE', BASE, { confirmation: 'REMOVE' }],
    ] as Array<['GET' | 'PUT' | 'POST' | 'DELETE', string, Record<string, unknown>]>)(
      '%s %s: a viewer (no push permission at all) gets 403',
      async (method, path, body) => {
        const viewer = await createMockViewerUser(context);

        const req = request(context.app.getHttpServer())[
          method.toLowerCase() as 'get' | 'put' | 'post' | 'delete'
        ](path).set(authHeader(viewer.accessToken));

        await (method === 'GET' ? req : req.send(body)).expect(403);
      },
    );

    it.each([
      ['PUT', BASE, { enabled: false, subject: null }],
      ['POST', `${BASE}/generate`, {}],
      ['POST', `${BASE}/rotate`, { confirmation: 'ROTATE' }],
      ['DELETE', BASE, { confirmation: 'REMOVE' }],
    ] as Array<['PUT' | 'POST' | 'DELETE', string, Record<string, unknown>]>)(
      '%s %s: an admin holding ONLY push:read gets 403 — push:read does not imply push:write',
      async (method, path, body) => {
        const readOnly = await createPushReadOnlyUser();

        await request(context.app.getHttpServer())
          [method.toLowerCase() as 'put' | 'post' | 'delete'](path)
          .set(authHeader(readOnly.accessToken))
          .send(body)
          .expect(403);
      },
    );

    it('GET succeeds for a caller holding only push:read', async () => {
      const readOnly = await createPushReadOnlyUser();

      await request(context.app.getHttpServer())
        .get(BASE)
        .set(authHeader(readOnly.accessToken))
        .expect(200);
    });

    it('returns 401 without auth on every endpoint', async () => {
      const server = context.app.getHttpServer();
      await request(server).get(BASE).expect(401);
      await request(server).put(BASE).send({ enabled: false, subject: null }).expect(401);
      await request(server).post(`${BASE}/generate`).send({}).expect(401);
      await request(server).post(`${BASE}/rotate`).send({ confirmation: 'ROTATE' }).expect(401);
      await request(server).delete(BASE).send({ confirmation: 'REMOVE' }).expect(401);
    });
  });

  // ==========================================================================
  // The typed confirmation literals — enforced BEFORE the service is touched
  // ==========================================================================

  describe('rotate/remove confirmation literals are enforced at the DTO layer', () => {
    const ROTATE_BAD_BODIES: Array<[string, Record<string, unknown>]> = [
      ['no body at all', {}],
      ['a boolean confirm flag', { confirm: true }],
      ['a lower-case word', { confirmation: 'rotate' }],
      ['a misspelt word', { confirmation: 'ROTATTE' }],
      ['the empty string', { confirmation: '' }],
      ["the OTHER route's word", { confirmation: 'REMOVE' }],
    ];

    it.each(ROTATE_BAD_BODIES)(
      'POST /rotate 400s on %s, and PushConfigService.rotate is NEVER CALLED',
      async (_label, body) => {
        const admin = await createMockAdminUser(context);
        const pushConfigService = context.module.get<PushConfigService>(PushConfigService);
        const rotateSpy = jest.spyOn(pushConfigService, 'rotate');

        await request(context.app.getHttpServer())
          .post(`${BASE}/rotate`)
          .set(authHeader(admin.accessToken))
          .send(body)
          .expect(400);

        expect(rotateSpy).not.toHaveBeenCalled();
        rotateSpy.mockRestore();
      },
    );

    const REMOVE_BAD_BODIES: Array<[string, Record<string, unknown>]> = [
      ['no body at all', {}],
      ['a boolean confirm flag', { confirm: true }],
      ['a lower-case word', { confirmation: 'remove' }],
      ["the OTHER route's word", { confirmation: 'ROTATE' }],
    ];

    it.each(REMOVE_BAD_BODIES)(
      'DELETE 400s on %s, and PushConfigService.remove is NEVER CALLED',
      async (_label, body) => {
        const admin = await createMockAdminUser(context);
        const pushConfigService = context.module.get<PushConfigService>(PushConfigService);
        const removeSpy = jest.spyOn(pushConfigService, 'remove');

        await request(context.app.getHttpServer())
          .delete(BASE)
          .set(authHeader(admin.accessToken))
          .send(body)
          .expect(400);

        expect(removeSpy).not.toHaveBeenCalled();
        removeSpy.mockRestore();
      },
    );

    it('a body carrying the RIGHT literal for rotate DOES reach the service', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        value: { enabled: true, publicKey: 'existing-public-key', subject: null },
      });
      mockCredentials.describe.mockResolvedValue({
        purpose: 'push_vapid',
        name: 'default',
        hint: '••••abcd',
        label: 'Web Push VAPID private key',
        updatedByUserId: admin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      context.prismaMock.systemSettings.upsert.mockImplementation(async ({ create, update }: any) => ({
        id: 'settings-webPush',
        key: 'webPush',
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
        value: create?.value ?? update?.value,
      }));

      const pushConfigService = context.module.get<PushConfigService>(PushConfigService);
      const rotateSpy = jest.spyOn(pushConfigService, 'rotate');

      await request(context.app.getHttpServer())
        .post(`${BASE}/rotate`)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'ROTATE' })
        .expect(200);

      expect(rotateSpy).toHaveBeenCalledTimes(1);
      rotateSpy.mockRestore();
    });
  });

  // ==========================================================================
  // The private key never appears anywhere in a serialised response
  // ==========================================================================

  describe('the private key never appears in any response', () => {
    it('GET never contains a known plaintext-shaped value', async () => {
      const admin = await createMockAdminUser(context);
      const knownPlaintext = 'do-not-leak-this-vapid-private-key-Xk9!q2';
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        version: 1,
        updatedAt: new Date(),
        updatedByUser: { id: admin.id, email: admin.email },
        value: { enabled: true, publicKey: 'a-public-key', subject: null },
      });
      mockCredentials.describe.mockResolvedValue({
        purpose: 'push_vapid',
        name: 'default',
        hint: '••••q2',
        label: 'Web Push VAPID private key',
        updatedByUserId: admin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .get(BASE)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(knownPlaintext);
      expect(mockCredentials.getSecret).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // End-to-end happy path: generate -> GET -> rotate -> GET
  // ==========================================================================

  describe('end-to-end: generate -> GET reflects configured -> rotate -> GET reflects a changed key', () => {
    it('walks the full lifecycle against the real controller and service', async () => {
      const admin = await createMockAdminUser(context);
      const server = context.app.getHttpServer();

      // A tiny in-memory `system_settings` row and credential-store flag,
      // stateful ACROSS requests within this one test — the whole point of
      // this suite's end-to-end case.
      let storedRow: { version: number; value: Record<string, unknown> } | null = null;
      let credentialConfigured = false;

      context.prismaMock.systemSettings.findUnique.mockImplementation(async () =>
        storedRow
          ? {
              version: storedRow.version,
              value: storedRow.value,
              updatedAt: new Date(),
              updatedByUser: { id: admin.id, email: admin.email },
            }
          : null,
      );
      context.prismaMock.systemSettings.upsert.mockImplementation(async ({ create, update }: any) => {
        const nextVersion = storedRow ? storedRow.version + 1 : 1;
        const value = storedRow ? (update?.value ?? storedRow.value) : create?.value;
        storedRow = { version: nextVersion, value };
        return {
          id: 'settings-webPush',
          key: 'webPush',
          version: nextVersion,
          updatedAt: new Date(),
          updatedByUserId: admin.id,
          updatedByUser: { id: admin.id, email: admin.email },
          value,
        };
      });
      mockCredentials.setSecret.mockImplementation(async () => {
        credentialConfigured = true;
      });
      mockCredentials.describe.mockImplementation(async () =>
        credentialConfigured
          ? {
              purpose: 'push_vapid',
              name: 'default',
              hint: '••••abcd',
              label: 'Web Push VAPID private key',
              updatedByUserId: admin.id,
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null,
      );

      // 1. Nothing configured yet.
      const beforeGenerate = await request(server)
        .get(BASE)
        .set(authHeader(admin.accessToken))
        .expect(200);
      expect(beforeGenerate.body.data.configured).toBe(false);

      // 2. generate -> configured, enabled, a real public key.
      const generated = await request(server)
        .post(`${BASE}/generate`)
        .set(authHeader(admin.accessToken))
        .send({ subject: 'mailto:ops@example.com' })
        .expect(200);
      expect(generated.body.data.configured).toBe(true);
      expect(generated.body.data.enabled).toBe(true);
      expect(typeof generated.body.data.publicKey).toBe('string');
      const firstPublicKey: string = generated.body.data.publicKey;

      // 3. GET reflects it.
      const afterGenerate = await request(server)
        .get(BASE)
        .set(authHeader(admin.accessToken))
        .expect(200);
      expect(afterGenerate.body.data.configured).toBe(true);
      expect(afterGenerate.body.data.publicKey).toBe(firstPublicKey);

      // 4. rotate -> a DIFFERENT public key.
      const rotated = await request(server)
        .post(`${BASE}/rotate`)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'ROTATE' })
        .expect(200);
      expect(rotated.body.data.configured).toBe(true);
      expect(typeof rotated.body.data.publicKey).toBe('string');
      expect(rotated.body.data.publicKey).not.toBe(firstPublicKey);

      // 5. GET reflects the ROTATED key, not the original one.
      const afterRotate = await request(server)
        .get(BASE)
        .set(authHeader(admin.accessToken))
        .expect(200);
      expect(afterRotate.body.data.publicKey).toBe(rotated.body.data.publicKey);
      expect(afterRotate.body.data.publicKey).not.toBe(firstPublicKey);
    });
  });
});
