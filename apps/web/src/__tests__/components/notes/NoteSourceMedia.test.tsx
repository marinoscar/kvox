import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { NoteSourceMedia, sourceMediaCaption, spokenDuration } from '../../../components/notes/NoteSourceMedia';
import type { NoteOriginTranscript } from '../../../services/notes';

/**
 * `NoteSourceMedia` (issue #309) — the note's own player for the recording it
 * was generated from.
 *
 * jsdom implements no real media playback, so `HTMLMediaElement.prototype`'s
 * `play`/`pause`/`load` are stubbed at the module level, the same stand-in
 * `TranscriptPage.test.tsx` uses. The signing call itself goes through the
 * real service and MSW — this suite is what proves the LAZINESS the header
 * promises: no request until Play is pressed.
 */

const API_BASE = 'http://localhost:3000/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

beforeAll(() => {
  // jsdom's stub leaves `play()`/`pause()` unimplemented and, even stubbed
  // to a no-op, neither fires the real DOM event a browser would — which is
  // what `useSourceAudio`'s own `play`/`pause` listeners drive `status` off
  // of. So the stubs below dispatch that event themselves, exactly as a real
  // element does once playback actually starts/stops.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('pause'));
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).play;
  delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).pause;
  delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).load;
});

function origin(overrides: Partial<NoteOriginTranscript> = {}): NoteOriginTranscript {
  return {
    id: 't1',
    title: 'Weekly standup',
    durationMs: 83_000,
    status: 'ready',
    playbackStatus: 'ready',
    via: 'direct',
    hops: 0,
    ...overrides,
  };
}

let audioRequests: number;

beforeEach(() => {
  audioRequests = 0;
  server.use(
    http.get(`${API_BASE}/transcripts/:id/audio`, () => {
      audioRequests += 1;
      return HttpResponse.json({
        data: {
          url: 'https://storage.example/t1.mp3',
          kind: 'playback',
          mimeType: 'audio/mp4',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    }),
  );
});

describe('sourceMediaCaption', () => {
  it('reads "Source recording" for a direct source', () => {
    expect(sourceMediaCaption(origin({ via: 'direct' }))).toBe('Source recording');
  });

  it('names the hop count for a note chain, singular', () => {
    expect(sourceMediaCaption(origin({ via: 'note_chain', hops: 1 }))).toBe(
      'Original recording (via 1 note)',
    );
  });

  it('names the hop count for a note chain, plural', () => {
    expect(sourceMediaCaption(origin({ via: 'note_chain', hops: 2 }))).toBe(
      'Original recording (via 2 notes)',
    );
  });
});

describe('spokenDuration', () => {
  it('speaks minutes and seconds', () => {
    expect(spokenDuration(83_000)).toBe('1 minute 23 seconds');
  });

  it('speaks hours, minutes and seconds together', () => {
    expect(spokenDuration(3_723_000)).toBe('1 hour 2 minutes 3 seconds');
  });

  it('speaks zero seconds rather than an empty string', () => {
    expect(spokenDuration(0)).toBe('0 seconds');
  });
});

describe('NoteSourceMedia — rendering', () => {
  it('shows the caption, the title link, the transcript link and the duration', () => {
    render(<NoteSourceMedia origin={origin()} />);

    expect(screen.getByText('Source recording')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Weekly standup' })).toHaveAttribute(
      'href',
      '/transcripts/t1',
    );
    expect(screen.getByRole('link', { name: 'Open transcript' })).toHaveAttribute(
      'href',
      '/transcripts/t1',
    );
    expect(screen.getByText('1 min')).toBeInTheDocument();
  });

  it('shows the chain caption for a note-chain origin', () => {
    render(<NoteSourceMedia origin={origin({ via: 'note_chain', hops: 2 })} />);

    expect(screen.getByText('Original recording (via 2 notes)')).toBeInTheDocument();
  });

  it('does NOT request the signed URL on render', async () => {
    render(<NoteSourceMedia origin={origin()} />);

    // Give any accidental effect a tick to fire before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audioRequests).toBe(0);
  });
});

describe('NoteSourceMedia — playing', () => {
  it('requests the signed URL exactly once when Play is pressed', async () => {
    const user = userEvent.setup();
    render(<NoteSourceMedia origin={origin()} />);

    await user.click(screen.getByRole('button', { name: 'Play source recording' }));

    await waitFor(() => expect(audioRequests).toBe(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Pause source recording' })).toBeInTheDocument(),
    );
  });

  it('shows Audio unavailable and a Retry control on a 404', async () => {
    server.use(
      http.get(`${API_BASE}/transcripts/:id/audio`, () => new HttpResponse(null, { status: 404 })),
    );
    const user = userEvent.setup();
    render(<NoteSourceMedia origin={origin()} />);

    await user.click(screen.getByRole('button', { name: 'Play source recording' }));

    expect(await screen.findByText('Audio unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('NoteSourceMedia — a processing transcript', () => {
  it('disables Play with a tooltip explaining why', async () => {
    const user = userEvent.setup();
    render(<NoteSourceMedia origin={origin({ status: 'processing' })} />);

    const button = screen.getByRole('button', { name: 'Play source recording' });
    expect(button).toBeDisabled();

    // A disabled IconButton fires no pointer events, so the tooltip's own
    // wrapping <span> carries it — hover that instead.
    await user.hover(button.parentElement ?? button);
    expect(await screen.findByText('Audio is still processing')).toBeInTheDocument();

    expect(audioRequests).toBe(0);
  });
});

describe('NoteSourceMedia — accessibility', () => {
  it('has an aria-valuetext on the seek slider', async () => {
    const user = userEvent.setup();
    render(<NoteSourceMedia origin={origin()} />);

    await user.click(screen.getByRole('button', { name: 'Play source recording' }));
    await waitFor(() => expect(audioRequests).toBe(1));

    const slider = screen.getByRole('slider', { name: 'Seek source recording' });
    expect(slider).toHaveAttribute('aria-valuetext');
  });

  it('has no axe violations at rest', async () => {
    const { container } = render(<NoteSourceMedia origin={origin()} />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations while playing', async () => {
    const user = userEvent.setup();
    const { container } = render(<NoteSourceMedia origin={origin()} />);

    await user.click(screen.getByRole('button', { name: 'Play source recording' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Pause source recording' })).toBeInTheDocument(),
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the failed state', async () => {
    server.use(
      http.get(`${API_BASE}/transcripts/:id/audio`, () => new HttpResponse(null, { status: 404 })),
    );
    const user = userEvent.setup();
    const { container } = render(<NoteSourceMedia origin={origin()} />);

    await user.click(screen.getByRole('button', { name: 'Play source recording' }));
    await screen.findByText('Audio unavailable');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
