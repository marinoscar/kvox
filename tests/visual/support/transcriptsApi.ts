import type { Page, Route } from '@playwright/test';

/**
 * A mocked transcripts API for the visual harness — issue #30, epic #19.
 *
 * =============================================================================
 * WHY THESE SPECS MOCK AND THE EXISTING ONES DO NOT
 * =============================================================================
 *
 * Every spec written before this one screenshots NAVIGATION CHROME — the rail,
 * the AppBar, the settings hub — and scopes its capture to that element
 * precisely so the page body's own `/api` calls (which the harness deliberately
 * leaves unproxied; see `apps/web/visual/vite.config.ts`) can never appear in a
 * baseline.
 *
 * The three transcript screens are the page BODY. There is nothing to scope
 * away: an unmocked library renders its error state, an unmocked viewer renders
 * a spinner forever. So these specs intercept `/api` at the browser and answer
 * with fixtures, which also makes the baselines independent of any running
 * backend — the same property the rest of this suite gets by not needing one.
 *
 * =============================================================================
 * EVERY VALUE IS FIXED, INCLUDING THE DATES
 * =============================================================================
 *
 * A pixel baseline cannot contain "3 minutes ago". The library renders
 * `formatRelativeTime(createdAt)`, so the fixtures below are pinned to an
 * absolute instant far enough in the past that its rendering ("2 years ago")
 * does not change between the day the baseline is generated and the day it is
 * compared. A `Date.now()`-relative fixture would re-baseline itself daily.
 */

/** The instant every fixture timestamp is derived from. Never `Date.now()`. */
const FIXED_ISO = '2024-03-01T09:00:00.000Z';

/** Two speakers, with stable palette indices — the colour IS the identity. */
const SPEAKERS = [
  { id: 'sp1', label: 'A', displayName: 'Ana Ruiz', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Ben Olsen', colorIndex: 1, rev: 1 },
];

/**
 * Twelve segments across 48 seconds, alternating speakers.
 *
 * Short on purpose: the point of these baselines is the LAYOUT — the speaker
 * colours, the timestamp column, the row rhythm, the player's bands — and a
 * 6,000-segment fixture would render the same visible rows while making the
 * screenshot slower and the fixture unreadable. The virtualization itself is
 * asserted in `apps/web/src/__tests__/components/transcripts/SegmentList.test.tsx`,
 * where a DOM row count can actually be counted.
 */
const SEGMENTS = Array.from({ length: 12 }, (_, index) => ({
  id: `seg-${index}`,
  speakerId: index % 2 === 0 ? 'sp1' : 'sp2',
  startMs: index * 4000,
  endMs: index * 4000 + 3500,
  ordinal: index + 1,
  text:
    index % 2 === 0
      ? 'Right, so the migration finished overnight and the numbers look healthy.'
      : 'Good. Did anything need a manual replay afterwards?',
  wordsAlignment: 'exact',
  confidence: 0.94,
  origin: 'ai',
  rev: 1,
  editedAt: null,
}));

function listItem(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title,
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 48_000,
    speakerCount: 2,
    wordCount: 240,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  };
}

const LIST_ITEMS = [
  listItem('t1', 'Weekly engineering standup'),
  listItem('t2', 'Customer discovery — Northwind', {
    status: 'processing',
    transcriptionStatus: 'processing',
    playbackStatus: 'ready',
    durationMs: null,
    speakerCount: 0,
  }),
  listItem('t3', 'Board update rehearsal', {
    status: 'failed',
    transcriptionStatus: 'failed',
    failureReason: 'The provider could not detect any speech in this recording.',
  }),
];

const DETAIL = {
  ...listItem('t1', 'Weekly engineering standup'),
  speakers: SPEAKERS,
  provider: 'AssemblyAI',
  remoteDeletedAt: null,
  submittedAt: FIXED_ISO,
  completedAt: FIXED_ISO,
  sourceName: 'standup.m4a',
  sourceMimeType: 'audio/mp4',
  sourceSizeBytes: '4194304',
};

/** Where the mocked audio endpoint points. Served by `installTranscriptsApi`. */
const AUDIO_PATH = '/__fixtures__/silence.wav';

/**
 * A valid, silent PCM WAV of `seconds` length.
 *
 * GENERATED RATHER THAN COMMITTED, for two reasons. A binary fixture in the
 * repository is a file nobody can review, and one that is 384 KB of zeros is a
 * file nobody should have to. More importantly, the engine's behaviour depends
 * on the DURATION the browser reports: `setPositionState`, the scrubber's
 * range, and the player's `0:00 / 0:48` readout all come from
 * `loadedmetadata`, so the fixture has to be a real decodable file rather than
 * a data URL the browser may reject — a rejected source fires `error`, the
 * engine re-signs once, fails again, and the screenshot captures the error
 * state instead of the player.
 *
 * 8-bit mono at 8 kHz keeps 48 seconds down to ~384 KB over loopback.
 */
function silentWav(seconds: number): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM header length
  buffer.writeUInt16LE(1, 20); // format: PCM
  buffer.writeUInt16LE(1, 22); // channels
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28); // byte rate (8-bit mono)
  buffer.writeUInt16LE(1, 32); // block align
  buffer.writeUInt16LE(8, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples, 40);
  // 8-bit PCM silence is 128 (unsigned midpoint), not 0 — which would be a
  // full-scale DC offset rather than silence. Inaudible either way here, but a
  // fixture that is wrong on purpose is a fixture somebody later copies.
  buffer.fill(128, 44);

  return buffer;
}

function json(route: Route, data: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers,
    body: JSON.stringify({ data }),
  });
}

export interface TranscriptsApiOptions {
  /** Serve an empty library, for the empty-state baseline. */
  empty?: boolean;
  /** Serve a transcript that is still processing, for the stepper baseline. */
  processing?: boolean;
}

/**
 * Intercept every `/api` call the three transcript screens make.
 *
 * Registered BEFORE `page.goto`, because the pages fetch on mount and a route
 * installed afterwards would miss the first request — which is the only one
 * most of them make.
 */
export async function installTranscriptsApi(
  page: Page,
  options: TranscriptsApiOptions = {},
): Promise<void> {
  await page.route(`**${AUDIO_PATH}`, (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav(48) }),
  );

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    if (path === '/transcription/config') {
      return json(route, {
        available: true,
        providerLabel: 'AssemblyAI',
        maxUploadBytes: 100_000_000,
        maxDurationMs: 7_200_000,
        acceptedExtensions: ['.m4a', '.mp3', '.wav'],
        acceptedMimeTypes: ['audio/mp4', 'audio/mpeg', 'audio/wav'],
      });
    }

    if (path === '/transcripts') {
      const scope = url.searchParams.get('scope');
      // The Shared tab is genuinely empty in every fixture — it is the
      // library's third empty state and worth a baseline of its own later.
      const items = options.empty || scope === 'shared' ? [] : LIST_ITEMS;
      return json(route, { items, nextCursor: null });
    }

    if (/^\/transcripts\/[^/]+\/segments$/.test(path)) {
      return json(
        route,
        { currentVersion: 1, segments: options.processing ? [] : SEGMENTS },
        { ETag: 'W/"v1"' },
      );
    }

    if (/^\/transcripts\/[^/]+\/words$/.test(path)) {
      // Empty: word-level highlighting would put a moving background behind
      // one word, which is exactly the kind of frame-dependent detail a pixel
      // baseline must not contain.
      return json(route, { currentVersion: 1, fromMs: 0, toMs: 300_000, segments: [] });
    }

    if (/^\/transcripts\/[^/]+\/audio$/.test(path)) {
      return json(route, {
        url: AUDIO_PATH,
        kind: 'playback',
        mimeType: 'audio/wav',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }

    if (/^\/transcripts\/[^/]+$/.test(path)) {
      const detail = options.processing
        ? {
            ...DETAIL,
            status: 'processing',
            transcriptionStatus: 'processing',
            playbackStatus: 'ready',
            durationMs: null,
            completedAt: null,
          }
        : DETAIL;
      return json(route, detail, { ETag: 'W/"v1"' });
    }

    // Everything else (`/user-settings`, `/notifications/config`, …) answers an
    // empty object rather than being left to fail: the harness's own header
    // explains why an unproxied `/api` is safe for the NAV specs, but a page
    // body rendering an error banner is not something to leave to chance.
    return json(route, {});
  });
}
