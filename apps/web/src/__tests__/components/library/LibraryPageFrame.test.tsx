import { describe, it, expect, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { LibraryPageFrame } from '../../../components/library/LibraryPageFrame';

/**
 * The header `TranscriptsPage` and `NotesPage` share — issue #106.
 *
 * Tested once, here, rather than twice through the two pages that wrap it. The
 * pages' own suites assert that each passes the RIGHT action ("New note" from
 * `/notes`, never "New transcript"); what this file asserts is the behaviour
 * that is identical for both and would otherwise be duplicated: which of the
 * two renderings of that action appears at which width, and that neither
 * appears without the permission.
 *
 * ⚠ THE WIDTH SWITCH IS A PAGE-LEVEL READ, NOT A SHELL GATE. The component's
 * own header says so at length: the five coupled breakpoint gates in
 * `docs/specs/settings-ui.md` §5 stay five, and this `down('sm')` only decides
 * whether one button floats.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const DESKTOP = 1280;
const PHONE = 375;

const ACTION = {
  label: 'New transcript',
  path: '/transcripts/new',
  permission: 'transcripts:write',
};

function renderFrame(user = mockAdminUser, action: typeof ACTION | null = ACTION) {
  return render(
    <LibraryPageFrame title="Transcripts" action={action}>
      <p>view body</p>
    </LibraryPageFrame>,
    { wrapperOptions: { user, route: '/transcripts' } },
  );
}

beforeEach(() => {
  localStorage.setItem('theme_mode', 'light');
  setViewportWidth(DESKTOP);
});

describe('LibraryPageFrame — the heading', () => {
  it('renders the title as the page’s single h1', () => {
    renderFrame();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Transcripts');
  });

  it('renders its children below the heading', () => {
    renderFrame();

    expect(screen.getByText('view body')).toBeInTheDocument();
  });
});

describe('LibraryPageFrame — the create affordance', () => {
  it('shows a header button at desktop width', () => {
    renderFrame();

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeInTheDocument();
  });

  it('shows a FAB instead at phone width', async () => {
    // A floating control on a laptop covers content for no reason; on a phone
    // it is the only way to keep the primary action reachable past the bottom
    // bar. EXACTLY ONE control either way — the two renderings are alternatives,
    // not a header button plus a FAB.
    renderFrame();
    await act(async () => setViewportWidth(PHONE));

    const controls = screen.getAllByRole('button', { name: 'New transcript' });
    expect(controls).toHaveLength(1);
  });

  it('hides it at BOTH widths from a user without the declared permission', async () => {
    // `mockUser` holds only the two `user_settings` permissions. Asserted at
    // both widths rather than one: the gate and the width switch are separate
    // conditions, and a regression that moved the permission check into only
    // one of the two branches would pass a single-width test.
    renderFrame(mockUser);
    expect(screen.queryByRole('button', { name: /new transcript/i })).not.toBeInTheDocument();

    await act(async () => setViewportWidth(PHONE));
    expect(screen.queryByRole('button', { name: /new transcript/i })).not.toBeInTheDocument();
  });

  it('renders no affordance at all when the page declares no action', async () => {
    // `action: null` is the honest way to say "this surface creates nothing".
    // A permitted user must still get no button, which is what distinguishes
    // it from a permission failure.
    renderFrame(mockAdminUser, null);
    expect(screen.queryByRole('button', { name: /new/i })).not.toBeInTheDocument();

    await act(async () => setViewportWidth(PHONE));
    expect(screen.queryByRole('button', { name: /new/i })).not.toBeInTheDocument();
  });
});

describe('LibraryPageFrame — accessibility', () => {
  it('has no axe violations at desktop width', async () => {
    const { container } = renderFrame();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations at phone width, where the FAB is mounted', async () => {
    const { container } = renderFrame();
    await act(async () => setViewportWidth(PHONE));

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
