/**
 * `ReturnToSetupBar` — issue #280, epic #271.
 *
 * Two things are worth testing here and they pull in opposite directions.
 *
 * ⚠ THE FIRST IS SILENCE. `?setup=` is in the URL, so it is user-controllable
 * input, and the bar must render NOTHING for a key it does not recognise — an
 * invented one, a malformed one, or one belonging to a checklist this caller
 * does not hold. Those are asserted as their own block, and against
 * `findSetupStep` directly as well as through the DOM, because "renders
 * nothing" is a property of the lookup rather than of markup that never gets
 * rendered.
 *
 * The second is the thread back out: the step is named, `Back to setup` goes to
 * the hub the step's OWN `audience` implies, `refresh()` is called on arrival
 * so the status is current rather than whatever was cached when the user left,
 * and `Next step` appears once the named step flips to `satisfied`.
 *
 * The provider is stubbed; see `onboardingFixtures.ts` and
 * `OnboardingContext.test.tsx`.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import {
  ReturnToSetupBar,
  findSetupStep,
  nextOutstandingStep,
} from '../../../components/onboarding/ReturnToSetupBar';
import {
  ADMIN_SETUP_PATH,
  GETTING_STARTED_PATH,
  SETUP_RETURN_PARAM,
  withSetupReturn,
} from '../../../components/onboarding/onboardingPaths';
import { OnboardingContext } from '../../../contexts/OnboardingContext';
import type { OnboardingContextValue } from '../../../contexts/OnboardingContext';
import { AXE_OPTIONS } from '../home/homeFixtures';
import { adminState, onboardingContext, onboardingState, step, userState } from './onboardingFixtures';

/**
 * Renders the bar at `/settings/ai?setup=<key>` by default — a real step's real
 * destination, marked exactly as `withSetupReturn` marks it.
 */
function renderBar(
  value: Partial<OnboardingContextValue> = {},
  route = `/settings/ai?${SETUP_RETURN_PARAM}=user.ai_key`,
) {
  const context = onboardingContext(value);
  const view = render(
    <OnboardingContext.Provider value={context}>
      <ReturnToSetupBar />
    </OnboardingContext.Provider>,
    { wrapperOptions: { route } },
  );
  return { ...view, context };
}

/** The caller's own checklist, with an `user.ai_key` row this suite can move. */
function userWithAiKey(status: 'pending' | 'satisfied' = 'pending') {
  return userState({
    steps: [
      step({
        key: 'user.ai_key',
        tier: 'required',
        title: 'Connect your AI provider key',
        description: 'Notes are generated with your own provider account.',
        actionLabel: 'Connect a key',
        href: '/settings/ai',
        status,
      }),
      step({
        key: 'user.profile',
        tier: 'optional',
        title: 'Set your display name and picture',
        actionLabel: 'Edit profile',
        href: '/settings/profile',
        skippable: true,
      }),
    ],
  });
}

// =============================================================================
// ⚠ SILENCE IS THE DEFAULT
// =============================================================================

describe('an unrecognised ?setup= value', () => {
  it('renders nothing with no marker at all', () => {
    const { container } = renderBar({ user: userWithAiKey() }, '/settings/ai');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a key that names no step', () => {
    // The ordinary hostile case: somebody typed something into the URL.
    const { container } = renderBar(
      { user: userWithAiKey() },
      `/settings/ai?${SETUP_RETURN_PARAM}=not.a.real.step`,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a malformed value, and never echoes it', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = renderBar(
      { user: userWithAiKey() },
      `/settings/ai?${SETUP_RETURN_PARAM}=${encodeURIComponent(hostile)}`,
    );

    expect(container).toBeEmptyDOMElement();
    // ⚠ The stronger claim behind the empty render: nothing this bar displays
    // ever comes from the URL. Every string it shows is looked up out of the
    // checklist the SERVER returned, so there is no escaping rule for a later
    // change to forget.
    expect(document.body.innerHTML).not.toContain('onerror');
  });

  it("renders nothing for another audience's step", () => {
    // An ordinary user hand-typing an admin step key. The provider never
    // fetched the admin checklist for them (it is gated on
    // `system_settings:read`), so there is no state for the lookup to find it
    // in — the silence is structural rather than a filter that could be
    // dropped.
    const { container } = renderBar(
      { user: userWithAiKey(), admin: null },
      `/settings/ai?${SETUP_RETURN_PARAM}=admin.transcription`,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the first read has settled', () => {
    const { container } = renderBar({ user: userWithAiKey(), isLoading: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing with no provider in the tree at all', () => {
    const { container } = render(<ReturnToSetupBar />, {
      wrapperOptions: { route: `/settings/ai?${SETUP_RETURN_PARAM}=user.ai_key` },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on the hub the step belongs to', () => {
    // A "Back to setup" button pointing at the page it is already on reads as
    // a broken control — `OnboardingBanner` suppresses itself on the same
    // grounds. Only reachable by hand-editing the URL.
    const { container } = renderBar(
      { user: userWithAiKey() },
      `${GETTING_STARTED_PATH}?${SETUP_RETURN_PARAM}=user.ai_key`,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

// =============================================================================
// The lookup itself
// =============================================================================

describe('findSetupStep', () => {
  it('takes the audience from the state the step was found in, never from the key', () => {
    // ⚠ Parsing `admin.` off the front of the key would work today and would
    // be a SECOND source of truth about which checklist a step belongs to.
    // Here the key is deliberately unprefixed and the answer is still right.
    const state = onboardingState({
      audience: 'admin',
      steps: [step({ key: 'transcription', title: 'Configure transcription' })],
    });

    const match = findSetupStep({ user: null, admin: state }, 'transcription');
    expect(match?.hubPath).toBe(ADMIN_SETUP_PATH);
  });

  it('resolves a user step to the getting-started hub', () => {
    const match = findSetupStep({ user: userWithAiKey(), admin: null }, 'user.ai_key');
    expect(match?.hubPath).toBe(GETTING_STARTED_PATH);
    expect(match?.step.title).toBe('Connect your AI provider key');
  });

  it('answers null for a null key, an unknown key, and an empty checklist', () => {
    const state = userWithAiKey();
    expect(findSetupStep({ user: state, admin: null }, null)).toBeNull();
    expect(findSetupStep({ user: state, admin: null }, 'nope')).toBeNull();
    expect(findSetupStep({ user: null, admin: null }, 'user.ai_key')).toBeNull();
  });
});

describe('nextOutstandingStep', () => {
  it('offers the next step still outstanding, not merely the next index', () => {
    // A user who did the third item first would be offered nothing at all by
    // an index-based rule — and they are exactly the person the link is for.
    const state = onboardingState({
      steps: [
        step({ key: 'a', status: 'pending' }),
        step({ key: 'b', status: 'satisfied' }),
        step({ key: 'c', status: 'pending' }),
      ],
    });

    expect(nextOutstandingStep(state, 'c')?.key).toBe('a');
  });

  it('never offers a blocked or a skipped step', () => {
    // `blocked` means somebody ELSE has to act first, so offering it as the
    // next thing to do sends the user to a disabled button; `skipped` is a
    // decision they already made.
    const state = onboardingState({
      steps: [
        step({ key: 'done', status: 'satisfied' }),
        step({ key: 'blocked', status: 'blocked', blockedReason: 'Ask your administrator.' }),
        step({ key: 'skipped', tier: 'optional', skippable: true, skipped: true }),
      ],
    });

    expect(nextOutstandingStep(state, 'done')).toBeNull();
  });
});

// =============================================================================
// The thread back out
// =============================================================================

describe('on a recognised step', () => {
  it('names the step in progress and links back to its own hub', () => {
    renderBar({ user: userWithAiKey() });

    expect(screen.getByText('Setting up:')).toBeInTheDocument();
    expect(screen.getByText('Connect your AI provider key')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to setup/ })).toHaveAttribute(
      'href',
      GETTING_STARTED_PATH,
    );
  });

  it('sends an administrator back to the deployment hub instead', () => {
    renderBar(
      { admin: adminState() },
      `/admin/settings/transcription?${SETUP_RETURN_PARAM}=admin.transcription`,
    );

    expect(screen.getByText('Configure transcription')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to setup/ })).toHaveAttribute(
      'href',
      ADMIN_SETUP_PATH,
    );
  });

  it('calls refresh() on arrival, because the cached status predates the visit', async () => {
    // The state cached when the user LEFT says the step is not done; it was
    // fetched before they went and did it.
    const { context } = renderBar({ user: userWithAiKey() });
    await waitFor(() => expect(context.refresh).toHaveBeenCalled());
  });

  it('does NOT refresh on a page with no marker', async () => {
    // ⚠ The shell mounts this on every page for the whole session. An
    // unconditional mount effect would fire a second copy of the provider's
    // own first read on every page load, for every user, most of whom will
    // never see this bar.
    const { context } = renderBar({ user: userWithAiKey() }, '/settings/ai');
    await waitFor(() => expect(screen.queryByText('Setting up:')).not.toBeInTheDocument());
    expect(context.refresh).not.toHaveBeenCalled();
  });

  it('offers no Next step while the named step is still outstanding', () => {
    renderBar({ user: userWithAiKey('pending') });
    expect(screen.queryByRole('link', { name: /Next step/ })).not.toBeInTheDocument();
  });

  it('offers Next step once the named step flips to satisfied, carrying the marker onward', () => {
    renderBar({ user: userWithAiKey('satisfied') });

    expect(screen.getByText('Done:')).toBeInTheDocument();

    // Named, because "Next step" alone announces identically on every page this
    // bar ever appears on.
    const next = screen.getByRole('link', {
      name: 'Next step: Set your display name and picture',
    });
    // ⚠ THE MARKER TRAVELS. Without it the bar vanishes on the next
    // destination, and the thread back out is cut at the second step.
    expect(next).toHaveAttribute('href', withSetupReturn('/settings/profile', 'user.profile'));
  });

  it('offers no Next step when the satisfied one was the last outstanding', () => {
    renderBar({
      user: userState({
        steps: [step({ key: 'user.ai_key', href: '/settings/ai', status: 'satisfied' })],
      }),
    });

    expect(screen.getByText('Done:')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Next step/ })).not.toBeInTheDocument();
  });
});

// =============================================================================
// vitest-axe
// =============================================================================

describe('accessibility', () => {
  it('is a named landmark rather than an unannounced slab above the page', () => {
    renderBar({ user: userWithAiKey() });
    expect(screen.getByRole('region', { name: 'Setup in progress' })).toBeInTheDocument();
  });

  it('is clean mid-step', async () => {
    const { container } = renderBar({ user: userWithAiKey('pending') });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean once the step is satisfied and Next step appears', async () => {
    const { container } = renderBar({ user: userWithAiKey('satisfied') });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
