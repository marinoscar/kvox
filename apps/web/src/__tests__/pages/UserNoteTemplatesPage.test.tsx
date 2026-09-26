/**
 * `/settings/note-templates` (issue #56, epic #45).
 *
 * =============================================================================
 * WHAT IS MOCKED, AND WHY IT IS THE TRANSPORT RATHER THAN THE HOOKS
 * =============================================================================
 *
 * The SERVICE modules are mocked; every hook, every narrowing function and the
 * whole stream client are real — the same choice `UserAiPage.test.tsx` makes
 * and for a stronger version of its reason. This issue's central behaviour is a
 * statement about a REQUEST BODY ("preview posts the current unsaved form
 * state"), and it is only really proven when the real `toInlineTemplate`, the
 * real `useTemplatePreview` and the real editor state sit between the typing
 * and the assertion. A mocked hook would let this suite pass over a page that
 * previewed the last saved row.
 *
 * `services/sse.ts` is mocked one level lower still, with a FAKE CONNECTION
 * whose `close` is a spy. That is what makes two otherwise untestable claims
 * testable: frames can be delivered one at a time (so "streams in
 * incrementally" is an assertion rather than a hope), and the teardown on
 * unmount is observable — a leaked stream renders nothing wrong and would
 * otherwise be invisible until a tab had been open for an hour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

// ---------------------------------------------------------------------------
// The fake SSE connection
// ---------------------------------------------------------------------------

interface FakeConnection {
  url: string;
  onFrame: (frame: { event: string; data: string; id: string | null }) => void;
  close: ReturnType<typeof vi.fn>;
}

const connections: FakeConnection[] = [];

vi.mock('../../services/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sse')>();
  return {
    ...actual,
    connectSse: vi.fn((options: Parameters<typeof actual.connectSse>[0]) => {
      const close = vi.fn();
      connections.push({ url: options.url, onFrame: options.onFrame, close });
      return { close };
    }),
  };
});

vi.mock('../../services/ai', () => ({ getAiConfig: vi.fn() }));

vi.mock('../../services/transcripts', () => ({ getTranscripts: vi.fn() }));

// ⚠ `importOriginal` rather than a bare factory: `toInlineTemplate`,
// `toCreateInput` and `draftFromTemplate` are the functions this suite is
// really asserting about, so only the CALLS are replaced.
vi.mock('../../services/noteTemplates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/noteTemplates')>();
  return {
    ...actual,
    getNoteTemplates: vi.fn(),
    createNoteTemplate: vi.fn(),
    updateNoteTemplate: vi.fn(),
    deleteNoteTemplate: vi.fn(),
    duplicateNoteTemplate: vi.fn(),
    previewNoteTemplate: vi.fn(),
    hideNoteTemplate: vi.fn(),
    unhideNoteTemplate: vi.fn(),
  };
});

import { render } from '../utils/test-utils';
import UserNoteTemplatesPage from '../../pages/UserNoteTemplatesPage';
import { getAiConfig } from '../../services/ai';
import { getTranscripts } from '../../services/transcripts';
import {
  createNoteTemplate,
  duplicateNoteTemplate,
  getNoteTemplates,
  hideNoteTemplate,
  previewNoteTemplate,
  unhideNoteTemplate,
  updateNoteTemplate,
} from '../../services/noteTemplates';
import type { AiConfig } from '../../services/ai';
import type { NoteTemplate, NoteTemplatePreview } from '../../services/noteTemplates';
import type { TranscriptListItem } from '../../services/transcripts';

const mockGetAiConfig = vi.mocked(getAiConfig);
const mockGetTranscripts = vi.mocked(getTranscripts);
const mockGetTemplates = vi.mocked(getNoteTemplates);
const mockCreate = vi.mocked(createNoteTemplate);
const mockUpdate = vi.mocked(updateNoteTemplate);
const mockDuplicate = vi.mocked(duplicateNoteTemplate);
const mockPreview = vi.mocked(previewNoteTemplate);
const mockHide = vi.mocked(hideNoteTemplate);
const mockUnhide = vi.mocked(unhideNoteTemplate);

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: AiConfig = {
  available: true,
  provider: 'openai',
  providerLabel: 'OpenAI',
  // #97: `source`/`derivedFrom` complete the `AiConfigModel` shape — absent, a
  // provenance assertion elsewhere would silently pass against a fallback
  // chip instead of the real one.
  models: [
    {
      id: 'gpt-4o',
      label: 'GPT-4o',
      contextWindowTokens: 128_000,
      maxOutputTokens: 4_096,
      source: 'catalogue',
      derivedFrom: null,
      structuredOutput: true,
      toolCalling: true,
    },
    {
      id: 'gpt-4o-mini',
      label: 'GPT-4o mini',
      contextWindowTokens: 128_000,
      maxOutputTokens: 4_096,
      source: 'catalogue',
      derivedFrom: null,
      structuredOutput: true,
      toolCalling: true,
    },
  ],
  defaultModel: 'gpt-4o',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_096,
  keyConfigured: true,
};

function template(overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'tpl-owned',
    name: 'My meeting notes',
    description: 'How I like my meetings written up',
    instructions: 'Write up the meeting.',
    outputFormat: 'meeting_notes',
    structure: ['Overview', 'Decisions'],
    tone: 'neutral',
    length: 'short',
    model: null,
    isArchived: false,
    builtIn: false,
    hidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

const builtIn = template({
  id: 'tpl-builtin',
  name: 'Standard meeting notes',
  description: 'The seeded default',
  builtIn: true,
});

function transcript(overrides: Partial<TranscriptListItem> = {}): TranscriptListItem {
  return {
    id: 'tr-recent',
    title: 'Weekly sync — 12 March',
    status: 'ready',
    transcriptionStatus: 'succeeded',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 1_800_000,
    speakerCount: 3,
    wordCount: 4_200,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    ownerName: 'Test User',
    createdAt: '2026-03-12T09:00:00.000Z',
    updatedAt: '2026-03-12T09:30:00.000Z',
    ...overrides,
  } as TranscriptListItem;
}

const queued: NoteTemplatePreview = {
  generationId: 'gen-1',
  kind: 'preview',
  status: 'pending',
  jobId: 'job-1',
  templateId: null,
  templateName: 'My meeting notes',
  providerId: 'openai',
  model: 'gpt-4o',
  expiresAt: '2026-03-13T09:00:00.000Z',
};

function setup(options: { config?: Partial<AiConfig>; templates?: NoteTemplate[] } = {}) {
  mockGetAiConfig.mockResolvedValue({ ...baseConfig, ...options.config });
  const items = options.templates ?? [template(), builtIn];
  mockGetTemplates.mockResolvedValue({ items, total: items.length });
  mockGetTranscripts.mockResolvedValue({
    // Newest first, which is what makes "defaults to the most recent" true.
    items: [transcript(), transcript({ id: 'tr-older', title: 'Kickoff — 2 March' })],
    nextCursor: null,
  });
  mockPreview.mockResolvedValue(queued);
  mockHide.mockResolvedValue(undefined);
  mockUnhide.mockResolvedValue(undefined);
  mockCreate.mockResolvedValue(template({ id: 'tpl-new', name: 'New one' }));
  mockUpdate.mockResolvedValue(template());
}

async function renderPage() {
  const result = render(<UserNoteTemplatesPage />);
  await screen.findByRole('heading', { level: 1, name: 'Note Templates' });
  return result;
}

/** Open the editor on the caller's own template, with the source list loaded. */
async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^edit$/i }));
  await screen.findByRole('heading', { level: 2, name: 'Preview' });
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: /source recording/i })).toHaveTextContent(
      /weekly sync/i,
    ),
  );
}

/** Deliver one SSE frame on the most recent connection, inside `act`. */
function emit(event: string, data: unknown) {
  const connection = connections[connections.length - 1];
  act(() => {
    connection.onFrame({ event, data: JSON.stringify(data), id: null });
  });
}

describe('UserNoteTemplatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connections.length = 0;
    localStorage.clear();
    setup();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ==========================================================================
  // The list: built-ins are usable, not merely present
  // ==========================================================================

  describe('the list', () => {
    it('renders built-ins with Duplicate and WITHOUT an Edit affordance', async () => {
      await renderPage();

      const row = (await screen.findByText('Standard meeting notes')).closest('li') as HTMLElement;

      // ⚠ ABSENT, not disabled. A greyed-out Edit is a control the user cannot
      // explain: a built-in is immutable under every role, permanently.
      expect(within(row).queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
      expect(within(row).getByRole('button', { name: /duplicate/i })).toBeEnabled();
      // And Archive is absent for the same reason.
      expect(within(row).queryByRole('button', { name: /archive/i })).not.toBeInTheDocument();
    });

    it('says WHY a built-in row is different, rather than leaving a hole where a button was', async () => {
      await renderPage();

      const row = (await screen.findByText('Standard meeting notes')).closest('li') as HTMLElement;
      expect(
        within(row).getByLabelText(/built-in template\. duplicate it to make an editable copy/i),
      ).toBeInTheDocument();
    });

    it('gives an owned template Edit, Duplicate and Archive', async () => {
      await renderPage();

      const row = (await screen.findByText('My meeting notes')).closest('li') as HTMLElement;
      expect(within(row).getByRole('button', { name: /^edit$/i })).toBeEnabled();
      expect(within(row).getByRole('button', { name: /duplicate/i })).toBeEnabled();
      expect(within(row).getByRole('button', { name: /archive/i })).toBeEnabled();
    });

    it('opens the COPY in the editor after duplicating — the only reason to duplicate is to change it', async () => {
      const user = userEvent.setup();
      const copy = template({ id: 'tpl-copy', name: 'Standard meeting notes (copy)' });
      mockDuplicate.mockResolvedValue(copy);
      await renderPage();

      const row = (await screen.findByText('Standard meeting notes')).closest('li') as HTMLElement;
      await user.click(within(row).getByRole('button', { name: /duplicate/i }));

      expect(mockDuplicate).toHaveBeenCalledWith('tpl-builtin');
      // The editor, loaded with the copy — not the list it came from.
      expect(await screen.findByRole('heading', { level: 2, name: 'Template' })).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByLabelText(/^name/i)).toHaveValue('Standard meeting notes (copy)'),
      );
    });
  });

  // ==========================================================================
  // The editor
  // ==========================================================================

  describe('the editor', () => {
    it('offers only the models GET /api/ai/config permits, plus the deployment default', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('combobox', { name: /^model/i }));
      const options = within(screen.getByRole('listbox')).getAllByRole('option');

      expect(options.map((option) => option.textContent)).toEqual([
        'Use the deployment default (gpt-4o)',
        'GPT-4o',
        'GPT-4o mini',
      ]);
      // The picker is a Select, not a free-text box: a model policy forbids
      // cannot be typed in either.
      expect(screen.queryByRole('textbox', { name: /^model/i })).not.toBeInTheDocument();
    });

    it('shows a worked example in the Instructions placeholder, not a restatement of the label', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      const instructions = screen.getByLabelText(/^instructions/i);
      expect(instructions).toHaveAttribute('placeholder', expect.stringContaining('Example:'));
      expect(instructions.getAttribute('placeholder')).toMatch(/never invent a decision/i);
    });

    it('edits the structure as an ORDERED list — order is what the prompt numbers', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      expect(screen.getByLabelText('Section 1')).toHaveValue('Overview');
      expect(screen.getByLabelText('Section 2')).toHaveValue('Decisions');

      await user.click(screen.getByRole('button', { name: 'Move section 2 up' }));

      expect(screen.getByLabelText('Section 1')).toHaveValue('Decisions');
      expect(screen.getByLabelText('Section 2')).toHaveValue('Overview');
    });

    it('choosing Body format "Plain text" sends bodyFormat: \'plain_text\' on save (issue #334)', async () => {
      const user = userEvent.setup();
      mockUpdate.mockResolvedValue(template({ bodyFormat: 'plain_text' }));
      await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('combobox', { name: 'Body format' }));
      await user.click(await screen.findByRole('option', { name: 'Plain text' }));

      await user.click(within(screen.getByRole('region', { name: 'Template' })).getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
      expect(mockUpdate).toHaveBeenCalledWith(
        'tpl-owned',
        expect.objectContaining({ bodyFormat: 'plain_text' }),
      );
    });
  });

  // ==========================================================================
  // Preview — the part that matters
  // ==========================================================================

  describe('preview', () => {
    it('states the cost next to the action, BEFORE it is pressed', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      // Present with no preview run, and it names whose account pays.
      expect(mockPreview).not.toHaveBeenCalled();
      const notice = screen.getByText(/your own ai provider account/i);
      expect(notice).toBeInTheDocument();
      expect(screen.getByText(/each run costs again/i)).toBeInTheDocument();

      // And the button points at it, so the price is part of the control's own
      // description rather than a line met only afterwards.
      expect(screen.getByRole('button', { name: /^preview$/i })).toHaveAttribute(
        'aria-describedby',
        notice.closest('[id]')?.id,
      );
    });

    it('defaults the source to the most recent recording', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      expect(screen.getByRole('combobox', { name: /source recording/i })).toHaveTextContent(
        'Weekly sync — 12 March',
      );
    });

    it('⚠ posts the CURRENT UNSAVED form state, not the saved row', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      const instructions = screen.getByLabelText(/^instructions/i);
      await user.clear(instructions);
      await user.type(instructions, 'Only list decisions.');
      await user.clear(screen.getByLabelText(/^tone/i));
      await user.type(screen.getByLabelText(/^tone/i), 'direct');
      await user.clear(screen.getByLabelText('Section 1'));
      await user.type(screen.getByLabelText('Section 1'), 'Outcomes');

      await user.click(screen.getByRole('button', { name: /^preview$/i }));

      await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
      expect(mockPreview).toHaveBeenCalledWith({
        template: {
          name: 'My meeting notes',
          // The typed text, not `'Write up the meeting.'` from the fixture.
          instructions: 'Only list decisions.',
          outputFormat: 'meeting_notes',
          // Issue #334: a fixture without `bodyFormat` reads as markdown.
          bodyFormat: 'markdown',
          structure: ['Outcomes', 'Decisions'],
          tone: 'direct',
          length: 'short',
          model: null,
        },
        source: { type: 'transcript', transcriptId: 'tr-recent' },
      });

      // ⚠ NEVER `templateId`, even though this row is saved: sending the id
      // would preview what was last committed rather than what is on screen.
      expect(mockPreview.mock.calls[0][0]).not.toHaveProperty('templateId');
      // And `description` is dropped — the API's inline schema is `.strict()`
      // and has no such key, so sending it would 400 a request the user
      // believes is simply "try this".
      expect(mockPreview.mock.calls[0][0].template).not.toHaveProperty('description');
    });

    it('streams the sample in incrementally and renders it as markdown', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('button', { name: /^preview$/i }));
      await waitFor(() => expect(connections).toHaveLength(1));
      expect(connections[0].url).toContain('/note-generations/gen-1/stream');

      emit('delta', { delta: '# Weekly sync\n\n', offset: 16 });

      // Rendered as MARKDOWN while still streaming: an `h1`, not the literal
      // `#` characters.
      const heading = await screen.findByRole('heading', { name: 'Weekly sync' });
      expect(heading.tagName).toBe('H1');
      expect(screen.queryByText(/^# Weekly sync/)).not.toBeInTheDocument();

      // A SECOND frame extends what is on screen — this is the incremental
      // claim, and it is why the frames are delivered one at a time.
      emit('delta', { delta: '- Ship on Friday\n', offset: 33 });
      expect(await screen.findByText('Ship on Friday')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Weekly sync' })).toBeInTheDocument();
    });

    it('announces completion to assistive technology rather than only changing visually', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('button', { name: /^preview$/i }));
      await waitFor(() => expect(connections).toHaveLength(1));

      const status = screen.getByRole('status');
      emit('delta', { delta: 'Some text', offset: 9 });
      expect(status).toHaveTextContent(/generating/i);

      emit('done', { status: 'succeeded', offset: 9, currentVersion: null });

      // The completion sentence lands in a polite live region. The SAMPLE is
      // deliberately not in it — rewriting a live region on every token would
      // be read continuously and interrupt itself.
      expect(status).toHaveTextContent('Preview complete.');
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(within(status).queryByText(/some text/i)).not.toBeInTheDocument();
    });

    it('renders a stream failure inline and leaves the form editable', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('button', { name: /^preview$/i }));
      await waitFor(() => expect(connections).toHaveLength(1));

      emit('error', {
        status: 'failed',
        offset: 0,
        errorClass: 'auth',
        reason: 'Incorrect API key provided.',
      });

      // The provider's OWN words, in place, not a toast that takes the reason
      // away after five seconds.
      expect(await screen.findByText('Incorrect API key provided.')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/preview failed/i);

      // ⚠ AND THE FORM IS STILL EDITABLE — the adjust/re-run loop is the whole
      // point, so a failure must not leave the page read-only.
      const instructions = screen.getByLabelText(/^instructions/i);
      expect(instructions).toBeEnabled();
      await user.type(instructions, ' Also list risks.');
      expect(instructions).toHaveValue('Write up the meeting. Also list risks.');
      expect(screen.getByRole('button', { name: /run again/i })).toBeEnabled();
    });

    it('renders a REQUEST failure inline too, with the API’s own sentence', async () => {
      const user = userEvent.setup();
      const { ApiError } = await import('../../services/api');
      mockPreview.mockRejectedValue(
        new ApiError('AI is enabled, but you have not saved an API key.', 409),
      );
      await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('button', { name: /^preview$/i }));

      expect(
        await screen.findByText('AI is enabled, but you have not saved an API key.'),
      ).toBeInTheDocument();
      // Nothing was streamed, so nothing was billed and no connection exists.
      expect(connections).toHaveLength(0);
    });

    it('⚠ tears the connection down when the page goes away mid-preview', async () => {
      const user = userEvent.setup();
      const { unmount } = await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('button', { name: /^preview$/i }));
      await waitFor(() => expect(connections).toHaveLength(1));
      emit('delta', { delta: 'half a note', offset: 11 });

      // Still open: the generation never settled.
      expect(connections[0].close).not.toHaveBeenCalled();

      unmount();

      // A leak here renders nothing wrong — it is one dead stream per abandoned
      // preview, retrying on backoff for the life of the tab.
      expect(connections[0].close).toHaveBeenCalled();
    });

    it('will not start a second run while one is in flight — a preview is a charge', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('button', { name: /^preview$/i }));
      await waitFor(() => expect(connections).toHaveLength(1));

      // The control reports what it is doing and refuses a second press, so a
      // double click cannot buy two samples of the same template.
      expect(screen.getByRole('button', { name: /generating/i })).toBeDisabled();
      expect(mockPreview).toHaveBeenCalledTimes(1);
    });

    it('lets the user adjust and re-run without leaving the form', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('button', { name: /^preview$/i }));
      await waitFor(() => expect(connections).toHaveLength(1));
      emit('delta', { delta: 'First attempt', offset: 13 });
      emit('done', { status: 'succeeded', offset: 13, currentVersion: null });

      // The terminal frame closed the first stream — nothing is left open
      // between runs.
      expect(connections[0].close).toHaveBeenCalled();

      await user.type(screen.getByLabelText(/^instructions/i), ' Be blunt.');
      await user.click(screen.getByRole('button', { name: /run again/i }));

      await waitFor(() => expect(connections).toHaveLength(2));
      expect(mockPreview).toHaveBeenCalledTimes(2);
      expect(mockPreview.mock.calls[1][0].template?.instructions).toBe(
        'Write up the meeting. Be blunt.',
      );
      // Still the editor — the loop never navigates.
      expect(screen.getByRole('heading', { level: 2, name: 'Template' })).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Hiding and showing templates — issue #311
  // ==========================================================================

  describe('hiding and showing templates', () => {
    it('asks the API with includeHidden=true — the template manager sees everything', async () => {
      await renderPage();
      await screen.findByText('My meeting notes');

      expect(mockGetTemplates).toHaveBeenCalledWith(
        expect.objectContaining({ includeHidden: true }),
      );
    });

    it('shows filter counts and filters the list', async () => {
      const user = userEvent.setup();
      setup({
        templates: [
          template({ id: 'shown-1', name: 'Shown one', hidden: false }),
          template({ id: 'hidden-1', name: 'Hidden one', hidden: true }),
          builtIn,
        ],
      });
      await renderPage();
      await screen.findByText('Shown one');

      expect(screen.getByRole('button', { name: /^all \(3\)$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^shown \(2\)$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^hidden \(1\)$/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^hidden \(1\)$/i }));
      expect(screen.getByText('Hidden one')).toBeInTheDocument();
      expect(screen.queryByText('Shown one')).not.toBeInTheDocument();
      expect(screen.queryByText('Standard meeting notes')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^shown \(2\)$/i }));
      expect(screen.queryByText('Hidden one')).not.toBeInTheDocument();
      expect(screen.getByText('Shown one')).toBeInTheDocument();
      expect(screen.getByText('Standard meeting notes')).toBeInTheDocument();
    });

    it('persists the chosen filter to localStorage and restores it on the next mount', async () => {
      const user = userEvent.setup();
      setup({
        templates: [
          template({ id: 'shown-1', name: 'Shown one', hidden: false }),
          template({ id: 'hidden-1', name: 'Hidden one', hidden: true }),
        ],
      });
      const { unmount } = await renderPage();
      await screen.findByText('Shown one');

      await user.click(screen.getByRole('button', { name: /^hidden \(1\)$/i }));
      expect(localStorage.getItem('noteTemplates.visibilityFilter')).toBe('hidden');

      unmount();

      await renderPage();
      await screen.findByText('Hidden one');
      expect(screen.queryByText('Shown one')).not.toBeInTheDocument();
    });

    it('does not crash when localStorage throws on read or write', async () => {
      const getSpy = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(() => {
          throw new Error('blocked');
        });
      const setSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('blocked');
        });
      const user = userEvent.setup();
      setup({
        templates: [
          template({ id: 'shown-1', name: 'Shown one', hidden: false }),
          template({ id: 'hidden-1', name: 'Hidden one', hidden: true }),
        ],
      });

      await renderPage();
      await screen.findByText('Shown one');
      // The default filter falls back to `all` when the read throws.
      expect(screen.getByText('Hidden one')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^hidden \(1\)$/i }));
      expect(screen.queryByText('Shown one')).not.toBeInTheDocument();

      getSpy.mockRestore();
      setSpy.mockRestore();
    });

    it('hides a template: PUT is sent, a snackbar reports it, and Undo sends DELETE', async () => {
      const user = userEvent.setup();
      setup({ templates: [template({ id: 'tpl-owned', name: 'My meeting notes', hidden: false })] });
      await renderPage();
      await screen.findByText('My meeting notes');

      await user.click(screen.getByRole('button', { name: 'Hide My meeting notes' }));

      await waitFor(() => expect(mockHide).toHaveBeenCalledWith('tpl-owned'));
      expect(await screen.findByText('“My meeting notes” hidden')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /undo/i }));

      await waitFor(() => expect(mockUnhide).toHaveBeenCalledWith('tpl-owned'));
    });

    it('rolls back and shows an error snackbar when the hide request fails', async () => {
      const user = userEvent.setup();
      const { ApiError } = await import('../../services/api');
      setup({ templates: [template({ id: 'tpl-owned', name: 'My meeting notes', hidden: false })] });
      mockHide.mockRejectedValue(new ApiError('Server error', 500));
      await renderPage();
      await screen.findByText('My meeting notes');

      await user.click(screen.getByRole('button', { name: 'Hide My meeting notes' }));

      await waitFor(() => expect(mockHide).toHaveBeenCalled());
      // Rolled back: the row is shown again and the toggle reads "Hide" again.
      expect(await screen.findByRole('button', { name: 'Hide My meeting notes' })).toBeInTheDocument();
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });

    it('warns when every template is hidden', async () => {
      setup({ templates: [template({ id: 'tpl-1', name: 'Only one', hidden: true })] });
      await renderPage();
      await screen.findByText('Only one');

      expect(
        screen.getByText(/all templates are hidden.*unhide one to create a note/i),
      ).toBeInTheDocument();
    });

    it('shows a message for an empty filtered view without claiming there are no templates at all', async () => {
      const user = userEvent.setup();
      setup({ templates: [template({ id: 'tpl-1', name: 'Only shown', hidden: false })] });
      await renderPage();
      await screen.findByText('Only shown');

      await user.click(screen.getByRole('button', { name: /^hidden \(0\)$/i }));

      expect(screen.getByText('No hidden templates.')).toBeInTheDocument();
    });

    it('passes axe with the hide/show controls and a Hidden chip on screen', async () => {
      setup({
        templates: [
          template({ id: 'shown-1', name: 'Shown one', hidden: false }),
          template({ id: 'hidden-1', name: 'Hidden one', hidden: true }),
        ],
      });
      const { container } = await renderPage();
      await screen.findByText('Hidden one');

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });
  });

  // ==========================================================================
  // The editor's footer action row and the Ctrl/⌘+S shortcut — issue #331
  // ==========================================================================

  describe('editor footer actions', () => {
    /** Open the editor on a brand-new, empty template. */
    async function openNewTemplate(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await screen.findByRole('button', { name: /new template/i }));
      await screen.findByRole('heading', { level: 2, name: 'Preview' });
    }

    /** The `NoteTemplateEditor` Paper, whose `footer` prop is where these
     *  buttons live — scoping to it is what tells the footer button apart
     *  from the top-bar Save button, which jsdom keeps in the DOM too. */
    function editorRegion() {
      return screen.getByRole('region', { name: 'Template' });
    }

    it('labels the footer button "Create template" for a new template', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openNewTemplate(user);

      expect(
        within(editorRegion()).getByRole('button', { name: 'Create template' }),
      ).toBeInTheDocument();
    });

    it('labels the footer button "Save changes" for an existing template', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      expect(
        within(editorRegion()).getByRole('button', { name: 'Save changes' }),
      ).toBeInTheDocument();
    });

    it('disables the footer button and explains why when name and instructions are both empty', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openNewTemplate(user);

      expect(
        within(editorRegion()).getByRole('button', { name: 'Create template' }),
      ).toBeDisabled();
      expect(
        within(editorRegion()).getByText('Name and instructions are required'),
      ).toBeInTheDocument();
    });

    it('says "Add a name to save" when only the name is missing', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openNewTemplate(user);

      await user.type(screen.getByLabelText(/^instructions/i), 'Write it up.');

      expect(within(editorRegion()).getByText('Add a name to save')).toBeInTheDocument();
      expect(
        within(editorRegion()).getByRole('button', { name: 'Create template' }),
      ).toBeDisabled();
    });

    it('says "Add instructions to save" when only instructions are missing', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openNewTemplate(user);

      await user.type(screen.getByLabelText(/^name/i), 'My template');

      expect(within(editorRegion()).getByText('Add instructions to save')).toBeInTheDocument();
      expect(
        within(editorRegion()).getByRole('button', { name: 'Create template' }),
      ).toBeDisabled();
    });

    it('clicking the footer button creates a new template', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openNewTemplate(user);

      await user.type(screen.getByLabelText(/^name/i), 'My template');
      await user.type(screen.getByLabelText(/^instructions/i), 'Write it up.');
      await user.click(within(editorRegion()).getByRole('button', { name: 'Create template' }));

      await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My template', instructions: 'Write it up.' }),
      );
    });

    it('clicking the footer button saves an existing template', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.click(within(editorRegion()).getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(mockUpdate).toHaveBeenCalledWith(
          'tpl-owned',
          expect.objectContaining({ name: 'My meeting notes' }),
        ),
      );
    });

    it('the footer Cancel button returns to the list', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.click(within(editorRegion()).getByRole('button', { name: 'Cancel' }));

      expect(
        await screen.findByRole('button', { name: /new template/i }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Template' })).not.toBeInTheDocument();
    });

    it('Ctrl+S saves the current draft while editing', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.keyboard('{Control>}s{/Control}');

      await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    });

    it('Meta+S (⌘S) saves the current draft while editing', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openEditor(user);

      await user.keyboard('{Meta>}s{/Meta}');

      await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    });

    it('Ctrl+S does not save an invalid draft', async () => {
      const user = userEvent.setup();
      await renderPage();
      await openNewTemplate(user);

      await user.keyboard('{Control>}s{/Control}');

      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('does not save on Ctrl+S while on the list', async () => {
      const user = userEvent.setup();
      await renderPage();
      await screen.findByText('My meeting notes');

      await user.keyboard('{Control>}s{/Control}');

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // No key
  // ==========================================================================

  describe('when the caller has no AI key', () => {
    it('renders AiKeyRequired as the whole page and issues NO generation request', async () => {
      setup({ config: { keyConfigured: false } });
      await renderPage();

      expect(
        await screen.findByRole('heading', { name: /add your ai key to use this/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /set up your ai key/i })).toHaveAttribute(
        'href',
        '/settings/ai',
      );

      // The editor and the preview are not merely disabled — they are absent.
      expect(screen.queryByRole('heading', { name: 'Template' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^preview$/i })).not.toBeInTheDocument();

      // Nothing that costs anything was requested, and neither was the source
      // list that exists only to feed one.
      expect(mockPreview).not.toHaveBeenCalled();
      expect(connections).toHaveLength(0);
      expect(mockGetTranscripts).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Accessibility, in both themes
  // ==========================================================================

  describe('accessibility', () => {
    it('passes axe in the light theme, with a streamed sample on screen', async () => {
      localStorage.setItem('theme_mode', 'light');
      const user = userEvent.setup();
      const { container } = await renderPage();
      await openEditor(user);

      await user.click(screen.getByRole('button', { name: /^preview$/i }));
      await waitFor(() => expect(connections).toHaveLength(1));
      emit('delta', { delta: '# Weekly sync\n\n- Ship on Friday\n', offset: 33 });
      emit('done', { status: 'succeeded', offset: 33, currentVersion: null });
      await screen.findByRole('heading', { name: 'Weekly sync' });

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });

    it('passes axe in the dark theme, on the list', async () => {
      localStorage.setItem('theme_mode', 'dark');
      const { container } = await renderPage();
      await screen.findByText('Standard meeting notes');

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });

    it('passes axe in the dark theme, in the editor', async () => {
      localStorage.setItem('theme_mode', 'dark');
      const user = userEvent.setup();
      const { container } = await renderPage();
      await openEditor(user);

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });
  });
});
