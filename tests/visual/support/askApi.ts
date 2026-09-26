import type { Page, Route } from '@playwright/test';

import { onboardingResponse } from './onboardingApi';

/**
 * A mocked Ask API for the visual harness (#380) — #376's conversation CRUD
 * shapes, plus the graph reads the page's citation chips and suggestions make.
 *
 * Self-contained like `graphApi.ts` (this project never imports app source).
 * Every timestamp is a fixed instant far in the past, so relative dates never
 * move between the day a baseline is generated and the day it is compared.
 *
 * No SSE is needed: every fixture message is `complete` or `failed`, and the
 * stream only attaches to `pending`/`streaming` ones.
 */

const FIXED_ISO = '2024-03-01T09:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ASK_PERMS = ['user_settings:read', 'user_settings:write', 'transcripts:read', 'notes:read', 'graph:read'];

const JOE_ID = id(1);
const TRANSCRIPT_ID = id(900);
const SEGMENT_ID = id(901);
const EV_SEGMENT = id(701);

export const CONV_ANSWERED_ID = id(1201);
export const CONV_FAILED_ID = id(1204);

const summary = (conversationId: string, title: string | null, preview: string | null, scope = false) => ({
  id: conversationId,
  title,
  scopeEntity: scope ? { id: JOE_ID, label: 'Joe Rivera', type: 'Person' } : null,
  lastMessagePreview: preview,
  running: false,
  createdAt: FIXED_ISO,
  updatedAt: FIXED_ISO,
});

const CONVERSATIONS = [
  summary(CONV_ANSWERED_ID, 'When does the Atlas beta ship?', 'The Atlas beta ships by the end of October.'),
  summary(id(1202), 'What did Joe promise us?', 'Joe committed to the Atlas launch.', true),
  summary(CONV_FAILED_ID, 'Who leads the platform group?', null),
];

const message = (overrides: Record<string, unknown>) => ({
  conversationId: CONV_ANSWERED_ID,
  content: '',
  status: 'complete',
  toolCalls: [],
  citations: [],
  model: null,
  provider: null,
  promptTokens: null,
  completionTokens: null,
  errorClass: null,
  finishReason: null,
  createdAt: FIXED_ISO,
  ...overrides,
});

const citation = (overrides: Record<string, unknown>) => ({
  id: null,
  via: null,
  valid: true,
  label: null,
  documentKind: null,
  startMs: null,
  ...overrides,
});

const ANSWERED = {
  ...summary(CONV_ANSWERED_ID, 'When does the Atlas beta ship?', null),
  hasEarlier: false,
  messages: [
    message({ id: id(1301), role: 'user', content: 'When does the Atlas beta ship?' }),
    message({
      id: id(1302),
      role: 'assistant',
      model: 'gpt-4o-mini',
      provider: 'openai',
      finishReason: 'stop',
      content:
        'The Atlas beta ships **by the end of October** [^ev1].\n\n' +
        '- [^ent1] owns the launch and confirmed the date on the Q3 planning call [^doc1].\n' +
        '- Budget for the beta was also discussed [^ev9].',
      toolCalls: [
        { index: 0, name: 'search', arguments: {}, summary: 'Searched “Atlas beta”', resultCount: 3, durationMs: 120, error: null },
        { index: 1, name: 'timeline', arguments: {}, summary: 'Read timeline', resultCount: 2, durationMs: 90, error: null },
      ],
      citations: [
        citation({ marker: 'ev1', kind: 'evidence', id: EV_SEGMENT, label: 'Q3 planning call' }),
        citation({ marker: 'ent1', kind: 'entity', id: JOE_ID, label: 'Joe Rivera' }),
        citation({
          marker: 'doc1',
          kind: 'document',
          id: TRANSCRIPT_ID,
          label: 'Q3 planning call',
          documentKind: 'transcript',
          startMs: 754_000,
        }),
        citation({ marker: 'ev9', kind: 'evidence', valid: false }),
      ],
    }),
  ],
};

const FAILED = {
  ...summary(CONV_FAILED_ID, 'Who leads the platform group?', null),
  hasEarlier: false,
  messages: [
    message({ id: id(1321), role: 'user', conversationId: CONV_FAILED_ID, content: 'Who leads the platform group?' }),
    message({
      id: id(1322),
      role: 'assistant',
      conversationId: CONV_FAILED_ID,
      status: 'failed',
      errorClass: 'rate_limit',
      model: 'gpt-4o-mini',
    }),
  ],
};

const EVIDENCE = [
  {
    id: EV_SEGMENT,
    subjectKind: 'item',
    subjectId: id(301),
    quote: 'We will ship the Atlas beta by the end of October.',
    createdAt: FIXED_ISO,
    source: {
      kind: 'segment',
      transcriptId: TRANSCRIPT_ID,
      transcriptTitle: 'Q3 planning call',
      segmentId: SEGMENT_ID,
      segmentRev: 1,
      currentSegmentRev: 1,
      startMs: 754_000,
      endMs: 760_000,
      textChanged: false,
      available: true,
      href: `/transcripts/${TRANSCRIPT_ID}?segment=${SEGMENT_ID}&t=754000`,
    },
  },
];

const ENTITIES = [
  { id: JOE_ID, type: 'Person', label: 'Joe Rivera', aliases: [], mentionCount: 14, lastSeenAt: FIXED_ISO },
  { id: id(4), type: 'Organization', label: 'Acme Corp', aliases: [], mentionCount: 22, lastSeenAt: FIXED_ISO },
  { id: id(6), type: 'Project', label: 'Project Atlas', aliases: [], mentionCount: 11, lastSeenAt: FIXED_ISO },
];

const model = (modelId: string, label: string) => ({
  id: modelId,
  label,
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_000,
  source: 'catalogue',
  derivedFrom: null,
  structuredOutput: true,
  toolCalling: true,
});

const AI_CONFIG = {
  available: true,
  provider: 'openai',
  providerLabel: 'OpenAI',
  models: [model('gpt-4o-mini', 'GPT-4o mini'), model('gpt-4.1', 'GPT-4.1')],
  defaultModel: 'gpt-4o-mini',
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  keyConfigured: true,
  graphEnabled: true,
  taskModels: {
    'graph.agent': {
      model: 'gpt-4o-mini',
      source: 'task',
      reasoningEffort: 'medium',
      requires: ['toolCalling'],
      usable: true,
      reason: null,
    },
  },
};

function json(route: Route, data: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
}

export async function installAskApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    if (path === '/ai/config') return json(route, AI_CONFIG);
    if (path === '/ask/conversations') return json(route, { items: CONVERSATIONS, nextCursor: null });
    if (path === `/ask/conversations/${CONV_ANSWERED_ID}`) return json(route, ANSWERED);
    if (path === `/ask/conversations/${CONV_FAILED_ID}`) return json(route, FAILED);
    if (path === '/graph/entities') return json(route, { items: ENTITIES, nextCursor: null });
    if (path === '/graph/evidence') {
      const ids = url.searchParams.get('ids')?.split(',') ?? [];
      return json(route, { items: EVIDENCE.filter((ev) => ids.includes(ev.id)) });
    }

    const onboarding = onboardingResponse(path);
    if (onboarding) return json(route, onboarding);

    return json(route, {});
  });
}
