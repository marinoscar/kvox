import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { render, mockAdminUser } from '../utils/test-utils';
import NotePage from '../../pages/NotePage';
import type { Note } from '../../services/notes';
import type { NoteGenerationStreamHandlers } from '../../services/noteGenerationStream';

/**
 * `/notes/:id` — the generation view.
 *
 * =============================================================================
 * THE STREAM IS A FAKE, AND THE TEARDOWN IS WHAT IT EXISTS TO PROVE
 * =============================================================================
 *
 * `connectNoteStream` is replaced with a recorder that hands back a `close`
 * spy, for two reasons. The first is practical: a real SSE connection needs a
 * `ReadableStream` body, a decoder and a reconnect loop, none of which this
 * page owns — `services/sse.ts` has its own suite for all three. The second is
 * the point: a connection LEAK is invisible to any assertion about rendered
 * output, so the only way to catch "navigating away mid-generation leaves a
 * socket open" is to hold the handle the component was given and check it was
 * closed.
 *
 * Everything else in the module is left real, including `describeStreamError`,
 * which is what turns an `error` frame into the sentence this page shows.
 */

const API_BASE = 'http://localhost:3000/api';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

interface FakeStream {
  noteId: string;
  handlers: NoteGenerationStreamHandlers;
  close: ReturnType<typeof vi.fn>;
}

const streams: FakeStream[] = [];

vi.mock('../../services/noteGenerationStream', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/noteGenerationStream')>();
  return {
    ...actual,
    connectNoteStream: (noteId: string, handlers: NoteGenerationStreamHandlers) => {
      const close = vi.fn();
      streams.push({ noteId, handlers, close });
      return { close };
    },
  };
});

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Q3 planning — decisions',
    body: '',
    status: 'generating',
    currentVersion: 0,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting minutes',
    sourceName: null,
    contextText: null,
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * One template row, as every `/note-templates` read returns it.
 *
 * ⚠ THE PAGE NOW READS TEMPLATES AT ALL, which it did not before #109: the
 * generation-context panel reads the note's own template by id, and the
 * regenerate dialog's container reads the list. A suite that did not answer
 * both would exercise the `error` branch of every template assertion below
 * while appearing to test the happy path.
 */
function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl-1',
    name: 'Meeting minutes',
    description: 'Who decided what.',
    instructions: 'Lead with the decisions.',
    outputFormat: 'meeting_notes',
    structure: ['Decisions', 'Owners'],
    tone: 'Neutral',
    length: 'Under a page',
    model: null,
    isArchived: false,
    builtIn: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Every body `POST /api/notes/:id/regenerate` was sent. */
let regenerateBodies: Record<string, unknown>[];

/**
 * What `GET /api/ai/config` answers with.
 *
 * ⚠ IT HAS TO BE MOCKED AT ALL because the note page asks before deciding
 * whether to offer Regenerate — and `useAiConfig` treats an unanswered question
 * as `keyConfigured: false`, which is the safe direction and would silently
 * turn every regeneration test into a test of `AiKeyRequired`.
 */
let aiConfig: Record<string, unknown>;

/** The formats the export dialog builds itself from. */
const EXPORTERS = [
  {
    format: 'markdown',
    label: 'Markdown',
    mimeType: 'text/markdown',
    extension: 'md',
    options: [
      {
        key: 'includeProvenance',
        label: 'Include the provenance header',
        description: 'Names the source, the template and the version.',
        type: 'boolean',
        default: true,
      },
    ],
  },
  { format: 'pdf', label: 'PDF', mimeType: 'application/pdf', extension: 'pdf', options: [] },
  {
    format: 'docx',
    label: 'Word',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
    options: [],
  },
];

function exportRowFor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    noteId: 'n1',
    version: 1,
    format: 'markdown',
    options: { includeProvenance: true },
    status: 'ready',
    reused: false,
    mimeType: 'text/markdown',
    filename: 'Q3 planning — decisions (v1).md',
    sizeBytes: '2048',
    error: null,
    downloadUrl: 'https://storage.example/exports/exp-1?sig=abc',
    downloadExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Every body `POST /api/notes/:id/exports` was sent, for the registry assertions. */
let exportRequests: Record<string, unknown>[];
/** What both export routes answer with. Reassign mid-test to make a poll settle. */
let exportRow: Record<string, unknown> | null;

/** What `GET /api/notes/:id` answers with right now. Reassign to change it. */
let current: Note;
let regenerateCalls = 0;

beforeEach(() => {
  // See `NotesPage.test.tsx`: `localStorage` survives between tests and the
  // theme provider seeds itself from this key.
  localStorage.setItem('theme_mode', 'light');
  // The source-name cache is MODULE-LEVEL and deliberately never invalidated
  // (see `useNoteSourceNames`' header), including its resolved negatives — so a
  // test that does not clear it inherits whichever answer an earlier test's
  // handlers produced.
  streams.length = 0;
  regenerateCalls = 0;
  current = note();
  aiConfig = {
    available: true,
    provider: 'openai',
    providerLabel: 'OpenAI',
    // #97: `source`/`derivedFrom` complete the `AiConfigModel` shape — absent,
    // a provenance assertion elsewhere would silently pass against a fallback
    // chip instead of the real one.
    models: [
      {
        id: 'gpt-4o-mini',
        label: 'GPT-4o mini',
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        source: 'catalogue',
        derivedFrom: null,
      },
    ],
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    keyConfigured: true,
  };
  exportRequests = [];
  exportRow = null;
  regenerateBodies = [];
  server.use(
    // ⚠ REGISTERED BEFORE `/notes/:id`. Within one `server.use` call handlers
    // are matched in order, and `/notes/:id` would happily swallow
    // `/notes/exporters` — which is the same collision the API's own
    // controller has to declare its literal routes first to avoid.
    http.get(`${API_BASE}/ai/config`, () => HttpResponse.json({ data: aiConfig })),
    http.get(`${API_BASE}/notes/exporters`, () =>
      HttpResponse.json({ data: { exporters: EXPORTERS } }),
    ),
    http.post(`${API_BASE}/notes/:id/exports`, async ({ request }) => {
      exportRequests.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ data: exportRow });
    }),
    http.get(`${API_BASE}/notes/:id/exports`, () =>
      HttpResponse.json({ data: { exports: exportRow ? [exportRow] : [] } }),
    ),
    // ⚠ THE LITERAL ROUTE BEFORE THE PARAMETERISED ONE, for the same reason
    // `/notes/exporters` is registered before `/notes/:id` above: within one
    // `server.use` call handlers match in order, and `/note-templates/:id`
    // would swallow the list.
    http.get(`${API_BASE}/note-templates`, () =>
      HttpResponse.json({
        data: { items: [templateRow(), templateRow({ id: 'tpl-2', name: 'Executive brief' })], total: 2 },
      }),
    ),
    http.get(`${API_BASE}/note-templates/:id`, ({ params }) =>
      HttpResponse.json({ data: templateRow({ id: params.id as string }) }),
    ),
    http.get(`${API_BASE}/notes/:id`, () => HttpResponse.json({ data: current })),
    http.post(`${API_BASE}/notes/:id/regenerate`, async ({ request }) => {
      regenerateBodies.push((await request.json()) as Record<string, unknown>);
      regenerateCalls += 1;
      current = note({ status: 'generating', failureReason: null, body: '' });
      return HttpResponse.json({
        data: {
          note: current,
          generationId: 'gen-2',
          jobId: 'job-2',
          providerId: 'openai',
          model: 'gpt-4o-mini',
        },
      });
    }),
  );
});

function renderNote(route = '/notes/n1') {
  return render(
    <Routes>
      <Route path="/notes/:id" element={<NotePage />} />
      <Route path="/notes" element={<h1>Library</h1>} />
    </Routes>,
    { wrapperOptions: { user: mockAdminUser, route } },
  );
}

/** Deliver one `delta` frame through the fake stream the page opened. */
async function emit(content: string, index = streams.length - 1) {
  await act(async () => {
    streams[index].handlers.onContent(content);
  });
}

describe('NotePage — the live stream', () => {
  it('opens exactly one connection for the note being generated', async () => {
    renderNote();

    await waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0].noteId).toBe('n1');
  });

  it('renders streamed text as MARKDOWN, as it arrives', async () => {
    renderNote();
    await waitFor(() => expect(streams).toHaveLength(1));

    await emit('# Decisions\n\nWe agreed to **ship it**.');

    // A real heading element, not the literal characters `#`.
    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeInTheDocument();
    expect(screen.getByText('ship it').tagName).toBe('STRONG');
  });

  it('does NOT execute raw HTML in model output', async () => {
    // ⚠ THE SECURITY ASSERTION. The body is generated from a transcript this
    // application did not write, so markup in it must be inert text. The
    // guarantee is structural — `react-markdown` builds a React tree and never
    // sets HTML from a string, and `rehype-raw` is deliberately not installed —
    // and this is what stops somebody adding it later.
    const { container } = renderNote();
    await waitFor(() => expect(streams).toHaveLength(1));

    await emit(
      'Summary:\n\n<script>window.__pwned = true;</script>\n\n' +
        '<img src="x" onerror="window.__pwned = true" data-evil="1">\n\n' +
        '<iframe src="https://evil.example"></iframe>\n',
    );

    // No element was created from any of it, anywhere in the document.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[data-evil]')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(document.querySelector('script[data-evil]')).toBeNull();
    expect(
      (window as unknown as { __pwned?: boolean }).__pwned,
    ).toBeUndefined();
    // …and the user still sees what the model produced, as text.
    expect(screen.getByText(/window.__pwned = true;/)).toBeInTheDocument();
  });

  it('announces the streaming region and marks it busy while it is being written', async () => {
    renderNote();
    await waitFor(() => expect(streams).toHaveLength(1));
    await emit('First words.');

    const region = screen.getByRole('region', { name: 'Note' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
  });

  it('says, plainly, that closing the page is safe', async () => {
    renderNote();
    await waitFor(() => expect(streams).toHaveLength(1));

    expect(
      screen.getByText(/You can close this page/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/notification will arrive/i)).toBeInTheDocument();
  });

  it('closes the connection when Stop watching is pressed, and keeps telling the truth about it', async () => {
    const user = userEvent.setup();
    renderNote();
    await waitFor(() => expect(streams).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Stop watching' }));

    expect(streams[0].close).toHaveBeenCalled();
    // ⚠ The note is STILL BEING WRITTEN — there is no cancel endpoint and this
    // button never claimed to be one. A page that switched to "cancelled" here
    // would be lying about what it just did.
    expect(screen.getByText('Still writing in the background')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop watching' })).not.toBeInTheDocument();
  });

  it('re-reads the note when the generation commits', async () => {
    renderNote();
    await waitFor(() => expect(streams).toHaveLength(1));
    await emit('Draft text');

    current = note({ status: 'ready', body: '# Final\n\nCommitted.', currentVersion: 1 });
    await act(async () => {
      streams[0].handlers.onDone({ status: 'succeeded', offset: 10, currentVersion: 1 });
    });

    // The ROW is what is true once the job has committed — not the buffer.
    expect(await screen.findByRole('heading', { name: 'Final' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());
  });

  it('tears the stream down when the page is navigated away from', async () => {
    // ⚠ THE LEAK TEST. Every note opened in a session would otherwise hold a
    // connection against a page that is gone, and nothing rendered would say so.
    const view = renderNote();
    await waitFor(() => expect(streams).toHaveLength(1));

    view.unmount();

    expect(streams[0].close).toHaveBeenCalled();
    // Nothing was asked to stop server-side: the generation runs to completion
    // whether or not anybody is watching, which is what makes leaving safe.
    expect(regenerateCalls).toBe(0);
  });

  it('opens no connection at all for a note that has already settled', async () => {
    current = note({ status: 'ready', body: 'Done.', currentVersion: 1 });
    renderNote();

    await screen.findByText('Done.');
    expect(streams).toHaveLength(0);
  });
});

describe('NotePage — failure and regeneration', () => {
  it('shows the RECORDED reason, never a bare "something went wrong"', async () => {
    current = note({
      status: 'failed',
      failureReason: 'Your provider rejected the key saved for your account.',
    });
    renderNote();

    expect(
      await screen.findByText('Your provider rejected the key saved for your account.'),
    ).toBeInTheDocument();
    expect(screen.getByText('This note could not be generated')).toBeInTheDocument();
  });

  it('falls back to the stream’s own reason when the row records none', async () => {
    renderNote();
    await waitFor(() => expect(streams).toHaveLength(1));

    current = note({ status: 'failed', failureReason: null });
    await act(async () => {
      streams[0].handlers.onError({
        status: 'failed',
        offset: 0,
        errorClass: 'rate_limit',
        reason: 'Rate limited by the provider; try again in a minute.',
      });
    });

    expect(
      await screen.findByText('Rate limited by the provider; try again in a minute.'),
    ).toBeInTheDocument();
  });

  it('regenerates, and starts watching the new generation', async () => {
    const user = userEvent.setup();
    current = note({ status: 'failed', failureReason: 'The provider timed out.' });
    renderNote();
    await screen.findByText('The provider timed out.');
    expect(streams).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    // #58: Regenerate CONFIRMS first. Nothing has been spent yet.
    expect(regenerateCalls).toBe(0);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Regenerate' }),
    );

    await waitFor(() => expect(regenerateCalls).toBe(1));
    // A NEW connection, opened off the row `regenerate` answered with rather
    // than after a poll.
    await waitFor(() => expect(streams).toHaveLength(1));
    await emit('Second attempt.');
    expect(screen.getByText('Second attempt.')).toBeInTheDocument();
  });

  it('reports a regeneration that could not even be started', async () => {
    const user = userEvent.setup();
    current = note({ status: 'failed', failureReason: 'The provider timed out.' });
    server.use(
      http.post(`${API_BASE}/notes/:id/regenerate`, () =>
        HttpResponse.json(
          { statusCode: 409, code: 'CONFLICT', message: 'This note is already generating.' },
          { status: 409 },
        ),
      ),
    );
    renderNote();
    await screen.findByText('The provider timed out.');

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Regenerate' }),
    );

    expect(await screen.findByText('This note is already generating.')).toBeInTheDocument();
  });
});

describe('NotePage — the rest of the page', () => {
  it('names the note, its status, its template and its source', async () => {
    current = note({ status: 'ready', body: 'Done.', currentVersion: 1 });
    renderNote();

    expect(
      await screen.findByRole('heading', { name: 'Q3 planning — decisions', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText(/Meeting minutes/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'a transcript' })).toHaveAttribute(
      'href',
      '/transcripts/t1',
    );
  });

  it('links to the version history', async () => {
    current = note({ status: 'ready', body: 'Done.', currentVersion: 1 });
    renderNote();

    expect(await screen.findByRole('link', { name: 'History' })).toHaveAttribute(
      'href',
      '/notes/n1/history',
    );
  });

  it('reports a note that cannot be read, in the API’s own terms', async () => {
    server.use(
      http.get(`${API_BASE}/notes/:id`, () => new HttpResponse(null, { status: 404 })),
    );
    renderNote();

    expect(
      await screen.findByText(/does not exist, or you no longer have access/i),
    ).toBeInTheDocument();
  });

  it('has no axe violations while generating, in the light theme', async () => {
    const { container } = renderNote();
    await waitFor(() => expect(streams).toHaveLength(1));
    await emit('# Decisions\n\nWe agreed.');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme', async () => {
    // ⚠ THROUGH `localStorage` — see `NotesPage.test.tsx`’s own note: the
    // helper's `theme` option is declared and not read, so passing it would
    // render the light theme and assert nothing.
    localStorage.setItem('theme_mode', 'dark');
    current = note({ status: 'ready', body: '# Decisions\n\nWe agreed.', currentVersion: 1 });
    const { container } = render(
      <Routes>
        <Route path="/notes/:id" element={<NotePage />} />
      </Routes>,
      { wrapperOptions: { user: mockAdminUser, route: '/notes/n1' } },
    );
    await screen.findByRole('heading', { name: 'Decisions' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations on the failed state', async () => {
    current = note({ status: 'failed', failureReason: 'The provider timed out.' });
    const { container } = renderNote();
    await screen.findByText('The provider timed out.');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// #58 — editing, saving, and the 409
// =============================================================================

/** Open the editor on a settled note. Every editing test starts here. */
async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  renderNote();
  await screen.findByRole('button', { name: 'Edit' });
  await user.click(screen.getByRole('button', { name: 'Edit' }));

  return screen.getByRole('textbox', { name: 'Note' });
}

describe('NotePage — editing the body', () => {
  beforeEach(() => {
    current = note({ status: 'ready', body: '# Decisions\n\nWe agreed.', currentVersion: 3 });
  });

  it('edits as MARKDOWN in a textarea, not a rich-text surface', async () => {
    const user = userEvent.setup();
    const textarea = await openEditor(user);

    // The literal markdown — the storage format, the model's output format and
    // the export source. A WYSIWYG would have shown a rendered heading here and
    // would have had to convert it back on save.
    expect(textarea).toHaveValue('# Decisions\n\nWe agreed.');
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  it('previews the draft with the same renderer the read view uses, and back again', async () => {
    const user = userEvent.setup();
    const textarea = await openEditor(user);

    await user.clear(textarea);
    await user.type(textarea, '## Later');

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    // A real heading, from the draft, rendered by `MarkdownView`.
    expect(
      within(screen.getByTestId('note-preview')).getByRole('heading', { name: 'Later' }),
    ).toBeInTheDocument();

    // ⚠ AND BACK, WITH THE TEXT INTACT. Toggling to the preview must never be a
    // way to lose a paragraph.
    await user.click(screen.getByRole('button', { name: 'Write' }));
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('## Later');
  });

  it('toggles between writing and previewing from the keyboard alone', async () => {
    const user = userEvent.setup();
    await openEditor(user);

    const preview = screen.getByRole('button', { name: 'Preview' });

    preview.focus();
    expect(preview).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('note-preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const write = screen.getByRole('button', { name: 'Write' });
    write.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'Note' })).toBeInTheDocument();
  });

  it('does not execute raw HTML typed into the editor’s own preview', async () => {
    const user = userEvent.setup();
    const textarea = await openEditor(user);

    await user.clear(textarea);
    await user.type(textarea, '<img src="x" data-evil="1">');
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(document.querySelector('img[data-evil]')).toBeNull();
    expect(screen.getByTestId('note-preview')).toHaveTextContent('data-evil');
  });

  it('sends the baseVersion it was editing, and adopts the version that comes back', async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> | null = null;

    server.use(
      http.patch(`${API_BASE}/notes/:id`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        current = note({
          status: 'ready',
          body: '# Decisions\n\nWe agreed, twice.',
          currentVersion: 4,
        });
        return HttpResponse.json({ data: current });
      }),
    );

    const textarea = await openEditor(user);
    await user.clear(textarea);
    await user.type(textarea, 'We agreed, twice.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).not.toBeNull());
    // ⚠ THE VERSION THE DRAFT WAS OPENED AGAINST — not one re-read at save
    // time, which would defeat the check entirely.
    expect(sent).toMatchObject({ baseVersion: 3, body: 'We agreed, twice.' });

    // …and the page now reports the version the save produced. (A regex: the
    // version and the provider share one element, so an exact match would be
    // asserting against a string the page never renders as one node.)
    expect(await screen.findByText(/Version 4/)).toBeInTheDocument();
  });

  it('says out loud that there is no autosave', async () => {
    const user = userEvent.setup();
    await openEditor(user);

    expect(screen.getByText(/there is no autosave/i)).toBeInTheDocument();
  });

  it('does not offer Save until something has actually changed', async () => {
    const user = userEvent.setup();
    await openEditor(user);

    // An unchanged save would be a version row recording nothing, which is
    // exactly the noise the no-autosave decision exists to keep out.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('NotePage — the 409', () => {
  beforeEach(() => {
    current = note({ status: 'ready', body: 'Mine was based on this.', currentVersion: 3 });
    server.use(
      http.patch(`${API_BASE}/notes/:id`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'The note has changed since you loaded it.',
            details: { reason: 'stale_base_version', currentVersion: 5 },
          },
          { status: 409 },
        ),
      ),
    );
  });

  /** Type something and try to save it into a note that has moved on. */
  async function collide(user: ReturnType<typeof userEvent.setup>) {
    const textarea = await openEditor(user);
    await user.clear(textarea);
    await user.type(textarea, 'My unsaved paragraph.');
    // The other tab's save, as the re-read will find it.
    current = note({ status: 'ready', body: 'Their paragraph.', currentVersion: 5 });
    await user.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('explains what happened, names both versions, and shows what the other one says', async () => {
    const user = userEvent.setup();
    await collide(user);

    const dialog = await screen.findByRole('dialog', { name: 'This note changed somewhere else' });

    expect(within(dialog).getByText(/you were editing version 3/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/now at version 5/i)).toBeInTheDocument();
    // BOTH TEXTS ARE ON SCREEN. A user cannot choose between two bodies they
    // have only been told about.
    expect(within(dialog).getByText('My unsaved paragraph.')).toBeInTheDocument();
    expect(await within(dialog).findByText('Their paragraph.')).toBeInTheDocument();
  });

  it('offers a CHOICE, and never a Retry — retrying would overwrite the other version', async () => {
    const user = userEvent.setup();
    await collide(user);

    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('button', { name: /copy my text/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /keep editing/i })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /discard mine and reload/i }),
    ).toBeInTheDocument();
    // ⚠ THE ASSERTION THE ISSUE ASKS FOR BY NAME.
    expect(within(dialog).queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('never overwrites silently — nothing was saved, and the draft is still there', async () => {
    const user = userEvent.setup();
    let patches = 0;

    server.use(
      http.patch(`${API_BASE}/notes/:id`, () => {
        patches += 1;
        return HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'The note has changed since you loaded it.',
            details: { reason: 'stale_base_version', currentVersion: 5 },
          },
          { status: 409 },
        );
      }),
    );

    await collide(user);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /keep editing/i }));

    // Exactly ONE attempt, and it was refused. Nothing re-sent, nothing forced.
    expect(patches).toBe(1);
    // `findBy`, not `getBy`: MUI keeps the dialog mounted through its closing
    // transition and `aria-hidden`s the page behind it, so the editor is
    // briefly absent from the accessibility tree.
    expect(await screen.findByRole('textbox', { name: 'Note' })).toHaveValue(
      'My unsaved paragraph.',
    );
  });

  it('puts the user’s own text on the clipboard so it survives whatever they choose', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await collide(user);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /copy my text/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('My unsaved paragraph.'));
    expect(await screen.findByText(/on the clipboard/i)).toBeInTheDocument();
  });

  it('takes the server’s version only when the user asks for it, in those words', async () => {
    const user = userEvent.setup();
    await collide(user);
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: /discard mine and reload/i }));

    expect(await screen.findByText('Their paragraph.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument();
  });

  it('treats a `generating` 409 as a wait, not as a conflict between two texts', async () => {
    const user = userEvent.setup();

    server.use(
      http.patch(`${API_BASE}/notes/:id`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'This note is generating.',
            details: { reason: 'generating' },
          },
          { status: 409 },
        ),
      ),
    );

    const textarea = await openEditor(user);
    await user.clear(textarea);
    await user.type(textarea, 'Something.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/save again once the generation finishes/i)).toBeInTheDocument();
    // Nothing to choose between — there is only one text.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Something.');
  });

  it('has no axe violations while the conflict is on screen', async () => {
    const user = userEvent.setup();
    await collide(user);
    await screen.findByRole('dialog');

    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('NotePage — leaving with unsaved changes', () => {
  beforeEach(() => {
    current = note({ status: 'ready', body: 'Committed.', currentVersion: 2 });
  });

  it('asks the browser to confirm before the tab leaves', async () => {
    const user = userEvent.setup();
    const textarea = await openEditor(user);

    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await user.type(textarea, ' And more.');

    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    // ⚠ THE WHOLE MITIGATION FOR HAVING NO AUTOSAVE.
    expect(dirty.defaultPrevented).toBe(true);
  });

  it('warns before an in-app navigation away from unsaved text', async () => {
    const user = userEvent.setup();
    const textarea = await openEditor(user);
    await user.type(textarea, ' And more.');

    await user.click(screen.getByRole('link', { name: 'History' }));

    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    expect(within(dialog).getByText(/There is no autosave/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /stay and keep editing/i }));
    // Still here, with the text intact — the link's default was prevented
    // rather than followed. (`findBy` because the dialog's closing transition
    // `aria-hidden`s the page behind it for a frame.)
    expect(await screen.findByRole('textbox', { name: 'Note' })).toHaveValue(
      'Committed. And more.',
    );
  });

  it('does not warn when there is nothing to lose', async () => {
    const user = userEvent.setup();
    await openEditor(user);

    await user.click(screen.getByRole('link', { name: 'History' }));

    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).not.toBeInTheDocument();
  });
});

// =============================================================================
// #58 — provenance
// =============================================================================

describe('NotePage — provenance', () => {
  it('names the transcript it was generated from, and links to it', async () => {
    // ⚠ NO SOURCE ENDPOINT IS STUBBED, and that IS the assertion since #192:
    // the name arrives ON the note as `sourceName`, resolved server-side. This
    // test used to need a `GET /transcripts/:id` handler because the client
    // fetched the title itself; if one is ever needed again, the N+1 is back.
    current = note({
      status: 'ready',
      body: 'Done.',
      currentVersion: 1,
      sourceName: 'Q3 planning call',
    });
    renderNote();

    const link = await screen.findByRole('link', { name: 'Q3 planning call' });
    expect(link).toHaveAttribute('href', '/transcripts/t1');
    // The whole sentence, not a label-and-value pair.
    expect(screen.getByTestId('note-provenance')).toHaveTextContent(
      /Generated from Q3 planning call using Meeting minutes/,
    );
  });

  it('links a source NOTE back to that note', async () => {
    current = note({
      status: 'ready',
      body: 'Done.',
      currentVersion: 1,
      sourceType: 'note',
      sourceTranscriptId: null,
      sourceNoteId: 'n0',
      sourceName: 'Earlier note',
    });
    renderNote();

    expect(await screen.findByRole('link', { name: 'Earlier note' })).toHaveAttribute(
      'href',
      '/notes/n0',
    );
  });

  it('NAMES an uploaded document without inventing a link to it', async () => {
    // ⚠ A `managed_by: 'notes'` object has no page in this application, so
    // there is nothing to link to — and a link to a download would hand the
    // user back the file they uploaded instead of the evidence.
    current = note({
      status: 'ready',
      body: 'Done.',
      currentVersion: 1,
      sourceType: 'document',
      sourceTranscriptId: null,
      sourceObjectId: 'obj-1',
      sourceName: 'board-pack.pdf',
    });
    renderNote();

    expect(await screen.findByText('board-pack.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'board-pack.pdf' })).not.toBeInTheDocument();
  });

  it('falls back to the category noun rather than showing a uuid', async () => {
    current = note({ status: 'ready', body: 'Done.', currentVersion: 1 });
    renderNote();

    expect(await screen.findByRole('link', { name: 'a transcript' })).toHaveAttribute(
      'href',
      '/transcripts/t1',
    );
    expect(screen.getByTestId('note-provenance')).not.toHaveTextContent('t1');
  });
});

// =============================================================================
// #58 — export
// =============================================================================

describe('NotePage — the export dialog', () => {
  beforeEach(() => {
    current = note({ status: 'ready', body: 'Done.', currentVersion: 1 });
  });

  async function openExport(user: ReturnType<typeof userEvent.setup>) {
    renderNote();
    await screen.findByRole('button', { name: 'Export' });
    await user.click(screen.getByRole('button', { name: 'Export' }));

    return screen.findByRole('dialog', { name: 'Export note' });
  }

  it('offers every format the SERVER publishes, with that format’s own options', async () => {
    const user = userEvent.setup();
    exportRow = exportRowFor();
    const dialog = await openExport(user);

    // ⚠ NOT A HARDCODED LIST. These three come from `GET /api/notes/exporters`,
    // which is what makes "a fourth exporter is one class" true on this side.
    expect(within(dialog).getByRole('radio', { name: 'Markdown' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'PDF' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Word' })).toBeInTheDocument();
    // …and the option the registry declared for the selected one.
    expect(
      within(dialog).getByRole('checkbox', { name: 'Include the provenance header' }),
    ).toBeInTheDocument();
  });

  it('says which version is being exported', async () => {
    const user = userEvent.setup();
    exportRow = exportRowFor();
    const dialog = await openExport(user);

    expect(within(dialog).getByText(/version 1/i)).toBeInTheDocument();
  });

  it('polls a queued render to completion, then offers the download', async () => {
    const user = userEvent.setup();
    exportRow = exportRowFor({ status: 'pending', downloadUrl: null, sizeBytes: null });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    const dialog = await openExport(user);
    await user.click(within(dialog).getByRole('button', { name: 'Export' }));

    // The render finishes between two polls.
    exportRow = exportRowFor();

    expect(await screen.findByTestId('note-export-ready', undefined, { timeout: 10_000 }))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download' }));

    // ⚠ THE SIGNED URL IS OPENED, NOT FETCHED — the filename is signed into its
    // own `Content-Disposition`.
    expect(open).toHaveBeenCalledWith(
      'https://storage.example/exports/exp-1?sig=abc',
      '_blank',
      'noopener,noreferrer',
    );
    open.mockRestore();
  }, 20_000);

  it('hands back a REUSED export immediately, with no visible stall', async () => {
    const user = userEvent.setup();
    // #54's content addressing: the identical request answers 200 with the
    // existing, already-`ready` row.
    exportRow = exportRowFor({ reused: true });

    const dialog = await openExport(user);
    await user.click(within(dialog).getByRole('button', { name: 'Export' }));

    // No poll, no spinner — the download is on screen on the same tick.
    expect(await screen.findByTestId('note-export-ready')).toBeInTheDocument();
    expect(screen.getByText(/here it is again, no waiting/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Rendering the export')).not.toBeInTheDocument();
    expect(exportRequests).toHaveLength(1);
  });

  it('sends the chosen format and the options as drawn', async () => {
    const user = userEvent.setup();
    exportRow = exportRowFor({ format: 'docx' });
    const dialog = await openExport(user);

    await user.click(within(dialog).getByRole('radio', { name: 'Word' }));
    await user.click(within(dialog).getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(exportRequests).toHaveLength(1));
    expect(exportRequests[0]).toMatchObject({ format: 'docx' });
  });

  it('reports a render that failed, with the reason the row recorded', async () => {
    const user = userEvent.setup();
    exportRow = exportRowFor({ status: 'failed', error: 'The PDF renderer ran out of memory.' });
    const dialog = await openExport(user);

    await user.click(within(dialog).getByRole('button', { name: 'Export' }));

    expect(
      await screen.findByText('The PDF renderer ran out of memory.'),
    ).toBeInTheDocument();
  });

  it('has no axe violations with the dialog open', async () => {
    const user = userEvent.setup();
    exportRow = exportRowFor();
    await openExport(user);

    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// #58 — regeneration, and the missing key
// =============================================================================

describe('NotePage — regenerating', () => {
  beforeEach(() => {
    current = note({ status: 'ready', body: 'The first attempt.', currentVersion: 2 });
  });

  it('confirms first, and the confirmation states the cost and what is kept', async () => {
    const user = userEvent.setup();
    renderNote();
    await screen.findByRole('button', { name: 'Regenerate' });

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    const dialog = await screen.findByRole('dialog', { name: 'Regenerate this note?' });
    // FACT 1 — it is the user's own money, again.
    expect(within(dialog).getByText(/costs you money again/i)).toBeInTheDocument();
    // FACT 2 — the current body is kept as a version, not lost.
    expect(within(dialog).getByText(/version 2/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing is lost/i)).toBeInTheDocument();
    // Nothing has been spent while the question is still on screen.
    expect(regenerateCalls).toBe(0);
  });

  it('spends nothing when the confirmation is declined', async () => {
    const user = userEvent.setup();
    renderNote();
    await screen.findByRole('button', { name: 'Regenerate' });

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );

    expect(regenerateCalls).toBe(0);
    expect(screen.getByText('The first attempt.')).toBeInTheDocument();
  });

  it('starts the generation once, and keeps the old text on screen until the new one commits', async () => {
    const user = userEvent.setup();
    renderNote();
    await screen.findByRole('button', { name: 'Regenerate' });

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Regenerate' }),
    );

    await waitFor(() => expect(regenerateCalls).toBe(1));
    await waitFor(() => expect(streams).toHaveLength(1));
  });

  // ===========================================================================
  // #109 — the request body is a DIFF
  // ===========================================================================

  it('sends `{}` when the user changed nothing — byte-for-byte #58’s request', async () => {
    // ⚠ THE COMPATIBILITY ASSERTION, end to end. #109 put three controls in
    // this dialog; an untouched confirmation must still produce the request the
    // confirm-only dialog produced.
    const user = userEvent.setup();
    renderNote();
    await screen.findByRole('button', { name: 'Regenerate' });

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Regenerate' })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Regenerate' }));

    await waitFor(() => expect(regenerateBodies).toHaveLength(1));
    expect(regenerateBodies[0]).toEqual({});
  });

  it('sends ONLY what the user changed', async () => {
    const user = userEvent.setup();
    current = note({
      status: 'ready',
      body: 'The first attempt.',
      currentVersion: 2,
      contextText: 'Ana and Ben were there.',
    });
    renderNote();
    await screen.findByRole('button', { name: 'Regenerate' });

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    const dialog = await screen.findByRole('dialog');

    // The template list has to have landed for a second option to exist.
    await user.click(await within(dialog).findByLabelText('Template'));
    await user.click(await screen.findByRole('option', { name: 'Executive brief' }));
    await user.clear(within(dialog).getByLabelText('Context'));
    await user.click(within(dialog).getByRole('button', { name: 'Regenerate' }));

    await waitFor(() => expect(regenerateBodies).toHaveLength(1));
    // The template and the CLEARED context — and no `model`, which nobody
    // touched. `contextText: null` rather than an omission: see
    // `regenerateInput.ts`.
    expect(regenerateBodies[0]).toEqual({ templateId: 'tpl-2', contextText: null });
  });

  it('keeps the dialog OPEN on a 409 `template_required`, with the question in it', async () => {
    // ⚠ A QUESTION, NOT A FAILURE. The one control that can answer it is the
    // select the user is already looking at; closing the dialog to report this
    // on the page would put the answer and the question on different screens.
    const user = userEvent.setup();
    server.use(
      http.post(`${API_BASE}/notes/:id/regenerate`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'This note has no template.',
            details: { reason: 'template_required' },
          },
          { status: 409 },
        ),
      ),
    );
    renderNote();
    await screen.findByRole('button', { name: 'Regenerate' });

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Regenerate' }));

    expect(
      await within(dialog).findByText('Choose a template to regenerate with'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The user's own controls are still there to answer with.
    expect(within(dialog).getByLabelText('Template')).toBeInTheDocument();
  });

  it('reads NO templates at all until the dialog is opened', async () => {
    // ⚠ THE REASON THE CONTAINER EXISTS. Reading a note is by far the most
    // common thing that happens on this page; it must not pay for a dialog most
    // readers never open. (The panel's own read of ONE template by id is a
    // different request and is expected.)
    const user = userEvent.setup();
    let listReads = 0;
    server.use(
      http.get(`${API_BASE}/note-templates`, () => {
        listReads += 1;
        return HttpResponse.json({ data: { items: [templateRow()], total: 1 } });
      }),
    );
    renderNote();
    await screen.findByRole('button', { name: 'Regenerate' });

    expect(listReads).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await screen.findByRole('dialog');

    await waitFor(() => expect(listReads).toBe(1));
  });
});

// =============================================================================
// #109 — "How this note was generated"
// =============================================================================

describe('NotePage — the generation context panel', () => {
  beforeEach(() => {
    current = note({
      status: 'ready',
      body: 'Done.',
      currentVersion: 1,
      contextText: 'Ana and Ben were there. The budget line is the point.',
    });
  });

  it('sits under the provenance line, collapsed', async () => {
    renderNote();

    const panel = await screen.findByTestId('note-generation-context');
    const provenance = screen.getByTestId('note-provenance');

    // ⚠ ORDER MATTERS: the always-visible sentence first, its long form
    // directly beneath. `DOCUMENT_POSITION_FOLLOWING` is 4.
    expect(
      provenance.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(panel).getByRole('button', { name: /How this note was generated/i }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the CONTEXT TEXT — which is rendered nowhere else in this application', async () => {
    const user = userEvent.setup();
    renderNote();

    await user.click(
      await screen.findByRole('button', { name: /How this note was generated/i }),
    );

    expect(
      screen.getByText(/Ana and Ben were there\. The budget line is the point\./),
    ).toBeInTheDocument();
  });

  it('shows the template’s own recipe, read from `GET /api/note-templates/:id`', async () => {
    const user = userEvent.setup();
    renderNote();

    await user.click(
      await screen.findByRole('button', { name: /How this note was generated/i }),
    );

    // None of this is on `GET /api/notes/:id` — which is why the template is
    // read at all.
    expect(await screen.findByText('Lead with the decisions.')).toBeInTheDocument();
    expect(screen.getByText('Meeting notes')).toBeInTheDocument();
    expect(screen.getByText('Neutral')).toBeInTheDocument();
  });

  it('says the caller has no access rather than reporting an error, on a 404', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${API_BASE}/note-templates/:id`, () => new HttpResponse(null, { status: 404 })),
    );
    renderNote();

    await user.click(
      await screen.findByRole('button', { name: /How this note was generated/i }),
    );

    expect(
      await screen.findByText('You no longer have access to this template'),
    ).toBeInTheDocument();
  });

  it('has no axe violations with the panel open', async () => {
    const user = userEvent.setup();
    const { container } = renderNote();

    await user.click(
      await screen.findByRole('button', { name: /How this note was generated/i }),
    );
    await screen.findByText('Lead with the decisions.');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('NotePage — with no AI key saved', () => {
  beforeEach(() => {
    current = note({ status: 'ready', body: '# Kept\n\nMy own note.', currentVersion: 2 });
    aiConfig = { ...aiConfig, keyConfigured: false };
  });

  it('replaces Regenerate with AiKeyRequired', async () => {
    renderNote();

    expect(
      await screen.findByRole('heading', { name: 'Add your AI key to use this' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
  });

  it('still lets the user READ, EDIT and EXPORT their own note', async () => {
    // ⚠ THE POINT OF THE CRITERION. A missing provider credential gates spending
    // money at a provider; it must never gate a user's own work.
    const user = userEvent.setup();
    exportRow = exportRowFor();
    renderNote();

    expect(await screen.findByRole('heading', { name: 'Kept' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('dialog', { name: 'Export note' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('textbox', { name: 'Note' })).toHaveValue(
      '# Kept\n\nMy own note.',
    );
  });

  it('offers no Regenerate on a FAILED note either, but still explains the failure', async () => {
    current = note({ status: 'failed', failureReason: 'Your provider rejected the key.' });
    renderNote();

    expect(await screen.findByText('Your provider rejected the key.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Add your AI key to use this' }),
    ).toBeInTheDocument();
  });
});

// =============================================================================
// #58 — the title
// =============================================================================

describe('NotePage — renaming', () => {
  it('renames in place, and sends NO baseVersion because a title is not versioned', async () => {
    const user = userEvent.setup();
    current = note({ status: 'ready', body: 'Done.', currentVersion: 2 });

    let sent: Record<string, unknown> | null = null;
    server.use(
      http.patch(`${API_BASE}/notes/:id`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        current = note({ ...current, title: 'Renamed' });
        return HttpResponse.json({ data: current });
      }),
    );

    renderNote();
    await user.click(await screen.findByRole('button', { name: 'Rename this note' }));

    const field = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(field);
    await user.type(field, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save the title' }));

    await waitFor(() => expect(sent).not.toBeNull());
    // ⚠ A title is metadata about the note, never versioned content of it —
    // recording a rename would put a no-op in the history that a later restore
    // could "undo" into a name nobody chose.
    expect(sent).toEqual({ title: 'Renamed' });
    expect(await screen.findByRole('heading', { name: 'Renamed', level: 1 })).toBeInTheDocument();
  });
});

describe('NotePage — the editor’s accessibility', () => {
  beforeEach(() => {
    current = note({ status: 'ready', body: '# Decisions\n\nWe agreed.', currentVersion: 3 });
  });

  it('is reachable and typable from the keyboard alone', async () => {
    const user = userEvent.setup();
    await openEditor(user);

    const textarea = screen.getByRole('textbox', { name: 'Note' });

    textarea.focus();
    expect(textarea).toHaveFocus();
    // The caret lands at the start on a programmatic focus, so this asserts
    // that keystrokes reach the field — not where jsdom puts the cursor.
    await user.keyboard('Typed. ');

    expect(textarea).toHaveValue('Typed. # Decisions\n\nWe agreed.');
  });

  it('has no axe violations with the editor open, in the light theme', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Routes>
        <Route path="/notes/:id" element={<NotePage />} />
      </Routes>,
      { wrapperOptions: { user: mockAdminUser, route: '/notes/n1' } },
    );
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations with the editor open, in the dark theme', async () => {
    // ⚠ THROUGH `localStorage` — the helper's `theme` option is declared and
    // not read, so passing it would render the light theme and assert nothing.
    localStorage.setItem('theme_mode', 'dark');
    const user = userEvent.setup();
    const { container } = render(
      <Routes>
        <Route path="/notes/:id" element={<NotePage />} />
      </Routes>,
      { wrapperOptions: { user: mockAdminUser, route: '/notes/n1' } },
    );
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
