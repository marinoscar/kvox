import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../../mocks/server';
import { mockGraphAiConfig } from '../../mocks/graphData';
import {
  CONV_ATLAS_ID,
  CONV_JOE_ID,
  JOE_ID,
  askMock,
  defaultAskConversations,
  resetAskMock,
} from '../../mocks/askData';
import { render } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { graphReader } from '../../utils/graphTestUsers';
import type { AskStreamHandlers } from '../../../services/askStream';
import { clearEvidenceCache } from '../../../hooks/useGraphEvidence';
import { ENTITY_ASK_GONE_COPY } from '../../../components/ask/EntityAskPanel';

/**
 * The entity page's Ask panel (#381), mounted through the real entity page so
 * the `?ask=` URL contract, the header action and the drawer are exercised
 * together. MSW answers the conversation routes from `askMock` (#376/#378's
 * contracts); the stream (#379) is a recorder the test drives by hand.
 */

interface Recorded {
  messageId: string;
  handlers: AskStreamHandlers;
  close: ReturnType<typeof vi.fn>;
}

const streams: Recorded[] = [];

vi.mock('../../../services/askStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/askStream')>();
  return {
    ...actual,
    connectAskStream: (messageId: string, handlers: AskStreamHandlers) => {
      const close = vi.fn();
      streams.push({ messageId, handlers, close });
      return { close };
    },
  };
});

// Imported after the mock so the panel picks up the recorder.
import GraphEntityPage from '../../../pages/GraphEntityPage';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const API = '*/api';

let aiConfig: Record<string, unknown>;

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <button type="button" onClick={() => navigate(-1)}>
        Browser back
      </button>
    </>
  );
}

function renderEntity(search = '') {
  return render(
    <>
      <Routes>
        <Route path="/graph/entities/:id" element={<GraphEntityPage />} />
        <Route path="/ask/:conversationId" element={<p>Ask page</p>} />
        <Route path="/" element={<p>Previous page</p>} />
      </Routes>
      <Probe />
    </>,
    { wrapperOptions: { route: `/graph/entities/${JOE_ID}${search}`, user: graphReader } },
  );
}

const search = () => new URLSearchParams((screen.getByTestId('location').textContent ?? '').split('?')[1] ?? '');
const panel = () => screen.findByRole('dialog', { name: 'Ask about Joe Rivera' });
const askButton = () => screen.findByRole('button', { name: 'Ask about Joe Rivera' });
const listRequests = () => askMock.requests.filter((r) => r.method === 'GET' && r.path === '/ask/conversations');

async function openPanel() {
  const user = userEvent.setup({ delay: null });
  await user.click(await askButton());
  return { user, dialog: await panel() };
}

/** Only unscoped conversations: the entity has none of its own. */
function withoutJoeConversations() {
  resetAskMock(defaultAskConversations().filter((conv) => conv.summary.id !== CONV_JOE_ID));
}

beforeEach(() => {
  streams.length = 0;
  resetAskMock();
  clearEvidenceCache();
  window.sessionStorage.clear();
  aiConfig = mockGraphAiConfig();
  server.use(http.get(`${API}/ai/config`, () => HttpResponse.json({ data: aiConfig })));
});

describe('EntityAskPanel — the header action', () => {
  it('is offered only when connected knowledge is on', async () => {
    aiConfig = mockGraphAiConfig({ graphEnabled: false });
    renderEntity('?ask=1');
    await screen.findByRole('heading', { level: 1, name: 'Joe Rivera' });
    // Let the AI config answer before asserting the absence.
    await waitFor(() => expect(askMock.requests).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: 'Ask about Joe Rivera' })).not.toBeInTheDocument();
    // Even a URL asking for the panel does not open it.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a right-hand drawer on a wide window, pushing ?ask=1', async () => {
    renderEntity();
    const { dialog } = await openPanel();
    expect(dialog.closest('.MuiDrawer-root')).toHaveClass('MuiDrawer-anchorRight');
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Ask about Joe Rivera' })).toBeInTheDocument();
    expect(search().get('ask')).not.toBeNull();
  });

  it('is icon-only with its accessible name on a phone, and opens a bottom sheet', async () => {
    act(() => setViewportWidth(390));
    renderEntity();
    const button = await askButton();
    expect(button).not.toHaveTextContent('Ask about');
    const user = userEvent.setup({ delay: null });
    await user.click(button);
    const dialog = await panel();
    expect(dialog.closest('.MuiDrawer-root')).toHaveClass('MuiDrawer-anchorBottom');
  });
});

describe('EntityAskPanel — scoped conversations', () => {
  it('lists only this entity’s conversations and opens the newest', async () => {
    renderEntity();
    const { user, dialog } = await openPanel();

    await waitFor(() => expect(listRequests().length).toBeGreaterThan(0));
    const query = new URLSearchParams(listRequests()[0].search);
    expect(query.get('scopeEntityId')).toBe(JOE_ID);
    expect(query.get('limit')).toBe('10');

    // The newest scoped conversation opens by default, and the URL says so.
    expect(await within(dialog).findByText(/Joe committed to the Atlas launch/)).toBeInTheDocument();
    await waitFor(() => expect(search().get('ask')).toBe(CONV_JOE_ID));
    expect(within(dialog).getByRole('link', { name: 'Open in Ask' })).toHaveAttribute('href', `/ask/${CONV_JOE_ID}`);

    await user.click(within(dialog).getByRole('combobox', { name: 'Conversation' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'New conversation',
      expect.stringContaining('What did Joe promise us?'),
    ]);
    expect(screen.queryByRole('option', { name: /Atlas beta ship/ })).not.toBeInTheDocument();

    // "New conversation" shows the entity's suggestions.
    await user.click(options[0]);
    expect(await within(dialog).findByRole('list', { name: 'Suggested questions' })).toBeInTheDocument();
    expect(search().get('ask')).toBe('1');
    expect(within(dialog).queryByRole('link', { name: 'Open in Ask' })).not.toBeInTheDocument();
  });

  it('reopens the conversation named in the URL (a reload)', async () => {
    renderEntity(`?ask=${CONV_JOE_ID}`);
    const dialog = await panel();
    expect(await within(dialog).findByText(/Joe committed to the Atlas launch/)).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Conversation' })).toHaveTextContent('What did Joe promise us?');
  });

  it('never shows a conversation scoped to a different entity', async () => {
    resetAskMock(
      defaultAskConversations().map((conv) =>
        conv.summary.id === CONV_ATLAS_ID
          ? { ...conv, summary: { ...conv.summary, scopeEntity: { id: 'someone-else', label: 'Ann', type: 'Person' } } }
          : conv,
      ),
    );
    renderEntity(`?ask=${CONV_ATLAS_ID}`);
    await panel();
    await waitFor(() => expect(search().get('ask')).toBe('1'));
  });
});

describe('EntityAskPanel — asking', () => {
  it('offers Person suggestions and sends one into a new, scoped conversation', async () => {
    withoutJoeConversations();
    renderEntity();
    const { user, dialog } = await openPanel();

    const suggestions = await within(dialog).findByRole('list', { name: 'Suggested questions' });
    const buttons = within(suggestions).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'What has Joe Rivera committed to?',
      "How has Joe Rivera's role changed?",
      'What did we last discuss with Joe Rivera?',
    ]);
    await waitFor(() => expect(buttons[0]).toBeEnabled());
    await user.click(buttons[0]);

    // Created WITH the scope, then asked.
    await waitFor(() => expect(within(dialog).getByText('What has Joe Rivera committed to?')).toBeInTheDocument());
    const create = askMock.requests.find((r) => r.method === 'POST' && r.path === '/ask/conversations');
    expect(create?.body).toEqual({ scopeEntityId: JOE_ID });
    const post = askMock.requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'));
    expect(post?.body).toEqual({ content: 'What has Joe Rivera committed to?' });

    const createdId = askMock.conversations[0].summary.id;
    await waitFor(() => expect(search().get('ask')).toBe(createdId));
    await waitFor(() => expect(streams).toHaveLength(1));

    // Streaming behaves as on /ask: the shared thread renders the frames.
    act(() => streams[0].handlers.onContent('Joe owns the Atlas launch.'));
    expect(await within(dialog).findByText('Joe owns the Atlas launch.')).toBeInTheDocument();
    act(() => streams[0].handlers.onDone({ citations: [], finishReason: 'stop' }));
    expect(await within(dialog).findByText('No sources were cited — treat this answer with care.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open in Ask' })).toHaveAttribute('href', `/ask/${createdId}`);
  });

  it('says the entity is gone when creating the conversation 404s', async () => {
    withoutJoeConversations();
    server.use(
      http.post(`${API}/ask/conversations`, () =>
        HttpResponse.json({ statusCode: 404, code: 'NOT_FOUND', message: 'Entity not found' }, { status: 404 }),
      ),
    );
    renderEntity();
    const { user, dialog } = await openPanel();
    const suggestions = await within(dialog).findByRole('list', { name: 'Suggested questions' });
    const first = within(suggestions).getAllByRole('button')[0];
    await waitFor(() => expect(first).toBeEnabled());
    await user.click(first);
    expect(await within(dialog).findByText(`${ENTITY_ASK_GONE_COPY}.`)).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: 'Your question' })).not.toBeInTheDocument();
  });

  it('keeps the typed question and shows the 409 copy when a send is refused', async () => {
    renderEntity(`?ask=${CONV_JOE_ID}`);
    askMock.postError = {
      status: 409,
      body: { statusCode: 409, code: 'CONFLICT', message: 'x', details: { reason: 'ai_key_missing' } },
    };
    const dialog = await panel();
    const box = await within(dialog).findByRole('textbox', { name: 'Your question' });
    await waitFor(() => expect(box).toBeEnabled());
    const user = userEvent.setup({ delay: null });
    await user.type(box, 'Anything new?{Enter}');
    expect(await within(dialog).findByText(/Add your AI key in Settings → AI\./)).toBeInTheDocument();
    expect(box).toHaveValue('Anything new?');
  });
});

describe('EntityAskPanel — closing', () => {
  it('closes with its button, popping its own history entry', async () => {
    renderEntity();
    const { user, dialog } = await openPanel();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(search().get('ask')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Joe Rivera' })).toBeInTheDocument();
  });

  it('closes on the back gesture', async () => {
    renderEntity();
    const { user } = await openPanel();
    await waitFor(() => expect(search().get('ask')).toBe(CONV_JOE_ID));
    await user.click(screen.getByRole('button', { name: 'Browser back', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(search().get('ask')).toBeNull();
  });

  it('drops the parameter when the panel was opened from the URL', async () => {
    renderEntity(`?ask=${CONV_JOE_ID}`);
    const dialog = await panel();
    const user = userEvent.setup({ delay: null });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(search().get('ask')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Joe Rivera' })).toBeInTheDocument();
  });

  it('disconnects a running answer on close and shows it completed on reopening', async () => {
    withoutJoeConversations();
    renderEntity();
    const { user, dialog } = await openPanel();
    const suggestions = await within(dialog).findByRole('list', { name: 'Suggested questions' });
    const first = within(suggestions).getAllByRole('button')[0];
    await waitFor(() => expect(first).toBeEnabled());
    await user.click(first);
    await waitFor(() => expect(streams).toHaveLength(1));

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(streams[0].close).toHaveBeenCalled();

    // Server-side the job finished while nobody watched.
    const conv = askMock.conversations[0];
    conv.messages = conv.messages.map((m) =>
      m.role === 'assistant' ? { ...m, status: 'complete', content: 'Joe owns the launch.', finishReason: 'stop' } : m,
    );
    conv.summary = { ...conv.summary, running: false };

    await user.click(await askButton());
    const reopened = await panel();
    expect(await within(reopened).findByText('Joe owns the launch.')).toBeInTheDocument();
    // A settled turn never reattaches.
    expect(streams).toHaveLength(1);
  });
});

describe('EntityAskPanel — accessibility', () => {
  it('has no axe violations with the drawer open', async () => {
    renderEntity();
    const { dialog } = await openPanel();
    await within(dialog).findByText(/Joe committed to the Atlas launch/);
    await waitFor(() => expect(within(dialog).queryAllByLabelText(/Loading/)).toHaveLength(0));
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});
