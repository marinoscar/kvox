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
import { AiProviderRegistry } from '../../src/ai/ai-provider.registry';
import type { AiProvider } from '../../src/ai/providers/ai-provider.interface';

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

    it('reports NOTHING as unknownModels for an id this build has merely never heard of (#97)', async () => {
      // Pre-#97 this was the refusal case: an id absent from the OpenAI
      // catalogue was unresolvable and landed in `unknownModels`. Since #97
      // it resolves at rank 3 (family derivation) or rank 4 (the provider's
      // conservative floor) — the REAL `OpenAiProvider` always declares a
      // floor, so `unknownModels` can no longer be produced by a mistyped or
      // unrecognised id against a real, registered provider. The genuinely
      // unresolvable case — a provider with NO knowledge at all — is covered
      // below in its own describe block, against a test-double provider.
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

      expect(res.body.data.unknownModels).toEqual([]);
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

    it('SAVES a model id no build catalogue entry matches, because the real provider still derives or floors it (#97)', async () => {
      // Pre-#97 this was the refusal case this test's old name described. The
      // REAL `OpenAiProvider` always declares `defaultModelLimits`, so a bare
      // id it cannot place in a family still resolves at the floor — see
      // `resolveAllowedModel`'s rank 4. The genuinely-refused case (a
      // provider with NO knowledge at all) is covered below, against a
      // test-double provider.
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ providers: { openai: { allowedModels: ['gpt-9-imaginary'] } } })
        .expect(200);

      expect(prismaMock.systemSettings.update).toHaveBeenCalled();
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

    it('SAVES an entry with neither its own numbers nor a catalogue descriptor, once the provider floor can answer (#97)', async () => {
      // Pre-#97 this was the refusal case this test's old name described:
      // an entry naming ONLY an id, with no typed numbers and no catalogue
      // hit, used to be unresolvable. The real `OpenAiProvider`'s floor
      // (`defaultModelLimits`) now answers it — the genuinely-refused case
      // (missing numbers AND no provider knowledge of any kind) is covered
      // below, against a test-double provider that declares no floor.
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({
          providers: {
            openai: { allowedModels: [{ id: 'gpt-9-imaginary' }] },
          },
        })
        .expect(200);

      expect(prismaMock.systemSettings.update).toHaveBeenCalled();
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
        expect.objectContaining({ id: 'gpt-4o', known: true, source: 'catalogue' }),
        // `gpt-5-preview` is in neither the build catalogue nor a known
        // family (#97: `deriveOpenAiModelDescriptor` needs a hyphen-boundary
        // prefix match against `gpt-4o`/`gpt-4.1`/`gpt-5.4` etc., and this id
        // matches none), so it falls through to
        // `OPENAI_DEFAULT_MODEL_LIMITS` — the provider's conservative floor
        // — rather than staying `null`.
        expect.objectContaining({
          id: 'gpt-5-preview',
          known: false,
          contextWindowTokens: 128_000,
          maxOutputTokens: 16_384,
          source: 'default',
          derivedFrom: null,
        }),
      ]);
    });

    it('includeAll=true bypasses the plausible-chat-model heuristic and returns a non-chat id (#97)', async () => {
      const admin = await createMockAdminUser(context);
      await withStoredKey();
      openAiFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({
          data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }],
        }),
      });

      // Without `includeAll`, `text-embedding-3-small` is dropped by
      // `NON_CHAT_MODEL_MARKERS` (it contains "embedding") before this
      // caller's id list is even fetched.
      const withoutIncludeAll = await request(context.app.getHttpServer())
        .get(MODELS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(
        withoutIncludeAll.body.data.models.map((m: { id: string }) => m.id),
      ).not.toContain('text-embedding-3-small');

      const withIncludeAll = await request(context.app.getHttpServer())
        .get(`${MODELS}?includeAll=true`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(withIncludeAll.body.data.ok).toBe(true);
      expect(
        withIncludeAll.body.data.models.map((m: { id: string }) => m.id),
      ).toEqual(expect.arrayContaining(['gpt-4o', 'text-embedding-3-small']));
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

    it('publishes every permitted model, narrowed by policy — including one this build has never heard of, at the provider floor (#97)', async () => {
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
        expect.objectContaining({
          id: 'gpt-4o-mini',
          maxOutputTokens: 4096,
          source: 'catalogue',
        }),
        // ⚠ SINCE #97: no longer dropped. `gpt-9-imaginary` is in neither the
        // build catalogue nor a known family, so it falls through to
        // `OPENAI_DEFAULT_MODEL_LIMITS` (128k/16.4k) — narrowed by this
        // deployment's own ceilings exactly like every other model, the same
        // way `gpt-4o-mini` above is.
        expect.objectContaining({
          id: 'gpt-9-imaginary',
          contextWindowTokens: 100_000 + 4_096, // maxInputTokens + maxOutputTokens narrows the 128k floor
          maxOutputTokens: 4_096,
          source: 'default',
          derivedFrom: null,
        }),
      ]);
      expect(res.body.data.defaultModel).toBe('gpt-4o-mini');
    });

    it("publishes a dated snapshot at its family's FULL window, with source: 'derived' and derivedFrom naming the family (#97)", async () => {
      const viewer = await createMockViewerUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({
          ...ENABLED,
          providers: {
            openai: {
              ...ENABLED.providers.openai,
              allowedModels: ['gpt-5.4-mini-2026-03-17'],
              defaultModel: 'gpt-5.4-mini-2026-03-17',
            },
          },
          // Large enough that this deployment's own ceilings are not what is
          // being asserted here — the point of this test is the FAMILY's
          // numbers, not policy narrowing (which the test above already
          // covers).
          maxInputTokens: 2_000_000,
          maxOutputTokens: 200_000,
        }) as never,
      );

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      // `gpt-5.4-mini-2026-03-17` is a dated snapshot of `gpt-5.4-mini`
      // (400k context / 128k output, per `MODELS` in `openai.provider.ts`).
      // `deriveOpenAiModelDescriptor` strips the trailing date and takes the
      // FAMILY's FULL window, never a reduced one.
      expect(res.body.data.models).toEqual([
        expect.objectContaining({
          id: 'gpt-5.4-mini-2026-03-17',
          contextWindowTokens: 400_000,
          maxOutputTokens: 128_000,
          source: 'derived',
          derivedFrom: 'gpt-5.4-mini',
        }),
      ]);
    });

    it("an entry's own typed numbers outrank BOTH the family derivation and the provider floor (#97 rank 1)", async () => {
      const viewer = await createMockViewerUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({
          ...ENABLED,
          providers: {
            openai: {
              ...ENABLED.providers.openai,
              allowedModels: [
                // The identical id the previous test derives to 400k/128k —
                // an administrator who typed different numbers for THIS
                // exact id knows more about it than the family derivation
                // assumes, and rank 1 must still win.
                {
                  id: 'gpt-5.4-mini-2026-03-17',
                  contextWindowTokens: 9_000,
                  maxOutputTokens: 2_000,
                },
              ],
              defaultModel: 'gpt-5.4-mini-2026-03-17',
            },
          },
          maxInputTokens: 2_000_000,
          maxOutputTokens: 200_000,
        }) as never,
      );

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data.models).toEqual([
        expect.objectContaining({
          id: 'gpt-5.4-mini-2026-03-17',
          contextWindowTokens: 9_000,
          maxOutputTokens: 2_000,
          source: 'explicit',
          derivedFrom: null,
        }),
      ]);
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

// =============================================================================
// The genuinely-unresolvable case (#97 rank 5): a provider with NO knowledge
// at all
// =============================================================================
//
// Every refusal test above this point was rewritten rather than deleted,
// because `unknownModels` and the 400 on `PUT /api/ai-settings` both still
// exist and are both still reachable — see `ai-model-resolution.ts`'s header,
// rank 5. What changed is WHAT can trigger them: the real, registered
// `OpenAiProvider` always declares `capabilities.defaultModelLimits` (its
// conservative floor), so as of #97 it can resolve ANY id at all. The only
// way left to reach "this deployment cannot budget for this model" is a
// provider that supplies no catalogue hit, no family derivation AND no floor
// — which no real provider in this build is, by design.
//
// So this block runs against a SEPARATE app instance with its own
// `AiProviderRegistry`, into which a test-double "OpenAI" provider is
// registered — one that declares a (non-empty, but otherwise irrelevant)
// catalogue, no `deriveModelDescriptor`, and no `defaultModelLimits`. A
// SEPARATE instance is required, not a mutation of the shared one `context`
// above uses: `GET /api/ai-settings/models`'s own describe block already
// documents why registering a second provider into the suite's shared,
// singleton registry would leak into every test that runs after it in this
// file. Building a fresh `createTestApp()` and overwriting `'openai'`'s
// registration only in THIS app's own registry (registrations are per Nest
// module instance) keeps the leak from ever happening rather than merely
// cleaning up after it.
//
// `AiProviderRegistry.register` requires a NON-EMPTY `capabilities.models`
// (an empty catalogue is refused at registration — see its own comment), so
// "no catalogue knowledge" is expressed here as one entry whose id never
// matches anything these tests submit, rather than as `models: []`.
// =============================================================================

describe('AI policy resolution when the active provider has no knowledge of a model at all (#97 rank 5)', () => {
  let noKnowledgeContext: TestContext;

  /** An id no test below ever names, so it never produces a catalogue hit. */
  const UNRELATED_FIXTURE_MODEL_ID = '__unrelated_fixture_model_97__';

  function knowledgeLessOpenAiProvider(): AiProvider<never> {
    return {
      id: 'openai',
      label: 'OpenAI (test double — declares no model knowledge, #97 rank 5)',
      capabilities: {
        // Non-empty to satisfy `AiProviderRegistry.register`, but its one
        // entry never matches an id these tests submit — see the file
        // header for why this stands in for "no catalogue".
        models: [
          {
            id: UNRELATED_FIXTURE_MODEL_ID,
            label: 'Unrelated fixture model',
            contextWindowTokens: 1,
            maxOutputTokens: 1,
          },
        ],
        streaming: true,
        modelDiscovery: false,
        // No `defaultModelLimits` — declines to have a floor (rank 4
        // absent, exactly the posture `AiProviderCapabilities.defaultModelLimits`'s
        // own doc comment describes as legitimate).
      },
      settingsSchema: {
        safeParse: (value: unknown) => ({ success: true, data: value }),
      } as never,
      fieldDescriptors: [],
      testConnection: jest.fn(),
      countTokens: () => 0,
      generate: (async function* () {})(),
      // No `deriveModelDescriptor` — declines to derive (rank 3 absent).
    } as unknown as AiProvider<never>;
  }

  beforeAll(async () => {
    noKnowledgeContext = await createTestApp({ useMockDatabase: true });

    // Overwrites the real `OpenAiProvider`'s registration for `'openai'` in
    // THIS app's own `AiProviderRegistry` only — "the later registration
    // wins" is the registry's own documented behaviour for a duplicate id,
    // the same mechanism a fork shadowing a framework provider relies on.
    const registry = noKnowledgeContext.module.get(AiProviderRegistry);
    registry.register(knowledgeLessOpenAiProvider());
  });

  afterAll(async () => {
    await closeTestApp(noKnowledgeContext);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    prismaMock.auditEvent.create.mockResolvedValue({} as never);
    prismaMock.systemSettings.findUnique.mockResolvedValue(storedSettings() as never);
    prismaMock.userAiCredential.findUnique.mockResolvedValue(null as never);
  });

  it('GET /api/ai-settings reports a permitted model as unknownModels when the provider has no knowledge of it at all', async () => {
    const admin = await createMockAdminUser(noKnowledgeContext);
    prismaMock.systemSettings.findUnique.mockResolvedValue(
      storedSettings({
        ...ENABLED,
        providers: {
          openai: { ...ENABLED.providers.openai, allowedModels: ['gpt-9-imaginary'] },
        },
      }) as never,
    );

    const res = await request(noKnowledgeContext.app.getHttpServer())
      .get(SETTINGS)
      .set(authHeader(admin.accessToken))
      .expect(200);

    // No catalogue hit (the fixture's one entry is a different id), no
    // derivation (the fixture declares none) and no floor (the fixture
    // declares none either) — the entry is unresolvable, and that is still
    // reported rather than silently dropped.
    expect(res.body.data.unknownModels).toEqual(['gpt-9-imaginary']);
  });

  it('PUT /api/ai-settings rejects a model id the active provider has no knowledge of at all', async () => {
    const admin = await createMockAdminUser(noKnowledgeContext);
    prismaMock.systemSettings.update.mockResolvedValue({
      ...storedSettings(),
      id: 'settings-1',
    } as never);

    const res = await request(noKnowledgeContext.app.getHttpServer())
      .put(SETTINGS)
      .set(authHeader(admin.accessToken))
      .send({ providers: { openai: { allowedModels: ['gpt-9-imaginary'] } } })
      .expect(400);

    expect(res.text).toContain('gpt-9-imaginary');
    expect(prismaMock.systemSettings.update).not.toHaveBeenCalled();
  });

  it('PUT /api/ai-settings names the missing fields for an entry with neither its own numbers nor any provider knowledge', async () => {
    const admin = await createMockAdminUser(noKnowledgeContext);
    prismaMock.systemSettings.update.mockResolvedValue({
      ...storedSettings(),
      id: 'settings-1',
    } as never);

    const res = await request(noKnowledgeContext.app.getHttpServer())
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

  it('SAVES an entry that carries its OWN numbers even though the provider has no knowledge of the id at all (rank 1 still wins)', async () => {
    const admin = await createMockAdminUser(noKnowledgeContext);
    prismaMock.systemSettings.update.mockResolvedValue({
      ...storedSettings(),
      id: 'settings-1',
    } as never);

    await request(noKnowledgeContext.app.getHttpServer())
      .put(SETTINGS)
      .set(authHeader(admin.accessToken))
      .send({
        providers: {
          openai: {
            allowedModels: [
              { id: 'gpt-9-imaginary', contextWindowTokens: 32_000, maxOutputTokens: 4_000 },
            ],
          },
        },
      })
      .expect(200);

    expect(prismaMock.systemSettings.update).toHaveBeenCalled();
  });
});
