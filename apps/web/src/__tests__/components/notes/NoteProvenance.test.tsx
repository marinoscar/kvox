import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { NoteProvenance } from '../../../components/notes/NoteProvenance';
import { formatShortDate } from '../../../utils/relativeTime';
import type { Note } from '../../../services/notes';

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
    // A `managed_by: 'notes'` storage object has no route in this application,
    // and a link to a download would hand the user back their own upload
    // instead of the evidence.
    render(
      <NoteProvenance
        note={note({ sourceType: 'document', sourceTranscriptId: null, sourceObjectId: 'obj-1' })}
        sourceName="board-pack.pdf"
      />,
    );

    expect(screen.getByText('board-pack.pdf')).toBeInTheDocument();
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
