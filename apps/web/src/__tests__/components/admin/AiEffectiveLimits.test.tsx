/**
 * `AiEffectiveLimits` (issue #436) — the per-permitted-model effective token
 * limits rendered on `/admin/settings/ai`'s Limits section.
 *
 * The component renders exactly what it is given (its own header says it
 * computes nothing), so these tests exercise rendering logic only: the
 * input/output numbers and their `(model maximum)`/`(your cap)` captions, the
 * `'default'`-source conservative-floor warning, the stale note, and the
 * empty-list note.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { AiEffectiveLimits } from '../../../components/admin/AiEffectiveLimits';
import type { AiEffectiveLimit } from '../../../services/ai';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const baseLimit: AiEffectiveLimit = {
  modelId: 'gpt-4o',
  label: 'GPT-4o',
  source: 'catalogue',
  derivedFrom: null,
  modelContextWindowTokens: 128_000,
  modelMaxOutputTokens: 16_384,
  maxInputTokens: 128_000,
  maxOutputTokens: 16_384,
  inputSource: 'model',
  outputSource: 'model',
};

describe('AiEffectiveLimits', () => {
  it('renders each model with its effective input/output and where each came from', () => {
    render(<AiEffectiveLimits limits={[baseLimit]} stale={false} />);

    const row = screen.getByTestId('ai-effective-limit-gpt-4o');
    expect(within(row).getByText('GPT-4o')).toBeInTheDocument();
    expect(
      within(row).getByText('Input 128,000 tokens (model maximum) · Output 16,384 tokens (model maximum)'),
    ).toBeInTheDocument();
  });

  it('labels a capped model as "your cap" for whichever side the policy binds', () => {
    const capped: AiEffectiveLimit = {
      ...baseLimit,
      modelId: 'gpt-4o-mini',
      label: 'GPT-4o mini',
      maxInputTokens: 50_000,
      maxOutputTokens: 4_096,
      inputSource: 'policy',
      outputSource: 'policy',
    };
    render(<AiEffectiveLimits limits={[capped]} stale={false} />);

    const row = screen.getByTestId('ai-effective-limit-gpt-4o-mini');
    expect(
      within(row).getByText('Input 50,000 tokens (your cap) · Output 4,096 tokens (your cap)'),
    ).toBeInTheDocument();
  });

  it('shows a model id caption only when it differs from the label', () => {
    render(<AiEffectiveLimits limits={[baseLimit]} stale={false} />);
    // label === modelId ('GPT-4o' vs 'gpt-4o') differ in case, so it IS shown.
    const row = screen.getByTestId('ai-effective-limit-gpt-4o');
    expect(within(row).getByText('gpt-4o')).toBeInTheDocument();
  });

  it('shows the conservative-floor warning and its numbers when source is "default", and not otherwise', () => {
    const defaulted: AiEffectiveLimit = {
      ...baseLimit,
      modelId: 'gpt-unknown',
      label: 'gpt-unknown',
      source: 'default',
      modelContextWindowTokens: 32_000,
      modelMaxOutputTokens: 4_096,
      maxInputTokens: 32_000,
      maxOutputTokens: 4_096,
    };
    render(<AiEffectiveLimits limits={[baseLimit, defaulted]} stale={false} />);

    // The catalogue-sourced model gets no warning.
    expect(
      within(screen.getByTestId('ai-effective-limit-gpt-4o')).queryByText(/real capacity is unknown/i),
    ).not.toBeInTheDocument();

    const defaultRow = screen.getByTestId('ai-effective-limit-gpt-unknown');
    expect(within(defaultRow).getByText(/real capacity is unknown/i)).toBeInTheDocument();
    expect(within(defaultRow).getByText(/context 32,000/)).toBeInTheDocument();
    expect(within(defaultRow).getByText(/output 4,096 tokens/)).toBeInTheDocument();
    expect(within(defaultRow).getByText(/Permitted models/)).toBeInTheDocument();
  });

  it('shows the "save to see the effect" note when the draft differs from the saved settings, and the plain note otherwise', () => {
    const { rerender } = render(<AiEffectiveLimits limits={[baseLimit]} stale={false} />);
    expect(screen.getByText('Reflects the saved settings.')).toBeInTheDocument();
    expect(screen.queryByText(/save to see the effect/i)).not.toBeInTheDocument();

    rerender(<AiEffectiveLimits limits={[baseLimit]} stale />);
    expect(
      screen.getByText('Reflects the saved settings — save to see the effect of your changes above.'),
    ).toBeInTheDocument();
  });

  it('shows a note instead of a list when there are no permitted models', () => {
    render(<AiEffectiveLimits limits={[]} stale={false} />);

    expect(
      screen.getByText(/no permitted model of the active provider to show/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(/ai-effective-limit-/)).not.toBeInTheDocument();
  });

  it('passes axe', async () => {
    const { container } = render(
      <AiEffectiveLimits
        limits={[baseLimit, { ...baseLimit, modelId: 'gpt-unknown-2', source: 'default' }]}
        stale={false}
      />,
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
