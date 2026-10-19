import {
  KVOX_TASK_IDS,
  KVOX_TASK_REQUIREMENTS,
  routeKvoxTasks,
  type KvoxTaskId,
  type ProviderChoice,
} from './route-kvox-tasks.js';

// =============================================================================
// routeKvoxTasks (issue #630): capability-based task routing, as a table
// =============================================================================

const COPILOT: ProviderChoice = {
  provider: 'copilot',
  model: 'gpt-5-mini',
  toolCalling: false,
  embeddings: false,
};
const OPENAI: ProviderChoice = {
  provider: 'openai',
  model: 'gpt-5.4',
  toolCalling: true,
  embeddings: true,
};
const OPENAI_NO_TOOLS: ProviderChoice = { ...OPENAI, toolCalling: false };
const OPENAI_NO_EMBEDS: ProviderChoice = { ...OPENAI, embeddings: false };

const EMBEDS: KvoxTaskId[] = ['graph.embed', 'search.embed'];
const TEXT_TASKS = KVOX_TASK_IDS.filter((t) => t !== 'ask.respond' && !EMBEDS.includes(t));

describe('task vocabulary', () => {
  it('requires tool calling only for ask.respond and embeddings only for the embed tasks', () => {
    for (const task of KVOX_TASK_IDS) {
      expect(KVOX_TASK_REQUIREMENTS[task]).toEqual({
        toolCalling: task === 'ask.respond',
        embeddings: EMBEDS.includes(task),
      });
    }
  });
});

describe('routeKvoxTasks', () => {
  it('sends ask.respond and the embeddings to the fallback and the rest to Copilot', () => {
    const { taskModels, unavailable } = routeKvoxTasks({ primary: COPILOT, fallback: OPENAI });
    expect(unavailable).toEqual([]);
    expect(taskModels['ask.respond']).toEqual({ provider: 'openai', model: 'gpt-5.4' });
    for (const task of EMBEDS) {
      expect(taskModels[task]).toEqual({ provider: 'openai', model: 'gpt-5.4' });
    }
    for (const task of TEXT_TASKS) {
      expect(taskModels[task]).toEqual({ provider: 'copilot', model: 'gpt-5-mini' });
    }
    expect(Object.keys(taskModels)).toEqual([...KVOX_TASK_IDS]);
  });

  it('lists ask.respond and the embeddings as unavailable without a fallback', () => {
    for (const fallback of [null, undefined]) {
      const { taskModels, unavailable } = routeKvoxTasks({ primary: COPILOT, fallback });
      expect(unavailable).toEqual([
        { task: 'ask.respond', reason: 'needs_tool_calling' },
        { task: 'graph.embed', reason: 'needs_embeddings' },
        { task: 'search.embed', reason: 'needs_embeddings' },
      ]);
      expect(Object.keys(taskModels)).toEqual([...TEXT_TASKS]);
      expect(taskModels['ask.respond']).toBeUndefined();
    }
  });

  it('sends every task to a full-capability primary and ignores the fallback', () => {
    const other: ProviderChoice = { ...OPENAI, provider: 'other', model: 'm' };
    const { taskModels, unavailable } = routeKvoxTasks({ primary: OPENAI, fallback: other });
    expect(unavailable).toEqual([]);
    expect(Object.keys(taskModels)).toEqual([...KVOX_TASK_IDS]);
    for (const task of KVOX_TASK_IDS) {
      expect(taskModels[task]).toEqual({ provider: 'openai', model: 'gpt-5.4' });
    }
  });

  it('keeps ask.respond unavailable when the fallback lacks tool calling', () => {
    const { taskModels, unavailable } = routeKvoxTasks({
      primary: COPILOT,
      fallback: OPENAI_NO_TOOLS,
    });
    expect(unavailable).toEqual([{ task: 'ask.respond', reason: 'needs_tool_calling' }]);
    expect(taskModels['ask.respond']).toBeUndefined();
    expect(taskModels['graph.embed']).toEqual({ provider: 'openai', model: 'gpt-5.4' });
    expect(taskModels['notes.generate']?.provider).toBe('copilot');
  });

  it('keeps the embeddings unavailable when the fallback lacks them', () => {
    const { taskModels, unavailable } = routeKvoxTasks({
      primary: COPILOT,
      fallback: OPENAI_NO_EMBEDS,
    });
    expect(unavailable).toEqual([
      { task: 'graph.embed', reason: 'needs_embeddings' },
      { task: 'search.embed', reason: 'needs_embeddings' },
    ]);
    expect(taskModels['ask.respond']?.provider).toBe('openai');
    expect(Object.keys(taskModels)).toEqual(KVOX_TASK_IDS.filter((t) => !EMBEDS.includes(t)));
  });

  it('works for any non-Copilot provider without tool calling', () => {
    const local: ProviderChoice = {
      provider: 'local',
      model: 'llama',
      toolCalling: false,
      embeddings: true,
    };
    const withFallback = routeKvoxTasks({ primary: local, fallback: OPENAI });
    expect(withFallback.unavailable).toEqual([]);
    expect(withFallback.taskModels['ask.respond']?.provider).toBe('openai');
    expect(withFallback.taskModels['graph.embed']?.provider).toBe('local');
    expect(withFallback.taskModels['notes.title']?.provider).toBe('local');

    const alone = routeKvoxTasks({ primary: local });
    expect(alone.unavailable).toEqual([{ task: 'ask.respond', reason: 'needs_tool_calling' }]);
  });

  it('is deterministic and does not mutate its input', () => {
    const input = { primary: { ...COPILOT }, fallback: { ...OPENAI } };
    const snapshot = JSON.parse(JSON.stringify(input));
    const first = routeKvoxTasks(input);
    const second = routeKvoxTasks(input);
    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
    expect(first.taskModels['notes.generate']).not.toBe(input.primary);
  });
});
