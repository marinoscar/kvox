import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { NeedsAttention } from '../../../components/home/NeedsAttention';
import type { NeedsAttentionProps } from '../../../components/home/NeedsAttention';
import { AXE_OPTIONS, note, transcript } from './homeFixtures';

/**
 * The home page's "Needs attention" section — issue #171, epic #166.
 *
 * The component is props-only, so every list it renders is handed to it and
 * nothing here mocks a summary hook. The retry calls are NOT mocked either:
 * they go through `services/transcripts.ts` and `services/notes.ts` to MSW, so
 * these tests assert the real paths (`POST /api/transcripts/:id/retry`, `POST
 * /api/notes/:id/regenerate`) rather than that some spy was called — the thing
 * most likely to be wrong is which endpoint a button reaches.
 */

const API_BASE = 'http://localhost:3000/api';

/** A failed recording, as the summary's `failed` list carries it. */
const FAILED_TRANSCRIPT = transcript({
  id: 't-failed',
  title: 'Board meeting',
  status: 'failed',
  transcriptionStatus: 'failed',
  playbackStatus: 'failed',
  failureReason: 'The provider rejected the audio.',
});

/** A note whose generation failed. */
const FAILED_NOTE = note({
  id: 'n-failed',
  title: 'Board minutes',
  status: 'failed',
  failureReason: 'Your API key was rejected.',
});

/** Every path a retry POST reached, so "the right endpoint" is assertable. */
let retryPaths: string[] = [];

function setup(overrides: Partial<NeedsAttentionProps> = {}) {
  const onTranscriptRetried = vi.fn();
  const onNoteRetried = vi.fn();
  const props: NeedsAttentionProps = {
    transcripts: [FAILED_TRANSCRIPT],
    transcriptTotal: 1,
    notes: [FAILED_NOTE],
    noteTotal: 1,
    canRetryTranscripts: true,
    canRetryNotes: true,
    onTranscriptRetried,
    onNoteRetried,
    ...overrides,
  };
  const result = render(<NeedsAttention {...props} />);
  return { ...result, onTranscriptRetried, onNoteRetried };
}

/** The row a title belongs to — every inline assertion is scoped to one. */
function row(title: string) {
  return screen.getByRole('heading', { name: title }).closest('li') as HTMLElement;
}

beforeEach(() => {
  mockNavigate.mockClear();
  retryPaths = [];
  server.resetHandlers();
  server.use(
    http.post(`${API_BASE}/transcripts/:id/retry`, ({ request }) => {
      retryPaths.push(new URL(request.url).pathname);
      return HttpResponse.json({ data: { ...FAILED_TRANSCRIPT, status: 'processing' } });
    }),
    http.post(`${API_BASE}/notes/:id/regenerate`, ({ request }) => {
      retryPaths.push(new URL(request.url).pathname);
      return HttpResponse.json({
        data: {
          note: { ...FAILED_NOTE, status: 'generating' },
          generationId: 'gen-1',
          jobId: 'job-1',
          providerId: 'openai',
          model: 'gpt-4o-mini',
        },
      });
    }),
  );
});

// =============================================================================
// What it renders
// =============================================================================

describe('NeedsAttention — the rows', () => {
  it('heads the section "Needs attention"', () => {
    setup();

    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
  });

  it('labels the section region for a screen reader', () => {
    setup();

    expect(screen.getByRole('region', { name: 'Needs attention' })).toBeInTheDocument();
  });

  it('heads the section at h2, under the page’s one h1', () => {
    // Every sibling section on this page (`In progress`, `Recent`, `Shared with
    // me`, `Recent notes`) is an h2 and the only h1 is the hero's greeting, so
    // an h3 here would skip a level for anybody navigating by heading.
    setup();

    expect(screen.getByRole('heading', { name: 'Needs attention' }).tagName).toBe('H2');
  });

  it('renders a row for a failed transcript AND a failed note', () => {
    // BOTH CONTENT TYPES IN ONE SECTION. "What went wrong?" is one question,
    // and answering it in two places makes the user check both.
    setup();

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Board meeting' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Board minutes' })).toBeInTheDocument();
  });

  it('renders them as a real list, not a pile of divs', () => {
    setup();

    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('states the recorded reason each one failed', () => {
    setup();

    expect(within(row('Board meeting')).getByText('The provider rejected the audio.'))
      .toBeInTheDocument();
    expect(within(row('Board minutes')).getByText('Your API key was rejected.'))
      .toBeInTheDocument();
  });

  it('says when a transcript failed rather than leaving it undated', () => {
    // `formatRelativeTime` over `updatedAt` — the fixture instant is years in
    // the past on purpose, so this reads the same on every machine on every day.
    setup();

    expect(within(row('Board meeting')).getByText(/^Failed .+ ago$/)).toBeInTheDocument();
  });

  it('still says something when the API recorded no reason at all', () => {
    // `failureMessage` covers the transcript half and this component covers the
    // note half; a row with a blank explanation is the one thing a section
    // called "Needs attention" must never render.
    setup({
      transcripts: [transcript({ id: 't2', title: 'Silent', status: 'failed', failureReason: null })],
      notes: [note({ id: 'n2', title: 'Nameless', status: 'failed', failureReason: null })],
    });

    expect(within(row('Silent')).getByText(/went wrong/i)).toBeInTheDocument();
    expect(within(row('Nameless')).getByText(/did not return a note/i)).toBeInTheDocument();
  });

  it('opens the transcript when its row is pressed', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('heading', { name: 'Board meeting' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/t-failed');
  });

  it('opens the note when its row is pressed', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('heading', { name: 'Board minutes' }));

    expect(mockNavigate).toHaveBeenCalledWith('/notes/n-failed');
  });
});

// =============================================================================
// Absent on a healthy account
// =============================================================================

describe('NeedsAttention — nothing wrong', () => {
  it('renders NOTHING when both lists are empty', () => {
    // Not an empty box and not a "nothing needs attention" card: the steady
    // state of this app is that nothing is broken, so a permanent empty block
    // would push the recent list below the fold on a phone to say nothing.
    const { container } = setup({ transcripts: [], notes: [], transcriptTotal: 0, noteTotal: 0 });

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing even when the counts are non-zero but the lists are not', () => {
    // The rows decide, never the counts. A count with no rows behind it is
    // exactly the dead end this section exists to replace.
    const { container } = setup({
      transcripts: [],
      notes: [],
      transcriptTotal: 4,
      noteTotal: 2,
    });

    expect(container).toBeEmptyDOMElement();
  });

  it('still renders for a failed note alone', () => {
    setup({ transcripts: [], transcriptTotal: 0 });

    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1);
  });

  it('renders no note rows when the page hands it none', () => {
    // What a caller without `notes:read` produces: `HomePage` passes `[]`
    // because there is no notes summary for that user at all.
    setup({ notes: [], noteTotal: 0 });

    expect(screen.queryByRole('heading', { name: 'Board minutes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Regenerate/ })).not.toBeInTheDocument();
  });
});

// =============================================================================
// The capped list
// =============================================================================

describe('NeedsAttention — the cap', () => {
  it('says how many of the total it is showing', () => {
    // The lists are capped at eight and `counts.failed` is the true total, so
    // eight rows presented as everything would be the summary lying.
    setup({ transcriptTotal: 24, noteTotal: 6 });

    expect(screen.getByText('Showing 2 of 30')).toBeInTheDocument();
  });

  it('says nothing when the cap did not bite', () => {
    setup();

    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
  });
});

// =============================================================================
// The permission gates
// =============================================================================

describe('NeedsAttention — who may retry', () => {
  it('withholds the transcript retry without transcripts:write', () => {
    setup({ canRetryTranscripts: false });

    expect(screen.queryByRole('button', { name: 'Retry Board meeting' })).not.toBeInTheDocument();
  });

  it('keeps the transcript ROW without transcripts:write', () => {
    // The button is gated, never the news. A user who cannot retry still
    // benefits from knowing the recording failed.
    setup({ canRetryTranscripts: false });

    expect(screen.getByRole('heading', { name: 'Board meeting' })).toBeInTheDocument();
    expect(within(row('Board meeting')).getByText('The provider rejected the audio.'))
      .toBeInTheDocument();
  });

  it('withholds the note retry without notes:write', () => {
    setup({ canRetryNotes: false });

    expect(screen.queryByRole('button', { name: 'Regenerate Board minutes' }))
      .not.toBeInTheDocument();
  });

  it('keeps the note ROW without notes:write', () => {
    setup({ canRetryNotes: false });

    expect(screen.getByRole('heading', { name: 'Board minutes' })).toBeInTheDocument();
  });

  it('gates the two independently', () => {
    setup({ canRetryTranscripts: false });

    expect(screen.getByRole('button', { name: 'Regenerate Board minutes' })).toBeInTheDocument();
  });

  it('names each control with the item it acts on', () => {
    // Eight rows whose buttons all announce "Retry" are eight controls a
    // screen-reader user cannot tell apart.
    setup({
      transcripts: [
        transcript({ id: 'a', title: 'Alpha', status: 'failed' }),
        transcript({ id: 'b', title: 'Beta', status: 'failed' }),
      ],
      notes: [],
      noteTotal: 0,
      transcriptTotal: 2,
    });

    expect(screen.getByRole('button', { name: 'Retry Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry Beta' })).toBeInTheDocument();
  });
});

// =============================================================================
// Retrying
// =============================================================================

describe('NeedsAttention — retrying', () => {
  it('retries a transcript through POST /api/transcripts/:id/retry', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));

    await waitFor(() => expect(retryPaths).toEqual(['/api/transcripts/t-failed/retry']));
  });

  it('refreshes the TRANSCRIPT summary after a transcript retry', async () => {
    // The refreshed summary is what takes the row off the list; nothing is
    // spliced out locally on the evidence of a queued job.
    const user = userEvent.setup();
    const { onTranscriptRetried, onNoteRetried } = setup();

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));

    await waitFor(() => expect(onTranscriptRetried).toHaveBeenCalledTimes(1));
    // AND NOT THE OTHER ONE. A single `onRetried` would make every transcript
    // retry re-read the notes summary too, which is a request nothing on
    // screen is waiting for.
    expect(onNoteRetried).not.toHaveBeenCalled();
  });

  it('regenerates a note through POST /api/notes/:id/regenerate', async () => {
    // `note.generate` is `maxAttempts: 1`, so this endpoint is the note's ONLY
    // retry path — see CLAUDE.md. A "retry the job" call would not exist.
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Regenerate Board minutes' }));

    await waitFor(() => expect(retryPaths).toEqual(['/api/notes/n-failed/regenerate']));
  });

  it('refreshes the NOTES summary after a note retry', async () => {
    const user = userEvent.setup();
    const { onTranscriptRetried, onNoteRetried } = setup();

    await user.click(screen.getByRole('button', { name: 'Regenerate Board minutes' }));

    await waitFor(() => expect(onNoteRetried).toHaveBeenCalledTimes(1));
    expect(onTranscriptRetried).not.toHaveBeenCalled();
  });

  it('reports a refused retry ON THE ROW it happened to', async () => {
    // Never in a page-level banner: a message about a recording the reader
    // would then have to go and find is a message about nothing they can act
    // on — the argument `TranscriptsLibraryView` already makes for its own
    // rows. With two content types in one list it is sharper still.
    server.use(
      http.post(`${API_BASE}/transcripts/:id/retry`, () =>
        HttpResponse.json({ message: 'Transcription is not configured' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));

    expect(
      await within(row('Board meeting')).findByText(/Transcription is not configured/),
    ).toBeInTheDocument();
  });

  it('raises no page-level alert for a refused retry', async () => {
    server.use(
      http.post(`${API_BASE}/transcripts/:id/retry`, () =>
        HttpResponse.json({ message: 'Transcription is not configured' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));
    await within(row('Board meeting')).findByText(/Transcription is not configured/);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves the OTHER row unmarked', async () => {
    server.use(
      http.post(`${API_BASE}/transcripts/:id/retry`, () =>
        HttpResponse.json({ message: 'Transcription is not configured' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));
    await within(row('Board meeting')).findByText(/Transcription is not configured/);

    expect(
      within(row('Board minutes')).queryByText(/Transcription is not configured/),
    ).not.toBeInTheDocument();
  });

  it('does not refresh anything when the retry was refused', async () => {
    server.use(
      http.post(`${API_BASE}/transcripts/:id/retry`, () =>
        HttpResponse.json({ message: 'no' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    const { onTranscriptRetried } = setup();

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));
    await within(row('Board meeting')).findByText(/no/);

    expect(onTranscriptRetried).not.toHaveBeenCalled();
  });

  it('carries a message even when the refusal had none', async () => {
    server.use(
      http.post(`${API_BASE}/transcripts/:id/retry`, () => HttpResponse.error()),
    );
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));

    expect(
      await within(row('Board meeting')).findByText(/could not be started again/),
    ).toBeInTheDocument();
  });

  it('clears a previous failure when the row is retried again', async () => {
    server.use(
      http.post(`${API_BASE}/transcripts/:id/retry`, () =>
        HttpResponse.json({ message: 'Temporarily unavailable' }, { status: 503 }),
      ),
    );
    const user = userEvent.setup();
    const { onTranscriptRetried } = setup();

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));
    await within(row('Board meeting')).findByText(/Temporarily unavailable/);

    server.use(
      http.post(`${API_BASE}/transcripts/:id/retry`, () =>
        HttpResponse.json({ data: { ...FAILED_TRANSCRIPT, status: 'processing' } }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));

    await waitFor(() => expect(onTranscriptRetried).toHaveBeenCalledTimes(1));
    expect(
      within(row('Board meeting')).queryByText(/Temporarily unavailable/),
    ).not.toBeInTheDocument();
  });
});

// =============================================================================
// Accessibility
// =============================================================================

describe('NeedsAttention — accessibility', () => {
  it('has no violations with both content types listed', async () => {
    const { container } = setup();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no violations with the retry buttons withheld', async () => {
    const { container } = setup({ canRetryTranscripts: false, canRetryNotes: false });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no violations with a failure reported on a row', async () => {
    server.use(
      http.post(`${API_BASE}/transcripts/:id/retry`, () =>
        HttpResponse.json({ message: 'Transcription is not configured' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    const { container } = setup();

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));
    await within(row('Board meeting')).findByText(/Transcription is not configured/);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
