import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  CONV_ATLAS_ID,
  CONV_EMPTY_ID,
  askMessage,
  askMock,
  atlasMessages,
  defaultAskConversations,
  resetAskMock,
} from '../mocks/askData';
import type { AskStreamHandlers, AskStreamResume } from '../../services/askStream';

/**
 * `useAskConversation` / `useAskStream` / `useAskConversations` (#380).
 * `connectAskStream` is replaced with a recorder, so each test drives the
 * stream by hand; MSW answers the conversation routes from `askMock`.
 */

interface Recorded {
  messageId: string;
  handlers: AskStreamHandlers;
  resume: AskStreamResume | undefined;
  close: ReturnType<typeof vi.fn>;
}

const streams: Recorded[] = [];

vi.mock('../../services/askStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/askStream')>();
  return {
    ...actual,
    connectAskStream: (messageId: string, handlers: AskStreamHandlers, resume?: AskStreamResume) => {
      const close = vi.fn();
      streams.push({ messageId, handlers, resume, close });
      return { close };
    },
  };
});

import { mergeConversation, useAskConversation } from '../../hooks/useAskConversation';
import { useAskConversations } from '../../hooks/useAskConversations';
import { mergeSteps } from '../../hooks/useAskStream';

beforeEach(() => {
  streams.length = 0;
  resetAskMock();
});

const detailReads = () =>
  askMock.requests.filter((r) => r.method === 'GET' && r.path === `/ask/conversations/${CONV_EMPTY_ID}`);

describe('useAskConversation', () => {
  it('loads a conversation and never connects for complete messages', async () => {
    const { result } = renderHook(() => useAskConversation(CONV_ATLAS_ID));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.conversation?.messages).toHaveLength(2);
    expect(result.current.running).toBe(false);
    expect(streams).toHaveLength(0);
  });

  it('appends both returned messages at once and attaches the stream to the assistant one', async () => {
    const { result } = renderHook(() => useAskConversation(CONV_EMPTY_ID));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let sent: Awaited<ReturnType<typeof result.current.send>> | undefined;
    await act(async () => {
      sent = await result.current.send('What changed?', 'gpt-4.1');
    });

    expect(result.current.conversation?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.current.conversation?.messages[0].content).toBe('What changed?');
    expect(result.current.running).toBe(true);
    expect(streams).toHaveLength(1);
    expect(streams[0].messageId).toBe(sent?.assistantMessage.id);
    expect(askMock.requests.find((r) => r.method === 'POST')?.body).toEqual({ content: 'What changed?', model: 'gpt-4.1' });
  });

  it('shows streamed text and steps, then settles in place and re-reads after done', async () => {
    const onTurnSettled = vi.fn();
    const { result } = renderHook(() => useAskConversation(CONV_EMPTY_ID, { onTurnSettled }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.send('What changed?');
    });
    const readsBefore = detailReads().length;
    const { handlers } = streams[0];

    act(() => {
      handlers.onStep({ index: 0, name: 'search', arguments: {}, summary: 'Searched', resultCount: 2, durationMs: 0, error: null });
      handlers.onContent('It changed');
    });
    expect(result.current.stream.status).toBe('streaming');
    expect(result.current.stream.content).toBe('It changed');
    expect(result.current.stream.steps).toHaveLength(1);

    act(() => {
      handlers.onContent('It changed [^ev1].');
      handlers.onDone({ citations: [], finishReason: 'token_cap' });
    });
    const assistant = result.current.conversation?.messages[1];
    expect(assistant).toMatchObject({ status: 'complete', content: 'It changed [^ev1].', finishReason: 'token_cap' });
    expect(result.current.running).toBe(false);
    expect(onTurnSettled).toHaveBeenCalledWith(CONV_EMPTY_ID);
    await waitFor(() => expect(detailReads().length).toBeGreaterThan(readsBefore));
  });

  it('marks a failed turn from its error frame', async () => {
    const { result } = renderHook(() => useAskConversation(CONV_EMPTY_ID));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.send('Q');
    });
    // The server row settles too, so the quiet re-read agrees.
    const conv = askMock.conversations.find((c) => c.summary.id === CONV_EMPTY_ID)!;
    conv.messages = conv.messages.map((m) => (m.role === 'assistant' ? { ...m, status: 'failed', errorClass: 'auth' } : m));
    act(() => streams[0].handlers.onError({ errorClass: 'auth', reason: null }));
    expect(result.current.conversation?.messages[1]).toMatchObject({ status: 'failed', errorClass: 'auth' });
    await waitFor(() => expect(result.current.conversation?.messages[1].status).toBe('failed'));
  });

  it('connects on mount to a message already pending, resuming after its content and steps', async () => {
    const conv = askMock.conversations.find((c) => c.summary.id === CONV_ATLAS_ID)!;
    conv.messages = [
      ...atlasMessages(),
      askMessage({ id: 'u2', role: 'user', content: 'And then?' }),
      askMessage({
        id: 'a2',
        role: 'assistant',
        status: 'streaming',
        content: 'Half an answer',
        toolCalls: [{ index: 0, name: 'search', arguments: {}, summary: 's', resultCount: 1, durationMs: 5, error: null }],
      }),
    ];
    const { result, unmount } = renderHook(() => useAskConversation(CONV_ATLAS_ID));
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0].messageId).toBe('a2');
    expect(streams[0].resume).toEqual({ content: 'Half an answer', knownStepIndexes: [0] });
    expect(result.current.stream.content).toBe('Half an answer');
    unmount();
    expect(streams[0].close).toHaveBeenCalled();
  });

  it('reattaches after the reader gives up at its duration cap', async () => {
    const conv = askMock.conversations.find((c) => c.summary.id === CONV_ATLAS_ID)!;
    conv.messages = [askMessage({ id: 'u2', role: 'user', content: 'Q' }), askMessage({ id: 'a2', role: 'assistant', status: 'streaming' })];
    renderHook(() => useAskConversation(CONV_ATLAS_ID));
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].handlers.onError({ errorClass: 'timeout', reason: 'stream_duration_cap' }));
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(streams[1].messageId).toBe('a2');
  });

  it('pages earlier messages in front of the ones held', async () => {
    const conv = askMock.conversations.find((c) => c.summary.id === CONV_ATLAS_ID)!;
    conv.hasEarlier = true;
    const { result } = renderHook(() => useAskConversation(CONV_ATLAS_ID));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // The mock answers `before=<first id>` with nothing older; the request is what matters.
    await act(async () => {
      await result.current.loadEarlier();
    });
    const paged = askMock.requests.find((r) => r.search.includes('before='));
    expect(paged?.search).toBe(`?before=${conv.messages[0].id}`);
    expect(result.current.conversation?.hasEarlier).toBe(false);
  });

  it('reports a missing conversation as notFound, not an error', async () => {
    const { result } = renderHook(() => useAskConversation('00000000-0000-4000-8000-000000009999'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('renders a seed immediately, without a loading state', () => {
    const seed = {
      id: CONV_EMPTY_ID,
      title: 'Seeded',
      scopeEntity: null,
      running: true,
      createdAt: '',
      updatedAt: '',
      hasEarlier: false,
      messages: [askMessage({ id: 's1', role: 'user', content: 'Seeded' })],
    };
    const { result } = renderHook(() => useAskConversation(CONV_EMPTY_ID, { seed }));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.conversation?.title).toBe('Seeded');
  });
});

describe('merge helpers', () => {
  it('keeps earlier-loaded messages in front of a fresh page', () => {
    const [first, second] = atlasMessages();
    const older = askMessage({ id: 'old', role: 'user', createdAt: '2026-01-01T00:00:00.000Z' });
    const held = { id: 'c', title: null, scopeEntity: null, running: false, createdAt: '', updatedAt: '', hasEarlier: true, messages: [older, first, second] };
    const fresh = { ...held, hasEarlier: true, messages: [first, second] };
    expect(mergeConversation(held, fresh).messages.map((m) => m.id)).toEqual(['old', first.id, second.id]);
  });

  it('never puts a turn it saw settle back to running because a read raced the row', () => {
    const settledAnswer = askMessage({ id: 'a', role: 'assistant', status: 'complete', content: 'Done' });
    const stale = askMessage({ id: 'a', role: 'assistant', status: 'streaming', content: 'Do' });
    const base = { id: 'c', title: null, scopeEntity: null, running: false, createdAt: '', updatedAt: '', hasEarlier: false };
    const merged = mergeConversation({ ...base, messages: [settledAnswer] }, { ...base, messages: [stale] });
    expect(merged.messages[0]).toBe(settledAnswer);
  });

  it('merges steps by index, first report wins', () => {
    const step = (index: number, summary: string) => ({ index, name: 'n', arguments: {}, summary, resultCount: 0, durationMs: 0, error: null });
    expect(mergeSteps([step(1, 'a')], [step(0, 'b'), step(1, 'c')]).map((s) => s.summary)).toEqual(['b', 'a']);
  });
});

describe('useAskConversations', () => {
  it('lists, pages, creates, renames and removes', async () => {
    askMock.pageSize = 2;
    const { result } = renderHook(() => useAskConversations({ limit: 2 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toHaveLength(2);
    expect(result.current.nextCursor).toBe('2');

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items).toHaveLength(defaultAskConversations().length);
    expect(result.current.nextCursor).toBeNull();

    let createdId = '';
    await act(async () => {
      createdId = (await result.current.create()).id;
    });
    expect(result.current.items[0].id).toBe(createdId);

    await act(async () => {
      await result.current.rename(createdId, 'Renamed');
    });
    expect(result.current.items[0].title).toBe('Renamed');

    await act(async () => {
      await result.current.remove(createdId);
    });
    expect(result.current.items.find((row) => row.id === createdId)).toBeUndefined();
  });

  it('sends the scope filter and creates scoped conversations', async () => {
    const { result } = renderHook(() => useAskConversations({ scopeEntityId: 'entity-1' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(askMock.requests[0].search).toContain('scopeEntityId=entity-1');
    await act(async () => {
      await result.current.create();
    });
    expect(askMock.requests.find((r) => r.method === 'POST')?.body).toEqual({ scopeEntityId: 'entity-1' });
  });
});
