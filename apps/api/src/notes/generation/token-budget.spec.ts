// =============================================================================
// The token budget refuses with a number (issue #49, docs/specs/notes.md §3.3)
// =============================================================================
//
// Two things are asserted here that are easy to lose in a later refactor: the
// budget takes the SMALLER of the model's window and the deployment's ceiling
// (dropping either would silently discard an operator's cost lever or produce a
// prompt the vendor rejects), and the refusal names BOTH counts. An error that
// could only say "too large" would satisfy the type and defeat the requirement.
// =============================================================================

import { AiBudgetError } from '../../ai/ai-errors';
import {
  OUTPUT_RESERVE_TOKENS,
  REASONING_HEADROOM_TOKENS,
  SAFETY_MARGIN_TOKENS,
  assertWithinBudget,
  budgetRefusalMessage,
  computeTokenBudget,
  outputTokensForPrompt,
} from './token-budget';

describe('computeTokenBudget', () => {
  it('subtracts the output allowance and the safety margin from the context window', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 128_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: 2_000_000,
    });

    expect(budget.maxOutputTokens).toBe(4_000);
    expect(budget.availableInputTokens).toBe(128_000 - 4_000 - SAFETY_MARGIN_TOKENS);
  });

  it('takes the DEPLOYMENT ceiling when it is the smaller of the two', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 128_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: 10_000,
    });

    expect(budget.availableInputTokens).toBe(10_000);
  });

  it('takes the MODEL window when the deployment ceiling is larger', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 8_000,
      modelMaxOutputTokens: 4_000,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: 1_000_000,
    });

    expect(budget.availableInputTokens).toBe(8_000 - 4_000 - SAFETY_MARGIN_TOKENS);
  });

  it('narrows the output allowance to the smaller of model and policy', () => {
    expect(
      computeTokenBudget({
        contextWindowTokens: 128_000,
        modelMaxOutputTokens: 2_000,
        policyMaxOutputTokens: 90_000,
        policyMaxInputTokens: 1_000_000,
      }).maxOutputTokens,
    ).toBe(2_000);
  });

  it('never reports a negative input allowance', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 4_000,
      modelMaxOutputTokens: 8_000,
      policyMaxOutputTokens: 8_000,
      policyMaxInputTokens: 1_000_000,
    });

    expect(budget.availableInputTokens).toBe(0);
  });
});

// =============================================================================
// null caps — the model's own maximum governs (issue #436)
// =============================================================================

describe('computeTokenBudget — null policy caps', () => {
  it('#435/#436 scenario: a gpt-5.4-mini-like model (400k window / 128k output), no deployment caps, gives the full 128,000-token output ceiling', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 400_000,
      modelMaxOutputTokens: 128_000,
      policyMaxOutputTokens: null,
      policyMaxInputTokens: null,
    });

    expect(budget.maxOutputTokens).toBe(128_000);
    expect(budget.outputSource).toBe('model');
    // Only the reserve (capped at OUTPUT_RESERVE_TOKENS, here smaller than the
    // 128,000 ceiling) plus the safety margin is held back from the window —
    // not the whole output ceiling.
    expect(budget.availableInputTokens).toBe(400_000 - OUTPUT_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS);
    expect(budget.inputSource).toBe('model');
    expect(budget.contextWindowTokens).toBe(400_000);
  });

  it('a null policyMaxOutputTokens alone falls through to the model maximum', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 200_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: null,
      policyMaxInputTokens: 50_000,
    });

    expect(budget.maxOutputTokens).toBe(16_000);
    expect(budget.outputSource).toBe('model');
  });

  it('a null policyMaxInputTokens alone falls through to what the model window leaves after the reserve', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 200_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: null,
    });

    expect(budget.availableInputTokens).toBe(200_000 - 4_000 - SAFETY_MARGIN_TOKENS);
    expect(budget.inputSource).toBe('model');
  });
});

// =============================================================================
// Which bound decides maxOutputTokens: policy vs. task vs. model (#436)
// =============================================================================

describe('computeTokenBudget — outputSource', () => {
  it('a typed deployment cap smaller than the model max is the "policy" source', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 200_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: null,
    });

    expect(budget.maxOutputTokens).toBe(4_000);
    expect(budget.outputSource).toBe('policy');
  });

  it('a per-task clamp narrower than an unset (null) policy cap is the "task" source', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 200_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: null,
      policyMaxInputTokens: null,
      taskMaxOutputTokens: 2_000,
    });

    expect(budget.maxOutputTokens).toBe(2_000);
    expect(budget.outputSource).toBe('task');
  });

  it('a per-task clamp narrower than a typed policy cap is still the "task" source', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 200_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: null,
      taskMaxOutputTokens: 500,
    });

    expect(budget.maxOutputTokens).toBe(500);
    expect(budget.outputSource).toBe('task');
  });

  it('a tie between the policy cap and the task clamp reports "task"', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 200_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 500,
      policyMaxInputTokens: null,
      taskMaxOutputTokens: 500,
    });

    expect(budget.maxOutputTokens).toBe(500);
    expect(budget.outputSource).toBe('task');
  });

  it('a policy cap strictly smaller than the task clamp is the "policy" source', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 200_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 400,
      policyMaxInputTokens: null,
      taskMaxOutputTokens: 500,
    });

    expect(budget.maxOutputTokens).toBe(400);
    expect(budget.outputSource).toBe('policy');
  });
});

// =============================================================================
// Reasoning headroom is added ON TOP of a typed answer ceiling, bounded by the
// model's own maximum (#436 Q3)
// =============================================================================

describe('computeTokenBudget — reasoning headroom', () => {
  const efforts: Array<'none' | 'low' | 'medium' | 'high' | 'xhigh'> = ['none', 'low', 'medium', 'high', 'xhigh'];

  it.each(efforts)(
    "adds the '%s' effort's headroom on top of a typed cap, when the sum stays under the model max",
    (effort) => {
      const headroom = REASONING_HEADROOM_TOKENS[effort];
      const budget = computeTokenBudget({
        contextWindowTokens: 1_000_000,
        modelMaxOutputTokens: 500_000,
        policyMaxOutputTokens: 1_000,
        policyMaxInputTokens: null,
        reasoningEffort: effort,
      });

      expect(budget.maxOutputTokens).toBe(1_000 + headroom);
      expect(budget.outputSource).toBe('policy');
    },
  );

  it('with no reasoningEffort given, no headroom is added (treated as "none")', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 1_000_000,
      modelMaxOutputTokens: 500_000,
      policyMaxOutputTokens: 1_000,
      policyMaxInputTokens: null,
    });

    expect(budget.maxOutputTokens).toBe(1_000);
  });

  it('the headroom-augmented ceiling is bounded by the model maximum, and reports "model" as the source', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 1_000_000,
      modelMaxOutputTokens: 128_000,
      policyMaxOutputTokens: 100_000,
      policyMaxInputTokens: null,
      reasoningEffort: 'xhigh', // +65,536 -> 165,536, which exceeds the 128,000 model max
    });

    expect(budget.maxOutputTokens).toBe(128_000);
    expect(budget.outputSource).toBe('model');
  });

  it('with no typed cap (null), the model maximum already covers reasoning and no headroom arithmetic runs', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 1_000_000,
      modelMaxOutputTokens: 128_000,
      policyMaxOutputTokens: null,
      policyMaxInputTokens: null,
      reasoningEffort: 'high',
    });

    expect(budget.maxOutputTokens).toBe(128_000);
    expect(budget.outputSource).toBe('model');
  });
});

// =============================================================================
// The output reserve held back when sizing input: min(ceiling, OUTPUT_RESERVE_TOKENS)
// (#436)
// =============================================================================

describe('computeTokenBudget — output reserve', () => {
  it('reserves the full ceiling when it is smaller than OUTPUT_RESERVE_TOKENS', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 100_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 1_000,
      policyMaxInputTokens: null,
    });

    expect(budget.maxOutputTokens).toBe(1_000);
    expect(budget.availableInputTokens).toBe(100_000 - 1_000 - SAFETY_MARGIN_TOKENS);
  });

  it('caps the reserve at OUTPUT_RESERVE_TOKENS when the ceiling is larger', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 500_000,
      modelMaxOutputTokens: 128_000,
      policyMaxOutputTokens: null,
      policyMaxInputTokens: null,
    });

    expect(budget.maxOutputTokens).toBe(128_000);
    expect(budget.availableInputTokens).toBe(500_000 - OUTPUT_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS);
  });
});

// =============================================================================
// The deployment's input spend cap (#436)
// =============================================================================

describe('computeTokenBudget — policy input cap', () => {
  it('a typed input cap narrower than what the window leaves is the "policy" source', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 200_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: 10_000,
    });

    expect(budget.availableInputTokens).toBe(10_000);
    expect(budget.inputSource).toBe('policy');
  });

  it('a typed input cap wider than what the window leaves is the "model" source', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 20_000,
      modelMaxOutputTokens: 4_000,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: 1_000_000,
    });

    expect(budget.availableInputTokens).toBe(20_000 - 4_000 - SAFETY_MARGIN_TOKENS);
    expect(budget.inputSource).toBe('model');
  });
});

// =============================================================================
// outputTokensForPrompt: what one call actually requests (#436)
// =============================================================================

describe('outputTokensForPrompt', () => {
  it('requests the full ceiling when the window leaves plenty of room', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 400_000,
      modelMaxOutputTokens: 128_000,
      policyMaxOutputTokens: null,
      policyMaxInputTokens: null,
    });

    expect(outputTokensForPrompt(budget, 1_000)).toBe(128_000);
  });

  it('shrinks the completion request to what the window has left once the prompt is in it', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 400_000,
      modelMaxOutputTokens: 128_000,
      policyMaxOutputTokens: null,
      policyMaxInputTokens: null,
    });

    // 400,000 - 350,000 - 500 (SAFETY_MARGIN_TOKENS) = 49,500 < the 128,000 ceiling.
    expect(outputTokensForPrompt(budget, 350_000)).toBe(49_500);
  });

  it('never goes negative even when the prompt alone exceeds the context window', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 8_000,
      modelMaxOutputTokens: 4_000,
      policyMaxOutputTokens: null,
      policyMaxInputTokens: null,
    });

    expect(outputTokensForPrompt(budget, 20_000)).toBe(0);
  });

  it('never exceeds the budget ceiling even when the window would leave more room', () => {
    const budget = computeTokenBudget({
      contextWindowTokens: 1_000_000,
      modelMaxOutputTokens: 16_000,
      policyMaxOutputTokens: 4_000,
      policyMaxInputTokens: null,
    });

    expect(outputTokensForPrompt(budget, 100)).toBe(4_000);
  });
});

describe('assertWithinBudget', () => {
  const within = {
    promptTokens: 100,
    availableInputTokens: 100,
    model: 'gpt-4o',
    providerId: 'openai',
  };

  it('passes when the prompt exactly fills the budget', () => {
    expect(() => assertWithinBudget(within)).not.toThrow();
  });

  it('throws AiBudgetError carrying BOTH counts when it does not fit', () => {
    let thrown: unknown;

    try {
      assertWithinBudget({ ...within, promptTokens: 14_200, availableInputTokens: 11_500 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AiBudgetError);
    const budgetError = thrown as AiBudgetError;
    expect(budgetError.requiredTokens).toBe(14_200);
    expect(budgetError.availableTokens).toBe(11_500);
    expect(budgetError.providerId).toBe('openai');
  });

  it('names the actual and permitted sizes and the model in the message', () => {
    const message = budgetRefusalMessage({
      promptTokens: 14_200,
      availableInputTokens: 11_500,
      model: 'gpt-4o',
    });

    expect(message).toContain('14,200');
    expect(message).toContain('11,500');
    expect(message).toContain('gpt-4o');
    // It must tell the user what to DO, not only that something is wrong.
    expect(message.toLowerCase()).toContain('shorter source');
  });
});
