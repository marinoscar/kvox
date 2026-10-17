/**
 * The shell banner (issue #277, epic #271; on the platform onboarding hooks since #481).
 *
 * `useOnboarding` is mocked: this suite is about WHICH checklist the banner is about, when it
 * says nothing, and what dismissing does, not about the provider's fetch plumbing (the platform
 * tests that).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { render as rtlRender } from '@testing-library/react';

import type { OnboardingResponse, UseOnboardingReturn } from '@marinoscar/platform-web/onboarding/headless';
import { GETTING_STARTED_PATH, SETUP_GUIDE_PATH } from '@marinoscar/platform-web/onboarding/ui';

vi.mock('@marinoscar/platform-web/onboarding/headless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/onboarding/headless')>()),
  useOnboarding: vi.fn(),
}));

import { useOnboarding } from '@marinoscar/platform-web/onboarding/headless';
import {
  BANNER_COPY,
  OnboardingBanner,
  chooseBannerAudience,
  requiredProgress,
} from '../../../components/onboarding/OnboardingBanner';
import { ADMIN_STEPS, USER_STEPS, block, onboardingResponse, step } from './onboardingFixtures';

const mockUseOnboarding = vi.mocked(useOnboarding);

function provide(overrides: Partial<UseOnboardingReturn>): UseOnboardingReturn {
  const value = {
    available: true,
    appName: 'this app',
    state: null,
    isLoading: false,
    isRefreshing: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    markWelcomeSeen: vi.fn().mockResolvedValue(undefined),
    dismissChecklist: vi.fn().mockResolvedValue(undefined),
    dismissAdmin: vi.fn().mockResolvedValue(undefined),
    setSkipped: vi.fn().mockResolvedValue(undefined),
    reopen: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } satisfies UseOnboardingReturn;
  mockUseOnboarding.mockReturnValue(value);
  return value;
}

function renderBanner(path = '/') {
  return rtlRender(
    <MemoryRouter initialEntries={[path]}>
      <OnboardingBanner />
    </MemoryRouter>,
  );
}

describe('OnboardingBanner', () => {
  beforeEach(() => {
    mockUseOnboarding.mockReset();
  });

  describe('chooseBannerAudience', () => {
    it('is null without state', () => {
      expect(chooseBannerAudience(null)).toBeNull();
    });

    it('is null for an answer without settings, rather than throwing', () => {
      // A catch-all that answers `{}` for a path it does not know yields a truthy "state" that is
      // not an `OnboardingResponse`; the shell the banner is mounted in must survive it.
      expect(chooseBannerAudience({} as OnboardingResponse)).toBeNull();
    });

    it('prefers the deployment checklist while it has a required step open', () => {
      const state = onboardingResponse({ user: USER_STEPS, admin: ADMIN_STEPS });
      expect(chooseBannerAudience(state)).toBe('admin');
    });

    it('falls back to the account checklist once the deployment one is dismissed', () => {
      const state = onboardingResponse({
        user: USER_STEPS,
        admin: ADMIN_STEPS,
        settings: { adminDismissedAt: '2026-01-01T00:00:00.000Z' },
      });
      expect(chooseBannerAudience(state)).toBe('user');
    });

    it('is null once every required step is done, even with recommended ones open', () => {
      const state = onboardingResponse({
        user: [step({ id: 'user.ai_key', status: 'done' }), ...USER_STEPS.filter((s) => s.tier !== 'required')],
      });
      expect(chooseBannerAudience(state)).toBeNull();
    });

    it('is null when the account checklist was dismissed', () => {
      const state = onboardingResponse({
        user: USER_STEPS,
        settings: { checklistDismissedAt: '2026-01-01T00:00:00.000Z' },
      });
      expect(chooseBannerAudience(state)).toBeNull();
    });
  });

  describe('requiredProgress', () => {
    it('counts blocked as open and skips the recommended tier', () => {
      expect(requiredProgress(block(USER_STEPS))).toMatchObject({ total: 2, remaining: 2, done: 0, percent: 0 });
      expect(
        requiredProgress(block([step({ id: 'user.ai_key', status: 'done' }), ...USER_STEPS.slice(1)])),
      ).toMatchObject({ total: 2, remaining: 1, done: 1, percent: 50 });
    });
  });

  it('renders nothing while loading, without state, and for a failed read', () => {
    provide({ isLoading: true, state: onboardingResponse({ user: USER_STEPS }) });
    expect(renderBanner().container).toBeEmptyDOMElement();

    provide({ state: null });
    expect(renderBanner().container).toBeEmptyDOMElement();
  });

  it('states how many required steps are left and links to the account checklist', () => {
    provide({ state: onboardingResponse({ user: USER_STEPS }) });
    renderBanner();

    expect(screen.getByRole('heading', { name: '2 of 2 required steps left to finish setting up your account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', GETTING_STARTED_PATH);
    expect(screen.getByRole('progressbar', { name: 'Required setup progress' })).toBeInTheDocument();
  });

  it('is about the deployment for an administrator, and links to the Setup guide', () => {
    provide({ state: onboardingResponse({ user: USER_STEPS, admin: ADMIN_STEPS }) });
    renderBanner();

    expect(screen.getByText(BANNER_COPY.admin.detail)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', SETUP_GUIDE_PATH);
  });

  it('says nothing on the page it links to, or beneath it', () => {
    provide({ state: onboardingResponse({ user: USER_STEPS }) });

    expect(renderBanner(GETTING_STARTED_PATH).container).toBeEmptyDOMElement();
  });

  it('dismisses the account checklist through the platform action and confirms where to find it', async () => {
    const value = provide({ state: onboardingResponse({ user: USER_STEPS }) });
    renderBanner();

    await userEvent.click(screen.getByRole('button', { name: BANNER_COPY.user.dismissLabel }));

    expect(value.dismissChecklist).toHaveBeenCalledTimes(1);
    expect(value.dismissAdmin).not.toHaveBeenCalled();
    expect(await screen.findByText(BANNER_COPY.user.confirmation)).toBeInTheDocument();
  });

  it('dismisses the deployment checklist separately from the account one', async () => {
    const value = provide({ state: onboardingResponse({ user: USER_STEPS, admin: ADMIN_STEPS }) });
    renderBanner();

    await userEvent.click(screen.getByRole('button', { name: BANNER_COPY.admin.dismissLabel }));

    expect(value.dismissAdmin).toHaveBeenCalledTimes(1);
    expect(value.dismissChecklist).not.toHaveBeenCalled();
  });
});
