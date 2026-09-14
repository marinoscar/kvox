import { BadRequestException } from '@nestjs/common';

import { NoteGenerationRequestService } from './note-generation-request.service';
import type { SystemAiValue } from '../../ai/ai-settings.schema';
import type { AiProvider } from '../../ai/providers/ai-provider.interface';

// =============================================================================
// NoteGenerationRequestService.assertPromptFits (issue #78, epic #45)
// =============================================================================
//
// Since #78, a model known only through its OWN policy entry — one the build
// catalogue has never heard of, adopted from the discovery dropdown — is
// budget-checked here exactly like a model this build ships knowing about.
// Before this file's own fix, `assertPromptFits` looked the model up only in
// `input.provider.capabilities.models` (the build catalogue) and silently
// returned when it found nothing there — which meant an over-budget prompt for
// such a model sailed past this 400 and was only ever discovered as a
// `failed` job minutes later, the exact outcome docs/specs/notes.md §3.3
// exists to prevent. `assertPromptFits` now resolves through
// `resolveAllowedModel` (the same function `AiConfigService` and
// `AiSettingsService` use), so the ENTRY's own numbers are what gets checked.
//
// `assertPromptFits` is synchronous and touches nothing but its argument, so
// the service under test needs no working collaborators — every constructor
// dependency below is an inert stand-in.
// =============================================================================

function service(): NoteGenerationRequestService {
  return new NoteGenerationRequestService(
    {} as never, // PrismaService — unused by assertPromptFits
    {} as never, // AiConfigService
    {} as never, // AiSettingsService
    {} as never, // AiProviderRegistry
    {} as never, // TranscriptAccessService
    {} as never, // NoteAccessService
  );
}

/** A provider whose BUILD CATALOGUE knows nothing — every model must resolve, if at all, from its own policy entry. */
function providerWithEmptyCatalogue(): AiProvider<never> {
  return {
    id: 'openai',
    label: 'OpenAI',
    capabilities: { models: [], streaming: true, modelDiscovery: false },
    settingsSchema: {} as never,
    fieldDescriptors: [],
    testConnection: jest.fn(),
    // One "token" per character — deterministic and trivial to reason about.
    countTokens: (text: string) => text.length,
    generate: (async function* () {})(),
  } as unknown as AiProvider<never>;
}

function policyPermitting(model: {
  id: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}): SystemAiValue {
  return {
    enabled: true,
    provider: 'openai',
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        allowedModels: [model],
        defaultModel: model.id,
      },
    },
    maxInputTokens: 2_000_000,
    maxOutputTokens: 200_000,
    requestTimeoutMs: 60_000,
    maxDocumentBytes: 1_000_000,
  };
}

describe('assertPromptFits — a model known only through its own policy entry (#78)', () => {
  it('refuses an over-budget prompt with the numbers in the error, rather than deferring to a failed job', () => {
    const svc = service();
    const provider = providerWithEmptyCatalogue(); // build catalogue: nothing
    const policy = policyPermitting({
      id: 'gpt-6-turbo',
      contextWindowTokens: 2_000,
      maxOutputTokens: 500,
    });

    // budget = contextWindow(2000) - min(modelMaxOutput(500), policyMaxOutput(200000))(500) - 500 safety margin = 1000
    const systemPrompt = 'x'.repeat(10);
    const userContent = 'y'.repeat(5_000); // "\n"-joined length is 5011, well over 1000

    let thrown: unknown;
    try {
      svc.assertPromptFits({
        provider,
        model: 'gpt-6-turbo',
        policy,
        systemPrompt,
        userContent,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    const message = (thrown as BadRequestException).message;
    // The real counts, not a generic refusal — the whole reason §3.3 requires
    // them, and the reason an over-budget request must be refused here rather
    // than an hour later as an opaque failed generation.
    expect(message).toContain('5,011');
    expect(message).toContain('1,000');
    expect(message).toContain('gpt-6-turbo');
  });

  it('does NOT refuse when the prompt fits within a policy-only model\'s budget', () => {
    const svc = service();
    const provider = providerWithEmptyCatalogue();
    const policy = policyPermitting({
      id: 'gpt-6-turbo',
      contextWindowTokens: 2_000_000,
      maxOutputTokens: 500,
    });

    expect(() =>
      svc.assertPromptFits({
        provider,
        model: 'gpt-6-turbo',
        policy,
        systemPrompt: 'short',
        userContent: 'also short',
      }),
    ).not.toThrow();
  });

  it('does not refuse a model NOTHING can describe — no entry numbers and no catalogue — the job is the backstop', () => {
    // `resolveModel` already established the model is permitted; a model that
    // resolves to nothing has no context window to check the prompt against,
    // so this method deliberately does not refuse it here, however long the
    // prompt is. `note.generate`'s own check is what backstops this case.
    const svc = service();
    const provider = providerWithEmptyCatalogue();
    const policy = policyPermitting({ id: 'gpt-6-turbo' }); // no numbers at all

    expect(() =>
      svc.assertPromptFits({
        provider,
        model: 'gpt-6-turbo',
        policy,
        systemPrompt: 'x'.repeat(10),
        userContent: 'y'.repeat(50_000),
      }),
    ).not.toThrow();
  });

  it('still budgets correctly against the BUILD catalogue when the entry carries no numbers of its own', () => {
    // Regression guard the other direction: the #78 fix must not stop
    // budgeting a model the build already knows just because the policy entry
    // itself carries no numbers.
    const svc = service();
    const provider = {
      ...providerWithEmptyCatalogue(),
      capabilities: {
        models: [
          {
            id: 'gpt-4o',
            label: 'GPT-4o',
            contextWindowTokens: 2_000,
            maxOutputTokens: 500,
          },
        ],
        streaming: true,
        modelDiscovery: false,
      },
    } as unknown as AiProvider<never>;
    const policy = policyPermitting({ id: 'gpt-4o' });

    expect(() =>
      svc.assertPromptFits({
        provider,
        model: 'gpt-4o',
        policy,
        systemPrompt: 'x'.repeat(10),
        userContent: 'y'.repeat(5_000),
      }),
    ).toThrow(BadRequestException);
  });
});
