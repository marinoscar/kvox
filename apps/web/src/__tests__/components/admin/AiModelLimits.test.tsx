/**
 * `AiModelLimits` / `AiModelLimitChip` / `describeModelLimits` — issue #97.
 *
 * These are the shared pieces both `AiModelDiscoveryDialog` and
 * `AiPermittedModels` build their provenance chip and override control from
 * (see `AiModelLimits.tsx`'s own file header for why they live in one place).
 * Covering the behaviour here — what each provenance state SAYS, and how the
 * override round-trips and validates — proves it once rather than twice with
 * the two callers able to drift apart.
 */

import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import {
  AiModelLimitChip,
  AiModelLimits,
  describeModelLimits,
  type ModelLimitProvenance,
} from '../../../components/admin/AiModelLimits';
import {
  EMPTY_MODEL_NUMBERS,
  parseModelNumbers,
  type ModelNumbersDraft,
} from '../../../components/admin/AiModelNumberFields';

// ============================================================================
// Provenance copy — one case per `AiModelLimitSource`, plus the override that
// outranks all three.
// ============================================================================

describe('describeModelLimits / AiModelLimitChip: provenance copy', () => {
  it('renders "Known model" for an exact catalogue hit', () => {
    const provenance: ModelLimitProvenance = {
      source: 'catalogue',
      derivedFrom: null,
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    };

    render(<AiModelLimitChip description={describeModelLimits(provenance, false)} />);

    expect(screen.getByText('Known model')).toBeInTheDocument();
  });

  it('a derived match names the catalogue id it was matched against', () => {
    const provenance: ModelLimitProvenance = {
      source: 'derived',
      derivedFrom: 'gpt-5.4-mini',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    };

    render(<AiModelLimitChip description={describeModelLimits(provenance, false)} />);

    expect(screen.getByText(/gpt-5\.4-mini/)).toBeInTheDocument();
  });

  it('a conservative default says so, not as a warning to clear', () => {
    const provenance: ModelLimitProvenance = {
      source: 'default',
      derivedFrom: null,
      contextWindowTokens: 32_000,
      maxOutputTokens: 4_096,
    };

    render(<AiModelLimitChip description={describeModelLimits(provenance, false)} />);

    expect(screen.getByText(/conservative default/i)).toBeInTheDocument();
  });

  it('an administrator override says "Custom limits", outranking catalogue, derived and default alike', () => {
    const sources: ModelLimitProvenance[] = [
      { source: 'catalogue', derivedFrom: null, contextWindowTokens: 1, maxOutputTokens: 1 },
      { source: 'derived', derivedFrom: 'x', contextWindowTokens: 1, maxOutputTokens: 1 },
      { source: 'default', derivedFrom: null, contextWindowTokens: 1, maxOutputTokens: 1 },
    ];

    for (const provenance of sources) {
      const { unmount } = render(
        <AiModelLimitChip description={describeModelLimits(provenance, true)} />,
      );
      expect(screen.getByText('Custom limits')).toBeInTheDocument();
      expect(screen.queryByText(/known model|auto-detected/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('a null provenance (nothing has answered for this model yet) renders a neutral fallback, never a specific claim', () => {
    render(<AiModelLimitChip description={describeModelLimits(null, false)} />);

    expect(screen.getByText('Limits set by this deployment')).toBeInTheDocument();
  });
});

// ============================================================================
// The `AiModelLimits` control itself: the override round trip and validation.
//
// A tiny stateful harness stands in for the real caller, because both
// `draft` and the submitted payload it produces are only meaningful as a
// controlled loop through `onChange` — exactly as `AiPermittedModels` and
// `AiModelDiscoveryDialog` each wire it.
// ============================================================================

function Harness({
  provenance = null,
  canOverride = true,
  showExplanation = false,
}: {
  provenance?: ModelLimitProvenance | null;
  canOverride?: boolean;
  showExplanation?: boolean;
}) {
  const [draft, setDraft] = useState<ModelNumbersDraft>(EMPTY_MODEL_NUMBERS);

  return (
    <>
      <AiModelLimits
        modelId="gpt-9-turbo"
        provenance={provenance}
        draft={draft}
        onChange={setDraft}
        canOverride={canOverride}
        showExplanation={showExplanation}
      />
      {/* Stands in for what a save would actually send — the one parse at the
          submit boundary, `parseModelNumbers`, applied to whatever `onChange`
          has accumulated. Exposed as text rather than a ref so the assertion
          below can read it the same way the rest of this file reads the DOM. */}
      <div data-testid="submitted-payload">
        {JSON.stringify(parseModelNumbers(draft))}
      </div>
    </>
  );
}

const CATALOGUE_PROVENANCE: ModelLimitProvenance = {
  source: 'catalogue',
  derivedFrom: null,
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_384,
};

describe('AiModelLimits: override round trip', () => {
  it('hides the number fields until Override is pressed, then round-trips a typed context window into the submitted payload', async () => {
    const user = userEvent.setup();
    render(<Harness provenance={CATALOGUE_PROVENANCE} />);

    expect(
      screen.queryByLabelText(/context window in tokens for gpt-9-turbo/i),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('submitted-payload')).toHaveTextContent('{}');

    await user.click(screen.getByRole('button', { name: /^override$/i }));

    const field = await screen.findByLabelText(/context window in tokens for gpt-9-turbo/i);
    await user.type(field, '99000');

    expect(field).toHaveValue(99_000);
    expect(screen.getByTestId('submitted-payload')).toHaveTextContent(
      JSON.stringify({ contextWindowTokens: 99_000 }),
    );
  });

  it('"Use detected limits" clears the override back out and hides the fields again', async () => {
    const user = userEvent.setup();
    render(<Harness provenance={CATALOGUE_PROVENANCE} />);

    await user.click(screen.getByRole('button', { name: /^override$/i }));
    await user.type(
      await screen.findByLabelText(/context window in tokens for gpt-9-turbo/i),
      '99000',
    );
    expect(screen.getByTestId('submitted-payload')).toHaveTextContent(
      JSON.stringify({ contextWindowTokens: 99_000 }),
    );

    await user.click(screen.getByRole('button', { name: /use detected limits/i }));

    expect(screen.getByTestId('submitted-payload')).toHaveTextContent('{}');
    // `Collapse unmountOnExit` removes the fields from the DOM only once its
    // exit transition finishes, so this settles asynchronously.
    await waitFor(() =>
      expect(
        screen.queryByLabelText(/context window in tokens for gpt-9-turbo/i),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('AiModelLimits: validation', () => {
  it('a typed maxOutputTokens greater than the effective context window is an error attached to the field the user typed in', async () => {
    const user = userEvent.setup();
    render(<Harness provenance={CATALOGUE_PROVENANCE} />);

    await user.click(screen.getByRole('button', { name: /^override$/i }));
    const outputField = await screen.findByLabelText(
      /maximum output tokens for gpt-9-turbo/i,
    );
    await user.type(outputField, '200000');

    expect(
      await screen.findByText(/cannot exceed the context window \(128,000 tokens\)/i),
    ).toBeInTheDocument();
    expect(outputField).toHaveAttribute('aria-invalid', 'true');
    // The untouched field is not blamed for a value it never held.
    expect(
      screen.getByLabelText(/context window in tokens for gpt-9-turbo/i),
    ).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('a non-numeric typed value is rejected', async () => {
    const user = userEvent.setup();
    render(<Harness provenance={CATALOGUE_PROVENANCE} />);

    await user.click(screen.getByRole('button', { name: /^override$/i }));
    await user.type(
      await screen.findByLabelText(/context window in tokens for gpt-9-turbo/i),
      '12abc',
    );

    expect(
      await screen.findByText(/must be a whole number between 1,024 and 10,000,000 tokens/i),
    ).toBeInTheDocument();
  });

  it('a typed value at or below zero is rejected', async () => {
    const user = userEvent.setup();
    render(<Harness provenance={CATALOGUE_PROVENANCE} />);

    await user.click(screen.getByRole('button', { name: /^override$/i }));
    await user.type(
      await screen.findByLabelText(/maximum output tokens for gpt-9-turbo/i),
      '0',
    );

    expect(
      await screen.findByText(/must be a whole number between 64 and 1,000,000 tokens/i),
    ).toBeInTheDocument();
  });

  it('a blank field is always valid — the ordinary state since #97', async () => {
    render(<Harness provenance={CATALOGUE_PROVENANCE} />);

    // No override pressed at all: nothing to type, nothing to be wrong.
    expect(screen.queryByText(/must be a whole number/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cannot exceed the context window/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('submitted-payload')).toHaveTextContent('{}');
  });
});
