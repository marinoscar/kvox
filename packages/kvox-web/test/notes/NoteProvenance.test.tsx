import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from './helpers.js';
import { http, HttpResponse, server } from './msw-compat.js';
import { NoteProvenance } from '../../src/notes/ui/components/NoteProvenance.js';
import { formatShortDate } from '../../src/core/headless/index.js';
import type { Note } from '../../src/notes/headless/clients/notes.js';

/**
 * `NoteProvenance` — issue #58, epic #45.
 *
 * The component asserts the epic's own premise: a reader can always get from a
 * note back to the evidence it was derived from, without opening a menu. So the
 * tests are about the SENTENCE and the LINK, not about styling.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Q3 planning — decisions',
    titleSource: 'ai',
    body: 'Body.',
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Executive summary',
    sourceName: null,
    contextText: null,
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: '2024-03-12T10:00:00.000Z',
    updatedAt: '2024-03-12T10:00:00.000Z',
    ...overrides,
  };
}

describe('NoteProvenance', () => {
  it('reads as the sentence the issue specifies', async () => {
    render(<NoteProvenance note={note()} sourceName="Q3 planning call" />);

    expect(screen.getByTestId('note-provenance')).toHaveTextContent(
      /^Generated from Q3 planning call using Executive summary, /,
    );
    // An ABSOLUTE date, not "5 months ago": provenance is a fact about a day.
    expect(screen.getByTestId('note-provenance')).toHaveTextContent(
      formatShortDate('2024-03-12T10:00:00.000Z'),
    );
  });

  it('links a transcript source back to the transcript', () => {
    render(<NoteProvenance note={note()} sourceName="Q3 planning call" />);

    expect(screen.getByRole('link', { name: 'Q3 planning call' })).toHaveAttribute(
      'href',
      '/transcripts/t1',
    );
  });

  it('links a note source back to that note', () => {
    render(
      <NoteProvenance
        note={note({ sourceType: 'note', sourceTranscriptId: null, sourceNoteId: 'n0' })}
        sourceName="Earlier note"
      />,
    );

    expect(screen.getByRole('link', { name: 'Earlier note' })).toHaveAttribute('href', '/notes/n0');
  });

  it('names a document source but does NOT link it — there is no page to link to', () => {
    // A `managed_by: 'notes'` storage object has no route in this application.
    // The name is a DOWNLOAD BUTTON (#732), never a link to a page.
    render(
      <NoteProvenance
        note={note({ sourceType: 'document', sourceTranscriptId: null, sourceObjectId: 'obj-1' })}
        sourceName="board-pack.pdf"
      />,
    );

    expect(screen.getByText('board-pack.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('says "Imported from" the file for a document kept as the note (#730)', () => {
    // No template and a document source: the file IS the note, so nothing was generated.
    render(
      <NoteProvenance
        note={note({
          sourceType: 'document',
          sourceTranscriptId: null,
          sourceObjectId: 'obj-1',
          templateId: null,
          templateName: null,
          model: null,
        })}
        sourceName="board-pack.docx"
      />,
    );

    expect(screen.getByTestId('note-provenance')).toHaveTextContent(/^Imported from board-pack\.docx, /);
    expect(screen.getByTestId('note-provenance')).not.toHaveTextContent('Generated');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('falls back to the CATEGORY NOUN, never to an id', () => {
    render(<NoteProvenance note={note()} sourceName={null} />);

    expect(screen.getByRole('link', { name: 'a transcript' })).toBeInTheDocument();
    expect(screen.getByTestId('note-provenance')).not.toHaveTextContent('t1');
  });

  it('drops the template clause rather than saying "using null"', () => {
    render(<NoteProvenance note={note({ templateName: null })} sourceName="Q3 planning call" />);

    expect(screen.getByTestId('note-provenance')).not.toHaveTextContent('using');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <NoteProvenance note={note()} sourceName="Q3 planning call" />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

const API_BASE = 'http://localhost:3000/api';

const SIGNED = {
  url: 'https://storage.example/signed/board-pack.pdf?sig=abc',
  filename: 'board-pack.pdf',
  mimeType: 'application/pdf',
  expiresAt: '2026-10-24T10:15:00.000Z',
};

function importedNote(overrides: Partial<Note> = {}): Note {
  return note({
    sourceType: 'document',
    sourceTranscriptId: null,
    sourceObjectId: 'obj-1',
    templateId: null,
    templateName: null,
    model: null,
    ...overrides,
  });
}

describe('NoteProvenance — downloading the original file (#732)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers "Download <file name>" for a document-sourced note', () => {
    render(<NoteProvenance note={importedNote()} sourceName="board-pack.docx" />);

    expect(screen.getByRole('button', { name: 'Download board-pack.docx' })).toBeInTheDocument();
    expect(screen.getByTestId('note-provenance')).toHaveTextContent(/^Imported from board-pack\.docx, /);
  });

  it('offers it for a document a template generated from, too', () => {
    render(
      <NoteProvenance
        note={note({ sourceType: 'document', sourceTranscriptId: null, sourceObjectId: 'obj-1' })}
        sourceName="board-pack.pdf"
      />,
    );

    expect(screen.getByRole('button', { name: 'Download board-pack.pdf' })).toBeInTheDocument();
  });

  it('offers no download for a transcript or a note source', () => {
    const { unmount } = render(<NoteProvenance note={note()} sourceName="Q3 planning call" />);
    expect(screen.queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
    unmount();

    render(
      <NoteProvenance
        note={note({ sourceType: 'note', sourceTranscriptId: null, sourceNoteId: 'n0' })}
        sourceName="Earlier note"
      />,
    );
    expect(screen.queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
  });

  it('offers no download for a document note without a stored object', () => {
    render(
      <NoteProvenance
        note={importedNote({ sourceObjectId: null })}
        sourceName="board-pack.pdf"
      />,
    );

    expect(screen.queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
  });

  it('asks the API for the signed URL and opens it the way an export download is opened', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    let requested: string | null = null;
    server.use(
      http.get(`${API_BASE}/notes/:id/source`, ({ request }) => {
        requested = new URL(request.url).pathname;
        return HttpResponse.json({ data: SIGNED });
      }),
    );
    render(<NoteProvenance note={importedNote()} sourceName="board-pack.pdf" />);

    await user.click(screen.getByRole('button', { name: 'Download board-pack.pdf' }));

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(SIGNED.url, '_blank', 'noopener,noreferrer'),
    );
    expect(requested).toBe('/api/notes/n1/source');
    expect(screen.queryByTestId('note-source-download-error')).not.toBeInTheDocument();
  });

  it('says the original file is gone on a 404, and opens nothing', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    server.use(
      http.get(`${API_BASE}/notes/:id/source`, () =>
        HttpResponse.json(
          { statusCode: 404, code: 'NOT_FOUND', message: 'Not found' },
          { status: 404 },
        ),
      ),
    );
    render(<NoteProvenance note={importedNote()} sourceName="board-pack.pdf" />);

    await user.click(screen.getByRole('button', { name: 'Download board-pack.pdf' }));

    expect(await screen.findByTestId('note-source-download-error')).toHaveTextContent(
      'The original file is no longer available.',
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('says so generically when the download fails for another reason', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'open').mockImplementation(() => null);
    server.use(
      http.get(`${API_BASE}/notes/:id/source`, () =>
        HttpResponse.json(
          { statusCode: 500, code: 'INTERNAL_SERVER_ERROR', message: 'Boom' },
          { status: 500 },
        ),
      ),
    );
    render(<NoteProvenance note={importedNote()} sourceName="board-pack.pdf" />);

    await user.click(screen.getByRole('button', { name: 'Download board-pack.pdf' }));

    expect(await screen.findByTestId('note-source-download-error')).toHaveTextContent(
      'The original file could not be downloaded.',
    );
  });

  it('has no axe violations with the download control', async () => {
    const { container } = render(
      <NoteProvenance note={importedNote()} sourceName="board-pack.pdf" />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('formatShortDate', () => {
  it('states the day and month for a date inside the current year', () => {
    const now = new Date('2024-06-01T00:00:00.000Z');

    expect(formatShortDate('2024-03-12T10:00:00.000Z', now)).toBe(
      new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' }).format(
        new Date('2024-03-12T10:00:00.000Z'),
      ),
    );
  });

  it('adds the year once the date is not this one', () => {
    // ⚠ "12 March" on a three-year-old note quietly lies about when the
    // meeting happened.
    const now = new Date('2027-06-01T00:00:00.000Z');

    expect(formatShortDate('2024-03-12T10:00:00.000Z', now)).toContain('2024');
  });

  it('hands back an unparseable value rather than rendering Invalid Date', () => {
    expect(formatShortDate('not a date')).toBe('not a date');
  });
});
