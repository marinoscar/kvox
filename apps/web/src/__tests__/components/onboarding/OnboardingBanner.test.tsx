/**
 * `OnboardingBanner` — issue #277, epic #271.
 *
 * The banner owns no data: it is a GATE plus some copy. So this file asserts
 * the gate (every state that must render nothing, and the one precedence rule
 * that decides which of two banners a fresh administrator sees), the two things
 * the issue's criteria call out by name (an optimistic dismiss, and a dismiss
 * control whose accessible name says what it dismisses), and the structural
 * promise that the checklist survives dismissal.
 *
 * ⚠ THE LAST ONE IS ASSERTED THROUGH THE SECTION REGISTRIES, NOT BY
 * NAVIGATING. "After dismissing, the checklist is still reachable from both
 * settings hubs" is a claim about `ADMIN_SECTIONS` and `USER_SETTINGS_SECTIONS`
 * — the single declaration the hub, the Console rail and the AppBar title
 * resolver all read. A test that clicked through to the page would prove a
 * route exists and would say nothing about whether any of those three surfaces
 * can find it, which is the half that makes a dismissal recoverable.
 *
 * The provider is stubbed rather than stood up; see `onboardingContext`'s own
 * comment in `onboardingFixtures.ts` for why, and `OnboardingContext.test.tsx`
 * for the wiring this file deliberately does not re-prove.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import type { ReactNode } from 'react';

import { APP_NAME } from '@app/shared';

import { render } from '../../utils/test-utils';
import {
  BANNER_COPY,
  OnboardingBanner,
  chooseBannerAudience,
} from '../../../components/onboarding/OnboardingBanner';
import {
  ADMIN_SETUP_PATH,
  GETTING_STARTED_PATH,
  withSetupReturn,
} from '../../../components/onboarding/onboardingPaths';
import { OnboardingContext } from '../../../contexts/OnboardingContext';
import type { OnboardingContextValue } from '../../../contexts/OnboardingContext';
import { ADMIN_SECTIONS } from '../../../config/adminSections';
import { USER_SETTINGS_SECTIONS } from '../../../config/userSettingsSections';
import { AXE_OPTIONS } from '../home/homeFixtures';
import { adminState, onboardingContext, step, userState } from './onboardingFixtures';

function renderBanner(value: Partial<OnboardingContextValue>, route = '/') {
  const context = onboardingContext(value);
  const view = render(
    <OnboardingContext.Provider value={context}>
      <OnboardingBanner />
    </OnboardingContext.Provider>,
    { wrapperOptions: { route } },
  );
  return { ...view, context };
}

/** Renders the banner with NO provider in the tree at all. */
function renderWithoutProvider(children: ReactNode = <OnboardingBanner />) {
  return render(<>{children}</>);
}

// =============================================================================
// The gate — every state that renders nothing
// =============================================================================

describe('when there is nothing to say', () => {
  it('renders nothing while the first read has not settled', () => {
    // ⚠ A banner that flashes into view for one frame and then vanishes when a
    // stored dismissal arrives is worse than one that appears a beat late, so
    // `isLoading` covers the settings read too (see the context's own header).
    const { container } = renderBanner({ admin: adminState(), isLoading: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when every required step is satisfied', () => {
    const { container } = renderBanner({
      user: userState({
        steps: [
          step({ key: 'user.first_transcript', status: 'satisfied' }),
          step({ key: 'user.profile', tier: 'optional', skippable: true }),
        ],
      }),
    });

    // The optional step is still outstanding, and it is deliberately not
    // enough: a shell banner interrupting every page over an optional step is
    // the front-loaded friction epic #271 exists to avoid.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an audience that has been dismissed', () => {
    const { container } = renderBanner({
      user: userState(),
      dismissed: { user: true, admin: false },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a failed read, which arrives as a null checklist', () => {
    const { container } = renderBanner({ user: null, admin: null, error: 'boom' });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing with no provider mounted, rather than throwing', () => {
    // `useOnboarding` returns null instead of throwing (unlike `useAuth`), so a
    // suite rendering a page on its own gets a missing banner and not a blank
    // application. Asserted here because the cost of that choice is a silent
    // failure, and a positive assertion is the only thing that catches it.
    const { container } = renderWithoutProvider();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on the checklist’s own page', () => {
    // `MaintenanceBanner`'s position, for its reason: that page's whole body is
    // a fuller statement of what this summarises, and a Continue button
    // pointing at the page it is already on reads as a broken control.
    const { container } = renderBanner({ user: userState() }, GETTING_STARTED_PATH);
    expect(container).toBeEmptyDOMElement();
  });
});

// =============================================================================
// ⚠ One banner. The admin one wins.
// =============================================================================

describe('which audience wins', () => {
  it('shows the ADMIN banner to an administrator with both outstanding', () => {
    renderBanner({ user: userState(), admin: adminState() });

    // A deployment that cannot transcribe is blocking everybody; an unset
    // display name is blocking nobody. Two stacked banners above every page
    // would compete for the same action and the same strip of a phone screen.
    expect(
      screen.getByRole('region', { name: BANNER_COPY.admin.landmark }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: BANNER_COPY.user.landmark }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(1);
  });

  it('falls back to the user banner once the admin one is dismissed', () => {
    renderBanner({
      user: userState(),
      admin: adminState(),
      dismissed: { user: false, admin: true },
    });

    expect(
      screen.getByRole('region', { name: BANNER_COPY.user.landmark }),
    ).toBeInTheDocument();
  });

  it('encodes the precedence as a pure rule, not as render order', () => {
    const both = {
      user: userState(),
      admin: adminState(),
      dismissed: { user: false, admin: false },
    };

    expect(chooseBannerAudience(both)).toBe('admin');
    expect(chooseBannerAudience({ ...both, dismissed: { user: false, admin: true } })).toBe(
      'user',
    );
    expect(chooseBannerAudience({ ...both, dismissed: { user: true, admin: true } })).toBeNull();
    // A checklist with nothing REQUIRED left never qualifies, whatever else is
    // outstanding on it.
    expect(
      chooseBannerAudience({
        user: userState({ steps: [step({ status: 'satisfied' })] }),
        admin: null,
        dismissed: { user: false, admin: false },
      }),
    ).toBeNull();
  });
});

// =============================================================================
// What it says
// =============================================================================

describe('the copy', () => {
  it('states how many required steps are left, in words, beside the bar', () => {
    renderBanner({
      user: userState({
        steps: [
          step({ key: 'a', tier: 'required', status: 'satisfied' }),
          step({ key: 'b', tier: 'required' }),
          step({ key: 'c', tier: 'required' }),
        ],
      }),
    });

    // The number is the text, not only the `aria-label`: a bar is not a number.
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: '2 of 3 required steps left to finish setting up your account',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Required setup progress' }),
    ).toBeInTheDocument();
  });

  it('names the application in the admin banner, and counts only required steps', () => {
    // `adminState()` is one required step (`admin.transcription`) plus one
    // RECOMMENDED one (`admin.backup`). Both the numerator and the denominator
    // ignore the second — the sentence is about what is blocking the
    // deployment, not about how long the checklist is — and the noun agrees
    // with the number rather than reading "1 of 1 required steps".
    renderBanner({ admin: adminState() });
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: `1 of 1 required step left to finish setting up ${APP_NAME}`,
      }),
    ).toBeInTheDocument();
  });

  it('points Continue at the checklist for that audience', () => {
    renderBanner({ admin: adminState() });
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      ADMIN_SETUP_PATH,
    );
  });

  it('points Continue at the user checklist for an ordinary account', () => {
    renderBanner({ user: userState() });
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      GETTING_STARTED_PATH,
    );
  });
});

// =============================================================================
// Dismissal
// =============================================================================

describe('dismissing', () => {
  it('names what is being dismissed in the control’s accessible name', async () => {
    // ⚠ NOT a bare "×" and not a bare "Dismiss": two banners can stack in this
    // strip, and "button, Dismiss" announces nothing about which one is going.
    renderBanner({ admin: adminState() });
    expect(
      screen.getByRole('button', { name: BANNER_COPY.admin.dismissLabel }),
    ).toBeInTheDocument();
    expect(BANNER_COPY.admin.dismissLabel).toBe('Dismiss the deployment setup checklist');
    expect(BANNER_COPY.user.dismissLabel).toBe('Dismiss the getting started checklist');
  });

  it('writes the audience’s own field and disappears before the PATCH resolves', async () => {
    const user = userEvent.setup();
    // A dismiss that never settles: if the banner only disappeared once the
    // write landed, this test would hang on the assertion below rather than
    // passing — which is exactly the property being asserted.
    const dismiss = vi.fn(() => new Promise<void>(() => {}));
    renderBanner({ admin: adminState(), dismiss });

    await user.click(screen.getByRole('button', { name: BANNER_COPY.admin.dismissLabel }));

    // The audience, so the provider writes `adminDismissedAt` and not
    // `dismissedAt` — an administrator putting the DEPLOYMENT banner away must
    // not also put their own getting-started checklist away.
    expect(dismiss).toHaveBeenCalledWith('admin');
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: BANNER_COPY.admin.landmark }),
      ).not.toBeInTheDocument(),
    );
  });

  it('says where the checklist lives afterwards', async () => {
    const user = userEvent.setup();
    renderBanner({ user: userState() });

    await user.click(screen.getByRole('button', { name: BANNER_COPY.user.dismissLabel }));

    // ⚠ A dismiss that silently hides the only entry point is a dismiss the
    // user regrets. The confirmation names the destination in prose AND
    // carries a link to it.
    expect(await screen.findByText(BANNER_COPY.user.confirmation)).toBeInTheDocument();
    expect(BANNER_COPY.user.confirmation).toContain('Settings → Getting Started');
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      GETTING_STARTED_PATH,
    );
  });

  it('leaves the checklist reachable from both hubs, per the registries', () => {
    // The structural half of "dismissal is recoverable". Asserted against the
    // ONE declaration the hub, the Console rail and the AppBar title resolver
    // all read — clicking through to the page would prove a route exists and
    // say nothing about whether any of the three can find it.
    const adminCard = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
      (card) => card.path === ADMIN_SETUP_PATH,
    );
    const userCard = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards).find(
      (card) => card.path === GETTING_STARTED_PATH,
    );

    expect(adminCard?.title).toBe('Setup');
    expect(userCard?.title).toBe('Getting Started');
    // The banner links at the same strings the registry declares, so a typo in
    // either fails here rather than sending a click to `App.tsx`'s `*`
    // catch-all and landing the user on the home page with no explanation.
    expect(BANNER_COPY.admin.path).toBe(adminCard?.path);
    expect(BANNER_COPY.user.path).toBe(userCard?.path);
  });
});

// =============================================================================
// The `?setup=` marker the two pages append (#278/#279, read by #280)
// =============================================================================

describe('withSetupReturn', () => {
  it('appends the step key as a query parameter', () => {
    expect(withSetupReturn('/admin/settings/transcription', 'admin.transcription')).toBe(
      '/admin/settings/transcription?setup=admin.transcription',
    );
  });

  it('preserves a query the href already carries', () => {
    // No step declares one today; one that later links to
    // `/admin/settings/users?tab=allowlist` must not have that stripped by the
    // act of being clicked from a checklist.
    expect(withSetupReturn('/admin/settings/users?tab=allowlist', 'admin.access')).toBe(
      '/admin/settings/users?tab=allowlist&setup=admin.access',
    );
  });
});

// =============================================================================
// vitest-axe
// =============================================================================

describe('accessibility', () => {
  it('is clean as the admin banner', async () => {
    const { container } = renderBanner({ user: userState(), admin: adminState() });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean as the user banner', async () => {
    const { container } = renderBanner({ user: userState() });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
