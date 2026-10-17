import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';

import { NOTE_CONFLICT_REASONS } from '../../../src/notes/dto/note.dto.js';
import { NoteGenerationRequestService } from '../../../src/notes/generation/note-generation-request.service.js';
import type { KvoxAiTarget, KvoxSettingsPort } from '../../../src/ports/index.js';
import { createFakeKvoxAi, type FakeKvoxAi } from '../../../src/testing/index.js';

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
  options: { caps?: ReturnType<typeof caps>; objects?: Map<string, unknown> } = {},
): NoteGenerationRequestService {
  const settings = {
    readSystem: jest.fn().mockResolvedValue({ value: options.caps ?? caps(), version: 1 }),
  } as unknown as KvoxSettingsPort;
  const store = { describe: jest.fn().mockResolvedValue(options.objects ?? new Map()) };

  return new NoteGenerationRequestService(
    ai,
    settings,
    store as never,
    {} as never, // TranscriptAccessService
    {} as never, // NoteAccessService
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
  it('asks the AI port for the notes.generate task and returns the resolution', async () => {
    const ai = createFakeKvoxAi({ script: { target: { model: 'gpt-5.4-mini', provider: 'openai' } } });

    const resolved = await service(ai).resolveModel('u1', null);

    expect(resolved.providerId).toBe('openai');
    expect(resolved.model).toBe('gpt-5.4-mini');
    expect(resolved.caps).toEqual(caps());
    expect(ai.calls.find((call) => call.method === 'resolveTask')).toMatchObject({
      ctx: { userId: 'u1', orgId: null, feature: 'notes.generate' },
      req: { task: 'notes.generate' },
    });
  });

  it('passes a requested model through', async () => {
    const ai = createFakeKvoxAi();

    const resolved = await service(ai).resolveModel('u1', 'gpt-5.4', 'preview');

    expect(resolved.model).toBe('gpt-5.4');
    expect(ai.calls.find((call) => call.method === 'resolveTask')?.req).toMatchObject({ model: 'gpt-5.4' });
  });

  it('returns the deployment spend caps beside the model', async () => {
    const ai = createFakeKvoxAi();

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
    const ai = createFakeKvoxAi({ script: { failWith: 'not_configured' } });

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
    const ai = createFakeKvoxAi({ script: { failWith: 'key_missing' } });

    const error = await refusalOf(service(ai).resolveModel('u1', null, intent));

    expect(error.getStatus()).toBe(409);
    expect(bodyOf(error)).toEqual({
      message: messages.keyMissing,
      details: { reason: NOTE_CONFLICT_REASONS.AI_KEY_MISSING },
    });
  });

  it('a model the caller picked that the deployment has not enabled is a 400 model_not_permitted', async () => {
    const ai = createFakeKvoxAi({ script: { failWith: 'capability' } });

    const error = await refusalOf(service(ai).resolveModel('u1', 'gpt-x'));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getStatus()).toBe(400);
    expect(bodyOf(error).details).toEqual({ reason: 'model_not_permitted' });
    expect(bodyOf(error).message).toContain('The model "gpt-x" is not one this deployment permits.');
  });

  it('a deployment default that no model can serve is a 409 model_lacks_capability', async () => {
    const ai = createFakeKvoxAi({ script: { failWith: 'capability' } });

    const error = await refusalOf(service(ai).resolveModel('u1', null));

    expect(error.getStatus()).toBe(409);
    expect(bodyOf(error).details).toEqual({ reason: 'model_lacks_capability' });
  });

  it('lets anything that is not an AI refusal through unchanged', async () => {
    const ai = createFakeKvoxAi();
    ai.resolveTask = async () => {
      throw new Error('boom');
    };

    await expect(service(ai).resolveModel('u1', null)).rejects.toThrow('boom');
  });
});

describe('NoteGenerationRequestService.resolveSource', () => {
  const DOCUMENT_ID = '77777777-7777-4777-8777-777777777777';
  const info = (overrides: Record<string, unknown> = {}) => ({
    id: DOCUMENT_ID,
    ownerId: 'u1',
    managedBy: 'notes',
    ...overrides,
  });

  it('accepts a document the caller uploaded for notes', async () => {
    const svc = service(createFakeKvoxAi(), { objects: new Map([[DOCUMENT_ID, info()]]) });

    await expect(
      svc.resolveSource({ type: 'document', objectId: DOCUMENT_ID }, { id: 'u1', permissions: [] }),
    ).resolves.toMatchObject({ sourceType: 'document', sourceObjectId: DOCUMENT_ID });
  });

  it.each([
    ['somebody else\'s document', info({ ownerId: 'u2' })],
    ['an object another module owns', info({ managedBy: 'transcripts' })],
    ['an object nobody owns', info({ managedBy: null })],
  ])('refuses %s with the same 404 as a missing one', async (_label, object) => {
    const svc = service(createFakeKvoxAi(), { objects: new Map([[DOCUMENT_ID, object]]) });

    await expect(
      svc.resolveSource({ type: 'document', objectId: DOCUMENT_ID }, { id: 'u1', permissions: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a document that does not exist', async () => {
    await expect(
      service(createFakeKvoxAi()).resolveSource({ type: 'document', objectId: DOCUMENT_ID }, { id: 'u1', permissions: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NoteGenerationRequestService.assertPromptFits', () => {
  // The fake counts `ceil(chars / 4)`, so the prompts below are sized in characters and the
  // expectations use the counted value.
  function target(overrides: Partial<KvoxAiTarget> = {}): KvoxAiTarget {
    return {
      provider: 'openai',
      model: 'gpt-6-turbo',
      contextWindowTokens: 2_000,
      maxOutputTokens: 500,
      source: 'default',
      ...overrides,
    };
  }

  function fits(ai: FakeKvoxAi, resolved: KvoxAiTarget, userContent: string, capsValue = caps()) {
    return service(ai).assertPromptFits({
      providerId: 'openai',
      model: 'gpt-6-turbo',
      target: resolved,
      caps: capsValue,
      systemPrompt: 'x'.repeat(8),
      userContent,
    });
  }

  it('refuses an over-budget prompt with the numbers in the error, rather than deferring to a failed job', () => {
    // window 2,000 - min(model 500, reserve) 500 - safety margin 500 = 1,000 available.
    let thrown: unknown;
    try {
      fits(createFakeKvoxAi(), target(), 'y'.repeat(5_000));
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
    expect(() => fits(createFakeKvoxAi(), target({ contextWindowTokens: 2_000_000 }), 'also short')).not.toThrow();
  });

  it('does not refuse a model with no recorded context window: the job is the backstop', () => {
    expect(() =>
      fits(createFakeKvoxAi(), target({ contextWindowTokens: 0, maxOutputTokens: 0 }), 'y'.repeat(500_000)),
    ).not.toThrow();
  });

  it('applies the deployment input cap under the model window', () => {
    expect(() =>
      fits(createFakeKvoxAi(), target({ contextWindowTokens: 2_000_000 }), 'y'.repeat(5_000), caps({ maxInputTokens: 300 })),
    ).toThrow(BadRequestException);
  });

  it('rethrows anything that is not a budget refusal', () => {
    const ai = createFakeKvoxAi();
    ai.countTokens = () => {
      throw new Error('boom');
    };

    expect(() => fits(ai, target(), 'y')).toThrow('boom');
  });
});
