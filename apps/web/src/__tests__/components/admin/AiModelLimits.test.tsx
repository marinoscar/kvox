/**
 * `AiModelLimits` / `AiModelNumberFields` — the "Limits and default model"
 * section of `/admin/settings/ai` (issue #477, repurposed from the per-model
 * override of #97).
 *
 * Rendered through a small stateful harness so an edit flows back in as the
 * next `value`, exactly as the container drives it. The pure helpers
 * (`validateLimits`, `toLimitsInput`, `integerFieldError`) are covered directly:
 * they are what makes a 400 prevented rather than reported.
 */

import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import {
  AiModelLimits,
  limitsHaveError,
  toLimitsDraft,
  toLimitsInput,
  validateLimits,
  type AiLimitsDraft,
} from '../../../components/admin/AiModelLimits';
import {
  integerFieldError,
  parseOptionalInteger,
} from '../../../components/admin/AiModelNumberFields';
import type { AiTasksSettings } from '../../../services/aiTasks';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const MODELS = [
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
];

const SETTINGS: AiTasksSettings = {
  taskModels: {},
  graphEnabled: false,
  defaultModel: 'gpt-4o',
  maxInputTokens: null,
  maxOutputTokens: 4_096,
  requestTimeoutMs: 600_000,
  maxDocumentBytes: 26_214_400,
  reasoningEffort: 'none',
};

function Harness({
  initial = toLimitsDraft(SETTINGS),
  disabled = false,
  onDraft,
}: {
  initial?: AiLimitsDraft;
  disabled?: boolean;
  onDraft?: (draft: AiLimitsDraft) => void;
}) {
  const [value, setValue] = useState(initial);
  const errors = validateLimits(
    value,
    MODELS.map((m) => m.id),
  );
  onDraft?.(value);
  return (
    <AiModelLimits
      value={value}
      onChange={setValue}
      errors={errors}
      models={MODELS}
      disabled={disabled}
    />
  );
}

describe('integerFieldError / parseOptionalInteger', () => {
  const bounds = { min: 10, max: 1000 };

  it('treats blank as valid only for an optional field', () => {
    expect(integerFieldError('', bounds, 'tokens', true)).toBeNull();
    expect(integerFieldError('  ', bounds, 'tokens', true)).toBeNull();
    expect(integerFieldError('', bounds, 'tokens', false)).toMatch(/whole number between 10 and 1,000 tokens/);
  });

  it('rejects out-of-range values and spellings parseInt would silently accept', () => {
    for (const raw of ['9', '1001', '1e3', '12.5', '12abc', '-20']) {
      expect(integerFieldError(raw, bounds, 'tokens', true), raw).not.toBeNull();
    }
    expect(integerFieldError('10', bounds, 'tokens', false)).toBeNull();
    expect(integerFieldError('1000', bounds, 'tokens', false)).toBeNull();
  });

  it('parses a blank cap to null and a number to itself', () => {
    expect(parseOptionalInteger('')).toBeNull();
    expect(parseOptionalInteger(' 256 ')).toBe(256);
  });
});

describe('validateLimits / toLimitsInput', () => {
  it('round-trips the stored settings into a draft and back unchanged', () => {
    const draft = toLimitsDraft(SETTINGS);
    expect(draft).toEqual({
      defaultModel: 'gpt-4o',
      maxInputTokens: '',
      maxOutputTokens: '4096',
      requestTimeoutMs: '600000',
      maxDocumentBytes: '26214400',
      reasoningEffort: 'none',
    });
    expect(limitsHaveError(validateLimits(draft, ['gpt-4o']))).toBe(false);
    expect(toLimitsInput(draft)).toEqual({
      defaultModel: 'gpt-4o',
      maxInputTokens: null,
      maxOutputTokens: 4096,
      requestTimeoutMs: 600000,
      maxDocumentBytes: 26214400,
      reasoningEffort: 'none',
    });
  });

  it('sends null, never undefined, for a blank cap and for no default model', () => {
    const draft = { ...toLimitsDraft(SETTINGS), defaultModel: '', maxOutputTokens: '' };
    const input = toLimitsInput(draft);
    expect(input.defaultModel).toBeNull();
    expect(input.maxOutputTokens).toBeNull();
    expect(input.maxInputTokens).toBeNull();
  });

  it('flags a default that is not an enabled model, but not when no catalogue is known', () => {
    const draft = { ...toLimitsDraft(SETTINGS), defaultModel: 'gpt-3.5' };
    expect(validateLimits(draft, ['gpt-4o']).defaultModel).toMatch(/not enabled/i);
    expect(validateLimits(draft, []).defaultModel).toBeNull();
    expect(validateLimits({ ...draft, defaultModel: '' }, ['gpt-4o']).defaultModel).toBeNull();
  });

  it('requires the timeout and document ceiling, and bounds every number', () => {
    const base = toLimitsDraft(SETTINGS);
    expect(validateLimits({ ...base, requestTimeoutMs: '' }, []).requestTimeoutMs).not.toBeNull();
    expect(validateLimits({ ...base, requestTimeoutMs: '999' }, []).requestTimeoutMs).not.toBeNull();
    expect(validateLimits({ ...base, maxDocumentBytes: '65535' }, []).maxDocumentBytes).not.toBeNull();
    expect(validateLimits({ ...base, maxInputTokens: '255' }, []).maxInputTokens).not.toBeNull();
    expect(validateLimits({ ...base, maxOutputTokens: '63' }, []).maxOutputTokens).not.toBeNull();
    expect(limitsHaveError(validateLimits(base, []))).toBe(false);
  });
});

describe('AiModelLimits', () => {
  it('renders the section with every field filled from the draft', () => {
    render(<Harness />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Limits and default model' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Max output tokens (optional)')).toHaveValue(4096);
    expect(screen.getByLabelText('Max input tokens (optional)')).toHaveValue(null);
    expect(screen.getByLabelText('Request timeout (ms)')).toHaveValue(600000);
    expect(screen.getByLabelText('Max document size (bytes)')).toHaveValue(26214400);
  });

  it('writes an edited number back through onChange', async () => {
    const user = userEvent.setup();
    let latest: AiLimitsDraft | undefined;
    render(<Harness onDraft={(d) => (latest = d)} />);

    const field = screen.getByLabelText('Max input tokens (optional)');
    await user.type(field, '5000');

    expect(latest?.maxInputTokens).toBe('5000');
  });

  it('shows the range message under a field that is out of bounds', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.clear(screen.getByLabelText('Request timeout (ms)'));
    await user.type(screen.getByLabelText('Request timeout (ms)'), '5');

    expect(screen.getByText(/whole number between 1,000 and 3,600,000 milliseconds/i)).toBeInTheDocument();
  });

  it('lists the enabled models plus None as default-model options', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('combobox', { name: 'Default model' }));
    const listbox = await screen.findByRole('listbox');
    const names = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual(['None', 'GPT-4o (gpt-4o)', 'gpt-4o-mini']);
  });

  it('keeps a stale default visible and flagged rather than silently clearing it', () => {
    render(<Harness initial={{ ...toLimitsDraft(SETTINGS), defaultModel: 'gpt-3.5' }} />);

    expect(screen.getByRole('combobox', { name: 'Default model' })).toHaveTextContent(
      'gpt-3.5 (not enabled)',
    );
    expect(screen.getByText(/this model is not enabled/i)).toBeInTheDocument();
  });

  it('says that Extra high runs as High', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByText(/extra high runs as high/i)).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Reasoning effort' }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: /extra high \(runs as high\)/i })).toBeInTheDocument();
  });

  it('disables every control when read-only', () => {
    render(<Harness disabled />);

    expect(screen.getByLabelText('Max input tokens (optional)')).toBeDisabled();
    expect(screen.getByLabelText('Request timeout (ms)')).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Default model' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<Harness />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
