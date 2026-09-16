import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { render } from '../../utils/test-utils';
import { NoteSummaryCard } from '../../../components/home/NoteSummaryCard';
import { AXE_OPTIONS, note } from './homeFixtures';

/**
 * The home page's note card — issue #107.
 *
 * The responsive behaviour is deliberately NOT asserted here and cannot be: it
 * is pure CSS (the parent's `Grid` sizes) and jsdom performs no layout. What IS
 * asserted is everything a reader has to be able to see without opening the
 * note, plus the two accessibility properties that a copy-paste from
 * `NotesLibraryView` would get wrong — the heading LEVEL (`h3` under a section
 * `h2`, where the library row is an `h2` under the page `h1`) and the source
 * link sitting OUTSIDE the card's action area.
 *
 * Axe runs in BOTH themes: the card is on the app's landing screen in both
 * modes, and a rule like `aria-prohibited-attr` is theme-independent but the
 * markup under a dark palette is not something anybody eyeballs.
 */

/**
 * The theme is chosen the way the app itself chooses it: `ThemeContextProvider`
 * reads `theme_mode` from `localStorage` synchronously in its `useState`
 * initializer, so setting the key before `render` is the whole mechanism. The
 * visual harness does exactly this (`apps/web/visual/main.tsx`).
 */
const THEME_STORAGE_KEY = 'theme_mode';

beforeEach(() => {
  mockNavigate.mockClear();
  localStorage.removeItem(THEME_STORAGE_KEY);
});

describe('NoteSummaryCard', () => {
  it('shows the title', () => {
    render(<NoteSummaryCard note={note()} />);

    expect(screen.getByRole('heading', { name: 'Standup minutes' })).toBeInTheDocument();
  });

  it('heads the title at level 3, under the section’s own h2', () => {
    render(<NoteSummaryCard note={note()} />);

    expect(screen.getByRole('heading', { level: 3, name: 'Standup minutes' })).toBeInTheDocument();
  });

  it('shows the relative date and the template on one line', () => {
    render(<NoteSummaryCard note={note()} />);

    expect(screen.getByText(/ago · Meeting minutes/)).toBeInTheDocument();
  });

  it('omits the separator when the note has no template name', () => {
    render(<NoteSummaryCard note={note({ templateName: null })} />);

    expect(screen.queryByText(/ · /)).not.toBeInTheDocument();
  });

  it('shows the status chip', () => {
    render(<NoteSummaryCard note={note()} />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('shows a failed note as failed', () => {
    render(<NoteSummaryCard note={note({ status: 'failed' })} />);

    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('shows the excerpt of a settled note', () => {
    render(<NoteSummaryCard note={note()} />);

    expect(screen.getByText(/ship the export dialog/)).toBeInTheDocument();
  });

  it('shows a labelled progress bar while the note is generating', () => {
    render(<NoteSummaryCard note={note({ status: 'generating' })} />);

    expect(
      screen.getByRole('progressbar', { name: 'Generating Standup minutes' }),
    ).toBeInTheDocument();
  });

  it('shows the same bar for a draft, which is a queued generation', () => {
    // `draft` is the API's word for "created, never generated even once" — the
    // first moment of a generation, not a document the user is writing.
    render(<NoteSummaryCard note={note({ status: 'draft' })} />);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows no progress bar once the note is ready', () => {
    render(<NoteSummaryCard note={note()} />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('names the source when it has been resolved', () => {
    render(<NoteSummaryCard note={note({ sourceName: 'Weekly standup' })} />);

    expect(screen.getByRole('link', { name: 'Weekly standup' })).toBeInTheDocument();
  });

  it('links the source to the transcript it came from', () => {
    render(<NoteSummaryCard note={note({ sourceName: 'Weekly standup' })} />);

    expect(screen.getByRole('link', { name: 'Weekly standup' })).toHaveAttribute(
      'href',
      '/transcripts/t1',
    );
  });

  it('falls back to the category noun rather than printing a uuid', () => {
    // A uuid where a title should be is worse than the category alone, because
    // it looks like the answer.
    render(<NoteSummaryCard note={note()} />);

    expect(screen.getByRole('link', { name: 'a transcript' })).toBeInTheDocument();
  });

  it('treats a null source name exactly as an absent one', () => {
    render(<NoteSummaryCard note={note()} sourceName={null} />);

    expect(screen.getByRole('link', { name: 'a transcript' })).toBeInTheDocument();
  });

  it('does not link an uploaded document, which has no page', () => {
    render(
      <NoteSummaryCard
        note={note({
          sourceType: 'document',
          sourceTranscriptId: null,
          sourceObjectId: 'obj-1',
          sourceName: 'quarterly.pdf',
        })}
      />,
    );

    expect(screen.getByText('quarterly.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps the source link OUTSIDE the card’s action area', () => {
    // A link inside a button is nested interactive content: axe fails it, and a
    // keyboard user reaches a control their reader called part of a button.
    render(<NoteSummaryCard note={note({ sourceName: 'Weekly standup' })} />);

    const link = screen.getByRole('link', { name: 'Weekly standup' });
    expect(link.closest('a[class*="MuiCardActionArea"]')).toBeNull();
    expect(link.closest('button')).toBeNull();
  });

  it('opens the note when the card is tapped', async () => {
    const user = userEvent.setup();
    render(<NoteSummaryCard note={note({ id: 'n-abc' })} />);

    await user.click(screen.getByRole('heading', { name: 'Standup minutes' }));

    expect(mockNavigate).toHaveBeenCalledWith('/notes/n-abc');
  });

  it('has no accessibility violations in light mode', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { container } = render(<NoteSummaryCard note={note({ sourceName: 'Weekly standup' })} />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no accessibility violations in dark mode', async () => {
    // The generating variant deliberately, so the labelled progressbar — the
    // one element here that adds a role and a name — is covered in both themes.
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { container } = render(
      <NoteSummaryCard note={note({ status: 'generating', sourceName: 'Weekly standup' })} />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
