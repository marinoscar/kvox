import type { Page, Route } from '@playwright/test';

/**
 * A mocked API for the signed-in home page — issue #32, epic #19.
 *
 * =============================================================================
 * WHY THE HOME PAGE NEEDS ITS OWN INSTALLER
 * =============================================================================
 *
 * `support/transcriptsApi.ts` mocks the three transcript SCREENS. This page
 * makes a different pair of calls (`GET /transcripts/summary` and
 * `GET /transcription/config`) and, crucially, needs to serve four distinct
 * SHAPES of answer — populated, empty, in-flight, unconfigured — because the
 * four are four completely different layouts rather than four contents of one.
 * Folding those cases into the transcript installer would give that file a
 * second, unrelated matrix of options.
 *
 * ⚠ `/transcripts/summary` MUST BE MATCHED BEFORE `/transcripts/:id`. The two
 * are indistinguishable by shape — `summary` is a legal transcript id as far as
 * a path pattern is concerned — so a handler ordered the other way round
 * answers the home page with a transcript DETAIL payload and the page renders
 * its error state into a baseline. The order below is load-bearing.
 *
 * =============================================================================
 * EVERY VALUE IS FIXED, INCLUDING THE DATES
 * =============================================================================
 *
 * A pixel baseline cannot contain "3 minutes ago". The cards render
 * `formatRelativeTime(createdAt)`, so every timestamp below is pinned to an
 * absolute instant far enough in the past that its rendering does not change
 * between the day the baseline is generated and the day it is compared. A
 * `Date.now()`-relative fixture would re-baseline itself daily.
 *
 * The same rule is why nothing here is `uploading`: a LOCAL upload's row
 * carries a live byte counter and a moving bar, which cannot be mocked through
 * `page.route` at all (it lives in the upload manager's memory, not on the
 * wire) and would not be a stable screenshot if it could. The in-flight
 * baseline captures the SERVER-side half — the stage chip — which is the part
 * this mock can pin exactly.
 */

/** The instant every fixture timestamp is derived from. Never `Date.now()`. */
const FIXED_ISO = '2024-03-01T09:00:00.000Z';

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
    durationMs: 1_920_000,
    speakerCount: 3,
    wordCount: 5400,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  };
}

/**
 * Six, not eight.
 *
 * Eight fills the desktop grid's first two rows exactly, which makes a change
 * in column count (4 → 3, the `lg` boundary) invisible: both render two tidy
 * rows. Six leaves a ragged last row at every width this suite captures, so a
 * reflow shows up as a diff rather than as a rearrangement nobody can see.
 */
const RECENT = [
  listItem('t1', 'Weekly engineering standup'),
  listItem('t2', 'Customer discovery — Northwind', { durationMs: 2_760_000, speakerCount: 2 }),
  listItem('t3', 'Board update rehearsal', { durationMs: 900_000, speakerCount: 1 }),
  listItem('t4', 'Design critique', { durationMs: 3_300_000, speakerCount: 4 }),
  listItem('t5', 'Support escalation review', {
    status: 'failed',
    transcriptionStatus: 'failed',
    failureReason: 'The provider could not detect any speech in this recording.',
  }),
  listItem('t6', 'Quarterly planning', { durationMs: 5_400_000, speakerCount: 6 }),
];

const SHARED = [
  listItem('s1', 'Partner sync — Aldbrook', { access: 'viewer', durationMs: 1_500_000 }),
  listItem('s2', 'Editorial handover', { access: 'editor', durationMs: 2_100_000 }),
];

const IN_PROGRESS = [
  listItem('p1', 'Founder interview, take 2', {
    status: 'processing',
    transcriptionStatus: 'processing',
    playbackStatus: 'ready',
    durationMs: null,
    speakerCount: 0,
  }),
  listItem('p2', 'All-hands recording', {
    status: 'processing',
    transcriptionStatus: 'waiting_input',
    playbackStatus: 'processing',
    durationMs: null,
    speakerCount: 0,
  }),
];

function json(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
}

export type HomeFixture = 'populated' | 'empty' | 'in-progress';

export interface HomeApiOptions {
  /** Which shape of answer `GET /transcripts/summary` gives. */
  fixture?: HomeFixture;
  /** `GET /transcription/config` reports the deployment cannot transcribe. */
  transcriptionUnavailable?: boolean;
}

function summaryFor(fixture: HomeFixture): Record<string, unknown> {
  if (fixture === 'empty') {
    return {
      inProgress: [],
      recent: [],
      sharedWithMe: [],
      counts: { owned: 0, shared: 0, inProgress: 0, failed: 0 },
    };
  }
  if (fixture === 'in-progress') {
    return {
      inProgress: IN_PROGRESS,
      recent: RECENT.slice(0, 3),
      sharedWithMe: [],
      counts: { owned: 5, shared: 0, inProgress: 2, failed: 0 },
    };
  }
  return {
    inProgress: [],
    recent: RECENT,
    sharedWithMe: SHARED,
    counts: { owned: 6, shared: 2, inProgress: 0, failed: 1 },
  };
}

/**
 * Intercept every `/api` call the home page makes.
 *
 * Registered BEFORE `page.goto`, because the page fetches on mount and a route
 * installed afterwards would miss the only request it makes.
 */
export async function installHomeApi(
  page: Page,
  options: HomeApiOptions = {},
): Promise<void> {
  const fixture = options.fixture ?? 'populated';

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    // FIRST — see the header. `summary` is a legal transcript id to a pattern.
    if (path === '/transcripts/summary') {
      return json(route, summaryFor(fixture));
    }

    if (path === '/transcription/config') {
      return json(route, {
        available: !options.transcriptionUnavailable,
        providerLabel: options.transcriptionUnavailable ? null : 'AssemblyAI',
        maxUploadBytes: 100_000_000,
        maxDurationMs: 7_200_000,
        acceptedExtensions: ['.m4a', '.mp3', '.wav'],
        acceptedMimeTypes: ['audio/mp4', 'audio/mpeg', 'audio/wav'],
      });
    }

    // Everything else (`/user-settings`, `/notifications/config`, …) answers an
    // empty object rather than being left to fail: an unproxied `/api` is safe
    // for the NAV specs (see `apps/web/visual/main.tsx`), but a page body
    // rendering an error banner is not something to leave to chance.
    return json(route, {});
  });
}
