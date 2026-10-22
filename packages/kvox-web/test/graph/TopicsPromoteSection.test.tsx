import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { http, HttpResponse } from './msw-compat.js';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { TopicsPromoteSection } from '../../src/graph/ui/components/settings/TopicsPromoteSection.js';
import { UserKnowledgeGraphPage } from '../../src/graph/ui/pages/UserKnowledgeGraphPage.js';
import type { TopicsPromoteStatus } from '../../src/graph/headless/clients/graph.js';
import { server } from './msw-compat.js';
import { render } from './helpers.js';
import { graphReader, graphWriter } from './graphTestUsers.js';

/**
 * "Find topics in past meetings" on the Knowledge graph card (#666): hidden
 * without graph:write and while connected knowledge is off (the host flag, the
 * Desktop one too), one POST on a click, progress while the job works, and the
 * "N topics proposed, review now" link.
 */

const API = '*/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const POLL = { pollIntervalMs: 5 };

let status: TopicsPromoteStatus;
let posts: number;

beforeEach(() => {
  status = { job: null, proposedTopics: 0 };
  posts = 0;
  server.use(
    http.get(`${API}/graph/topics/promote`, () => HttpResponse.json({ data: status })),
    http.post(`${API}/graph/topics/promote`, () => {
      posts += 1;
      status = { job: { id: 'j1', status: 'running', createdAt: '2026-10-01T00:00:00.000Z', finishedAt: null }, proposedTopics: 0 };
      return HttpResponse.json({ data: { jobId: 'j1', deduplicated: false } }, { status: 202 });
    }),
  );
});

const job = (state: 'pending' | 'running' | 'succeeded' | 'failed') => ({
  id: 'j1',
  status: state,
  createdAt: '2026-10-01T00:00:00.000Z',
  finishedAt: state === 'succeeded' || state === 'failed' ? '2026-10-01T00:05:00.000Z' : null,
});

function renderSection(options: { user?: typeof graphWriter; graphEnabled?: boolean | undefined } = {}) {
  return render(<TopicsPromoteSection pollOptions={POLL} />, {
    wrapperOptions: { user: options.user ?? graphWriter },
    hostOptions: { features: { graphEnabled: 'graphEnabled' in options ? options.graphEnabled : true } },
  });
}

describe('TopicsPromoteSection', () => {
  it('queues one run on a click and shows the progress with the count so far', async () => {
    const user = userEvent.setup();
    const { container } = renderSection();
    const button = await screen.findByRole('button', { name: 'Find topics in past meetings' });
    expect(posts).toBe(0); // never automatic

    await user.click(button);
    await waitFor(() => expect(posts).toBe(1));
    expect(await screen.findByRole('progressbar', { name: /finding topics/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find topics in past meetings' })).toBeDisabled();

    status = { job: job('running'), proposedTopics: 3 };
    expect(await screen.findByText(/3 topics proposed so far/i, {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('ends on "N topics proposed, review now" linking to the review page', async () => {
    status = { job: job('succeeded'), proposedTopics: 4 };
    renderSection();

    const link = await screen.findByRole('link', { name: /review now/i });
    expect(link).toHaveAttribute('href', '/graph/review');
    expect(screen.getByText(/4 topics proposed/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('says so when a finished run found nothing new, and when it failed', async () => {
    status = { job: job('succeeded'), proposedTopics: 0 };
    const first = renderSection();
    expect(await screen.findByText(/no new topics to propose/i)).toBeInTheDocument();
    first.unmount();

    status = { job: job('failed'), proposedTopics: 0 };
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not finish/i);
  });

  it('reports a refusal from the server', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/graph/topics/promote`, () =>
        HttpResponse.json({ statusCode: 409, message: 'off', details: { reason: 'graph_disabled' } }, { status: 409 }),
      ),
    );
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Find topics in past meetings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/turned off/i);
    expect(screen.getByRole('button', { name: 'Find topics in past meetings' })).toBeEnabled();
  });

  it('is hidden without graph:write', () => {
    renderSection({ user: graphReader as never });
    expect(screen.queryByRole('button', { name: 'Find topics in past meetings' })).not.toBeInTheDocument();
  });

  it.each([false, undefined])('is hidden while the host says connected knowledge is %s (Desktop flag included)', (graphEnabled) => {
    renderSection({ graphEnabled });
    expect(screen.queryByRole('button', { name: 'Find topics in past meetings' })).not.toBeInTheDocument();
  });

  it('never reads the job while hidden', async () => {
    let reads = 0;
    server.use(
      http.get(`${API}/graph/topics/promote`, () => {
        reads += 1;
        return HttpResponse.json({ data: status });
      }),
    );
    renderSection({ graphEnabled: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(0);
  });
});

describe('Knowledge graph settings page', () => {
  it('shows the "Past meetings" section only to a writer on a deployment with connected knowledge on', async () => {
    const shown = render(<UserKnowledgeGraphPage />, {
      wrapperOptions: { user: graphWriter },
      hostOptions: { features: { graphEnabled: true } },
    });
    expect(await screen.findByRole('heading', { name: 'Past meetings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find topics in past meetings' })).toBeInTheDocument();
    shown.unmount();

    render(<UserKnowledgeGraphPage />, {
      wrapperOptions: { user: graphWriter },
      hostOptions: { features: { graphEnabled: false } },
    });
    await screen.findByRole('heading', { level: 1, name: 'Knowledge graph' });
    expect(screen.queryByRole('heading', { name: 'Past meetings' })).not.toBeInTheDocument();
  });
});
