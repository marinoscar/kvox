import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { askErrorBody } from '../mocks/handlers';
import { mockGraphAiConfig } from '../mocks/graphData';
import {
  CONV_ATLAS_ID,
  CONV_EMPTY_ID,
  CONV_JOE_ID,
  EV_SEGMENT,
  JOE_ID,
  TRANSCRIPT_ID,
  askMessage,
  askMock,
  askToolCall,
  resetAskMock,
} from '../mocks/askData';
import { render } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import { graphReader, noGraphUser } from '../utils/graphTestUsers';
import type { MockUser } from '../utils/test-utils';
import type { AskStreamHandlers, AskStreamResume } from '../../services/askStream';
import { clearEvidenceCache } from '../../hooks/useGraphEvidence';
import { RequirePermission } from '../../components/common/RequirePermission';
import { AskMessageBubble } from '../../components/ask/AskMessageBubble';
import { ASK_ERROR_CLASS_COPY } from '../../components/ask/askErrorCopy';

/**
 * `/ask` and `/ask/:conversationId` (#380). MSW answers the conversation
 * routes from `askMock` (askData.ts — #376/#378's contracts); the stream
 * (#379) is replaced with a recorder the test drives by hand.
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

// Imported after the mock so the page picks up the recorder.
import AskPage from '../../pages/AskPage';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const API = '*/api';

let aiConfig: Record<string, unknown>;

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

const gated = (
  <RequirePermission permission="graph:read" fallback={<Navigate to="/" replace />}>
    <AskPage />
  </RequirePermission>
);

function renderAsk(route = '/ask', user: MockUser = graphReader) {
  return render(
    <>
      <Routes>
        <Route path="/ask/:conversationId?" element={gated} />
        <Route path="/" element={<p>Home page</p>} />
        <Route path="/graph/entities/:id" element={<p>Entity page</p>} />
        <Route path="/transcripts/:id" element={<p>Transcript page</p>} />
        <Route path="/settings/ai" element={<p>AI settings</p>} />
      </Routes>
      <LocationProbe />
    </>,
    { wrapperOptions: { route, user } },
  );
}

const location = () => screen.getByTestId('location').textContent;
const composer = () => screen.getByRole('textbox', { name: 'Your question' });
const conversationList = () => screen.findByRole('navigation', { name: 'Conversations' });
/** The composer once it can be typed into (the conversation has loaded). */
async function enabledComposer() {
  const box = await screen.findByRole('textbox', { name: 'Your question' });
  await waitFor(() => expect(box).toBeEnabled());
  return box;
}
const postBodies = () => askMock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).map((r) => r.body);

beforeEach(() => {
  streams.length = 0;
  resetAskMock();
  clearEvidenceCache();
  window.sessionStorage.clear();
  aiConfig = mockGraphAiConfig();
  server.use(http.get(`${API}/ai/config`, () => HttpResponse.json({ data: aiConfig })));
});

// =============================================================================
// Empty state and the first question
// =============================================================================

describe('AskPage — a new conversation', () => {
  it('shows the empty state with suggestions built from recent entities', async () => {
    const { container } = renderAsk('/ask');
    expect(await screen.findByRole('heading', { level: 1, name: 'Ask' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ask about your meetings' })).toBeInTheDocument();
    const suggestions = screen.getByRole('list', { name: 'Suggested questions' });
    expect(await within(suggestions).findByRole('button', { name: "What's the latest on Joe Rivera?" })).toBeInTheDocument();
    expect(within(suggestions).getByRole('button', { name: 'What did I commit to this week?' })).toBeInTheDocument();
    expect(within(suggestions).getByRole('button', { name: 'Which decisions changed last month?' })).toBeInTheDocument();
    expect(within(suggestions).getAllByRole('button')).toHaveLength(5);
    await waitFor(() => expect(composer()).toHaveFocus());
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('asks a suggested question: creates, posts, then replaces the URL — both messages on screen at once', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk('/ask');
    await user.click(await screen.findByRole('button', { name: "What's the latest on Joe Rivera?" }));

    await waitFor(() => expect(location()).toMatch(/^\/ask\/[0-9a-f-]{36}$/));
    const created = askMock.requests.find((r) => r.method === 'POST' && r.path === '/ask/conversations');
    expect(created?.body).toEqual({});
    expect(postBodies()).toEqual([{ content: "What's the latest on Joe Rivera?" }]);

    const thread = await screen.findByRole('region', { name: 'Conversation' });
    expect(within(thread).getByText("What's the latest on Joe Rivera?")).toBeInTheDocument();
    expect(within(thread).getByText('Thinking…')).toBeInTheDocument();
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(screen.getByRole('heading', { level: 1, name: "What's the latest on Joe Rivera?" })).toBeInTheDocument();
  });

  it('keeps the typed text on a refused first question, and reuses the conversation it created', async () => {
    const user = userEvent.setup({ delay: null });
    askMock.postError = askErrorBody(409, 'ai_key_missing');
    renderAsk('/ask');
    await user.type(await enabledComposer(), 'Who owns Atlas?{Enter}');

    expect(await screen.findByText('Add your AI key in Settings → AI.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings → AI' })).toHaveAttribute('href', '/settings/ai');
    expect(composer()).toHaveValue('Who owns Atlas?');
    expect(location()).toBe('/ask');

    askMock.postError = null;
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(location()).toMatch(/^\/ask\/.+/));
    const creates = askMock.requests.filter((r) => r.method === 'POST' && r.path === '/ask/conversations');
    expect(creates).toHaveLength(1);
  });
});

// =============================================================================
// A saved conversation: citations, captions, streaming
// =============================================================================

describe('AskPage — a completed, cited answer', () => {
  it('renders each citation kind as its chip and counts the removed one', async () => {
    const { container } = renderAsk(`/ask/${CONV_ATLAS_ID}`);
    const thread = await screen.findByRole('region', { name: 'Conversation' });
    expect(await within(thread).findByText('When does the Atlas beta ship?')).toBeInTheDocument();

    // Evidence → a numbered EvidenceChip (title resolved through /graph/evidence).
    expect(await within(thread).findByRole('button', { name: 'Source 1: Q3 planning call' })).toBeInTheDocument();
    // Entity → its page.
    expect(within(thread).getByRole('link', { name: 'Open Joe Rivera' })).toHaveAttribute('href', `/graph/entities/${JOE_ID}`);
    // Document → the transcript at the cited moment.
    expect(within(thread).getByRole('link', { name: 'Play Q3 planning call from 12:34' })).toHaveAttribute(
      'href',
      `/transcripts/${TRANSCRIPT_ID}?t=754000`,
    );
    // The unissued marker never renders, and is counted.
    expect(within(thread).queryByText(/\[\^/)).not.toBeInTheDocument();
    expect(within(thread).getByText("1 source couldn't be verified and was removed.")).toBeInTheDocument();
    expect(within(thread).queryByText(/No sources were cited/)).not.toBeInTheDocument();

    // The steps are collapsed once there is an answer.
    const steps = within(thread).getByRole('button', { name: /Searched “Atlas” · Read timeline · Found 5 results/ });
    expect(steps).toHaveAttribute('aria-expanded', 'false');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('plays the exact segment from an evidence chip', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_ATLAS_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Source 1: Q3 planning call' }));
    await user.click(await screen.findByRole('button', { name: 'Play from 12:34' }));
    await waitFor(() => expect(location()).toContain(`/transcripts/${TRANSCRIPT_ID}`));
    expect(location()).toContain('t=754000');
    expect(location()).toContain('segment=');
  });

  it('opens the entity page from an entity chip', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_ATLAS_ID}`);
    await user.click(await screen.findByRole('link', { name: 'Open Joe Rivera' }));
    expect(await screen.findByText('Entity page')).toBeInTheDocument();
  });

  it('cautions an uncited answer and says when a capped one stopped early', async () => {
    const conv = askMock.conversations.find((c) => c.summary.id === CONV_EMPTY_ID)!;
    conv.messages = [
      askMessage({ id: 'u1', role: 'user', conversationId: CONV_EMPTY_ID, content: 'Q' }),
      askMessage({
        id: 'a1',
        role: 'assistant',
        conversationId: CONV_EMPTY_ID,
        content: 'Atlas is probably late.',
        toolCalls: [askToolCall(0)],
        finishReason: 'step_cap',
      }),
    ];
    renderAsk(`/ask/${CONV_EMPTY_ID}`);
    expect(await screen.findByText('No sources were cited — treat this answer with care.')).toBeInTheDocument();
    expect(screen.getByText(/Stopped early — this answer may be incomplete: it reached the lookup limit/)).toBeInTheDocument();
  });

  it('does not caution an answer that says it found nothing', async () => {
    const conv = askMock.conversations.find((c) => c.summary.id === CONV_EMPTY_ID)!;
    conv.messages = [
      askMessage({ id: 'u1', role: 'user', conversationId: CONV_EMPTY_ID, content: 'Q' }),
      askMessage({
        id: 'a1',
        role: 'assistant',
        conversationId: CONV_EMPTY_ID,
        content: "I couldn't find anything about that in your graph.",
        toolCalls: [askToolCall(0, { resultCount: 0 })],
      }),
    ];
    renderAsk(`/ask/${CONV_EMPTY_ID}`);
    expect(await screen.findByText(/I couldn't find anything/)).toBeInTheDocument();
    expect(screen.queryByText(/No sources were cited/)).not.toBeInTheDocument();
  });
});

describe('AskPage — asking and streaming', () => {
  it('sends with Enter, shows steps while working, streams text and ends with chips', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_EMPTY_ID}`);
    await user.type(await enabledComposer(), 'What did Joe say?{Enter}');

    const thread = screen.getByRole('region', { name: 'Conversation' });
    expect(await within(thread).findByText('What did Joe say?')).toBeInTheDocument();
    expect(composer()).toHaveValue('');
    expect(postBodies()).toEqual([{ content: 'What did Joe say?' }]);
    await waitFor(() => expect(streams).toHaveLength(1));
    // Send is disabled while the turn runs.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    const { handlers } = streams[0];
    act(() => handlers.onStep({ ...askToolCall(0, { summary: 'Looked up Joe Rivera (Person)', resultCount: 1 }), arguments: {}, durationMs: 0 }));
    const stepsToggle = within(thread).getByRole('button', { name: /Looked up Joe Rivera \(Person\)/ });
    expect(stepsToggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(thread).getAllByText('Looking things up…').length).toBeGreaterThan(0);

    act(() => handlers.onContent('Joe committed to the launch [^ev'));
    const answer = within(thread).getAllByTestId('ask-answer').at(-1)!;
    expect(answer).toHaveAttribute('aria-busy', 'true');
    expect(answer).toHaveTextContent('Joe committed to the launch');
    expect(answer).not.toHaveTextContent('[^');
    // Once the answer starts, the steps fold away.
    expect(within(thread).getByRole('button', { name: /Looked up Joe Rivera/ })).toHaveAttribute('aria-expanded', 'false');

    act(() => {
      handlers.onContent('Joe committed to the launch [^ev1] [^ent1].');
      handlers.onDone({
        citations: [
          { marker: 'ev1', kind: 'evidence', id: EV_SEGMENT, via: null, valid: true, label: null, documentKind: null, startMs: null },
          { marker: 'ent1', kind: 'entity', id: JOE_ID, via: null, valid: true, label: 'Joe Rivera', documentKind: null, startMs: null },
        ],
        finishReason: 'stop',
      });
    });
    expect(answer).toHaveAttribute('aria-busy', 'false');
    expect(await within(answer).findByRole('button', { name: 'Source 1: Q3 planning call' })).toBeInTheDocument();
    expect(within(answer).getByRole('link', { name: 'Open Joe Rivera' })).toBeInTheDocument();
  });

  it('does not send on Shift+Enter, and counts characters from 3,500', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_EMPTY_ID}`);
    const box = await enabledComposer();
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(box).toHaveValue('line one\nline two');
    expect(postBodies()).toHaveLength(0);

    await user.clear(box);
    await user.click(box);
    await user.paste('x'.repeat(3500));
    expect(screen.getByText('3,500 / 4,000')).toBeInTheDocument();
    expect(box).toHaveAttribute('maxlength', '4000');
  });

  it('shows a failed turn with its copy, and Try again re-sends the question', async () => {
    const user = userEvent.setup({ delay: null });
    const conv = askMock.conversations.find((c) => c.summary.id === CONV_EMPTY_ID)!;
    conv.messages = [
      askMessage({ id: 'u1', role: 'user', conversationId: CONV_EMPTY_ID, content: 'Who leads Atlas?' }),
      askMessage({ id: 'a1', role: 'assistant', conversationId: CONV_EMPTY_ID, status: 'failed', errorClass: 'rate_limit', finishReason: null }),
    ];
    renderAsk(`/ask/${CONV_EMPTY_ID}`);
    expect(await screen.findByText(ASK_ERROR_CLASS_COPY.rate_limit)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(postBodies()).toEqual([{ content: 'Who leads Atlas?' }]));
    await waitFor(() => expect(streams).toHaveLength(1));
  });

  it('turns a stream error into the failed-turn copy', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_EMPTY_ID}`);
    await user.type(await enabledComposer(), 'Q{Enter}');
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].handlers.onError({ errorClass: 'budget', reason: null }));
    expect(await screen.findByText(ASK_ERROR_CLASS_COPY.budget)).toBeInTheDocument();
  });
});

// =============================================================================
// Refusals
// =============================================================================

describe('AskPage — a refused send keeps the text and says why', () => {
  const cases: Array<[number, string, string]> = [
    [409, 'graph_disabled', 'Ask is turned off for this deployment.'],
    [409, 'ai_not_configured', "An administrator hasn't set up AI yet."],
    [409, 'ai_key_missing', 'Add your AI key in Settings → AI.'],
    [409, 'model_lacks_capability', "That model can't use tools. Pick another model."],
    [409, 'ask_turn_running', 'Wait for the current answer to finish.'],
    [400, 'model_not_permitted', "That model isn't permitted on this deployment. Pick another."],
  ];

  for (const [status, reason, copy] of cases) {
    it(`${status} ${reason}`, async () => {
      const user = userEvent.setup({ delay: null });
      askMock.postError = askErrorBody(status as 400 | 409, reason);
      renderAsk(`/ask/${CONV_EMPTY_ID}`);
      await user.type(await enabledComposer(), 'Keep me{Enter}');
      expect(await screen.findByText(copy)).toBeInTheDocument();
      expect(composer()).toHaveValue('Keep me');
      expect(streams).toHaveLength(0);
    });
  }
});

describe('AskMessageBubble — every error class has its copy', () => {
  for (const [errorClass, copy] of Object.entries(ASK_ERROR_CLASS_COPY)) {
    it(errorClass, () => {
      render(
            <AskMessageBubble
              message={askMessage({ id: 'a', role: 'assistant', status: 'failed', errorClass: errorClass === 'gone' ? null : (errorClass as never) })}
              live={
                errorClass === 'gone'
                  ? { messageId: 'a', content: '', steps: [], status: 'error', citations: [], finishReason: null, error: { errorClass: 'gone', reason: null } }
                  : null
              }
            />,
      );
      expect(screen.getByText(copy)).toBeInTheDocument();
    });
  }
});

// =============================================================================
// The model picker
// =============================================================================

describe('AskPage — the model picker', () => {
  it('defaults to the graph.agent model, offers only tool-capable models, and sends model only when changed', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_EMPTY_ID}`);
    const modelButton = await screen.findByRole('button', { name: 'Model: GPT-4o mini' });

    await user.type(await enabledComposer(), 'First{Enter}');
    await waitFor(() => expect(postBodies()).toEqual([{ content: 'First' }]));
    act(() => streams[0].handlers.onDone({ citations: [], finishReason: 'stop' }));

    await user.click(modelButton);
    const picker = await screen.findByRole('dialog', { name: 'Choose a model' });
    await user.click(within(picker).getByRole('combobox'));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['GPT-4o mini', 'GPT-4.1']);
    await user.click(screen.getByRole('option', { name: 'GPT-4.1' }));

    expect(await screen.findByRole('button', { name: 'Model: GPT-4.1' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(`ask.model.${CONV_EMPTY_ID}`)).toBe('gpt-4.1');
    await user.type(composer(), 'Second{Enter}');
    await waitFor(() => expect(postBodies()).toHaveLength(2));
    expect(postBodies()[1]).toEqual({ content: 'Second', model: 'gpt-4.1' });
  });

  it('remembers the choice per conversation for this tab', async () => {
    window.sessionStorage.setItem(`ask.model.${CONV_ATLAS_ID}`, 'gpt-4.1');
    renderAsk(`/ask/${CONV_ATLAS_ID}`);
    expect(await screen.findByRole('button', { name: 'Model: GPT-4.1' })).toBeInTheDocument();
  });
});

// =============================================================================
// The conversation list
// =============================================================================

describe('AskPage — the conversation list', () => {
  it('lists conversations with scope chips, highlights the open one, and pages', async () => {
    askMock.pageSize = 2;
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_JOE_ID}`);
    const list = await conversationList();
    const current = await within(list).findByRole('link', { name: /What did Joe promise us\?/ });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(within(current).getByText('Joe Rivera')).toBeInTheDocument();
    expect(within(list).getAllByRole('link')).toHaveLength(2);

    await user.click(within(list).getByRole('button', { name: 'Load more' }));
    expect(await within(list).findByRole('link', { name: /New conversation/ })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('renames a conversation', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_ATLAS_ID}`);
    const list = await conversationList();
    await user.click(await within(list).findByRole('button', { name: 'Actions for When does the Atlas beta ship?' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename conversation' });
    const field = within(dialog).getByRole('textbox', { name: 'Title' });
    await user.clear(field);
    await user.type(field, 'Atlas launch date');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(list).findByRole('link', { name: /Atlas launch date/ })).toBeInTheDocument();
    expect(askMock.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ title: 'Atlas launch date' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Atlas launch date' })).toBeInTheDocument();
  });

  it('deletes the open conversation and goes back to /ask', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_ATLAS_ID}`);
    const list = await conversationList();
    await user.click(await within(list).findByRole('button', { name: 'Actions for When does the Atlas beta ship?' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this conversation?' });
    expect(within(dialog).getByText(/This can't be undone/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(location()).toBe('/ask'));
    expect(within(list).queryByRole('link', { name: /When does the Atlas beta ship/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Ask about your meetings' })).toBeInTheDocument();
  });

  it('loads earlier messages on request', async () => {
    const user = userEvent.setup({ delay: null });
    askMock.conversations.find((c) => c.summary.id === CONV_ATLAS_ID)!.hasEarlier = true;
    renderAsk(`/ask/${CONV_ATLAS_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Load earlier' }));
    await waitFor(() => expect(askMock.requests.some((r) => r.search.startsWith('?before='))).toBe(true));
  });

  it('starts a new conversation from the list', async () => {
    const user = userEvent.setup({ delay: null });
    renderAsk(`/ask/${CONV_ATLAS_ID}`);
    await user.click(await screen.findByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(location()).toBe('/ask'));
    await waitFor(() => expect(composer()).toHaveFocus());
  });
});

// =============================================================================
// Gates and states
// =============================================================================

describe('AskPage — gates and states', () => {
  it('says Ask is off, with no composer, when connected knowledge is disabled', async () => {
    aiConfig = mockGraphAiConfig({ graphEnabled: false });
    renderAsk('/ask');
    expect(await screen.findByText(/Ask is turned off for this deployment/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Your question' })).not.toBeInTheDocument();
    expect(askMock.requests).toHaveLength(0);
  });

  it('redirects a caller without graph:read', async () => {
    renderAsk('/ask', noGraphUser);
    expect(await screen.findByText('Home page')).toBeInTheDocument();
  });

  it('says a missing conversation does not exist, with a way back', async () => {
    renderAsk('/ask/00000000-0000-4000-8000-000000009999');
    expect(await screen.findByText("This conversation doesn't exist")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Ask' })).toHaveAttribute('href', '/ask');
    expect(screen.queryByRole('textbox', { name: 'Your question' })).not.toBeInTheDocument();
  });

  it('offers Retry when the conversation cannot be loaded', async () => {
    const user = userEvent.setup({ delay: null });
    let fail = true;
    server.use(
      http.get(`${API}/ask/conversations/:id`, () =>
        fail ? HttpResponse.json({ message: 'Upstream down' }, { status: 500 }) : undefined,
      ),
    );
    renderAsk(`/ask/${CONV_ATLAS_ID}`);
    expect(await screen.findByText('Upstream down')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('When does the Atlas beta ship?', { selector: 'p' })).toBeInTheDocument();
  });

  it('on a phone, opens the conversations in a drawer and keeps the thread full width', async () => {
    const user = userEvent.setup({ delay: null });
    setViewportWidth(390);
    const { container } = renderAsk(`/ask/${CONV_ATLAS_ID}`);
    await screen.findByRole('region', { name: 'Conversation' });
    expect(screen.queryByRole('navigation', { name: 'Conversations' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Conversations' }));
    const list = await screen.findByRole('navigation', { name: 'Conversations' });
    const row = await within(list).findByRole('link', { name: /What did Joe promise us\?/ });
    await user.click(row);
    await waitFor(() => expect(location()).toBe(`/ask/${CONV_JOE_ID}`));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Conversations' })).not.toBeInTheDocument());
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
