import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { server, http, HttpResponse, render, makeHost } from './helpers.js';
import { mockGraphAiConfig } from '../graph/graphData.js';
import { CONV_ATLAS_ID, JOE_ID, askMock, resetAskMock } from './askData.js';
import { graphReader } from '../graph/graphTestUsers.js';
import { clearEvidenceCache } from '../../src/graph/headless/index.js';
import type { AskStreamHandlers } from '../../src/ask/headless/index.js';
import { postAskMessage } from '../../src/ask/headless/index.js';
import { AskEntityPanelSlot } from '../../src/ask/ui/index.js';
import type { GraphEntityAskPanelProps } from '../../src/graph/ui/index.js';

/**
 * "Ask about this selection" on the ask slice's side (GIC-17, #678): the optional `scope` of a
 * question travels with `postAskMessage`, and the entity panel the explorer opens sends it with
 * the first question and every later one. Starting handles only; the server decides what is readable.
 */

vi.mock('../../src/ask/headless/clients/askStream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ask/headless/clients/askStream.js')>();
  return {
    ...actual,
    connectAskStream: (_host: unknown, _messageId: string, _handlers: AskStreamHandlers) => ({ close: vi.fn() }),
  };
});

const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVIDENCE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(() => {
  resetAskMock([]);
  clearEvidenceCache();
  window.sessionStorage.clear();
  server.use(http.get('*/api/ai-tasks/config', () => HttpResponse.json({ data: mockGraphAiConfig() })));
});

describe('postAskMessage', () => {
  const lastMessageBody = () => askMock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).pop()?.body;

  it('sends the scope when it names something, and nothing when it is empty or absent', async () => {
    const host = makeHost();
    resetAskMock();
    const id = CONV_ATLAS_ID;

    await postAskMessage(host, id, { content: 'How is Joe involved?', scope: { entityIds: [JOE_ID], evidenceIds: [EVIDENCE_ID] } });
    expect(lastMessageBody()).toEqual({ content: 'How is Joe involved?', scope: { entityIds: [JOE_ID], evidenceIds: [EVIDENCE_ID] } });

    await postAskMessage(host, id, { content: 'And now?', scope: { entityIds: [], evidenceIds: [] } });
    expect(lastMessageBody()).toEqual({ content: 'And now?' });

    await postAskMessage(host, id, { content: 'Plain.' });
    expect(lastMessageBody()).toEqual({ content: 'Plain.' });
  });
});

function Panel(props: Partial<GraphEntityAskPanelProps>) {
  return (
    <Routes>
      <Route
        path="*"
        element={
          <AskEntityPanelSlot
            entityId={JOE_ID}
            entityLabel="Joe and 1 more"
            entityType="Person"
            open
            onClose={() => undefined}
            conversationId={null}
            onConversationChange={() => undefined}
            scope={{ entityIds: [JOE_ID, OTHER_ID], evidenceIds: [EVIDENCE_ID] }}
            {...props}
          />
        }
      />
    </Routes>
  );
}

describe('the Ask panel the explorer opens for a selection', () => {
  it('sends the selection with the first question, into a conversation scoped to the first entity', async () => {
    render(<Panel />, { wrapperOptions: { route: '/', user: graphReader }, hostOptions: { features: { graphEnabled: true } } });
    const dialog = await screen.findByRole('dialog', { name: 'Ask about Joe and 1 more' });
    const suggestions = await within(dialog).findByRole('list', { name: 'Suggested questions' });
    const first = within(suggestions).getAllByRole('button')[0];
    await waitFor(() => expect(first).toBeEnabled());
    await userEvent.setup({ delay: null }).click(first);

    await waitFor(() => expect(askMock.requests.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toBe(true));
    const create = askMock.requests.find((r) => r.method === 'POST' && r.path === '/ask/conversations');
    expect(create?.body).toEqual({ scopeEntityId: JOE_ID });
    const post = askMock.requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'));
    expect(post?.body).toMatchObject({ scope: { entityIds: [JOE_ID, OTHER_ID], evidenceIds: [EVIDENCE_ID] } });
  });

  it('sends no scope when the panel is opened for a plain entity', async () => {
    render(<Panel scope={undefined} entityLabel="Joe Rivera" />, {
      wrapperOptions: { route: '/', user: graphReader },
      hostOptions: { features: { graphEnabled: true } },
    });
    const dialog = await screen.findByRole('dialog', { name: 'Ask about Joe Rivera' });
    const suggestions = await within(dialog).findByRole('list', { name: 'Suggested questions' });
    const first = within(suggestions).getAllByRole('button')[0];
    await waitFor(() => expect(first).toBeEnabled());
    await userEvent.setup({ delay: null }).click(first);

    await waitFor(() => expect(askMock.requests.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toBe(true));
    const post = askMock.requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'));
    expect(post?.body).not.toHaveProperty('scope');
  });
});
