import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { EvidenceCard, evidenceSourceTitle } from '../../src/graph/ui/components/explorer/inspector/EvidenceCard.js';
import type { EvidenceLink } from '../../src/graph/headless/clients/graph.js';
import { render } from './helpers.js';
import { gid } from './graphData.js';

// The explorer inspector's citation card shows a source-document citation (#789).

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function link(source: Partial<Extract<EvidenceLink['source'], { kind: 'source_text' }>> = {}): EvidenceLink {
  return {
    id: gid(600),
    subjectKind: 'item',
    subjectId: gid(601),
    quote: 'Person K1 leads Project P1 for Org Alpha.',
    createdAt: '2026-11-07T00:00:00.000Z',
    source: {
      kind: 'source_text',
      noteId: 'n-plan',
      noteTitle: 'Plan summary',
      noteVersion: 2,
      sourceObjectId: gid(602),
      charStart: 120,
      charEnd: 160,
      sourceTextLength: 900,
      available: true,
      href: '/notes/n-plan?source=120-160',
      ...source,
    },
  };
}

describe('EvidenceCard, source-text citation (#789)', () => {
  it('is titled after the note it was drawn for and opens at the span in the source', async () => {
    const { container } = render(<EvidenceCard link={link()} />);
    expect(evidenceSourceTitle(link())).toBe('Source of Plan summary');
    expect(screen.getByText('“Person K1 leads Project P1 for Org Alpha.”')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open at source: Source of Plan summary' })).toHaveAttribute(
      'href',
      '/notes/n-plan?source=120-160',
    );
    // The source never reads as an edited note: its text cannot change.
    expect(screen.queryByText('Note edited since')).not.toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('keeps the quote, warns and offers no link when the stored text was purged', () => {
    const purged = link({ sourceObjectId: null, available: false, href: null, noteTitle: null });
    render(<EvidenceCard link={purged} />);
    expect(evidenceSourceTitle(purged)).toBe('Source document no longer available');
    expect(screen.getByText('“Person K1 leads Project P1 for Org Alpha.”')).toBeInTheDocument();
    expect(screen.getByText('Source unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
