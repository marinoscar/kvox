/**
 * The default answers of the Ask suites: an in-memory stand-in for #376's
 * conversation CRUD and #378's `POST …/messages`, backed by `askMock`
 * (askData.ts). Every request is recorded so a test can assert the exact body or
 * query it sent. Registered by `helpers.tsx` through `server.use`.
 */

import { http, HttpResponse } from '../graph/msw-compat.js';
import { askMessage, askMock, askSummary, detailOf } from './askData.js';

const API_BASE = '*/api';

export const askHandlers = [
  // ---------------------------------------------------------------------------
  // Ask (#380) — an in-memory stand-in for #376's conversation CRUD and #378's
  // `POST …/messages`, backed by `askMock` (askData.ts). Every request is
  // recorded so a test can assert the exact body or query it sent.
  // ---------------------------------------------------------------------------
  http.get(`${API_BASE}/ask/conversations`, ({ request }) => {
    const url = new URL(request.url);
    recordAsk('GET', url, undefined);
    const scope = url.searchParams.get('scopeEntityId');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? askMock.pageSize), askMock.pageSize);
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const rows = askMock.conversations
      .map((conv) => conv.summary)
      .filter((row) => !scope || row.scopeEntity?.id === scope)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const items = rows.slice(offset, offset + limit);
    const nextCursor = offset + limit < rows.length ? String(offset + limit) : null;
    return HttpResponse.json({ data: { items, nextCursor } });
  }),

  http.get(`${API_BASE}/ask/conversations/:id`, ({ params, request }) => {
    const url = new URL(request.url);
    recordAsk('GET', url, undefined);
    const conv = askMock.conversations.find((row) => row.summary.id === params.id);
    if (!conv) return askNotFound();
    const before = url.searchParams.get('before');
    if (before) {
      const at = conv.messages.findIndex((m) => m.id === before);
      const older = at > 0 ? conv.messages.slice(0, at) : [];
      return HttpResponse.json({ data: { ...detailOf(conv), messages: older, hasEarlier: false } });
    }
    return HttpResponse.json({ data: detailOf(conv) });
  }),

  http.post(`${API_BASE}/ask/conversations`, async ({ request }) => {
    const body = (await request.json()) as { scopeEntityId?: string; title?: string };
    recordAsk('POST', new URL(request.url), body);
    const id = `00000000-0000-4000-8000-${String(1400 + askMock.conversations.length).padStart(12, '0')}`;
    const summary = askSummary({
      id,
      title: body.title ?? null,
      scopeEntity: body.scopeEntityId ? { id: body.scopeEntityId, label: 'Joe Rivera', type: 'Person' } : null,
      updatedAt: '2026-09-26T09:00:00.000Z',
      createdAt: '2026-09-26T09:00:00.000Z',
    });
    askMock.conversations.unshift({ summary, messages: [], hasEarlier: false });
    return HttpResponse.json({ data: summary }, { status: 201 });
  }),

  http.patch(`${API_BASE}/ask/conversations/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { title: string };
    recordAsk('PATCH', new URL(request.url), body);
    const conv = askMock.conversations.find((row) => row.summary.id === params.id);
    if (!conv) return askNotFound();
    conv.summary = { ...conv.summary, title: body.title };
    return HttpResponse.json({ data: conv.summary });
  }),

  http.delete(`${API_BASE}/ask/conversations/:id`, ({ params, request }) => {
    recordAsk('DELETE', new URL(request.url), undefined);
    const before = askMock.conversations.length;
    askMock.conversations = askMock.conversations.filter((row) => row.summary.id !== params.id);
    if (askMock.conversations.length === before) return askNotFound();
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE}/ask/conversations/:id/messages`, async ({ params, request }) => {
    const body = (await request.json()) as { content: string; model?: string };
    recordAsk('POST', new URL(request.url), body);
    const conv = askMock.conversations.find((row) => row.summary.id === params.id);
    if (!conv) return askNotFound();
    if (askMock.postError) {
      return HttpResponse.json(askMock.postError.body, { status: askMock.postError.status });
    }
    const n = askMock.nextAssistantId++;
    const userMessage = askMessage({
      id: `00000000-0000-4000-8000-${String(1500 + n * 2).padStart(12, '0')}`,
      role: 'user',
      conversationId: conv.summary.id,
      content: body.content,
      finishReason: null,
      createdAt: '2026-09-26T09:00:01.000Z',
    });
    const assistantMessage = askMessage({
      id: `00000000-0000-4000-8000-${String(1501 + n * 2).padStart(12, '0')}`,
      role: 'assistant',
      conversationId: conv.summary.id,
      status: 'pending',
      finishReason: null,
      model: body.model ?? 'gpt-4o-mini',
      createdAt: '2026-09-26T09:00:02.000Z',
    });
    conv.messages = [...conv.messages, userMessage, assistantMessage];
    conv.summary = {
      ...conv.summary,
      title: conv.summary.title ?? body.content.slice(0, 80),
      running: true,
    };
    return HttpResponse.json({ data: { userMessage, assistantMessage } }, { status: 202 });
  }),
];

function recordAsk(method: string, url: URL, body: unknown): void {
  askMock.requests.push({ method, path: url.pathname.replace(/^.*\/api/, ''), body, search: url.search });
}

function askNotFound() {
  return HttpResponse.json(
    { statusCode: 404, code: 'NOT_FOUND', message: 'Conversation not found' },
    { status: 404 },
  );
}

/** A 409/400 body the way the API's exception filter shapes one, for `askMock.postError`. */
export function askErrorBody(status: 400 | 409, reason: string, message = 'Request refused') {
  return {
    status,
    body: { statusCode: status, code: status === 409 ? 'CONFLICT' : 'BAD_REQUEST', message, details: { reason } },
  };
}

