import request from 'supertest';

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
import { TranscriptionSettingsController } from '../../src/transcription/transcription-settings.controller';
import { TranscriptionConfigController } from '../../src/transcription/transcription-config.controller';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';

// =============================================================================
// Transcription settings integration (issue #23, epic #19)
// =============================================================================
//
// HTTP-level coverage for the four `/api/transcription-settings*` endpoints and
// the one `/api/transcription/config`, mirroring
// `push-config.integration.spec.ts`'s structure:
//
//   * RBAC asserted TWICE — once as declared metadata (drift-proof against a
//     route quietly changing its guard) and once by driving real 403s, because
//     the first proves the decorator and the second proves the guard is
//     actually mounted.
//   * The API key is walked out of every response body an admin can reach.
//   * The config endpoint is asserted reachable by a VIEWER, which is the whole
//     reason it exists separately from the settings endpoint.
//
// `CredentialsService` is overridden with a controllable stub; everything else
// — the controllers, the services, the registry, the real `AssemblyAiProvider`
// — is what `AppModule` wires, which is the same boundary a production request
// crosses.
// =============================================================================

const SETTINGS = '/api/transcription-settings';
const CONFIG = '/api/transcription/config';
const API_KEY = 'aai-integration-secret-77f1';

describe('Transcription Settings Integration', () => {
  let context: TestContext;
  let mockCredentials: {
    describe: jest.Mock;
    setSecret: jest.Mock;
    getSecret: jest.Mock;
    deleteSecret: jest.Mock;
    list: jest.Mock;
  };

  beforeAll(async () => {
    mockCredentials = {
      describe: jest.fn().mockResolvedValue(null),
      setSecret: jest.fn().mockResolvedValue(undefined),
      getSecret: jest.fn().mockResolvedValue(null),
      deleteSecret: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue([]),
    };

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: CredentialsService, useValue: mockCredentials },
      ],
    });
  }, 60000);

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

    context.prismaMock.systemSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      key: 'global',
      value: DEFAULT_SYSTEM_SETTINGS as never,
      version: 3,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      updatedByUserId: null,
      updatedByUser: null,
    } as never);
    context.prismaMock.systemSettings.update.mockResolvedValue({
      id: 'settings-1',
      key: 'global',
      value: DEFAULT_SYSTEM_SETTINGS as never,
      version: 4,
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      updatedByUserId: null,
      updatedByUser: null,
    } as never);
    context.prismaMock.auditEvent.create.mockResolvedValue({} as never);
  });

  // ==========================================================================
  // RBAC — declared metadata (drift-proof)
  // ==========================================================================

  describe('declared permission metadata', () => {
    it.each([
      ['getSettings', 'system_settings:read'],
      ['updateSettings', 'system_settings:write'],
      ['testConnection', 'system_settings:write'],
      ['removeCredential', 'system_settings:write'],
    ] as Array<[keyof TranscriptionSettingsController, string]>)(
      '%s requires exactly %s',
      (handler, permission) => {
        const target = TranscriptionSettingsController.prototype[handler];
        expect(Reflect.getMetadata(PERMISSIONS_KEY, target)).toEqual([permission]);
      },
    );

    it('the test endpoint is gated on WRITE, not read', () => {
      // It is side-effecting — it spends a request against a third party using
      // a credential — and `:read` is held by anyone who may look at settings.
      // Looking is not probing.
      expect(
        Reflect.getMetadata(
          PERMISSIONS_KEY,
          TranscriptionSettingsController.prototype.testConnection,
        ),
      ).toEqual(['system_settings:write']);
    });

    it('the config endpoint is gated on `transcripts:read`, not `system_settings:read`', () => {
      // The capability governs every account, so every account can read it —
      // and `transcripts:read` is seeded to all three roles (#24), which is
      // what keeps that true while still naming a real permission. Gating it
      // on `system_settings:read` would lock the answer away from precisely
      // the users it is about.
      expect(
        Reflect.getMetadata(
          PERMISSIONS_KEY,
          TranscriptionConfigController.prototype.getConfig,
        ),
      ).toEqual(['transcripts:read']);
    });
  });

  // ==========================================================================
  // RBAC — driven through real requests
  // ==========================================================================

  describe('RBAC', () => {
    it.each([
      ['get', SETTINGS, {}],
      ['put', SETTINGS, { enabled: true }],
      ['post', `${SETTINGS}/test`, { provider: 'assemblyai' }],
      ['delete', `${SETTINGS}/credentials/assemblyai`, {}],
    ] as Array<['get' | 'put' | 'post' | 'delete', string, Record<string, unknown>]>)(
      '%s %s: a viewer gets 403',
      async (method, path, body) => {
        const viewer = await createMockViewerUser(context);

        const req = request(context.app.getHttpServer())
          [method](path)
          .set(authHeader(viewer.accessToken));

        await (method === 'get' ? req : req.send(body)).expect(403);
      },
    );

    it('an unauthenticated caller gets 401, before any permission check', async () => {
      await request(context.app.getHttpServer()).get(SETTINGS).expect(401);
    });

    it('an admin gets 200 on the settings read', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get(SETTINGS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.settings).toBeDefined();
      expect(response.body.data.providers[0].id).toBe('assemblyai');
    });

    it('an admin gets 200 on the settings write', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ enabled: true })
        .expect(200);
    });

    it('an admin gets 204 removing a credential', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .delete(`${SETTINGS}/credentials/assemblyai`)
        .set(authHeader(admin.accessToken))
        .expect(204);

      expect(mockCredentials.deleteSecret).toHaveBeenCalledWith(
        'transcription',
        'assemblyai',
      );
    });

    it('a VIEWER can read the config endpoint — the reason it exists', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      // A fresh deployment: enabled false, no provider. Unavailable, not an
      // error — "nothing is set up" is the normal state of a new install.
      expect(response.body.data.available).toBe(false);
    });

    it('the config endpoint still requires authentication', async () => {
      await request(context.app.getHttpServer()).get(CONFIG).expect(401);
    });
  });

  // ==========================================================================
  // The API key never travels back out
  // ==========================================================================

  describe('the API key', () => {
    it('is stored through CredentialsService and absent from the PUT response', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ enabled: true, provider: 'assemblyai', apiKey: API_KEY })
        .expect(200);

      expect(mockCredentials.setSecret).toHaveBeenCalledWith(
        'transcription',
        'assemblyai',
        API_KEY,
        expect.anything(),
      );
      expect(JSON.stringify(response.body)).not.toContain(API_KEY);
    });

    it('never reaches system_settings.value', async () => {
      // The settings row is returned wholesale by `GET /api/system-settings`,
      // so a key in it is one response away from exposure. This is the
      // assertion that proves the destructure in the service actually works
      // rather than merely being written down.
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ enabled: true, provider: 'assemblyai', apiKey: API_KEY })
        .expect(200);

      for (const call of context.prismaMock.systemSettings.update.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain(API_KEY);
      }
      for (const call of context.prismaMock.systemSettings.upsert.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain(API_KEY);
      }
    });

    it('never reaches an audit_events row', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ enabled: true, provider: 'assemblyai', apiKey: API_KEY })
        .expect(200);

      expect(context.prismaMock.auditEvent.create).toHaveBeenCalled();
      for (const call of context.prismaMock.auditEvent.create.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain(API_KEY);
      }
    });

    it('is absent from the GET response even when one is stored', async () => {
      mockCredentials.describe.mockResolvedValue({
        purpose: 'transcription',
        name: 'assemblyai',
        hint: '••••77f1',
        label: 'AssemblyAI API key',
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get(SETTINGS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(API_KEY);
      expect(response.body.data.keyStatuses[0].hint).toBe('••••77f1');
      expect(mockCredentials.getSecret).not.toHaveBeenCalled();
    });

    it('is preserved, not erased, by a save that omits it', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ enabled: false })
        .expect(200);

      // BLANK PRESERVES. `setSecret` is skipped entirely rather than called
      // with a blank value, because a blank first write is a 400 in the
      // credential store — and this save has nothing to do with the key.
      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
      expect(mockCredentials.deleteSecret).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Validation
  // ==========================================================================

  describe('validation', () => {
    it('rejects an unknown provider on the settings write', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ provider: 'nonesuch' })
        .expect(400);
    });

    it('rejects a playback bitrate outside the usable range', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ playback: { bitrateKbps: 1 } })
        .expect(400);
    });

    it('400s a test with no key supplied and none stored', async () => {
      // Not a failed probe — there was nothing to probe with, and the caller
      // can fix it without the network being involved at all.
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post(`${SETTINGS}/test`)
        .set(authHeader(admin.accessToken))
        .send({ provider: 'assemblyai' })
        .expect(400);
    });

    it('accepts a partial save that changes one nested field', async () => {
      // `{ "playback": { "bitrateKbps": 96 } }` has to be a legal body, or the
      // admin page has to send the whole namespace to change one control —
      // which is the silent-no-op trap `settings-parity.spec.ts` exists for,
      // seen from the other side.
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ playback: { bitrateKbps: 96 } })
        .expect(200);

      const [[patched]] = context.prismaMock.systemSettings.update.mock.calls;
      expect((patched as any).data.value.transcription.playback.bitrateKbps).toBe(96);
    });
  });
});
