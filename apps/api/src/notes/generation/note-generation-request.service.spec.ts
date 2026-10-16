import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';

import {
  FakeKvoxAi,
  notReadyReadiness,
  readyReadiness,
} from '../../ai-port/testing/fake-kvox-ai';
import { NOTE_CONFLICT_REASONS } from '../dto/note.dto';
import { NoteGenerationRequestService } from './note-generation-request.service';

// =============================================================================
// NoteGenerationRequestService (issues #53, #78, #360, #475)
// =============================================================================
//
// `resolveModel` turns one `KvoxAi.readiness` answer into the refusal the notes
// routes have always answered with (the same `details.reason` strings and the same
// per-intent sentences), and `assertPromptFits` refuses an over-budget prompt with
// the numbers in a 400. The port is the FakeKvoxAi; the deployment's two spend caps
// come from a stand-in settings service.
// =============================================================================

const NOTE_MESSAGES = {
  notConfigured:
    'AI features are not configured for this deployment, so a note cannot be generated. An administrator can enable them in system settings.',
  keyMissing:
    'You have not saved an AI API key. A note is generated on your own provider account, so it needs your key. Add one in your settings and try again.',
};

const PREVIEW_MESSAGES = {
  notConfigured:
    'AI features are not configured for this deployment, so a template cannot be previewed. An administrator can enable them in system settings.',
  keyMissing:
    'You have not saved an AI API key. A preview is a real generation on your own provider account, so it needs your key. Add one in your settings and try again.',
};

function caps(overrides: Partial<{ maxInputTokens: number | null; maxOutputTokens: number | null }> = {}) {
  return { maxInputTokens: null, maxOutputTokens: null, ...overrides };
}

function service(
  ai: FakeKvoxAi,
  options: { caps?: ReturnType<typeof caps>; models?: string[] } = {},
): NoteGenerationRequestService {
  const settings = { get: jest.fn().mockResolvedValue(options.caps ?? caps()) };
  const prisma = {
    aiModel: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.models ?? ['gpt-5.4', 'gpt-5.4-mini']).map((modelId) => ({ modelId }))),
    },
  };

  return new NoteGenerationRequestService(
    prisma as never,
    ai,
    settings as never,
    {} as never, // TranscriptAccessService
    {} as never, // NoteAccessService
    {} as never, // KvoxManagedObjectsService
  );
}

async function refusalOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a refusal');
}

function bodyOf(error: HttpException): { message?: string; details?: Record<string, unknown> } {
  const body = error.getResponse();

  return typeof body === 'string' ? { message: body } : (body as { message?: string });
}

describe('NoteGenerationRequestService.resolveModel', () => {
  it('asks readiness for note_generate with the requested model and returns the resolution', async () => {
    const ai = new FakeKvoxAi();
    ai.setReadiness({ model: 'gpt-5.4-mini' });

    const resolved = await service(ai).resolveModel('u1', null);

    expect(resolved.providerId).toBe('openai');
    expect(resolved.model).toBe('gpt-5.4-mini');
    expect(resolved.caps).toEqual(caps());
    expect(ai.lastCall('readiness')).toMatchObject({ userId: 'u1', feature: 'note_generate' });
  });

  it('passes a requested model through', async () => {
    const ai = new FakeKvoxAi();

    const resolved = await service(ai).resolveModel('u1', 'gpt-5.4', 'preview');

    expect(resolved.model).toBe('gpt-5.4');
    expect(ai.lastCall('readiness')?.model).toBe('gpt-5.4');
  });

  it('returns the deployment spend caps beside the model', async () => {
    const ai = new FakeKvoxAi();

    const resolved = await service(ai, { caps: caps({ maxInputTokens: 9_000, maxOutputTokens: 800 }) }).resolveModel(
      'u1',
      null,
    );

    expect(resolved.caps).toEqual({ maxInputTokens: 9_000, maxOutputTokens: 800 });
  });

  it.each([
    ['note', NOTE_MESSAGES],
    ['preview', PREVIEW_MESSAGES],
  ] as const)('not configured (%s) is a 409 ai_not_configured with the intent sentence', async (intent, messages) => {
    const ai = new FakeKvoxAi().setReadiness(notReadyReadiness('ai_not_configured'));

    const error = await refusalOf(service(ai).resolveModel('u1', null, intent));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(bodyOf(error)).toEqual({
      message: messages.notConfigured,
      details: { reason: NOTE_CONFLICT_REASONS.AI_NOT_CONFIGURED },
    });
  });

  it.each([
    ['note', NOTE_MESSAGES],
    ['preview', PREVIEW_MESSAGES],
  ] as const)('no key (%s) is a 409 ai_key_missing with the intent sentence', async (intent, messages) => {
    const ai = new FakeKvoxAi().setReadiness(notReadyReadiness('ai_key_missing'));

    const error = await refusalOf(service(ai).resolveModel('u1', null, intent));

    expect(error.getStatus()).toBe(409);
    expect(bodyOf(error)).toEqual({
      message: messages.keyMissing,
      details: { reason: NOTE_CONFLICT_REASONS.AI_KEY_MISSING },
    });
  });

  it('a model the deployment has not enabled is a 400 naming the permitted list', async () => {
    const ai = new FakeKvoxAi().setReadiness(notReadyReadiness('model_not_permitted'));

    const error = await refusalOf(service(ai).resolveModel('u1', 'gpt-x'));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getStatus()).toBe(400);
    expect(bodyOf(error)).toEqual({
      message: 'The model "gpt-x" is not one this deployment permits. Choose one of: gpt-5.4, gpt-5.4-mini.',
      details: { reason: 'model_not_permitted' },
    });
  });

  it('still refuses (without the list) when the permitted list cannot be read', async () => {
    const ai = new FakeKvoxAi().setReadiness(notReadyReadiness('model_not_permitted'));
    const svc = service(ai);
    (svc as unknown as { prisma: { aiModel: { findMany: jest.Mock } } }).prisma.aiModel.findMany.mockRejectedValue(
      new Error('db down'),
    );

    const error = await refusalOf(svc.resolveModel('u1', 'gpt-x'));

    expect(error.getStatus()).toBe(400);
    expect(bodyOf(error).details).toEqual({ reason: 'model_not_permitted' });
  });
});

describe('NoteGenerationRequestService.assertPromptFits', () => {
  // The fake counts with the real local estimate (max of chars/4 and words), so the
  // prompts below are sized in characters and the expectations use the counted value.
  function fits(ai: FakeKvoxAi, readiness: ReturnType<typeof readyReadiness>, userContent: string, capsValue = caps()) {
    return service(ai).assertPromptFits({
      providerId: 'openai',
      model: 'gpt-6-turbo',
      readiness,
      caps: capsValue,
      systemPrompt: 'x'.repeat(8),
      userContent,
    });
  }

  it('refuses an over-budget prompt with the numbers in the error, rather than deferring to a failed job', () => {
    const ai = new FakeKvoxAi();
    // window 2,000 - min(model 500, reserve) 500 - safety margin 500 = 1,000 available.
    const readiness = readyReadiness({ model: 'gpt-6-turbo', contextWindowTokens: 2_000, maxOutputTokens: 500 });

    let thrown: unknown;
    try {
      fits(ai, readiness, 'y'.repeat(5_000));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    const message = (thrown as BadRequestException).message;
    // The real counts, not a generic refusal: §3.3's whole argument.
    expect(message).toContain('1,253'); // ceil((8 + 1 + 5000) / 4)
    expect(message).toContain('1,000');
    expect(message).toContain('gpt-6-turbo');
  });

  it('does not refuse when the prompt fits', () => {
    const readiness = readyReadiness({ contextWindowTokens: 2_000_000, maxOutputTokens: 500 });

    expect(() => fits(new FakeKvoxAi(), readiness, 'also short')).not.toThrow();
  });

  it('does not refuse a model with no recorded context window: the job is the backstop', () => {
    const readiness = readyReadiness({ contextWindowTokens: null, maxOutputTokens: null });

    expect(() => fits(new FakeKvoxAi(), readiness, 'y'.repeat(500_000))).not.toThrow();
  });

  it('applies the deployment input cap under the model window', () => {
    const readiness = readyReadiness({ contextWindowTokens: 2_000_000, maxOutputTokens: 500 });

    expect(() =>
      fits(new FakeKvoxAi(), readiness, 'y'.repeat(5_000), caps({ maxInputTokens: 300 })),
    ).toThrow(BadRequestException);
  });

  it('rethrows anything that is not a budget refusal', () => {
    const ai = new FakeKvoxAi();
    jest.spyOn(ai, 'countTokens').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => fits(ai, readyReadiness(), 'y')).toThrow('boom');
  });
});
