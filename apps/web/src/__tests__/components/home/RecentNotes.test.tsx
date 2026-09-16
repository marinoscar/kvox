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

import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { RecentNotes } from '../../../components/home/RecentNotes';
import { AXE_OPTIONS, note } from './homeFixtures';

/**
 * The home page's "Recent notes" section — issue #107.
 *
 * `useNoteSourceNames` is NOT mocked: it is the one piece of behaviour this
 * component adds beyond laying cards out in a grid, its cache is module-level
 * and would leak between suites, and MSW already answers the lookups it makes.
 * Since #192 the name is on the row (`sourceName`), so there is no client-side
 * cache to reset and no per-source request to observe.
 *
 * The responsive behaviour is deliberately not asserted and cannot be: it is
 * pure CSS (`Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }}`) and jsdom performs
 * no layout, so a column count is only observable in the Playwright baselines.
 * What matters here — that no `useMediaQuery` creeps in and makes a sixth
 * coupled breakpoint gate — is a code-review question, not a test.
 */

const THEME_STORAGE_KEY = 'theme_mode';

const SIX = Array.from({ length: 6 }, (_, index) =>
  note({ id: `n${index}`, title: `Note ${index}` }),
);

beforeEach(() => {
  mockNavigate.mockClear();
  localStorage.removeItem(THEME_STORAGE_KEY);
  server.resetHandlers();
});

describe('RecentNotes — a populated list', () => {
  it('heads the section "Recent notes"', () => {
    render(<RecentNotes items={SIX} total={6} canCreate isLoading={false} />);

    expect(screen.getByRole('heading', { name: 'Recent notes' })).toBeInTheDocument();
  });

  it('labels the section region for a screen reader', () => {
    render(<RecentNotes items={SIX} total={6} canCreate isLoading={false} />);

    expect(screen.getByRole('region', { name: 'Recent notes' })).toBeInTheDocument();
  });

  it('renders every item it is given', () => {
    render(<RecentNotes items={SIX} total={6} canCreate isLoading={false} />);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(6);
  });

  it('renders them as a real list, not a pile of divs', () => {
    render(<RecentNotes items={SIX} total={6} canCreate isLoading={false} />);

    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('shows each title', () => {
    render(<RecentNotes items={SIX} total={6} canCreate isLoading={false} />);

    expect(screen.getByRole('heading', { name: 'Note 0' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Note 5' })).toBeInTheDocument();
  });

  it('shows the status of each row', () => {
    render(<RecentNotes items={SIX} total={6} canCreate isLoading={false} />);

    expect(screen.getAllByText('Ready')).toHaveLength(6);
  });

  it('shows the provenance line on every row', () => {
    // A note's whole premise is that it is DERIVED; a list with no indication
    // of what each came from throws away the fact that makes them trustworthy.
    render(<RecentNotes items={SIX} total={6} canCreate isLoading={false} />);

    expect(screen.getAllByRole('link', { name: 'a transcript' })).toHaveLength(6);
  });

  it('shows a generating note as generating', () => {
    render(
      <RecentNotes
        items={[note({ id: 'g', title: 'Board minutes', status: 'generating' })]}
        total={1}
        canCreate
        isLoading={false}
      />,
    );

    expect(
      screen.getByRole('progressbar', { name: 'Generating Board minutes' }),
    ).toBeInTheDocument();
  });

  it('offers a way to see the rest', () => {
    render(<RecentNotes items={SIX} total={20} canCreate isLoading={false} />);

    expect(screen.getByRole('button', { name: /View all/ })).toBeInTheDocument();
  });

  it('sends "View all" to the notes library', async () => {
    const user = userEvent.setup();
    render(<RecentNotes items={SIX} total={20} canCreate isLoading={false} />);

    await user.click(screen.getByRole('button', { name: /View all/ }));

    expect(mockNavigate).toHaveBeenCalledWith('/notes');
  });

  it('opens the note a card names', async () => {
    const user = userEvent.setup();
    render(<RecentNotes items={SIX} total={6} canCreate isLoading={false} />);

    await user.click(screen.getByRole('heading', { name: 'Note 3' }));

    expect(mockNavigate).toHaveBeenCalledWith('/notes/n3');
  });

  it('has no accessibility violations in light mode', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { container } = render(
      <RecentNotes items={SIX} total={6} canCreate isLoading={false} />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no accessibility violations in dark mode', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { container } = render(
      <RecentNotes items={SIX} total={6} canCreate isLoading={false} />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('RecentNotes — while it is loading', () => {
  it('shows its own skeleton rather than nothing', () => {
    // The page's full-page skeleton is gated on the TRANSCRIPT summary alone —
    // the two requests are parallel, so this section waits for its own answer.
    render(<RecentNotes items={[]} total={0} canCreate isLoading />);

    expect(screen.getByLabelText('Loading your notes')).toBeInTheDocument();
  });

  it('marks the skeleton busy for assistive technology', () => {
    render(<RecentNotes items={[]} total={0} canCreate isLoading />);

    expect(screen.getByLabelText('Loading your notes')).toHaveAttribute('aria-busy', 'true');
  });

  it('still heads the section, so the page does not jump when it lands', () => {
    render(<RecentNotes items={[]} total={0} canCreate isLoading />);

    expect(screen.getByRole('heading', { name: 'Recent notes' })).toBeInTheDocument();
  });

  it('shows no prompt card while the answer is still unknown', () => {
    render(<RecentNotes items={[]} total={0} canCreate isLoading />);

    expect(
      screen.queryByRole('heading', { name: 'Turn a transcript into a note' }),
    ).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<RecentNotes items={[]} total={0} canCreate isLoading />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('RecentNotes — an account with no notes at all', () => {
  it('prompts the user to make one from a transcript they already have', () => {
    render(<RecentNotes items={[]} total={0} canCreate isLoading={false} />);

    expect(
      screen.getByRole('heading', { name: 'Turn a transcript into a note' }),
    ).toBeInTheDocument();
  });

  it('offers the New note button to somebody who may create one', () => {
    render(<RecentNotes items={[]} total={0} canCreate isLoading={false} />);

    expect(screen.getByRole('button', { name: 'New note' })).toBeInTheDocument();
  });

  it('starts the flow from that button', async () => {
    const user = userEvent.setup();
    render(<RecentNotes items={[]} total={0} canCreate isLoading={false} />);

    await user.click(screen.getByRole('button', { name: 'New note' }));

    expect(mockNavigate).toHaveBeenCalledWith('/notes/new');
  });

  it('hides the button from somebody without notes:write', () => {
    render(<RecentNotes items={[]} total={0} canCreate={false} isLoading={false} />);

    expect(screen.queryByRole('button', { name: 'New note' })).not.toBeInTheDocument();
  });

  it('still EXPLAINS the section to them', () => {
    // Hiding the sentence too would leave a user without `notes:write` an
    // unexplained blank where their colleagues see a feature.
    render(<RecentNotes items={[]} total={0} canCreate={false} isLoading={false} />);

    expect(
      screen.getByRole('heading', { name: 'Turn a transcript into a note' }),
    ).toBeInTheDocument();
  });

  it('offers no "View all" into an empty library', () => {
    render(<RecentNotes items={[]} total={0} canCreate isLoading={false} />);

    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument();
  });

  it('has no accessibility violations in light mode', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { container } = render(
      <RecentNotes items={[]} total={0} canCreate isLoading={false} />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no accessibility violations in dark mode', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { container } = render(
      <RecentNotes items={[]} total={0} canCreate={false} isLoading={false} />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('RecentNotes — an empty list that is not an empty account', () => {
  it('renders nothing at all', () => {
    // `total > 0` with an empty `recent` is not a state the API produces, and
    // telling a user with forty notes to make their first one would be worse
    // than showing them nothing.
    const { container } = render(
      <RecentNotes items={[]} total={40} canCreate isLoading={false} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
