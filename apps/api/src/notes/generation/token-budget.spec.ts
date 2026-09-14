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
  SAFETY_MARGIN_TOKENS,
  assertWithinBudget,
  budgetRefusalMessage,
  computeTokenBudget,
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
