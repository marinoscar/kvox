import { BadRequestException, ConflictException } from '@nestjs/common';

import type { KvoxAiReason } from '@marinoscar/kvox-ai';
import { readinessRefusal } from './readiness-refusal';

const body = (error: Error): { message: string; details: Record<string, unknown> } =>
  (error as BadRequestException | ConflictException).getResponse() as {
    message: string;
    details: Record<string, unknown>;
  };

const input = (reason: KvoxAiReason | null, extra: Partial<Parameters<typeof readinessRefusal>[0]> = {}) => ({
  task: 'graph.agent' as const,
  readiness: { reason, model: 'gpt-a' },
  requested: null,
  permittedModels: async () => ['gpt-a', 'gpt-b'],
  ...extra,
});

describe('readinessRefusal', () => {
  it.each(['graph_disabled', 'ai_not_configured', 'ai_key_missing'] as const)(
    'answers %s with the 409 and its reason',
    async (reason) => {
      const error = await readinessRefusal(input(reason));

      expect(error).toBeInstanceOf(ConflictException);
      expect(body(error).details.reason).toBe(reason);
    },
  );

  it('answers model_not_permitted with a 400 listing the permitted models, and the requested pick', async () => {
    const error = await readinessRefusal(input('model_not_permitted', { requested: 'gpt-nope' }));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(body(error).details).toEqual({ reason: 'model_not_permitted', task: 'graph.agent', model: 'gpt-nope' });
    expect(body(error).message).toContain('gpt-a, gpt-b');
  });

  it('reads the permitted models only on the refusal that needs them', async () => {
    const permittedModels = jest.fn(async () => ['gpt-a']);

    await readinessRefusal(input('ai_key_missing', { permittedModels }));

    expect(permittedModels).not.toHaveBeenCalled();
  });

  it('names everything the task requires when the caller supplies no capability probe', async () => {
    const error = await readinessRefusal(input('model_lacks_capability'));

    expect(body(error).details).toEqual(
      expect.objectContaining({ reason: 'model_lacks_capability', task: 'graph.agent', model: 'gpt-a' }),
    );
    expect(body(error).details.missing).toEqual(['toolCalling']);
  });

  it('prefers the caller\'s capability probe', async () => {
    const error = await readinessRefusal(
      input('model_lacks_capability', {
        lacksCapability: async () => ({ model: 'gpt-c', missing: ['structured output'] }),
      }),
    );

    expect(body(error).details).toEqual(
      expect.objectContaining({ model: 'gpt-c', missing: ['structured output'] }),
    );
  });
});
