import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { CountsStrip, countsEntries } from '../../../components/home/CountsStrip';
import type { NoteSummary } from '../../../services/notes';
import type { TranscriptSummary } from '../../../services/transcripts';
import { AXE_OPTIONS, noteSummary, summary } from './homeFixtures';

/**
 * The home page's counts strip — issue #170, epic #166.
 *
 * Built over the REAL fixtures the other home suites use, so "the counts the
 * strip test renders" and "the counts the page test renders" cannot diverge —
 * the failure `homeFixtures.ts` exists to prevent.
 *
 * The one thing this file deliberately does NOT assert is that no request is
 * fired: this component takes props and could not issue one if it tried, so
 * the meaningful version of that assertion is against the whole page with MSW
 * counting calls, and it lives in `HomePage.test.tsx`.
 *
 * The responsive behaviour is also not asserted, and cannot be: it is one
 * `Grid size={{ xs: 6, sm: 3 }}` and jsdom performs no layout. What matters —
 * that no `useMediaQuery` creeps in and makes a sixth coupled breakpoint gate
 * (`docs/specs/settings-ui.md` §5) — is a code-review question, not a test.
 */

function counts(overrides: Partial<TranscriptSummary['counts']> = {}) {
  return summary({ counts: { owned: 12, shared: 3, inProgress: 0, failed: 0, ...overrides } })
    .counts;
}

function noteCounts(overrides: Partial<NoteSummary['counts']> = {}) {
  return noteSummary({ counts: { total: 7, ready: 7, inProgress: 0, failed: 0, ...overrides } })
    .counts;
}

// =============================================================================
// countsEntries — the pure derivation
// =============================================================================

describe('countsEntries', () => {
  it('derives nothing at all without a transcript summary', () => {
    // ⚠ THE LOAD-BEARING CASE. A failed read leaves the page with no counts
    // because nothing was ever read, not because nothing exists.
    expect(countsEntries(null, noteCounts())).toEqual([]);
  });

  it('points each entry at the library it counts', () => {
    const entries = countsEntries(counts({ failed: 2 }), noteCounts());

    expect(entries.map((entry) => [entry.key, entry.to])).toEqual([
      ['transcripts', '/transcripts'],
      // Deep links, which is why the URL-seeded filters had to exist first.
      ['shared', '/transcripts?scope=shared'],
      ['notes', '/notes'],
      ['attention', '/transcripts?status=failed'],
    ]);
  });

  it('sums failures across BOTH content types into one entry', () => {
    // A user has work that did not finish; they do not have a failed-transcript
    // problem and a separate failed-note problem.
    const entries = countsEntries(counts({ failed: 2 }), noteCounts({ failed: 3 }));

    expect(entries.find((entry) => entry.key === 'attention')?.value).toBe(5);
  });

  it('omits the attention entry when nothing has failed anywhere', () => {
    const entries = countsEntries(counts({ failed: 0 }), noteCounts({ failed: 0 }));

    expect(entries.map((entry) => entry.key)).not.toContain('attention');
  });

  it('still raises attention when only the NOTES half has failures', () => {
    // The obvious regression: reading `transcripts.failed` alone and never
    // consulting the notes count would pass every other case in this file.
    const entries = countsEntries(counts({ failed: 0 }), noteCounts({ failed: 1 }));

    expect(entries.find((entry) => entry.key === 'attention')?.value).toBe(1);
  });

  it('omits Notes entirely rather than reporting zero when there is no notes summary', () => {
    const entries = countsEntries(counts(), null);

    expect(entries.map((entry) => entry.key)).toEqual(['transcripts', 'shared']);
  });

  it('counts a null notes summary as no failures, not as a crash', () => {
    const entries = countsEntries(counts({ failed: 4 }), null);

    expect(entries.find((entry) => entry.key === 'attention')?.value).toBe(4);
  });
});

// =============================================================================
// Rendering
// =============================================================================

describe('CountsStrip — a populated strip', () => {
  it('renders nothing when the transcript summary never answered', () => {
    const { container } = render(<CountsStrip transcripts={null} notes={noteCounts()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('labels the strip as a region a screen reader can skip', () => {
    render(<CountsStrip transcripts={counts()} notes={noteCounts()} />);

    expect(
      screen.getByRole('region', { name: 'Your library at a glance' }),
    ).toBeInTheDocument();
  });

  it('shows each count with its label', () => {
    render(<CountsStrip transcripts={counts()} notes={noteCounts()} />);

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Transcripts')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Shared with me')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
  });

  it('announces BOTH the number and the label, never a bare number', () => {
    // ⚠ THE ACCESSIBILITY REQUIREMENT OF THIS COMPONENT. A screen-reader user
    // hearing "12" has been told nothing at all.
    render(<CountsStrip transcripts={counts()} notes={noteCounts()} />);

    expect(screen.getByRole('link', { name: '12 Transcripts' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '3 Shared with me' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '7 Notes' })).toBeInTheDocument();
  });

  it('carries the right href on every entry', () => {
    render(<CountsStrip transcripts={counts({ failed: 2 })} notes={noteCounts()} />);

    expect(screen.getByRole('link', { name: '12 Transcripts' })).toHaveAttribute(
      'href',
      '/transcripts',
    );
    expect(screen.getByRole('link', { name: '3 Shared with me' })).toHaveAttribute(
      'href',
      '/transcripts?scope=shared',
    );
    expect(screen.getByRole('link', { name: '7 Notes' })).toHaveAttribute('href', '/notes');
    expect(screen.getByRole('link', { name: '2 Needs attention' })).toHaveAttribute(
      'href',
      '/transcripts?status=failed',
    );
  });

  it('renders the entries as a real list, not a pile of divs', () => {
    render(<CountsStrip transcripts={counts()} notes={noteCounts()} />);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('hides Needs attention when nothing has failed', () => {
    render(<CountsStrip transcripts={counts({ failed: 0 })} notes={noteCounts()} />);

    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('shows Needs attention as soon as something has', () => {
    render(<CountsStrip transcripts={counts({ failed: 1 })} notes={noteCounts({ failed: 2 })} />);

    expect(screen.getByRole('link', { name: '3 Needs attention' })).toBeInTheDocument();
  });

  it('renders no Notes entry at all for a caller with no notes summary', () => {
    // No `notes:read` (the page never issues the request), or a read that
    // failed. Either way there is no honest number, so there is no tile.
    render(<CountsStrip transcripts={counts()} notes={null} />);

    expect(screen.queryByText('Notes')).not.toBeInTheDocument();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('groups a large count rather than printing a run of digits', () => {
    render(<CountsStrip transcripts={counts({ owned: 4200 })} notes={null} />);

    expect(screen.getByText((4200).toLocaleString())).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <CountsStrip transcripts={counts({ failed: 2 })} notes={noteCounts()} />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
