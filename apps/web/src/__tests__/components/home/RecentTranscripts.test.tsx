import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { render } from '../../utils/test-utils';
import { RecentTranscripts } from '../../../components/home/RecentTranscripts';
import {
  TranscriptSummaryCard,
  accessRoleLabel,
} from '../../../components/home/TranscriptSummaryCard';
import { AXE_OPTIONS, transcript } from './homeFixtures';

/**
 * The Recent list and the card it is made of.
 *
 * The responsive behaviour is deliberately NOT asserted here and cannot be:
 * it is pure CSS (`Grid` `size={{ xs: 12, sm: 6, md: 4, lg: 3 }}`) and jsdom
 * performs no layout, so a column count is only observable in the Playwright
 * baselines (`tests/visual/specs/home.spec.ts`). What IS asserted is the thing
 * that would make that CSS wrong: a `useMediaQuery` creeping in here would add
 * a sixth coupled breakpoint gate, which is a code review question, not a test.
 */

const EIGHT = Array.from({ length: 8 }, (_, index) =>
  transcript({ id: `t${index}`, title: `Recording ${index}` }),
);

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('accessRoleLabel', () => {
  it('spells an editor share "Editor"', () => {
    expect(accessRoleLabel('editor')).toBe('Editor');
  });

  it('spells a viewer share "Viewer"', () => {
    expect(accessRoleLabel('viewer')).toBe('Viewer');
  });

  it('spells ownership "Owner"', () => {
    expect(accessRoleLabel('owner')).toBe('Owner');
  });
});

describe('TranscriptSummaryCard', () => {
  it('shows the title', () => {
    render(<TranscriptSummaryCard transcript={transcript()} />);

    expect(screen.getByRole('heading', { name: 'Weekly standup' })).toBeInTheDocument();
  });

  it('shows the relative date, duration and speaker count on one line', () => {
    render(<TranscriptSummaryCard transcript={transcript()} />);

    expect(screen.getByText(/ago · 15 min · 3 speakers/)).toBeInTheDocument();
  });

  it('says "1 speaker" rather than "1 speakers"', () => {
    render(<TranscriptSummaryCard transcript={transcript({ speakerCount: 1 })} />);

    expect(screen.getByText(/1 speaker$/)).toBeInTheDocument();
  });

  it('renders an em dash for an unknown duration', () => {
    render(<TranscriptSummaryCard transcript={transcript({ durationMs: null })} />);

    expect(screen.getByText(/· — ·/)).toBeInTheDocument();
  });

  it('shows the status', () => {
    render(<TranscriptSummaryCard transcript={transcript()} />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('shows a failed transcript as failed', () => {
    render(
      <TranscriptSummaryCard
        transcript={transcript({ status: 'failed', transcriptionStatus: 'failed' })}
      />,
    );

    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('opens the transcript when tapped', async () => {
    const user = userEvent.setup();
    render(<TranscriptSummaryCard transcript={transcript({ id: 'abc' })} />);

    await user.click(screen.getByRole('heading', { name: 'Weekly standup' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/abc');
  });

  it('hides the owner line unless it is asked for', () => {
    render(<TranscriptSummaryCard transcript={transcript()} />);

    expect(screen.queryByText(/shared/i)).not.toBeInTheDocument();
  });

  it('names the owner when the API supplies one', () => {
    render(
      <TranscriptSummaryCard
        transcript={{ ...transcript({ access: 'viewer' }), ownerName: 'Ana Ruiz' }}
        showOwner
      />,
    );

    expect(screen.getByText('Shared by Ana Ruiz')).toBeInTheDocument();
  });

  it('falls back to "Shared with you" when the DTO carries no owner name', () => {
    // `transcriptListItemSchema` has no owner field today — see the type's own
    // note. The fallback must be true, not blank.
    render(<TranscriptSummaryCard transcript={transcript({ access: 'viewer' })} showOwner />);

    expect(screen.getByText('Shared with you')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<TranscriptSummaryCard transcript={transcript()} />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('RecentTranscripts', () => {
  it('renders nothing when there is nothing recent', () => {
    const { container } = render(<RecentTranscripts items={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('heads the section "Recent"', () => {
    render(<RecentTranscripts items={[transcript()]} />);

    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
  });

  it('labels the section region for a screen reader', () => {
    render(<RecentTranscripts items={[transcript()]} />);

    expect(screen.getByRole('region', { name: 'Recent' })).toBeInTheDocument();
  });

  it('renders every item it is given', () => {
    render(<RecentTranscripts items={EIGHT} />);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(8);
  });

  it('renders the items as a real list, not a pile of divs', () => {
    render(<RecentTranscripts items={EIGHT} />);

    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('shows each title', () => {
    render(<RecentTranscripts items={EIGHT} />);

    expect(screen.getByRole('heading', { name: 'Recording 0' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recording 7' })).toBeInTheDocument();
  });

  it('offers a way to see the rest', () => {
    render(<RecentTranscripts items={EIGHT} />);

    expect(screen.getByRole('button', { name: /View all/ })).toBeInTheDocument();
  });

  it('sends "View all" to the transcripts library', async () => {
    const user = userEvent.setup();
    render(<RecentTranscripts items={EIGHT} />);

    await user.click(screen.getByRole('button', { name: /View all/ }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts');
  });

  it('does not chip every row with "Owner"', () => {
    // Eight chips saying the same true-by-definition thing is eight chips
    // carrying no information.
    render(<RecentTranscripts items={EIGHT} />);

    expect(screen.queryByText('Owner')).not.toBeInTheDocument();
  });

  it('opens the transcript a card names', async () => {
    const user = userEvent.setup();
    render(<RecentTranscripts items={EIGHT} />);

    await user.click(screen.getByRole('heading', { name: 'Recording 3' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/t3');
  });

  it('has no accessibility violations with a full list', async () => {
    const { container } = render(<RecentTranscripts items={EIGHT} />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
