import request from 'supertest';

import { listAiFeatures } from '@marinoscar/platform-api/ai';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/settings/registry/default-system-settings';
import { KVOX_AI_FEATURES } from '../../src/ai-port/features';

// =============================================================================
// /api/ai-tasks/* and the platform's /api/ai/* beside it (issue #473)
// =============================================================================
//
// `GET /api/ai-tasks/config` is the capability probe that used to live at
// `GET /api/ai/config` (the platform owns that path now); it is gated on
// `notes:read`, seeded to every role, so a Viewer can read it. The settings pair is
// `ai_config:read` / `ai_config:write`, Admin only.
// =============================================================================

const CONFIG = '/api/ai-tasks/config';
const SETTINGS = '/api/ai-tasks/settings';

const FULL = { capabilities: ['responses', 'streaming', 'structured_output', 'tools'] };
const NO_TOOLS = { capabilities: ['responses', 'streaming', 'structured_output'] };

function modelRow(modelId: string, capabilities: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: `row-${modelId}`,
    provider: 'openai',
    modelId,
    displayName: null,
    capabilities,
    capabilitySource: 'catalogue',
    enabled: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    ...extra,
  };
}

function storedSettings(ai: Record<string, unknown> = {}, version = 7) {
  return {
    id: 'settings-1',
    key: 'global',
    value: { ...DEFAULT_SYSTEM_SETTINGS, ai: { ...DEFAULT_SYSTEM_SETTINGS.ai, ...ai } },
    version,
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedByUserId: null,
    updatedByUser: null,
  };
}

const ENABLED = {
  enabled: true,
  providers: { ...DEFAULT_SYSTEM_SETTINGS.ai.providers, openai: { enabled: true } },
  defaultModel: 'gpt-5.4-mini',
};

describe('AI task routes integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
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
    prismaMock.aiModel.findMany.mockResolvedValue([] as never);
    prismaMock.userAiKey.findUnique.mockResolvedValue(null as never);
  });

  // The resolver caches the policy for 5 seconds per process; every test needs a fresh read.
  afterEach(async () => {
    const { KvoxAiTargetResolver } = await import('../../src/ai-port/kvox-ai-target-resolver');
    context.module.get(KvoxAiTargetResolver, { strict: false }).invalidateCache();
  });

  describe('GET /api/ai-tasks/config', () => {
    it('answers 401 without a token', async () => {
      await request(context.app.getHttpServer()).get(CONFIG).expect(401);
    });

    it('IS REACHABLE BY A VIEWER and reports keyConfigured: false before a key is saved', async () => {
      const viewer = await createMockViewerUser(context);

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data).toMatchObject({
        available: false,
        provider: 'openai',
        providerLabel: 'OpenAI',
        models: [],
        defaultModel: null,
        keyConfigured: false,
        graphEnabled: false,
      });
      expect(Object.keys(res.body.data.taskModels)).toEqual([
        'graph.extract',
        'graph.adjudicate',
        'graph.digest',
        'graph.agent',
      ]);
      expect(res.body.data.taskModels['graph.extract']).toMatchObject({
        model: null,
        source: 'none',
        usable: false,
        reason: 'graph_disabled',
        requires: ['structuredOutput'],
      });
    });

    it('reads key existence only, never the secret, and keys it to the CALLER', async () => {
      const contributor = await createMockContributorUser(context);
      prismaMock.userAiKey.findUnique.mockResolvedValue({ id: 'key-1' } as never);

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(res.body.data.keyConfigured).toBe(true);
      expect(prismaMock.userAiKey.findUnique).toHaveBeenCalledWith({
        where: { userId_provider: { userId: contributor.id, provider: 'openai' } },
        select: { id: true },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/secret/i);
    });

    it('publishes the enabled models with their flags and answers each task from the same chooser', async () => {
      const viewer = await createMockViewerUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({
          ...ENABLED,
          graphEnabled: true,
          taskModels: { 'graph.agent': { model: 'gpt-5.4', reasoningEffort: 'high' } },
        }) as never,
      );
      prismaMock.aiModel.findMany.mockResolvedValue([
        modelRow('gpt-5.4', FULL),
        modelRow('gpt-5.4-mini', NO_TOOLS, { displayName: 'Mini' }),
      ] as never);

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data.available).toBe(true);
      expect(res.body.data.defaultModel).toBe('gpt-5.4-mini');
      expect(res.body.data.models).toEqual([
        expect.objectContaining({ id: 'gpt-5.4', structuredOutput: true, toolCalling: true }),
        expect.objectContaining({ id: 'gpt-5.4-mini', label: 'Mini', structuredOutput: true, toolCalling: false }),
      ]);
      expect(res.body.data.taskModels['graph.agent']).toMatchObject({
        model: 'gpt-5.4',
        source: 'task',
        reasoningEffort: 'high',
        usable: true,
        reason: null,
      });
      expect(res.body.data.taskModels['graph.extract']).toMatchObject({
        model: 'gpt-5.4-mini',
        source: 'default',
        usable: true,
      });
    });

    it('reports a task whose model lacks a capability as unusable', async () => {
      const viewer = await createMockViewerUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({ ...ENABLED, graphEnabled: true, taskModels: { 'graph.agent': { model: 'gpt-5.4-mini' } } }) as never,
      );
      prismaMock.aiModel.findMany.mockResolvedValue([modelRow('gpt-5.4-mini', NO_TOOLS)] as never);

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data.taskModels['graph.agent']).toMatchObject({
        usable: false,
        reason: 'model_lacks_capability',
      });
    });

    it('narrows the published numbers by the deployment token caps', async () => {
      const viewer = await createMockViewerUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({ ...ENABLED, maxInputTokens: 20_000, maxOutputTokens: 2_000 }) as never,
      );
      prismaMock.aiModel.findMany.mockResolvedValue([modelRow('gpt-5.4-mini', FULL)] as never);

      const res = await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data.maxInputTokens).toBe(20_000);
      expect(res.body.data.models[0].maxOutputTokens).toBe(2_000);
      expect(res.body.data.models[0].contextWindowTokens).toBeLessThan(128_000);
    });
  });

  describe('the platform AI routes beside it', () => {
    it('GET /api/ai/config answers with the PLATFORM shape, not this app\'s', async () => {
      const viewer = await createMockViewerUser(context);

      const res = await request(context.app.getHttpServer())
        .get('/api/ai/config')
        .set(authHeader(viewer.accessToken));

      // A Viewer holds ai:use, so the route is reachable; the body is the platform's.
      expect([200, 403]).toContain(res.status);
      expect(res.body.data?.taskModels).toBeUndefined();
      expect(res.body.data?.keyConfigured).toBeUndefined();
    });

    it('registers the nine kvox features, which GET /api/ai/features serves behind the kill switch', async () => {
      const viewer = await createMockViewerUser(context);

      const ids = listAiFeatures().map((feature) => feature.id);
      expect(ids).toEqual(expect.arrayContaining([...KVOX_AI_FEATURES]));
      expect(listAiFeatures().filter((feature) => feature.group === 'kvox')).toHaveLength(9);

      // The route is mounted (not a 404) and sits behind `AiEnabledGuard` + `ai:use`: a fresh
      // deployment has AI off, so a Viewer who holds `ai:use` gets the kill switch's 403.
      const res = await request(context.app.getHttpServer())
        .get('/api/ai/features')
        .set(authHeader(viewer.accessToken));
      expect([200, 403]).toContain(res.status);
      if (res.status === 403) expect(res.body.details).toMatchObject({ reason: 'AI_DISABLED' });
    });
  });

  describe('GET /api/ai-tasks/settings', () => {
    it('answers 403 to a Viewer and a Contributor, 401 to nobody', async () => {
      const viewer = await createMockViewerUser(context);
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer()).get(SETTINGS).expect(401);
      await request(context.app.getHttpServer()).get(SETTINGS).set(authHeader(viewer.accessToken)).expect(403);
      await request(context.app.getHttpServer()).get(SETTINGS).set(authHeader(contributor.accessToken)).expect(403);
    });

    it('shows an Admin the extension fields, the tasks, the models and the version', async () => {
      const admin = await createMockAdminUser(context);
      prismaMock.systemSettings.findUnique.mockResolvedValue(
        storedSettings({
          ...ENABLED,
          taskModels: { 'graph.extract': { model: 'retired' } },
        }) as never,
      );
      prismaMock.aiModel.findMany.mockResolvedValue([modelRow('gpt-5.4-mini', FULL)] as never);

      const res = await request(context.app.getHttpServer())
        .get(SETTINGS)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(res.body.data.version).toBe(7);
      expect(res.body.data.settings).toMatchObject({ graphEnabled: false, defaultModel: 'gpt-5.4-mini' });
      expect(res.body.data.tasks.map((task: { key: string }) => task.key)).toEqual([
        'graph.extract',
        'graph.adjudicate',
        'graph.digest',
        'graph.agent',
      ]);
      expect(res.body.data.models).toEqual([
        { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini', structuredOutput: true, toolCalling: true },
      ]);
      // Computed without the graph gate, and a stale task model is reported, not an error.
      expect(res.body.data.taskModelStatus[0]).toMatchObject({
        task: 'graph.extract',
        configuredModel: 'retired',
        effectiveModel: 'gpt-5.4-mini',
        source: 'default',
        problem: null,
        staleTaskModel: true,
      });
    });
  });

  describe('PUT /api/ai-tasks/settings', () => {
    beforeEach(() => {
      prismaMock.systemSettings.findUnique.mockResolvedValue(storedSettings({ ...ENABLED }) as never);
      prismaMock.aiModel.findMany.mockResolvedValue([
        modelRow('gpt-5.4', FULL),
        modelRow('no-tools', NO_TOOLS),
      ] as never);
    });

    it('answers 403 to a Viewer and a Contributor', async () => {
      const viewer = await createMockViewerUser(context);
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(viewer.accessToken))
        .send({ graphEnabled: true })
        .expect(403);
      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(contributor.accessToken))
        .send({ graphEnabled: true })
        .expect(403);
      expect(prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('400 model_not_permitted, naming the task, for a model that is not enabled', async () => {
      const admin = await createMockAdminUser(context);

      const res = await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ taskModels: { 'graph.extract': { model: 'gpt-x' } } })
        .expect(400);

      expect(res.body.details).toMatchObject({
        reason: 'model_not_permitted',
        task: 'graph.extract',
        model: 'gpt-x',
      });
      expect(prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('400 model_lacks_capability, with what is missing, for a model without the capability', async () => {
      const admin = await createMockAdminUser(context);

      const res = await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ taskModels: { 'graph.agent': { model: 'no-tools' } } })
        .expect(400);

      expect(res.body.details).toMatchObject({
        reason: 'model_lacks_capability',
        task: 'graph.agent',
        model: 'no-tools',
        missing: ['toolCalling'],
      });
      expect(prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('400 for an unknown task key, an effort outside the task set and an out-of-bounds limit', async () => {
      const admin = await createMockAdminUser(context);

      for (const body of [
        { taskModels: { 'graph.brief': { model: 'gpt-5.4' } } },
        { taskModels: { 'graph.extract': { model: 'gpt-5.4', reasoningEffort: 'xhigh' } } },
        { maxOutputTokens: 10 },
      ]) {
        await request(context.app.getHttpServer())
          .put(SETTINGS)
          .set(authHeader(admin.accessToken))
          .send(body)
          .expect(400);
      }
      expect(prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('writes through the platform settings service (If-Match, version bump, audit)', async () => {
      const admin = await createMockAdminUser(context);
      prismaMock.systemSettings.update.mockResolvedValue({
        ...storedSettings({ ...ENABLED, taskModels: { 'graph.extract': { model: 'gpt-5.4' } }, graphEnabled: true }, 8),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      } as never);

      const res = await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .set('If-Match', '7')
        .send({ taskModels: { 'graph.extract': { model: 'gpt-5.4' } }, graphEnabled: true })
        .expect(200);

      const written = prismaMock.systemSettings.update.mock.calls[0][0] as {
        data: { value: { ai: Record<string, unknown> }; version: unknown };
      };
      expect(written.data.value.ai.taskModels).toEqual({ 'graph.extract': { model: 'gpt-5.4' } });
      expect(written.data.value.ai.graphEnabled).toBe(true);
      // The fields it did not name are carried forward, platform fields included.
      expect(written.data.value.ai.defaultModel).toBe('gpt-5.4-mini');
      expect(written.data.value.ai.keyPolicy).toBe('byok');
      expect(written.data.version).toEqual({ increment: 1 });
      expect(prismaMock.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'system_settings:patch', actorUserId: admin.id }),
        }),
      );
      expect(res.body.data.settings.graphEnabled).toBeDefined();
    });

    it('409 on an If-Match that does not match the stored version', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .set('If-Match', '3')
        .send({ graphEnabled: true })
        .expect(409);
      expect(prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('accepts taskModels {} to clear, and null to clear the nullable limits', async () => {
      const admin = await createMockAdminUser(context);
      prismaMock.systemSettings.update.mockResolvedValue(storedSettings({ ...ENABLED }, 8) as never);

      await request(context.app.getHttpServer())
        .put(SETTINGS)
        .set(authHeader(admin.accessToken))
        .send({ taskModels: {}, defaultModel: null, maxInputTokens: null })
        .expect(200);

      const written = prismaMock.systemSettings.update.mock.calls[0][0] as {
        data: { value: { ai: Record<string, unknown> } };
      };
      expect(written.data.value.ai.taskModels).toEqual({});
      expect(written.data.value.ai.defaultModel).toBeNull();
      expect(written.data.value.ai.maxInputTokens).toBeNull();
    });
  });
});
