import type { Page, Route } from '@playwright/test';

/**
 * A mocked notes API for the visual harness — issue #57, epic #45.
 *
 * The sibling of `transcriptsApi.ts`, and installed the same way and for the
 * same reason: the note screens are the page BODY, so there is nothing to scope
 * a screenshot away from. An unmocked library renders its error state and an
 * unmocked note page a spinner forever.
 *
 * =============================================================================
 * EVERY VALUE IS FIXED, INCLUDING THE DATES AND THE STREAM
 * =============================================================================
 *
 * A pixel baseline cannot contain "3 minutes ago", so every timestamp is pinned
 * to an absolute instant far enough in the past that its rendering ("2 years
 * ago") does not move between the day a baseline is generated and the day it is
 * compared.
 *
 * ⚠ AND THE GENERATION STREAM IS SERVED COMPLETE, IN ONE RESPONSE. A stream
 * that arrived in timed chunks would be a different screenshot on every run —
 * the capture would land wherever the text happened to be. So the SSE body
 * carries its whole delta and then ENDS without a terminal frame: the page
 * renders a fixed amount of markdown and stays visibly mid-generation, which is
 * exactly the state this baseline exists to protect.
 */

/** The instant every fixture timestamp is derived from. Never `Date.now()`. */
const FIXED_ISO = '2024-03-01T09:00:00.000Z';

function noteRow(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title,
    excerpt:
      'The team agreed to ship the storage migration behind a flag, with a rollback ' +
      'plan owned by Ana.',
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
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  };
}

const LIST_ITEMS = [
  noteRow('n1', 'Weekly engineering standup — minutes'),
  noteRow('n2', 'Customer discovery — Northwind', {
    status: 'generating',
    currentVersion: 0,
    excerpt: '',
  }),
  noteRow('n3', 'Board update — talking points', {
    status: 'failed',
    currentVersion: 0,
    excerpt: '',
    failureReason: 'Your AI provider rejected the key saved for your account.',
  }),
];

/** The markdown every generation baseline renders. Fixed, and deliberately GFM-heavy. */
const GENERATED_MARKDOWN = `# Weekly engineering standup

## Decisions

- Ship the storage migration **behind a flag**, defaulting off.
- Ana owns the rollback plan; Ben reviews it before Friday.

## Actions

| Owner | Action | Due |
| ----- | ------ | --- |
| Ana | Write the rollback runbook | Thu |
| Ben | Re-run the load test | Fri |

> We agreed not to touch the queue while the migration is in flight.
`;

const TEMPLATES = [
  {
    id: 'tpl-1',
    name: 'Meeting minutes',
    description: 'Decisions, actions and owners.',
    instructions: 'Write up the meeting.',
    outputFormat: 'markdown',
    structure: ['Decisions', 'Actions'],
    tone: null,
    length: null,
    model: null,
    isArchived: false,
    builtIn: true,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  },
  {
    id: 'tpl-2',
    name: 'Executive brief',
    description: 'Three paragraphs, no bullets.',
    instructions: 'Summarise for an executive.',
    outputFormat: 'markdown',
    structure: [],
    tone: 'formal',
    length: 'short',
    model: null,
    isArchived: false,
    builtIn: false,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  },
];

/**
 * The version history every history baseline renders — issue #58.
 *
 * ⚠ `author: null` ON VERSION 1 IS THE POINT, not an omission: it is the
 * convention the API publishes for "the AI wrote this", and the baseline exists
 * partly to protect the "AI" label the page derives from it.
 */
const VERSIONS = [
  {
    version: 3,
    kind: 'restore',
    summary: 'Back to the AI draft',
    author: { id: 'u1', name: 'Visual Harness' },
    generationId: null,
    restoredFromVersion: 1,
    createdAt: FIXED_ISO,
  },
  {
    version: 2,
    kind: 'edit',
    summary: 'Fixed the owner of the rollback plan',
    author: { id: 'u1', name: 'Visual Harness' },
    generationId: null,
    restoredFromVersion: null,
    createdAt: FIXED_ISO,
  },
  {
    version: 1,
    kind: 'ai_generated',
    summary: null,
    author: null,
    generationId: 'gen-1',
    restoredFromVersion: null,
    createdAt: FIXED_ISO,
  },
];

/** The formats the export dialog builds itself from. Published, never hardcoded client-side. */
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
        description: 'Names the source, the template and the version exported.',
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

function transcriptRow(id: string, title: string): Record<string, unknown> {
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
    ownerName: 'Visual Harness',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
}

const TRANSCRIPTS = [
  transcriptRow('t1', 'Weekly engineering standup'),
  transcriptRow('t2', 'Customer discovery — Northwind'),
];

function json(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
}

export interface NotesApiOptions {
  /** Serve an empty library, for the empty-state baseline. */
  empty?: boolean;
  /** Serve the note at `/notes/n1` mid-generation rather than finished. */
  generating?: boolean;
  /** Serve the note at `/notes/n1` as a failed generation. */
  failed?: boolean;
  /** Answer `GET /api/ai/config` with `keyConfigured: false`. */
  noKey?: boolean;
}

/**
 * Intercept every `/api` call the note screens make.
 *
 * Registered BEFORE `page.goto`, because the pages fetch on mount and a route
 * installed afterwards would miss the first request — which is the only one
 * most of them make.
 */
export async function installNotesApi(
  page: Page,
  options: NotesApiOptions = {},
): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    if (path === '/ai/config') {
      return json(route, {
        available: true,
        provider: 'openai',
        providerLabel: 'OpenAI',
        models: [
          {
            id: 'gpt-4o-mini',
            label: 'GPT-4o mini',
            contextWindowTokens: 128_000,
            maxOutputTokens: 16_000,
          },
        ],
        defaultModel: 'gpt-4o-mini',
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
        keyConfigured: !options.noKey,
      });
    }

    if (path === '/note-templates') {
      return json(route, { items: TEMPLATES, total: TEMPLATES.length });
    }

    if (path === '/transcripts') {
      return json(route, { items: TRANSCRIPTS, nextCursor: null });
    }

    // The library's source-name resolver reads the transcript by id, which is
    // what turns "from a transcript" into "from *Weekly engineering standup*".
    if (/^\/transcripts\/[^/]+$/.test(path)) {
      return json(route, TRANSCRIPTS[0]);
    }

    if (path === '/notes') {
      return json(route, { items: options.empty ? [] : LIST_ITEMS, nextCursor: null });
    }

    // ⚠ The SSE stream. Served COMPLETE and then ended — see the file header
    // for why a timed stream cannot have a pixel baseline. No terminal frame,
    // so the page stays mid-generation and keeps its "Writing your note…"
    // treatment on screen.
    if (/^\/notes\/[^/]+\/stream$/.test(path)) {
      const body =
        `: connected\n\n` +
        `event: delta\nid: ${GENERATED_MARKDOWN.length}\n` +
        `data: ${JSON.stringify({ delta: GENERATED_MARKDOWN, offset: GENERATED_MARKDOWN.length })}\n\n`;
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    }

    // ⚠ BEFORE the `/notes/:id` matcher below, which would otherwise swallow
    // every one of these — the same literal-route-first ordering the API's own
    // controller has to declare.
    if (path === '/notes/exporters') {
      return json(route, { exporters: EXPORTERS });
    }

    if (/^\/notes\/[^/]+\/versions$/.test(path)) {
      return json(route, { currentVersion: 3, items: VERSIONS, nextCursor: null });
    }

    if (/^\/notes\/[^/]+\/versions\/\d+$/.test(path)) {
      const version = Number(path.split('/').pop());
      const row = VERSIONS.find((entry) => entry.version === version) ?? VERSIONS[0];

      return json(route, {
        ...row,
        noteId: 'n1',
        body: GENERATED_MARKDOWN,
        isCurrent: row.version === 3,
      });
    }

    if (/^\/notes\/[^/]+\/exports$/.test(path)) {
      return json(route, { exports: [] });
    }

    if (/^\/notes\/[^/]+$/.test(path)) {
      if (options.failed) {
        return json(
          route,
          noteRow('n1', 'Weekly engineering standup — minutes', {
            status: 'failed',
            currentVersion: 0,
            body: '',
            contextText: null,
            failureReason:
              'Your AI provider rejected the key saved for your account. Check it in ' +
              'User settings → AI.',
          }),
        );
      }

      if (options.generating) {
        return json(
          route,
          noteRow('n1', 'Weekly engineering standup — minutes', {
            status: 'generating',
            currentVersion: 0,
            body: '',
            contextText: null,
          }),
        );
      }

      return json(
        route,
        noteRow('n1', 'Weekly engineering standup — minutes', {
          body: GENERATED_MARKDOWN,
          contextText: null,
          // Matches `VERSIONS` above, so the detail page and the history page
          // agree about which version is current in every baseline.
          currentVersion: 3,
        }),
      );
    }

    // Anything else this harness has not been asked about. Answered with an
    // empty envelope rather than left hanging, so one unmocked call can never
    // turn a layout baseline into a spinner.
    return json(route, {});
  });
}
