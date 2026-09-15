import type { Page, Route } from '@playwright/test';

/**
 * A mocked API for the signed-in home page — issue #32, epic #19.
 *
 * =============================================================================
 * WHY THE HOME PAGE NEEDS ITS OWN INSTALLER
 * =============================================================================
 *
 * `support/transcriptsApi.ts` mocks the three transcript SCREENS. This page
 * makes a different set of calls (`GET /transcripts/summary`,
 * `GET /notes/summary` since issue #107, and `GET /transcription/config`) and,
 * crucially, needs to serve four distinct SHAPES of answer — populated, empty,
 * in-flight, unconfigured — because the four are four completely different
 * layouts rather than four contents of one. Folding those cases into the
 * transcript installer would give that file a second, unrelated matrix of
 * options.
 *
 * ⚠ `/transcripts/summary` MUST BE MATCHED BEFORE `/transcripts/:id`, AND
 * `/notes/summary` BEFORE `/notes/:id`. Each pair is indistinguishable by shape
 * — `summary` is a legal id as far as a path pattern is concerned — so a
 * handler ordered the other way round answers the home page with a DETAIL
 * payload and the page renders its error state into a baseline. The order below
 * is load-bearing, and stays load-bearing when a `/notes/:id` route is added.
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

/**
 * The notes half of the page — issue #107.
 *
 * Two rows rather than six: the notes grid uses the same `Grid` sizes as the
 * transcript one, which the six RECENT rows above already exercise at every
 * captured width, so a third full grid would be three more rows of pixels
 * asserting a reflow that is already asserted. What these two DO add is the
 * things only a note card has — the provenance line and the template name — at
 * one and two columns.
 *
 * `sourceTranscriptId` points at `t1`, which `RECENT` above defines, so the
 * provenance line resolves to a real title through `useNoteSourceNames` rather
 * than falling back to "a transcript" in the baseline.
 */
function noteItem(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title,
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting minutes',
    currentGenerationId: null,
    failureReason: null,
    excerpt:
      'The team agreed to ship the export dialog before the end of the month, and to '
      + 'revisit the pricing page once the new copy lands.',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  };
}

const RECENT_NOTES = [
  noteItem('n1', 'Weekly standup — minutes'),
  noteItem('n2', 'Northwind discovery brief', { templateName: 'Discovery brief' }),
];

const GENERATING_NOTES = [
  noteItem('n3', 'Founder interview — key quotes', { status: 'generating', excerpt: '' }),
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

/**
 * `GET /api/notes/summary`, shaped to match the transcript fixture beside it.
 *
 * The three shapes move TOGETHER: an `empty` transcript summary with a
 * populated notes one would render the "Recent notes" section under the journey
 * walkthrough, which is not a state the page produces (`isNewUser` consults
 * both counts since #107) and would bake a layout nobody can reach into a
 * baseline.
 */
function noteSummaryFor(fixture: HomeFixture): Record<string, unknown> {
  if (fixture === 'empty') {
    return {
      inProgress: [],
      recent: [],
      failed: [],
      counts: { total: 0, ready: 0, inProgress: 0, failed: 0 },
    };
  }
  if (fixture === 'in-progress') {
    return {
      inProgress: GENERATING_NOTES,
      recent: RECENT_NOTES.slice(0, 1),
      failed: [],
      counts: { total: 2, ready: 1, inProgress: 1, failed: 0 },
    };
  }
  return {
    inProgress: [],
    recent: RECENT_NOTES,
    failed: [],
    counts: { total: 2, ready: 2, inProgress: 0, failed: 0 },
  };
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

    // LIKEWISE FIRST, and before any `/notes/:id` route added later.
    if (path === '/notes/summary') {
      return json(route, noteSummaryFor(fixture));
    }

    // What `useNoteSourceNames` reads to turn a note's `sourceTranscriptId`
    // into "from *Weekly engineering standup*". Without it every provenance
    // line in the baseline would render the fallback noun instead — a real
    // state, but not the one these captures are for.
    const transcriptMatch = /^\/transcripts\/([^/]+)$/.exec(path);
    if (transcriptMatch) {
      const found = [...RECENT, ...SHARED, ...IN_PROGRESS].find(
        (item) => item.id === transcriptMatch[1],
      );
      if (found) return json(route, found);
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
