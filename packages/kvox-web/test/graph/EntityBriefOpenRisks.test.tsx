import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';

import { render } from './helpers.js';
import { graphReader } from './graphTestUsers.js';
import { EV_SEGMENT, briefFixture, gid } from './graphData.js';
import { BRIEF_OPEN_RISKS_TITLE, BRIEF_SECTION_TITLES, EntityBriefCard } from '../../src/graph/ui/components/EntityBriefCard.js';

/** The brief's optional "Open risks" section (#664): shown when the API sends it, absent otherwise. */

function renderBrief(openRisks?: NonNullable<ReturnType<typeof briefFixture>['sections']['openRisks']>) {
  const brief = briefFixture();
  if (openRisks) brief.sections.openRisks = openRisks;
  return render(<EntityBriefCard brief={brief} ontology={null} onRefresh={() => undefined} />, {
    wrapperOptions: { user: graphReader },
  });
}

describe('EntityBriefCard: Open risks', () => {
  it('names the optional section apart from the five fixed ones', () => {
    expect(BRIEF_OPEN_RISKS_TITLE).toBe('Open risks');
    // The five always-present sections keep their order and count: Open risks is optional, never one of them.
    expect(BRIEF_SECTION_TITLES).not.toContain(BRIEF_OPEN_RISKS_TITLE);
  });

  it('renders the section with its cited entries when the brief carries open risks', async () => {
    renderBrief([
      {
        itemId: gid(901),
        kind: 'risk',
        title: null,
        statement: 'Licence budget is not approved yet.',
        occurredAt: '2026-09-20T15:00:00.000Z',
        precision: 'day',
        status: 'open',
        dueAt: null,
        ownerPerson: null,
        counterparty: null,
        superseded: false,
        evidenceIds: [EV_SEGMENT],
      },
    ]);
    expect(await screen.findByRole('heading', { name: /Open risks/ })).toBeInTheDocument();
    expect(screen.getByText('Licence budget is not approved yet.')).toBeInTheDocument();
  });

  it('omits the section when the brief has no open risks', async () => {
    renderBrief();
    expect(await screen.findByRole('heading', { name: /What changed/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Open risks/ })).not.toBeInTheDocument();
    renderBrief([]);
    expect(screen.queryByRole('heading', { name: /Open risks/ })).not.toBeInTheDocument();
  });
});
