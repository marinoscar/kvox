import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { http, HttpResponse, server } from './msw-compat.js';
import { render } from './helpers.js';
import type { MockUser } from './helpers.js';
import { graphReader, graphWriter } from './graphTestUsers.js';
import { JONTY_ID, KAPPA_ID } from './graphData.js';
import { GraphEntityPage } from '../../src/graph/ui/pages/GraphEntityPage.js';
import { clearEvidenceCache } from '../../src/graph/headless/hooks/useGraphEvidence.js';
import {
  formatSpeechMinutes,
  voiceprintSummaryLine,
} from '../../src/graph/ui/components/EntityVoiceprintSection.js';

/**
 * The Voice section of a Person's page (#827): what was learned, "Forget voice"
 * behind a confirmation (`graph:write`), the muted hint when nothing was, and
 * nothing at all for another entity type.
 */

const ENROLLED = {
  enrolled: true,
  samples: 3,
  speechMs: 252_000,
  lastUpdatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  modelId: 'model-x',
};

let voiceReads: string[];
let forgets: string[];

beforeEach(() => {
  clearEvidenceCache();
  voiceReads = [];
  forgets = [];
  server.use(
    http.get('*/api/graph/entities/:id/voiceprint', ({ params }) => {
      voiceReads.push(String(params.id));
      return HttpResponse.json({ data: ENROLLED });
    }),
    http.delete('*/api/graph/entities/:id/voiceprint', ({ params }) => {
      forgets.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

function renderEntity(id = JONTY_ID, user: MockUser = graphWriter) {
  return render(
    <Routes>
      <Route path="/graph/entities/:id" element={<GraphEntityPage />} />
    </Routes>,
    { wrapperOptions: { route: `/graph/entities/${id}`, user } },
  );
}

async function voiceSection() {
  const heading = await screen.findByRole('heading', { level: 2, name: 'Voice' });
  return heading.closest('section') as HTMLElement;
}

describe('voiceprint copy helpers', () => {
  it('says whole minutes, at least one once anything was learned', () => {
    expect(formatSpeechMinutes(0)).toBe('0 min');
    expect(formatSpeechMinutes(10_000)).toBe('1 min');
    expect(formatSpeechMinutes(252_000)).toBe('4 min');
  });

  it('builds the summary line with the singular for one recording', () => {
    expect(
      voiceprintSummaryLine({ enrolled: true, samples: 1, speechMs: 60_000, lastUpdatedAt: null, modelId: null }),
    ).toBe('Voice learned from 1 recording · 1 min of speech');
  });
});

describe('GraphEntityPage — Voice (#827)', () => {
  it("shows what was learned of a Person's voice", async () => {
    renderEntity();
    const section = await voiceSection();
    expect(
      await within(section).findByText(/Voice learned from 3 recordings · 4 min of speech · updated 2 days ago/),
    ).toBeInTheDocument();
    expect(voiceReads).toEqual([JONTY_ID]);
  });

  it('forgets the voice only after the confirmation, then shows the hint', async () => {
    const user = userEvent.setup();
    renderEntity();
    const section = await voiceSection();
    await user.click(await within(section).findByRole('button', { name: 'Forget voice' }));

    const dialog = await screen.findByRole('dialog', { name: "Forget Jonty Placeholder's voice?" });
    expect(dialog).toHaveTextContent('voice samples learned for Jonty Placeholder are deleted');
    expect(dialog).toHaveTextContent('no longer suggested');
    expect(forgets).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Forget voice' }));
    await waitFor(() => expect(forgets).toEqual([JONTY_ID]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(section).findByText(/No voice learned yet/)).toBeInTheDocument();
  });

  it('cancelling the confirmation forgets nothing', async () => {
    const user = userEvent.setup();
    renderEntity();
    const section = await voiceSection();
    await user.click(await within(section).findByRole('button', { name: 'Forget voice' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(forgets).toEqual([]);
  });

  it('offers no "Forget voice" without graph:write', async () => {
    renderEntity(JONTY_ID, graphReader);
    const section = await voiceSection();
    await within(section).findByText(/Voice learned from 3 recordings/);
    expect(within(section).queryByRole('button', { name: 'Forget voice' })).not.toBeInTheDocument();
  });

  it('shows a muted hint when no voice was learned', async () => {
    server.use(
      http.get('*/api/graph/entities/:id/voiceprint', () =>
        HttpResponse.json({ data: { enrolled: false, samples: 0, speechMs: 0, lastUpdatedAt: null, modelId: null } }),
      ),
    );
    renderEntity();
    const section = await voiceSection();
    expect(await within(section).findByText(/No voice learned yet/)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Forget voice' })).not.toBeInTheDocument();
  });

  it('renders nothing and asks nothing for a non-Person', async () => {
    renderEntity(KAPPA_ID);
    await screen.findByRole('heading', { level: 1, name: 'Org Kappa' });
    await screen.findByRole('heading', { level: 2, name: 'Brief' });
    expect(screen.queryByRole('heading', { level: 2, name: 'Voice' })).not.toBeInTheDocument();
    expect(voiceReads).toEqual([]);
  });
});
