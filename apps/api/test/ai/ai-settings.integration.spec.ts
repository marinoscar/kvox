import { Logger } from '@nestjs/common';
import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { OPENAI_FETCH } from '../../src/ai/providers/openai.provider';

// =============================================================================
// AI policy and capability probe over the wire (issue #47, epic #45)
// =============================================================================
//
// The two ends of the same feature, and the gap between them is the point:
//
//   * `/api/ai-settings` is gated on `system_settings:read`/`:write`, which
//     only Admin holds — docs/specs/notes.md §6.4's decision.
//   * `GET /api/ai/config` is gated on `notes:read`, which is seeded to ALL
//     THREE ROLES, so the users the capability governs can actually read it.
//     That is the whole argument for it existing as a separate route rather
//     than being folded into the settings endpoint.
//
// And `keyConfigured` — the single boolean the entire web UI gates on — must be
// **false before a key is saved** and must describe the CALLER rather than the
// deployment.
// =============================================================================

// `secret-cipher.ts` caches its master key at module scope on first use
// (`GET /api/ai-settings/models` decrypts the calling administrator's own
// credential), so this must be set before the first encrypt/decrypt in this
// file — never at import time, since that happens inside a request. Restored
// below so it cannot leak into another spec sharing this worker. Mirrors
// `ai-credentials.integration.spec.ts` exactly.
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const ORIGINAL_KEY_ENV = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

afterAll(() => {
  if (ORIGINAL_KEY_ENV === undefined) {
    delete process.env.SECRETS_ENCRYPTION_KEY;
  } else {
    process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
  }
});

const SETTINGS = '/api/ai-settings';
const CONFIG = '/api/ai/config';

const storedSettings = (aiOverrides: Record<string, unknown> = {}) => ({
  key: 'global',
  value: {
    ...DEFAULT_SYSTEM_SETTINGS,
    ai: { ...DEFAULT_SYSTEM_SETTINGS.ai, ...aiOverrides },
  },
  version: 7,
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedByUser: { id: 'admin-1', email: 'admin@example.test' },
});

const ENABLED = {
  enabled: true,
  providers: {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      allowedModels: ['gpt-4o', 'gpt-4o-mini'],
      defaultModel: 'gpt-4o',
    },
  },
};

describe('AI settings and config integration', () => {
  let context: TestContext;
  /** Replaces the outbound `fetch` the reachability probe uses. */
  let openAiFetch: jest.Mock;

  beforeAll(async () => {
    openAiFetch = jest.fn();

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: OPENAI_FETCH,
          useValue: (url: string, init?: unknown) => openAiFetch(url, init),
        },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    prismaMock.auditEvent.create.mockResolvedValue({} as never);
    prismaMock.systemSettings.findUnique.mockResolvedValue(storedSettings() as never);
    prismaMock.userAiCredential.findUnique.mockResolvedValue(null as never);
  });

  // ==========================================================================
  // GET /api/ai-settings
  // ==========================================================================

  describe('GET /api/ai-settings', () => {
    it('returns the policy and the provider catalogue to an Admin', async () => {
      const admin = await createMockAdminUser(context);

      const res = await request(context.app.getHttpServer())
        .get(SETTINGS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(res.body.data.settings).toMatchObject({
        enabled: false,
        providers: { openai: { baseUrl: 'https://api.openai.com/v1' } },
      });
      expect(res.body.data.providers[0]).toMatchObject({
        id: 'openai',
        label: 'OpenAI',
        capabilities: { streaming: true },
      });
      expect(res.body.data.version).toBe(7);
    });

    it('carries no field able to hold an API key — there is no deployment key at all', async () => {
      const admin = await createMockAdminUser(context);

      const res = await request(context.app.getHttpServer())
        .get(SETTINGS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      // Unlike `GET /api/transcription-settings`, there is not even a masked
      // `keyStatuses` array here: this deployment stores no AI key. Asserted
      // over the serialized body so a field added later is caught too.
      expect(res.text).not.toMatch(/apiKey|keyStatuses|"secret"/);
    });

    it('reports a permitted model this build cannot budget as unknownModels', async () => {
      const admin = await createMockAdminUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({
          ...ENABLED,
          providers: {
            openai: {
              ...ENABLED.providers.openai,
              allowedModels: ['gpt-4o', 'gpt-9-imaginary'],
            },
          },
        }) as never,
      );

      const res = await request(context.app.getHttpServer())
        .get(SETTINGS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      // Otherwise the mistyped id is saved, listed back, and quietly never
      // offered to anyone, with nothing anywhere to explain why.
      expect(res.body.data.unknownModels).toEqual(['gpt-9-imaginary']);
    });

    it('is 403 for a Contributor and a Viewer', async () => {
      const contributor = await createMockContributorUser(context);
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get(SETTINGS)
        .set(authHeader(contributor.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .get(SETTINGS)
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });
  });

  // ==========================================================================
  // PUT /api/ai-settings
  // ==========================================================================

  describe('PUT /api/ai-settings', () => {
    beforeEach(() => {
      prismaMock.systemSettings.update.mockResolvedValue({
        ...storedSettings(),
        id: 'settings-1',
      } as never);
    });

    it('patches the namespace and is NOT a silent no-op', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ enabled: true, maxOutputTokens: 8192 })
        .expect(200);

      // ⚠ THE ASSERTION THE SIX-EDIT RULE EXISTS FOR. If `ai` were missing from
      // either wire DTO, this body would parse to `{}`, nothing would be
      // merged, and the endpoint would return 200 having stored nothing — with
      // no error, no log line and no audit entry to show for it.
      const written = prismaMock.systemSettings.update.mock.calls[0][0].data.value;
      expect(written.ai).toMatchObject({ enabled: true, maxOutputTokens: 8192 });
      // And the fields the caller did not send survive untouched.
      expect(written.ai.providers.openai.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('replaces allowedModels wholesale rather than merging', async () => {
      const admin = await createMockAdminUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings(ENABLED) as never,
      );

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ providers: { openai: { allowedModels: ['gpt-4o-mini'] } } })
        .expect(200);

      // A merging list could never express "stop permitting gpt-4o", so
      // unchecking it on the admin page would be a no-op.
      //
      // ⚠ STORED AS AN OBJECT even though a bare id was sent (#78): the schema
      // normalises both accepted forms on the way in, so every reader
      // downstream sees one shape. The bare-string form on the WIRE is
      // permanent — every pre-#78 row contains it — and this assertion is what
      // pins the normalisation rather than the wire format.
      const written = prismaMock.systemSettings.update.mock.calls[0][0].data.value;
      expect(written.ai.providers.openai.allowedModels).toEqual([
        { id: 'gpt-4o-mini' },
      ]);
    });

    it('rejects a model id no registered provider declares', async () => {
      const admin = await createMockAdminUser(context);

      const res = await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ providers: { openai: { allowedModels: ['gpt-9-imaginary'] } } })
        .expect(400);

      expect(res.text).toContain('gpt-9-imaginary');
      expect(prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    // ==========================================================================
    // #78: an entry carrying its own numbers is a DIFFERENT thing from a
    // mistyped id. Only a resolution to NOTHING is a 400.
    // ==========================================================================

    it('SAVES an entry the build catalogue has never heard of, when it carries its own numbers', async () => {
      // This is the whole point of #78: a deployment can permit a model no
      // release of this application knows about, without waiting for one.
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({
          providers: {
            openai: {
              allowedModels: [
                {
                  id: 'gpt-6-turbo',
                  contextWindowTokens: 500_000,
                  maxOutputTokens: 64_000,
                },
              ],
            },
          },
        })
        .expect(200);

      const written = prismaMock.systemSettings.update.mock.calls[0][0].data.value;
      expect(written.ai.providers.openai.allowedModels).toEqual([
        {
          id: 'gpt-6-turbo',
          contextWindowTokens: 500_000,
          maxOutputTokens: 64_000,
        },
      ]);
    });

    it('rejects an entry with NEITHER its own numbers nor a catalogue descriptor, naming the missing fields', async () => {
      const admin = await createMockAdminUser(context);

      const res = await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({
          providers: {
            openai: { allowedModels: [{ id: 'gpt-9-imaginary' }] },
          },
        })
        .expect(400);

      // Worded as "supply the numbers", not "this model is forbidden" — see
      // `AiSettingsService.update`'s own comment on why.
      expect(res.text).toContain('gpt-9-imaginary');
      expect(res.text).toContain('contextWindowTokens');
      expect(res.text).toContain('maxOutputTokens');
      expect(prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('SAVES a partial entry once the catalogue supplies the field it is missing', async () => {
      // `gpt-4o` is in the build catalogue with both numbers; overriding only
      // `contextWindowTokens` still resolves, because the catalogue fills in
      // `maxOutputTokens`.
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({
          providers: {
            openai: {
              allowedModels: [{ id: 'gpt-4o', contextWindowTokens: 300_000 }],
            },
          },
        })
        .expect(200);

      expect(prismaMock.systemSettings.update).toHaveBeenCalled();
    });

    // ==========================================================================
    // The six-edit path, end to end: a PATCH-shaped body naming ONLY `provider`
    // must actually persist — the failure mode `settings-parity.spec.ts` calls
    // the nastiest of the six is a silent 200 no-op.
    // ==========================================================================

    it('persists a body naming ONLY `provider`, leaving every other field untouched', async () => {
      const admin = await createMockAdminUser(context);
      // Starts at `null` specifically so the PATCH below produces an
      // OBSERVABLE change rather than re-asserting the schema's own default.
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({ ...ENABLED, provider: null }) as never,
      );

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ provider: 'openai' })
        .expect(200);

      // ⚠ THE ASSERTION THE SIX-EDIT RULE EXISTS FOR, applied to `provider`
      // specifically: if either wire DTO were missing this field, the body
      // would parse with `provider` stripped, nothing would be merged, and the
      // endpoint would return 200 having stored the stale `null` — with no
      // error, no log line and no audit entry to show for it.
      const written = prismaMock.systemSettings.update.mock.calls[0][0].data.value;
      expect(written.ai.provider).toBe('openai');
      // Nothing else in the namespace was named by this request, and none of
      // it may be lost.
      expect(written.ai.enabled).toBe(ENABLED.enabled);
      expect(written.ai.providers.openai.allowedModels).toEqual(
        ENABLED.providers.openai.allowedModels.map((id) => ({ id })),
      );
    });

    it('an explicit `provider: null` clears the active provider — distinct from omitting it entirely', async () => {
      const admin = await createMockAdminUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings(ENABLED) as never,
      );

      // Omitting `provider` leaves the stored one untouched.
      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ maxOutputTokens: 4096 })
        .expect(200);

      const unchanged = prismaMock.systemSettings.update.mock.calls[0][0].data.value;
      expect(unchanged.ai.provider).toBe('openai');

      // An EXPLICIT `null` is a value — "no provider is active" — and must
      // not be swallowed by a `??` merge, the exact `maintenance.startedAt`
      // trap the schema's own comments warn about.
      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ provider: null })
        .expect(200);

      const cleared = prismaMock.systemSettings.update.mock.calls[1][0].data.value;
      expect(cleared.ai.provider).toBeNull();
    });

    it('audits the policy change', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ enabled: true })
        .expect(200);

      const actions = prismaMock.auditEvent.create.mock.calls.map(
        (call: [{ data: { action: string } }]) => call[0].data.action,
      );

      // Both: the row's own `system_settings:patch` from `patchSettings`, and
      // this module's `ai_settings:update`, which is what makes "who changed
      // the AI policy" answerable without reading the whole settings trail.
      expect(actions).toContain('ai_settings:update');
      const own = prismaMock.auditEvent.create.mock.calls.find(
        (call: [{ data: { action: string } }]) =>
          call[0].data.action === 'ai_settings:update',
      );
      expect(own[0].data.targetType).toBe('system_settings');
      expect(own[0].data.targetId).toBe('ai');
    });

    it('rejects an out-of-range ceiling at the wire schema', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ maxOutputTokens: 0 })
        .expect(400);
    });

    it('is 403 for a Viewer', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(viewer.accessToken))
        .send({ enabled: true })
        .expect(403);
    });
  });

  // ==========================================================================
  // POST /api/ai-settings/test
  // ==========================================================================

  describe('POST /api/ai-settings/test', () => {
    it('treats a 401 from the endpoint as SUCCESS', async () => {
      const admin = await createMockAdminUser(context);
      openAiFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({}),
      });

      const res = await request(context.app.getHttpServer())
        .post(`${SETTINGS}/test`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      // ⚠ THE ONE CONTRACT THAT LOOKS WRONG AND IS NOT. This is a REACHABILITY
      // probe with no credential — there is no deployment key to send — so an
      // unauthenticated request to a correctly configured API root is SUPPOSED
      // to be refused, and that refusal is the proof it exists and speaks the
      // protocol. Reporting it as a failure would make a correctly configured
      // deployment look broken.
      expect(res.body.data.ok).toBe(true);
      expect(res.body.data.detail).toMatch(/demanded authentication/i);
    });

    it('sends NO authorization header — that absence is what makes the 401 meaningful', async () => {
      const admin = await createMockAdminUser(context);
      openAiFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({}),
      });

      await request(context.app.getHttpServer())
        .post(`${SETTINGS}/test`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      expect(openAiFetch.mock.calls[0][1].headers).toBeUndefined();
    });

    it('probes a supplied baseUrl before it has been saved', async () => {
      const admin = await createMockAdminUser(context);
      openAiFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({}),
      });

      await request(context.app.getHttpServer())
        .post(`${SETTINGS}/test`)
        .set(authHeader(admin.accessToken))
        .send({ baseUrl: 'https://gateway.internal/v1/' })
        .expect(200);

      // Trailing slash normalised, so an operator's paste does not produce a
      // double slash and a confusing 404.
      expect(openAiFetch.mock.calls[0][0]).toBe('https://gateway.internal/v1/models');
      expect(prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('reports 200 with ok: false for an unreachable endpoint, not a 5xx', async () => {
      const admin = await createMockAdminUser(context);
      openAiFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND gateway.internal'));

      const res = await request(context.app.getHttpServer())
        .post(`${SETTINGS}/test`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      expect(res.body.data.ok).toBe(false);
      expect(res.body.data.detail).toMatch(/DNS, TLS, firewall or typo/i);
    });

    it('audits the probe', async () => {
      const admin = await createMockAdminUser(context);
      openAiFetch.mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({}),
      });

      await request(context.app.getHttpServer())
        .post(`${SETTINGS}/test`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      const audit = prismaMock.auditEvent.create.mock.calls[0][0].data;
      expect(audit.action).toBe('ai_settings:test');
      expect(audit.meta).toMatchObject({ ok: false, usedSuppliedBaseUrl: false });
    });

    it('is 403 for a Contributor — probing is a write, looking is not', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post(`${SETTINGS}/test`)
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(403);
    });
  });

  // ==========================================================================
  // GET /api/ai-settings/models (#78)
  //
  // The 400-for-a-non-discovering-provider outcome is deliberately NOT driven
  // here: it would require registering a second, fake provider into this
  // suite's real (shared, singleton) `AiProviderRegistry`, which would leak
  // into every other test in this file that runs after it. It is covered at
  // the unit level instead, in `ai-model-discovery.service.spec.ts`, against
  // an isolated stub registry built fresh per test.
  // ==========================================================================

  describe('GET /api/ai-settings/models', () => {
    const MODELS = `${SETTINGS}/models`;
    /** A key with an obvious, greppable shape. Never a real one. */
    const RAW_KEY = 'sk-proj-DISCOVERY-INTEGRATION-abcd1234';

    beforeEach(() => {
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings(ENABLED) as never,
      );
    });

    async function withStoredKey() {
      const { encryptSecret } = await import(
        '../../src/common/crypto/secret-cipher'
      );
      prismaMock.userAiCredential.findUnique.mockResolvedValue({
        secret: encryptSecret(RAW_KEY, 'ai-key'),
      } as never);
    }

    it('lists the models the CALLING administrator\'s own key can reach', async () => {
      const admin = await createMockAdminUser(context);
      await withStoredKey();
      openAiFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({
          data: [{ id: 'gpt-4o' }, { id: 'gpt-5-preview' }],
        }),
      });

      const res = await request(context.app.getHttpServer())
        .get(MODELS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(res.body.data.ok).toBe(true);
      expect(res.body.data.models).toEqual([
        expect.objectContaining({ id: 'gpt-4o', known: true }),
        expect.objectContaining({
          id: 'gpt-5-preview',
          known: false,
          contextWindowTokens: null,
          maxOutputTokens: null,
        }),
      ]);
    });

    it("resolves the credential scoped by THIS caller's own id, and sends it as the bearer token", async () => {
      const admin = await createMockAdminUser(context);
      await withStoredKey();
      openAiFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({ data: [] }),
      });

      await request(context.app.getHttpServer())
        .get(MODELS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      const where = prismaMock.userAiCredential.findUnique.mock.calls[0][0].where;
      expect(where.userId_provider).toEqual({ userId: admin.id, provider: 'openai' });
      expect(openAiFetch.mock.calls[0][1].headers.authorization).toBe(
        `Bearer ${RAW_KEY}`,
      );
    });

    it('answers 200 with ok:false for a vendor refusal — never a 4xx or 5xx', async () => {
      const admin = await createMockAdminUser(context);
      await withStoredKey();
      openAiFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => '{"error":{"message":"Incorrect API key"}}',
        json: async () => ({}),
      });

      const res = await request(context.app.getHttpServer())
        .get(MODELS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(res.body.data.ok).toBe(false);
      expect(res.body.data.models).toEqual([]);
      expect(res.text).not.toContain(RAW_KEY);
    });

    it('409s with details.reason: ai_key_missing when the caller has saved no key of their own', async () => {
      const admin = await createMockAdminUser(context);
      prismaMock.userAiCredential.findUnique.mockResolvedValue(null as never);

      const res = await request(context.app.getHttpServer())
        .get(MODELS)
        .set(authHeader(admin.accessToken))
        .expect(409);

      expect(res.body.details.reason).toBe('ai_key_missing');
      // Not a diagnosis — nothing was spent, because there was no key to spend.
      expect(openAiFetch).not.toHaveBeenCalled();
    });

    it('400s for a provider this build does not implement', async () => {
      const admin = await createMockAdminUser(context);

      const res = await request(context.app.getHttpServer())
        .get(`${MODELS}?provider=azure-openai`)
        .set(authHeader(admin.accessToken))
        .expect(400);

      expect(res.text).toMatch(/Unknown AI provider/i);
      expect(openAiFetch).not.toHaveBeenCalled();
    });

    it('never leaks the key into the response body, the audit row, or a log call', async () => {
      const admin = await createMockAdminUser(context);
      await withStoredKey();
      // A REALISTIC refusal (a wrong key, HTTP 401) — `assertOk` answers this
      // one with a hand-written, key-free sentence, never the raw response
      // body. (A vendor's error BODY happening to echo a submitted key back is
      // a separate, already-documented and already-accepted edge case — see
      // `OpenAiProvider.testConnection`'s own "never puts the key in the
      // reported detail, whatever happened" spec, which asserts the opposite
      // for exactly that scenario. This test is about the ordinary path.)
      openAiFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => '{"error":{"message":"Incorrect API key provided"}}',
        json: async () => ({}),
      });

      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const debugSpy = jest
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => undefined);
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        const res = await request(context.app.getHttpServer())
          .get(MODELS)
          .set(authHeader(admin.accessToken))
          .expect(200);

        expect(res.text).not.toContain(RAW_KEY);

        const audit = prismaMock.auditEvent.create.mock.calls.find(
          (call: [{ data: { action: string } }]) =>
            call[0].data.action === 'ai_settings:discover_models',
        );
        expect(JSON.stringify(audit?.[0].data.meta)).not.toContain(RAW_KEY);

        for (const spy of [logSpy, debugSpy, warnSpy, errorSpy]) {
          for (const call of spy.mock.calls) {
            expect(JSON.stringify(call)).not.toContain(RAW_KEY);
          }
        }
      } finally {
        logSpy.mockRestore();
        debugSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('is 403 for a Contributor — this spends a real vendor call on the caller\'s own key', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .get(MODELS)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });

    it('is 403 for a Viewer too', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get(MODELS)
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });
  });

  // ==========================================================================
  // GET /api/ai/config
  // ==========================================================================

  describe('GET /api/ai/config', () => {
    it('IS REACHABLE BY A VIEWER and reports keyConfigured: false before a key is saved', async () => {
      const viewer = await createMockViewerUser(context);

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      // ⚠ The acceptance criterion, stated directly. `notes:read` is seeded to
      // all three roles precisely so this route names a real permission without
      // becoming Admin-only — a Viewer is this application's DEFAULT role, so a
      // probe a Viewer cannot read is a probe almost nobody can read.
      expect(res.body.data.keyConfigured).toBe(false);
    });

    it('is reachable by a Contributor and an Admin too', async () => {
      for (const user of [
        await createMockContributorUser(context),
        await createMockAdminUser(context),
      ]) {
        await request(context.app.getHttpServer())
          .get(CONFIG)
          .set(authHeader(user.accessToken))
          .expect(200);
      }
    });

    it('reports keyConfigured: true once the caller has a row — without decrypting it', async () => {
      const viewer = await createMockViewerUser(context);
      prismaMock.userAiCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
      } as never);

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data.keyConfigured).toBe(true);

      // ⚠ `select: { id: true }`. A path that decrypts a credential to answer a
      // capability question is a path one careless `return` away from
      // publishing it.
      const query = prismaMock.userAiCredential.findUnique.mock.calls[0][0];
      expect(query.select).toEqual({ id: true });
    });

    it('reports available: false on a fresh deployment, and does not create the settings row', async () => {
      const viewer = await createMockViewerUser(context);

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data).toMatchObject({
        available: false,
        models: [],
        defaultModel: null,
      });
      // Every account holding `notes:read` can reach this route; it must not
      // materialise a settings row as a side effect of loading a page.
      expect(prismaMock.systemSettings.upsert).not.toHaveBeenCalled();
      expect(prismaMock.systemSettings.create).not.toHaveBeenCalled();
    });

    it('keyConfigured is independent of available', async () => {
      const viewer = await createMockViewerUser(context);
      // AI is switched OFF for the deployment, but this user has a key.
      prismaMock.userAiCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
      } as never);

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      // Folding the two into one flag would make the UI unable to tell "your
      // administrator has not turned this on" from "you have not pasted a key".
      expect(res.body.data).toMatchObject({ available: false, keyConfigured: true });
    });

    it('publishes only permitted models this build can budget, narrowed by policy', async () => {
      const viewer = await createMockViewerUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({
          ...ENABLED,
          providers: {
            openai: {
              ...ENABLED.providers.openai,
              allowedModels: ['gpt-4o-mini', 'gpt-9-imaginary'],
              defaultModel: 'gpt-4o-mini',
            },
          },
          maxOutputTokens: 4096,
        }) as never,
      );

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data.available).toBe(true);
      expect(res.body.data.models).toEqual([
        expect.objectContaining({ id: 'gpt-4o-mini', maxOutputTokens: 4096 }),
      ]);
      expect(res.body.data.defaultModel).toBe('gpt-4o-mini');
    });

    it('falls back to the first usable model when the configured default is not permitted', async () => {
      const viewer = await createMockViewerUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({
          ...ENABLED,
          providers: {
            openai: {
              ...ENABLED.providers.openai,
              allowedModels: ['gpt-4o-mini'],
              defaultModel: 'gpt-4o',
            },
          },
        }) as never,
      );

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      // Never a model absent from `models`: that is the one value a client
      // would select and the server would then refuse.
      expect(res.body.data.defaultModel).toBe('gpt-4o-mini');
    });

    it('publishes no base URL, no timeout and nothing key-shaped', async () => {
      const viewer = await createMockViewerUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings(ENABLED) as never,
      );

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      // A capability probe hands out the CAPABILITY, not the configuration
      // behind it.
      expect(res.text).not.toContain('api.openai.com');
      expect(res.text).not.toMatch(/requestTimeoutMs|apiKey|secret/);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(context.app.getHttpServer()).get(CONFIG).expect(401);
    });
  });
});
