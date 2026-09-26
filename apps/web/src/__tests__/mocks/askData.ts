/**
 * Ask fixtures (#380) — the wire shapes of #376 (conversations, messages),
 * #378 (`POST …/messages`) and #379 (stream), built against their contracts
 * ahead of the API landing.
 *
 * `askMock` is an in-memory stand-in the MSW handlers in `handlers.ts` read and
 * write, so a test can create, rename and delete conversations and assert the
 * list afterwards. Call `resetAskMock()` in a `beforeEach`.
 *
 * Citation ids reuse `graphData.ts`'s evidence and entity fixtures, so an
 * `EvidenceChip` rendered from an Ask answer resolves through the same
 * `GET /api/graph/evidence` handler the entity page's chips do.
 */

import {
  EV_GONE,
  EV_NOTE,
  EV_SEGMENT,
  JOE_ID,
  NOTE_ID,
  TRANSCRIPT_ID,
  gid,
} from './graphData';
import type {
  AskCitation,
  AskConversationDetail,
  AskConversationSummary,
  AskMessage,
  AskToolCall,
} from '../../services/ask';

export { EV_GONE, EV_NOTE, EV_SEGMENT, JOE_ID, NOTE_ID, TRANSCRIPT_ID };

export const CONV_ATLAS_ID = gid(1201);
export const CONV_JOE_ID = gid(1202);
export const CONV_EMPTY_ID = gid(1203);
export const CONV_FAILED_ID = gid(1204);

export const MSG_USER_1 = gid(1301);
export const MSG_ASSISTANT_1 = gid(1302);

const AT = '2026-09-25T15:00:00.000Z';

export function askToolCall(index: number, overrides: Partial<AskToolCall> = {}): AskToolCall {
  return {
    index,
    name: 'search',
    arguments: { query: 'Atlas' },
    summary: 'Searched “Atlas”',
    resultCount: 3,
    durationMs: 120,
    error: null,
    ...overrides,
  };
}

export function askCitation(overrides: Partial<AskCitation> & Pick<AskCitation, 'marker' | 'kind'>): AskCitation {
  return {
    id: null,
    via: null,
    valid: true,
    label: null,
    documentKind: null,
    startMs: null,
    ...overrides,
  };
}

/** One citation of each kind, plus one the tools never issued. */
export const ATLAS_CITATIONS: AskCitation[] = [
  askCitation({ marker: 'ev1', kind: 'evidence', id: EV_SEGMENT, label: 'Q3 planning call' }),
  askCitation({ marker: 'ent1', kind: 'entity', id: JOE_ID, label: 'Joe Rivera' }),
  askCitation({
    marker: 'doc1',
    kind: 'document',
    id: TRANSCRIPT_ID,
    label: 'Q3 planning call',
    documentKind: 'transcript',
    startMs: 754_000,
  }),
  askCitation({ marker: 'ev9', kind: 'evidence', id: null, valid: false }),
];

export const ATLAS_ANSWER =
  'The Atlas beta ships by the end of October [^ev1]. [^ent1] owns the launch [^doc1]. ' +
  'Budget was also discussed [^ev9].';

export function askMessage(overrides: Partial<AskMessage> & Pick<AskMessage, 'id' | 'role'>): AskMessage {
  return {
    conversationId: CONV_ATLAS_ID,
    content: '',
    status: 'complete',
    toolCalls: [],
    citations: [],
    model: overrides.role === 'assistant' ? 'gpt-4o-mini' : null,
    provider: overrides.role === 'assistant' ? 'openai' : null,
    promptTokens: null,
    completionTokens: null,
    errorClass: null,
    finishReason: overrides.role === 'assistant' ? 'stop' : null,
    createdAt: AT,
    ...overrides,
  };
}

export function askSummary(overrides: Partial<AskConversationSummary> & Pick<AskConversationSummary, 'id'>): AskConversationSummary {
  return {
    title: null,
    scopeEntity: null,
    lastMessagePreview: null,
    running: false,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function atlasMessages(): AskMessage[] {
  return [
    askMessage({ id: MSG_USER_1, role: 'user', content: 'When does the Atlas beta ship?', finishReason: null }),
    askMessage({
      id: MSG_ASSISTANT_1,
      role: 'assistant',
      content: ATLAS_ANSWER,
      toolCalls: [
        askToolCall(0),
        askToolCall(1, { name: 'timeline', summary: 'Read timeline', resultCount: 2, arguments: { entity: 'ent1' } }),
      ],
      citations: ATLAS_CITATIONS,
      promptTokens: 1200,
      completionTokens: 80,
    }),
  ];
}

export interface AskMockConversation {
  summary: AskConversationSummary;
  messages: AskMessage[];
  hasEarlier: boolean;
}

export interface AskMockRequest {
  method: string;
  path: string;
  body: unknown;
  search: string;
}

/** The in-memory store behind the Ask MSW handlers. */
export const askMock: {
  conversations: AskMockConversation[];
  requests: AskMockRequest[];
  /** When set, `POST …/messages` answers this instead of 202. */
  postError: { status: number; body: Record<string, unknown> } | null;
  /** The assistant message `POST …/messages` answers with (status `pending`). */
  nextAssistantId: number;
  pageSize: number;
} = {
  conversations: [],
  requests: [],
  postError: null,
  nextAssistantId: 1,
  pageSize: 20,
};

export function defaultAskConversations(): AskMockConversation[] {
  return [
    {
      summary: askSummary({
        id: CONV_ATLAS_ID,
        title: 'When does the Atlas beta ship?',
        lastMessagePreview: 'The Atlas beta ships by the end of October.',
        updatedAt: '2026-09-25T15:00:00.000Z',
      }),
      messages: atlasMessages(),
      hasEarlier: false,
    },
    {
      summary: askSummary({
        id: CONV_JOE_ID,
        title: 'What did Joe promise us?',
        scopeEntity: { id: JOE_ID, label: 'Joe Rivera', type: 'Person' },
        lastMessagePreview: 'Joe committed to the Atlas launch.',
        updatedAt: '2026-09-24T15:00:00.000Z',
      }),
      messages: [
        askMessage({ id: gid(1311), role: 'user', conversationId: CONV_JOE_ID, content: 'What did Joe promise us?' }),
        askMessage({
          id: gid(1312),
          role: 'assistant',
          conversationId: CONV_JOE_ID,
          content: 'Joe committed to the Atlas launch [^ev1].',
          citations: [ATLAS_CITATIONS[0]],
        }),
      ],
      hasEarlier: false,
    },
    {
      summary: askSummary({ id: CONV_EMPTY_ID, title: null, updatedAt: '2026-09-20T15:00:00.000Z' }),
      messages: [],
      hasEarlier: false,
    },
  ];
}

export function resetAskMock(conversations: AskMockConversation[] = defaultAskConversations()): void {
  askMock.conversations = conversations;
  askMock.requests = [];
  askMock.postError = null;
  askMock.nextAssistantId = 1;
  askMock.pageSize = 20;
}

export function detailOf(conv: AskMockConversation): AskConversationDetail {
  const { lastMessagePreview: _preview, ...rest } = conv.summary;
  void _preview;
  return { ...rest, messages: conv.messages, hasEarlier: conv.hasEarlier };
}

resetAskMock();
