import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { InsightsPanel } from '../../src/graph/ui/components/explorer/insights/InsightsPanel.js';
import {
  CONNECTORS_REFRESH_TEXT,
  INSIGHT_EMPTY_TEXT,
  INSIGHTS_NONE_TEXT,
  INSIGHTS_PENDING_TEXT,
  INSIGHTS_STALE_TEXT,
  INSIGHTS_TOO_LARGE_TEXT,
  connectorSeeds,
  emptyText,
  riskSeeds,
  snapshotNotice,
  themeSeeds,
  tieSeeds,
} from '../../src/graph/ui/components/explorer/insights/insightsModel.js';
import { ANA_ID, ATLAS_ID, GLOBEX_ID, JOE_ID, RISK_ID, ACME_ID, insightsFixture } from './graphData.js';
import { graphReader, graphWriter } from './graphTestUsers.js';
import { render } from './helpers.js';
import { HttpResponse, http, server } from './msw-compat.js';

const API = '*/api';
const typeLabel = (key: string) => key;

function renderPanel(props: Partial<Parameters<typeof InsightsPanel>[0]> = {}, user = graphReader) {
  const onSelect = vi.fn();
  const view = render(<InsightsPanel onSelect={onSelect} typeLabel={typeLabel} inputModality="pointer" {...props} />, {
    wrapperOptions: { user },
  });
  return { ...view, onSelect };
}

function answer(body: ReturnType<typeof insightsFixture>) {
  server.use(http.get(`${API}/graph/insights`, () => HttpResponse.json({ data: body })));
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // Storage unavailable: the panel runs on memory.
  }
});

describe('insightsModel', () => {
  const data = insightsFixture();

  it('seeds a theme with its members and focuses its label entity', () => {
    const seeds = themeSeeds(data.themes[0]);
    expect(seeds.seedIds).toContain(ACME_ID);
    expect(seeds.focusId).toBe(ACME_ID);
    expect(seeds.markIds).toEqual([]);
  });

  it('seeds a connector with itself and the top members of both clusters it joins, and rings those', () => {
    const seeds = connectorSeeds(data.connectors[0], data.themes);
    expect(seeds.focusId).toBe(JOE_ID);
    expect(seeds.seedIds[0]).toBe(JOE_ID);
    expect(seeds.markIds).toContain(ACME_ID);
    expect(seeds.markIds).toContain(GLOBEX_ID);
    expect(seeds.markIds).not.toContain(JOE_ID);
    expect(seeds.seedIds.length).toBeLessThanOrEqual(10);
  });

  it('seeds a tie with both ends and a risk with the item itself', () => {
    expect(tieSeeds(data.fadingTies[0]).seedIds).toEqual([JOE_ID, ANA_ID]);
    expect(riskSeeds(data.openRisks[0])).toEqual({ seedIds: [RISK_ID], focusId: RISK_ID, markIds: [] });
  });

  it('says what is wrong with the snapshot, most pressing first', () => {
    expect(snapshotNotice(null)).toBeNull();
    expect(snapshotNotice(data)).toBeNull();
    expect(snapshotNotice({ ...data, stale: true })).toBe(INSIGHTS_STALE_TEXT);
    expect(snapshotNotice({ ...data, stale: true, pending: true })).toBe(INSIGHTS_PENDING_TEXT);
    expect(snapshotNotice({ ...data, tooLarge: true })).toBe(INSIGHTS_TOO_LARGE_TEXT);
    expect(snapshotNotice({ ...data, status: 'none' })).toBe(INSIGHTS_NONE_TEXT);
  });

  it('explains an empty connectors section on an older snapshot', () => {
    expect(emptyText('connectors', { ...data, connectorsReady: false })).toBe(CONNECTORS_REFRESH_TEXT);
    expect(emptyText('connectors', data)).toBe(INSIGHT_EMPTY_TEXT.connectors);
  });
});

describe('InsightsPanel', () => {
  it('shows the five sections with plain-language items and no raw score, and is axe-clean', async () => {
    const { container } = renderPanel();
    expect(await screen.findByRole('button', { name: /Themes/ })).toBeInTheDocument();
    for (const name of ['Connectors', 'Rising', 'Fading ties', 'Open risks']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(screen.getByText('Joe Rivera connects the Acme Corp group and the Globex group.')).toBeInTheDocument();
    expect(screen.getByText('Came up in 5 conversations in the last 30 days, up from 1 before.')).toBeInTheDocument();
    expect(screen.getByText("You haven't discussed Joe Rivera with Ana Diaz since May 1, 2026.")).toBeInTheDocument();
    expect(screen.getByText('Legal review')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.queryByText(/0\.42/)).not.toBeInTheDocument();
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations();
  });

  it('a theme seeds the canvas with its members', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPanel();
    await user.click(await screen.findByRole('button', { name: /^Globex/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].seedIds).toContain(GLOBEX_ID);
  });

  it('a connector focuses the node and rings both clusters', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPanel();
    const section = (await screen.findByRole('region', { name: /^Connectors/ })) as HTMLElement;
    await user.click(within(section).getByRole('button', { name: /Joe Rivera/ }));
    const seeds = onSelect.mock.calls[0][0];
    expect(seeds.focusId).toBe(JOE_ID);
    expect(seeds.markIds).toEqual(expect.arrayContaining([ACME_ID, GLOBEX_ID]));
  });

  it('a rising entity opens that entity', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPanel();
    const section = (await screen.findByRole('region', { name: /^Rising/ })) as HTMLElement;
    await user.click(within(section).getByRole('button', { name: /Ana Diaz/ }));
    expect(onSelect.mock.calls[0][0]).toEqual({ seedIds: [ANA_ID], focusId: ANA_ID, markIds: [] });
  });

  it('a fading tie opens both ends', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPanel();
    const section = (await screen.findByRole('region', { name: /^Fading ties/ })) as HTMLElement;
    await user.click(within(section).getByRole('button', { name: /Joe Rivera and Ana Diaz/ }));
    expect(onSelect.mock.calls[0][0].seedIds).toEqual([JOE_ID, ANA_ID]);
  });

  it('a risk opens the risk', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPanel();
    const section = (await screen.findByRole('region', { name: /^Open risks/ })) as HTMLElement;
    await user.click(within(section).getByRole('button', { name: /Legal review/ }));
    expect(onSelect.mock.calls[0][0].seedIds).toEqual([RISK_ID]);
    expect(within(section).getByText('On Project Atlas')).toBeInTheDocument();
    expect(ATLAS_ID).toBeTruthy();
  });

  it('collapses and expands a section, and remembers it', async () => {
    const user = userEvent.setup();
    const first = renderPanel();
    const toggle = await screen.findByRole('button', { name: /Rising/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: /Rising/ })).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByText(/Came up in 5 conversations/)).not.toBeInTheDocument());
    first.unmount();
    renderPanel();
    expect(await screen.findByRole('button', { name: /Rising/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('asks again for the window that was chosen', async () => {
    const user = userEvent.setup();
    const windows: string[] = [];
    server.use(
      http.get(`${API}/graph/insights`, ({ request }) => {
        const window = new URL(request.url).searchParams.get('window') ?? '30d';
        windows.push(window);
        return HttpResponse.json({ data: insightsFixture({ window: { key: window as '30d', days: 30, from: '', previousFrom: '' } }) });
      }),
    );
    renderPanel();
    await screen.findByRole('button', { name: /Themes/ });
    await user.click(screen.getByRole('button', { name: '90 days' }));
    await waitFor(() => expect(windows).toEqual(['30d', '90d']));
    expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so, and offers Refresh to a writer, when the snapshot is stale', async () => {
    answer(insightsFixture({ stale: true }));
    const user = userEvent.setup();
    let refreshed = 0;
    server.use(
      http.post(`${API}/graph/overview/refresh`, () => {
        refreshed += 1;
        return HttpResponse.json({ data: { jobId: 'j', deduplicated: false } }, { status: 202 });
      }),
    );
    renderPanel({}, graphWriter);
    expect(await screen.findByText(INSIGHTS_STALE_TEXT)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(refreshed).toBe(1));
  });

  it('offers a reader no Refresh', async () => {
    answer(insightsFixture({ stale: true }));
    renderPanel();
    expect(await screen.findByText(INSIGHTS_STALE_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('says every section is empty, and why, when there is no snapshot yet', async () => {
    answer(
      insightsFixture({ status: 'none', computedAt: null, themes: [], connectors: [], rising: [], fadingTies: [], openRisks: [], connectorsReady: false }),
    );
    renderPanel();
    expect(await screen.findByText(INSIGHTS_NONE_TEXT)).toBeInTheDocument();
    expect(screen.getByText(INSIGHT_EMPTY_TEXT.rising)).toBeInTheDocument();
    expect(screen.getByText(INSIGHT_EMPTY_TEXT.openRisks)).toBeInTheDocument();
  });

  it('shows the error when the read fails', async () => {
    server.use(http.get(`${API}/graph/insights`, () => HttpResponse.json({ message: 'boom' }, { status: 503 })));
    renderPanel();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('gives every target at least 44px on a touch input', async () => {
    renderPanel({ inputModality: 'touch' });
    const toggle = await screen.findByRole('button', { name: /Rising/ });
    expect(getComputedStyle(toggle).minHeight).toBe('44px');
    const item = screen.getAllByRole('button', { name: /Ana Diaz/ })[0];
    expect(getComputedStyle(item).minHeight).toBe('44px');
    expect(getComputedStyle(screen.getByRole('button', { name: '90 days' })).minHeight).toBe('44px');
  });
});
