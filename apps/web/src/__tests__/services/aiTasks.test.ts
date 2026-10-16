/**
 * `services/aiTasks.ts` — the `/api/ai-tasks/*` client (issue #477, epic #472).
 *
 * Over MSW rather than a mocked transport, so the real wire is exercised: the
 * unwrapping of `{ data }`, the `If-Match` version on the write, and the error
 * details the admin form reads. The response shapes are the API's
 * (`apps/api/src/ai-port/dto/ai-tasks.dto.ts`); the client returns them as sent.
 */

import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import { mockGraphAiConfig } from '../mocks/graphData';
import { mockAiTasksSettingsView, MOCK_AI_TASK_DEFINITIONS } from '../mocks/aiTasks';
import { ApiError } from '../../services/api';
import {
  AI_TASK_KEYS,
  getAiTasksConfig,
  getAiTasksSettings,
  putAiTasksSettings,
} from '../../services/aiTasks';
import type { AiTasksSettings } from '../../services/aiTasks';

const API = '*/api';

const SETTINGS: AiTasksSettings = {
  taskModels: { 'graph.extract': { model: 'gpt-4.1', reasoningEffort: 'high' } },
  graphEnabled: true,
  defaultModel: 'gpt-4o-mini',
  maxInputTokens: null,
  maxOutputTokens: 8_000,
  requestTimeoutMs: 300_000,
  maxDocumentBytes: 1_048_576,
  reasoningEffort: 'xhigh',
};

describe('getAiTasksConfig', () => {
  it('reads GET /api/ai-tasks/config as the API sends it', async () => {
    const body = mockGraphAiConfig();
    server.use(http.get(`${API}/ai-tasks/config`, () => HttpResponse.json({ data: body })));

    const config = await getAiTasksConfig();

    expect(config).toEqual(body);
    expect(config.keyConfigured).toBe(true);
    expect(config.graphEnabled).toBe(true);
    expect(Object.keys(config.taskModels)).toEqual([...AI_TASK_KEYS]);
    expect(config.models.map((m) => m.id)).toEqual(['gpt-4o-mini', 'gpt-4.1', 'legacy-text']);
  });

  it('rejects with an ApiError on 403 so the hook can name it', async () => {
    server.use(
      http.get(`${API}/ai-tasks/config`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );

    await expect(getAiTasksConfig()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('getAiTasksSettings / putAiTasksSettings', () => {
  it('reads GET /api/ai-tasks/settings: the document, its version, the tasks and the status', async () => {
    const body = mockAiTasksSettingsView(SETTINGS, 3);
    server.use(http.get(`${API}/ai-tasks/settings`, () => HttpResponse.json({ data: body })));

    const view = await getAiTasksSettings();

    expect(view).toEqual(body);
    expect(view.settings.defaultModel).toBe('gpt-4o-mini');
    expect(view.version).toBe(3);
    expect(view.tasks).toEqual(MOCK_AI_TASK_DEFINITIONS);
    expect(view.taskModelStatus.map((row) => row.task)).toEqual([...AI_TASK_KEYS]);
  });

  it('PUTs the document with the version as If-Match and returns the re-read response', async () => {
    let seen: { body: unknown; ifMatch: string | null } | null = null;
    server.use(
      http.put(`${API}/ai-tasks/settings`, async ({ request }) => {
        seen = { body: await request.json(), ifMatch: request.headers.get('if-match') };
        return HttpResponse.json({
          data: mockAiTasksSettingsView({ ...SETTINGS, graphEnabled: false }, 4),
        });
      }),
    );

    const view = await putAiTasksSettings(SETTINGS, 3);

    expect(seen).toEqual({ body: SETTINGS, ifMatch: '3' });
    expect(view.settings.graphEnabled).toBe(false);
    expect(view.version).toBe(4);
  });

  it('sends If-Match 0 to assert that nothing is stored yet', async () => {
    let ifMatch: string | null = null;
    server.use(
      http.put(`${API}/ai-tasks/settings`, ({ request }) => {
        ifMatch = request.headers.get('if-match');
        return HttpResponse.json({ data: mockAiTasksSettingsView(SETTINGS, 1) });
      }),
    );

    await putAiTasksSettings(SETTINGS, 0);

    expect(ifMatch).toBe('0');
  });

  it('surfaces a 400 with its details so the section can mark the row', async () => {
    server.use(
      http.put(`${API}/ai-tasks/settings`, () =>
        HttpResponse.json(
          {
            message: 'Model not permitted',
            details: { reason: 'model_not_permitted', task: 'graph.extract' },
          },
          { status: 400 },
        ),
      ),
    );

    const error = await putAiTasksSettings(SETTINGS, 3).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({ task: 'graph.extract' });
  });
});
