/**
 * Fixtures of `GET|PUT /api/ai-tasks/settings` (issue #477, epic #472), shaped as
 * `apps/api/src/ai-port/dto/ai-tasks.dto.ts` sends them. `mockGraphAiConfig` in
 * `graphData.ts` is the matching fixture of `GET /api/ai-tasks/config`.
 */

import type {
  AiTaskDefinition,
  AiTaskModelStatus,
  AiTasksEnabledModel,
  AiTasksSettings,
  AiTasksSettingsView,
} from '../../services/aiTasks';

/** The task copy the server publishes (`AI_TASK_DEFINITIONS` in `ai-port/task-models.ts`). */
export const MOCK_AI_TASK_DEFINITIONS: AiTaskDefinition[] = [
  {
    key: 'graph.extract',
    label: 'Graph extraction',
    requires: ['structuredOutput'],
    description:
      'Reads a finished note and proposes people, organizations, projects, decisions, commitments and claims for review. One call per note.',
  },
  {
    key: 'graph.adjudicate',
    label: 'Entity matching',
    requires: ['structuredOutput'],
    description:
      'Decides whether two similar names are the same person or organization. Many small calls; a smaller model is usually enough.',
  },
  {
    key: 'graph.digest',
    label: 'Entity digest',
    requires: ['structuredOutput'],
    description:
      'Keeps the rolling, cited summary an entity page shows ("what\'s the latest on …"), refreshed by a background job after commits.',
  },
  {
    key: 'graph.agent',
    label: 'Ask (graph agent)',
    requires: ['toolCalling'],
    description: 'Answers questions by calling read-only graph tools, with citations.',
  },
];

/** The stored defaults of the extended `ai` namespace, `defaultModel` chosen. */
export const MOCK_AI_TASKS_SETTINGS: AiTasksSettings = {
  taskModels: {},
  graphEnabled: false,
  defaultModel: 'gpt-4o',
  maxInputTokens: null,
  maxOutputTokens: null,
  requestTimeoutMs: 600_000,
  maxDocumentBytes: 26_214_400,
  reasoningEffort: 'none',
};

export const MOCK_AI_ENABLED_MODELS: AiTasksEnabledModel[] = [
  { id: 'gpt-4o', label: 'GPT-4o', structuredOutput: true, toolCalling: true },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', structuredOutput: true, toolCalling: false },
];

/** Every task on the default model, nothing stale. */
export function mockTaskModelStatus(
  overrides: Partial<Record<AiTaskDefinition['key'], Partial<AiTaskModelStatus>>> = {},
): AiTaskModelStatus[] {
  return MOCK_AI_TASK_DEFINITIONS.map((task) => ({
    task: task.key,
    configuredModel: null,
    effectiveModel: 'gpt-4o',
    source: 'default' as const,
    missing: [],
    problem: null,
    staleTaskModel: false,
    ...overrides[task.key],
  }));
}

/** `GET /api/ai-tasks/settings` (and the body of a successful `PUT`). */
export function mockAiTasksSettingsView(
  settings: Partial<AiTasksSettings> = {},
  version = 7,
  extra: Partial<Omit<AiTasksSettingsView, 'settings' | 'version'>> = {},
): AiTasksSettingsView {
  return {
    settings: { ...MOCK_AI_TASKS_SETTINGS, ...settings },
    tasks: MOCK_AI_TASK_DEFINITIONS.map((task) => ({ ...task, requires: [...task.requires] })),
    models: MOCK_AI_ENABLED_MODELS.map((model) => ({ ...model })),
    taskModelStatus: mockTaskModelStatus(),
    version,
    ...extra,
  };
}
