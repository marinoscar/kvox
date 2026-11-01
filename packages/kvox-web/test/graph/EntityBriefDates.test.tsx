import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { setPreferredTimeZone } from '@marinoscar/platform-web/timezone/headless';

import { render } from './helpers.js';
import { graphReader } from './graphTestUsers.js';
import { briefFixture } from './graphData.js';
import { EntityBriefCard } from '../../src/graph/ui/components/EntityBriefCard.js';
import type { EntityBrief } from '../../src/graph/headless/clients/graph.js';

/**
 * Calendar values vs. instants in the brief: a due date is the day it names in
 * every zone (the API sends a `date` column as UTC midnight); the summary's
 * `generatedAt` and a last-viewed `since` are instants, read in the display zone.
 */

function renderBrief(overrides: Partial<EntityBrief> = {}) {
  return render(<EntityBriefCard brief={briefFixture(overrides)} ontology={null} onRefresh={() => undefined} />, {
    wrapperOptions: { user: graphReader },
  });
}

describe('EntityBriefCard: dates', () => {
  it.each(['America/Los_Angeles', 'Asia/Tokyo'])('shows a due date as its own calendar day in %s', async (zone) => {
    setPreferredTimeZone(zone);
    renderBrief();
    const chips = await screen.findAllByText('Due Oct 31, 2026');
    expect(chips.length).toBeGreaterThan(0);
    expect(screen.queryByText(/Due Oct 30, 2026|Due Nov 1, 2026/)).not.toBeInTheDocument();
  });

  it('reads the summary time and a last-viewed since as instants in the display zone', async () => {
    setPreferredTimeZone('Asia/Tokyo');
    const base = briefFixture();
    renderBrief({
      window: { ...base.window, since: '2026-09-01T20:00:00.000Z', sinceSource: 'last_viewed' },
      digest: { ...base.digest!, generatedAt: '2026-09-21T18:00:00.000Z' },
    });
    expect(await screen.findByText(/^Since Sep 2, 2026/)).toBeInTheDocument();
    expect(screen.getByText('Summary as of Sep 22, 2026')).toBeInTheDocument();
  });

  it('keeps a typed ?since= date on its calendar day west of UTC', async () => {
    setPreferredTimeZone('America/Los_Angeles');
    const base = briefFixture();
    renderBrief({ window: { ...base.window, since: '2026-09-01T00:00:00.000Z', sinceSource: 'query' } });
    expect(await screen.findByText('Since Sep 1, 2026')).toBeInTheDocument();
  });
});
