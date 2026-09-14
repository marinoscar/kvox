import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
    contextText: null,
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** What `GET /api/notes/:id` answers with right now. Reassign to change it. */
let current: Note;
let regenerateCalls = 0;

beforeEach(() => {
  // See `LibraryPage.test.tsx`: `localStorage` survives between tests and the
  // theme provider seeds itself from this key.
  localStorage.setItem('theme_mode', 'light');
  streams.length = 0;
  regenerateCalls = 0;
  current = note();
  server.use(
    http.get(`${API_BASE}/notes/:id`, () => HttpResponse.json({ data: current })),
    http.post(`${API_BASE}/notes/:id/regenerate`, () => {
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
    // ⚠ THROUGH `localStorage` — see `LibraryPage.test.tsx`'s own note: the
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
