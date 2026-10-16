import {
  AI_PROVIDER_THROTTLE_PREFIX,
  KvoxEventEmitterEvents,
  OUTPUT_RESERVE_TOKENS,
  Prisma,
  REASONING_HEADROOM_TOKENS,
  SAFETY_MARGIN_TOKENS,
  TRANSCRIPTION_THROTTLE_KEY,
  aiProviderThrottleKey,
  assertWithinBudget,
  budgetRefusalMessage,
  computeTokenBudget,
  matchesETag,
  outputTokensForPrompt,
  versionETag,
} from '../src/core/index.js';
import { KvoxAiBudgetError, KvoxAiError } from '../src/ports/index.js';

describe('throttle keys', () => {
  it('has one bucket per user, never a shared one', () => {
    expect(aiProviderThrottleKey('a')).toBe(`${AI_PROVIDER_THROTTLE_PREFIX}:a`);
    expect(aiProviderThrottleKey('a')).not.toBe(aiProviderThrottleKey('b'));
  });

  it('keeps the transcription bucket string', () => {
    expect(TRANSCRIPTION_THROTTLE_KEY).toBe('transcription-provider');
  });
});

describe('token budget', () => {
  const model = { contextWindowTokens: 200_000, modelMaxOutputTokens: 64_000 };

  it('holds back the reserve and the safety margin from the window', () => {
    const budget = computeTokenBudget({ ...model, policyMaxOutputTokens: null, policyMaxInputTokens: null });
    expect(budget.maxOutputTokens).toBe(64_000);
    expect(budget.outputSource).toBe('model');
    expect(budget.availableInputTokens).toBe(200_000 - OUTPUT_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS);
  });

  it('adds reasoning headroom on top of a typed answer cap', () => {
    const budget = computeTokenBudget({
      ...model,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: null,
      reasoningEffort: 'low',
    });
    expect(budget.maxOutputTokens).toBe(4_000 + REASONING_HEADROOM_TOKENS.low);
    expect(budget.outputSource).toBe('policy');
  });

  it('lets a typed input cap narrow, never widen', () => {
    const budget = computeTokenBudget({ ...model, policyMaxOutputTokens: null, policyMaxInputTokens: 1_000 });
    expect(budget.availableInputTokens).toBe(1_000);
    expect(budget.inputSource).toBe('policy');
  });

  it('shrinks the completion to what the window has left', () => {
    const budget = computeTokenBudget({ ...model, policyMaxOutputTokens: null, policyMaxInputTokens: null });
    expect(outputTokensForPrompt(budget, 190_000)).toBe(200_000 - 190_000 - SAFETY_MARGIN_TOKENS);
    expect(outputTokensForPrompt(budget, 500_000)).toBe(0);
  });

  it('refuses with both numbers and never truncates', () => {
    expect(() => assertWithinBudget({ promptTokens: 10, availableInputTokens: 10, model: 'm' })).not.toThrow();
    try {
      assertWithinBudget({ promptTokens: 14_200, availableInputTokens: 11_500, model: 'gpt-x' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(KvoxAiBudgetError);
      expect(error).toBeInstanceOf(KvoxAiError);
      expect((error as KvoxAiBudgetError).errorClass).toBe('budget');
      expect((error as KvoxAiBudgetError).required).toBe(14_200);
      expect((error as KvoxAiBudgetError).available).toBe(11_500);
      expect((error as Error).message).toBe(
        budgetRefusalMessage({ promptTokens: 14_200, availableInputTokens: 11_500, model: 'gpt-x' }),
      );
      expect((error as Error).message).toContain('14,200');
    }
  });
});

describe('ETags', () => {
  it('builds a weak validator and matches it weakly, in a list, and with *', () => {
    expect(versionETag(3)).toBe('W/"v3"');
    expect(matchesETag('"v3"', 'W/"v3"')).toBe(true);
    expect(matchesETag('W/"v2", W/"v3"', versionETag(3))).toBe(true);
    expect(matchesETag('*', versionETag(3))).toBe(true);
    expect(matchesETag('W/"v2"', versionETag(3))).toBe(false);
    expect(matchesETag(undefined, versionETag(3))).toBe(false);
  });
});

describe('KvoxEventEmitterEvents', () => {
  it('delivers, unsubscribes and survives a throwing or rejecting listener', async () => {
    const events = new KvoxEventEmitterEvents();
    const seen: unknown[] = [];
    const off = events.subscribe('a.b', (payload) => {
      seen.push(payload);
    });
    events.subscribe('a.b', () => {
      throw new Error('boom');
    });
    events.subscribe('a.b', async () => {
      throw new Error('async boom');
    });
    events.emit('a.b', 1);
    off();
    events.emit('a.b', 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([1]);
  });
});

describe('Prisma helpers', () => {
  it('build parameterised fragments through the optional peer', () => {
    const id = 'x';
    const fragment = Prisma.sql`SELECT 1 WHERE id = ${id}`;
    expect(fragment.strings.join('?')).toContain('WHERE id =');
    expect(fragment.values).toEqual(['x']);
    expect(Prisma.join([1, 2]).values).toEqual([1, 2]);
    expect(Prisma.raw('now()').strings).toEqual(['now()']);
    expect(Prisma.empty.strings).toEqual(['']);
  });
});
