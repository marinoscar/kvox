/**
 * `SetupPage` (`/admin/settings/setup`) — issue #278, epic #271.
 *
 * Three things this page is responsible for, and the file is organised as
 * those three:
 *
 *  1. THE REGISTRY CONTRACT. The card is first in `General`, gated on the exact
 *     string the controller enforces, and routed. Asserted against the real
 *     `ADMIN_SECTIONS` and the live `App.tsx`, never against a copy — a card
 *     without a route sends a click to the `*` catch-all, and a route without a
 *     card is a page the hub, the Console rail and the AppBar title resolver
 *     are all blind to.
 *  2. WHERE A STEP'S ACTION GOES. `?setup=<stepKey>` is appended by this page,
 *     and #280's return bar reads it on the far side. A step navigated to
 *     without the marker is a user who cannot get back.
 *  3. THE ONE INLINE CONTROL. The invite exists only with `allowlist:write`,
 *     posts through the existing endpoint, and re-reads the checklist so
 *     `admin.access` flips without a reload.
 *
 * The provider is stubbed; see `onboardingContext`'s comment in
 * `onboardingFixtures.ts`. `addToAllowlist` is mocked at the service boundary
 * rather than over MSW because what is under test is that THIS page calls the
 * existing function once with what the dialog collected — not the transport,
 * which `services/api` owns and its own suites cover.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api')>(
    '../../../services/api',
  );
  return { ...actual, addToAllowlist: vi.fn().mockResolvedValue({ id: 'ae-1' }) };
});

import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import SetupPage, {
  INVITE_PERMISSION,
  PAGE_DESCRIPTION,
  PAGE_TITLE,
  withoutRequiredSteps,
} from '../../../pages/Admin/SetupPage';
import { ADMIN_SETUP_PATH } from '../../../components/onboarding/onboardingPaths';
import { OnboardingContext } from '../../../contexts/OnboardingContext';
import type { OnboardingContextValue } from '../../../contexts/OnboardingContext';
import {
  ADMIN_HUB_PATH,
  ADMIN_HUB_TITLE,
  ADMIN_SECTIONS,
  settingsPageTitle,
} from '../../../config/adminSections';
import { addToAllowlist } from '../../../services/api';
import { AXE_OPTIONS } from '../../components/home/homeFixtures';
import { adminState, onboardingContext, step } from '../../components/onboarding/onboardingFixtures';

const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../../App.tsx');

const mockAddToAllowlist = vi.mocked(addToAllowlist);

function renderPage(
  value: Partial<OnboardingContextValue> = {},
  user: MockUser = mockAdminUser,
) {
  const context = onboardingContext({ admin: adminState(), ...value });
  const view = render(
    <OnboardingContext.Provider value={context}>
      <SetupPage />
    </OnboardingContext.Provider>,
    { wrapperOptions: { user } },
  );
  return { ...view, context };
}

/** The same admin, minus the one permission the inline invite needs. */
const adminWithoutInvite: MockUser = {
  ...mockAdminUser,
  permissions: mockAdminUser.permissions.filter((p) => p !== INVITE_PERMISSION),
};

beforeEach(() => {
  mockNavigate.mockClear();
  mockAddToAllowlist.mockClear();
});

// =============================================================================
// 1. The registry contract
// =============================================================================

describe('the Setup card (#278)', () => {
  const general = ADMIN_SECTIONS.find((section) => section.label === 'General');
  const card = general?.cards[0];

  it('is the FIRST card in General', () => {
    // First in the group, and General is the first group, so it is the first
    // thing in the hub on a fresh install — which is the entire point: a hub
    // is the right shape for an operator who knows what they came for, and the
    // wrong one for somebody on minute one.
    expect(card?.title).toBe('Setup');
    expect(ADMIN_SECTIONS[0].label).toBe('General');
  });

  it('routes to /admin/settings/setup', () => {
    expect(card?.path).toBe(ADMIN_SETUP_PATH);
  });

  it('declares the exact permission the admin onboarding controller enforces', () => {
    // `system_settings:read` — #275 reused the settings pair rather than
    // minting `onboarding:read`, following epic #118 decision 8's precedent
    // for the About card. The registry never invents a permission.
    expect(card?.permission).toBe('system_settings:read');
  });

  it('is not an alwaysShow escape hatch — the gate must be able to deny it', () => {
    expect(card?.alwaysShow).toBeUndefined();
    expect(card?.disabled).toBeUndefined();
  });

  it('is wrapped in RequirePermission on the same string, in the live App.tsx', () => {
    // Read from the file rather than the imported tree, the discipline
    // `destinations.test.ts` established: this is what a reviewer actually
    // reads, and a card whose route gate differs from its own permission is
    // the split-brain in miniature — the card appears, the click redirects.
    const source = readFileSync(APP_TSX, 'utf8');
    const chunk = source
      .split('<Route')
      .slice(1)
      .find((entry) => /^\s*path="\/admin\/settings\/setup"/.test(entry));

    expect(chunk, '/admin/settings/setup has no route in App.tsx').toBeDefined();
    expect(/permission="([^"]+)"/.exec(chunk!)?.[1]).toBe('system_settings:read');
  });

  it('resolves the AppBar title through settingsPageTitle, with no drill-down entry', () => {
    // The card IS the title source. Nothing was added to `DRILL_DOWN_ROUTES`,
    // and nothing needed to be: a registry card buys the hub tile, the rail row
    // and this title from one declaration.
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, ADMIN_SETUP_PATH),
    ).toBe('Setup');
  });

  it('names the page identically to the card', () => {
    expect(PAGE_TITLE).toBe(card?.title);
    expect(PAGE_DESCRIPTION).toBe(card?.description);
  });
});

// =============================================================================
// The page body
// =============================================================================

describe('the page', () => {
  it('renders the checklist and refreshes on mount', async () => {
    const { context } = renderPage();

    expect(screen.getByRole('heading', { level: 1, name: PAGE_TITLE })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Setup steps' })).toBeInTheDocument();
    expect(screen.getByText('Configure transcription')).toBeInTheDocument();
    // An administrator arrives here straight from the page that satisfied a
    // step; a checklist showing the state from before they went is one that
    // makes them doubt what they just did.
    await waitFor(() => expect(context.refresh).toHaveBeenCalled());
  });

  it('states that AI provider keys are per user and that this deployment stores none', () => {
    renderPage();

    // ⚠ The fact an administrator will otherwise hunt the settings pages for.
    // `ai-settings.schema.ts` carries a compile-time proof that no
    // secret-bearing field can enter the AI settings document, so "the field is
    // missing" is indistinguishable from "the page is broken" unless the page
    // says otherwise.
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'AI keys belong to each user, not to this deployment',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/holds no API key/i)).toBeInTheDocument();
    expect(screen.getByText(/billed to their own provider account/i)).toBeInTheDocument();
  });

  it('says what the required steps unlock while any remain', () => {
    renderPage();
    expect(screen.getByText(/nobody here can turn a recording into a transcript/i)).toBeInTheDocument();
  });

  it('shows a ready panel and still lists the recommended steps once required work is done', () => {
    renderPage({
      admin: adminState({
        steps: [
          step({ key: 'admin.transcription', title: 'Configure transcription', status: 'satisfied' }),
          step({
            key: 'admin.backup',
            tier: 'recommended',
            title: 'Schedule a database backup',
            actionLabel: 'Set up backups',
            href: '/admin/settings/db-backup',
            skippable: true,
          }),
        ],
      }),
    });

    expect(screen.getByText('This deployment is ready')).toBeInTheDocument();
    // The list is not replaced by the panel — it is FILTERED. A satisfied
    // required step has nothing left to say; a recommended one still does.
    expect(screen.getByText('Schedule a database backup')).toBeInTheDocument();
    expect(screen.queryByText('Configure transcription')).not.toBeInTheDocument();
  });

  it('recomputes the filtered view’s counts rather than passing the originals through', () => {
    // `SetupChecklist` draws a progress bar over the rows it is given, so
    // handing it two fewer rows and the original `totalRemaining` would draw a
    // bar that disagrees with the list directly beneath it.
    const filtered = withoutRequiredSteps(
      adminState({
        steps: [
          step({ key: 'a', tier: 'required', status: 'satisfied' }),
          step({ key: 'b', tier: 'recommended' }),
          step({ key: 'c', tier: 'optional', skippable: true, skipped: true }),
        ],
      }),
    );

    expect(filtered.steps.map((s) => s.key)).toEqual(['b', 'c']);
    expect(filtered.totalRemaining).toBe(1);
    expect(filtered.requiredRemaining).toBe(0);
    expect(filtered.allRequiredSatisfied).toBe(true);
  });

  it('renders the error with a retry when the read failed outright', () => {
    renderPage({ admin: null, error: 'Failed to load setup state' });
    // A PAGE may say a read failed; the shell banner may not — see
    // `OnboardingContext`'s header for the split.
    expect(screen.getByText('Failed to load setup state')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

// =============================================================================
// 2. Where a step's action goes
// =============================================================================

describe('a step’s action', () => {
  it('navigates to the step’s href with ?setup=<stepKey> appended', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Configure' }));

    // ⚠ The marker says where the user came FROM, which is a property of this
    // navigation and not of the step — #280's return bar reads it on the far
    // side. Baking it into the registry `href` would put it on every link the
    // hub and the rail also draw.
    expect(mockNavigate).toHaveBeenCalledWith(
      '/admin/settings/transcription?setup=admin.transcription',
    );
  });
});

// =============================================================================
// 3. The one inline control
// =============================================================================

describe('the inline invite', () => {
  it('is absent for an administrator without allowlist:write', () => {
    renderPage({}, adminWithoutInvite);

    // A button that leads to a 403 is worse than no button.
    expect(screen.queryByRole('button', { name: 'Invite by email' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Invite someone' })).not.toBeInTheDocument();
  });

  it('creates the entry through the existing endpoint, then refreshes the checklist', async () => {
    const user = userEvent.setup();
    const { context } = renderPage();

    await user.click(screen.getByRole('button', { name: 'Invite by email' }));
    await user.type(screen.getByLabelText(/Email Address/i), 'ana@example.com');
    await user.click(screen.getByRole('button', { name: 'Add Email' }));

    await waitFor(() =>
      expect(mockAddToAllowlist).toHaveBeenCalledWith('ana@example.com', undefined),
    );
    // `refresh()` is what makes `admin.access` flip without a reload — the
    // checklist is derived on every read and has no other way to learn.
    await waitFor(() => expect(context.refresh).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('ana@example.com can now sign in.')).toBeInTheDocument();
  });

  it('reuses AddEmailDialog unchanged, including its own validation', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Invite by email' }));
    // ⚠ `ana@example` AND NOT `not-an-email`, deliberately. The field is
    // `type="email"`, so a string with no `@` at all is rejected by the
    // browser's own constraint validation and the form never submits — which
    // would make this test pass for a reason that has nothing to do with the
    // dialog. A missing TLD is valid to the browser and invalid to the
    // dialog's own regex, so it is the input that actually exercises the
    // dialog's check.
    await user.type(screen.getByLabelText(/Email Address/i), 'ana@example');
    await user.click(screen.getByRole('button', { name: 'Add Email' }));

    // The dialog's own message, not a second implementation of the check: this
    // page mounts `components/admin/AddEmailDialog.tsx` as-is, the same
    // component `AllowlistTable` mounts.
    expect(await screen.findByText('Please enter a valid email address')).toBeInTheDocument();
    expect(mockAddToAllowlist).not.toHaveBeenCalled();
  });
});

// =============================================================================
// vitest-axe
// =============================================================================

describe('accessibility', () => {
  it('is clean with an outstanding checklist', async () => {
    const { container } = renderPage();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean in the ready state', async () => {
    const { container } = renderPage({
      admin: adminState({
        steps: [step({ key: 'admin.transcription', status: 'satisfied' })],
      }),
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
