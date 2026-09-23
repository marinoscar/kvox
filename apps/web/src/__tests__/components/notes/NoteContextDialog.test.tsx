/**
 * `NoteContextDialog` — issue #308.
 *
 * `useNoteGenerationContext` is mocked so this suite is entirely about how the
 * dialog RENDERS whatever the hook hands it — the three tabs, the two warning
 * alerts, the facts line, copy and download — rather than about fetching,
 * which is `useNoteGenerationContext.test.tsx`'s job.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

vi.mock('../../../hooks/useNoteGenerationContext', () => ({
  useNoteGenerationContext: vi.fn(),
}));

import { render } from '../../utils/test-utils';
import {
  NoteContextDialog,
  fullPromptText,
  contextFileName,
  CONTEXT_SEPARATOR,
  CONTEXT_TRUNCATE_THRESHOLD,
  CONTEXT_TRUNCATED_PREVIEW,
} from '../../../components/notes/NoteContextDialog';
import { useNoteGenerationContext } from '../../../hooks/useNoteGenerationContext';
import type { UseNoteGenerationContextResult } from '../../../hooks/useNoteGenerationContext';
import type { NoteGenerationContext } from '../../../services/notes';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const mockUseContext = vi.mocked(useNoteGenerationContext);

function context(overrides: Partial<NoteGenerationContext> = {}): NoteGenerationContext {
  return {
    generationId: 'gen-1',
    kind: 'create',
    status: 'succeeded',
    stored: true,
    capturedAt: '2026-01-01T09:30:00.000Z',
    templateId: 'tpl-1',
    templateNameSnapshot: 'Meeting minutes',
    provider: 'openai',
    model: 'gpt-4o-mini',
    contextText: null,
    sourceType: 'transcript',
    sourceVersion: 7,
    sourceRedacted: false,
    systemPrompt: 'You write meeting notes.\nBe brief.',
    userContent: 'Ana and Ben discussed the budget.',
    promptTokens: 500,
    completionTokens: 200,
    ...overrides,
  };
}

function mockResult(overrides: Partial<UseNoteGenerationContextResult> = {}) {
  mockUseContext.mockReturnValue({
    context: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  });
}

function setClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

function renderDialog(props: Partial<React.ComponentProps<typeof NoteContextDialog>> = {}) {
  return render(
    <NoteContextDialog open noteId="n1" noteTitle="Q3 planning" onClose={vi.fn()} {...props} />,
  );
}

beforeEach(() => {
  mockUseContext.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NoteContextDialog — the three tabs', () => {
  it('renders the right slice of the prompt for each tab', async () => {
    const user = userEvent.setup();
    mockResult({ context: context() });
    renderDialog();

    // "Full prompt" is the default tab: both halves, joined by the separator.
    // ⚠ `getByRole('tabpanel')`, not `getByLabelText` — the panel's own
    // `aria-labelledby` resolves to the SAME tab text as the `<pre>`'s own
    // `aria-label`, so a label lookup here would match both.
    expect(screen.getByRole('tabpanel')).toHaveTextContent(
      'You write meeting notes. Be brief. --- Ana and Ben discussed the budget.',
    );

    await user.click(screen.getByRole('tab', { name: 'Instructions' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('You write meeting notes. Be brief.');

    await user.click(screen.getByRole('tab', { name: 'Context & source' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent(
      'Ana and Ben discussed the budget.',
    );
  });
});

describe('NoteContextDialog — copy', () => {
  it('"Copy all" puts systemPrompt + separator + userContent on the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = setClipboard();
    mockResult({ context: context() });
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Copy all' }));

    const expected = context().systemPrompt + CONTEXT_SEPARATOR + context().userContent;
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(writeText).toHaveBeenCalledWith(fullPromptText(context()));
  });

  it('a per-tab copy button copies only that tab’s text', async () => {
    const user = userEvent.setup();
    const writeText = setClipboard();
    mockResult({ context: context() });
    renderDialog();

    await user.click(screen.getByRole('tab', { name: 'Instructions' }));
    await user.click(screen.getByRole('button', { name: /Copy instructions/i }));

    expect(writeText).toHaveBeenCalledWith('You write meeting notes.\nBe brief.');
  });
});

describe('NoteContextDialog — stored: false', () => {
  it('shows the pre-capture warning, and "Not recorded" with a disabled copy on Context & source', async () => {
    const user = userEvent.setup();
    mockResult({
      context: context({ stored: false, userContent: null }),
    });
    renderDialog();

    expect(
      screen.getByText(/generated before full context capture existed/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Context & source' }));

    expect(screen.getByText('Not recorded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy context & source/i })).toBeDisabled();
  });
});

describe('NoteContextDialog — sourceRedacted', () => {
  it('shows an info alert when the source was withheld', () => {
    mockResult({ context: context({ sourceRedacted: true }) });
    renderDialog();

    expect(
      screen.getByText(/no longer have access to this note.s source/i),
    ).toBeInTheDocument();
  });
});

describe('NoteContextDialog — failed generation', () => {
  it('says this generation failed, and that this is what was sent', () => {
    mockResult({ context: context({ status: 'failed' }) });
    renderDialog();

    expect(
      screen.getByText('This generation failed; this is what was sent.'),
    ).toBeInTheDocument();
  });
});

describe('NoteContextDialog — no generation yet', () => {
  it('says the note has no generation, rather than showing an error', () => {
    mockResult({ context: null, isLoading: false, error: null });
    renderDialog();

    expect(screen.getByText('This note has no generation yet.')).toBeInTheDocument();
  });
});

describe('NoteContextDialog — error', () => {
  it('shows the error and refetches on Retry', async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    mockResult({ error: 'The context could not be loaded', refresh });
    renderDialog();

    expect(screen.getByText('The context could not be loaded')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('NoteContextDialog — download', () => {
  it('creates a Blob via URL.createObjectURL, named with the sanitised file name', async () => {
    const user = userEvent.setup();
    mockResult({ context: context() });

    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderDialog({ noteTitle: 'Q3 planning: "decisions"/notes' });

    await user.click(screen.getByRole('button', { name: 'Download .txt' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const [blob] = createObjectURL.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/plain;charset=utf-8');
    expect(contextFileName('Q3 planning: "decisions"/notes')).toBe(
      'Q3 planning_ _decisions_notes – context.txt',
    );

    clickSpy.mockRestore();
  });
});

describe('NoteContextDialog — the facts line', () => {
  it('names the captured time, template, model/provider, source version and tokens', () => {
    mockResult({ context: context() });
    renderDialog();

    const facts = screen.getByTestId('note-context-facts');
    expect(facts).toHaveTextContent('Meeting minutes');
    expect(facts).toHaveTextContent('gpt-4o-mini · openai');
    expect(facts).toHaveTextContent('transcript v7');
    expect(facts).toHaveTextContent('500 in / 200 out');
  });
});

describe('NoteContextDialog — truncation', () => {
  it('shows "Show all" past the threshold, but always copies the full text', async () => {
    const user = userEvent.setup();
    const writeText = setClipboard();
    const longText = 'a'.repeat(CONTEXT_TRUNCATE_THRESHOLD + 1);
    mockResult({ context: context({ systemPrompt: null, userContent: longText }) });
    renderDialog();

    // "Full prompt" tab shows just `userContent` here (systemPrompt is null).
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`showing the first ${CONTEXT_TRUNCATED_PREVIEW.toLocaleString()} characters`)),
    ).toBeInTheDocument();

    // The per-tab copy button still sends the WHOLE text, not the preview.
    await user.click(screen.getByRole('button', { name: /Copy full prompt/i }));
    expect(writeText).toHaveBeenCalledWith(longText);

    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
  });
});

describe('NoteContextDialog — accessibility', () => {
  it('has no axe violations', async () => {
    setClipboard();
    mockResult({ context: context() });
    renderDialog();

    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});
