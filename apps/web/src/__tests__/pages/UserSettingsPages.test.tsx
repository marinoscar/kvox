/**
 * The routed `/settings/*` pages introduced by issue #96, epic #90.
 *
 * PORTED, NOT NEW. `UserSettingsPage.test.tsx` was deleted with the stacked
 * page it covered; the cases below are the ones from that file that still
 * describe live behaviour, re-pointed at the pages that now own it — the
 * loading spinner, the fetch-error alert, and each page's title and
 * description. Everything else in the old file asserted `expect(fn)
 * .toBeDefined()` on a mock, or re-asserted `getByText(/settings/i)` under a
 * `describe` block whose name promised something it never checked; those are
 * dropped rather than carried forward, and `testing-dev` owns the real
 * behavioural coverage this split calls for.
 *
 * `ThemeSettings` and `ProfileSettings` are stubbed: both already have their
 * own test files, and the pages under test here are thin wiring. The stubs
 * expose `disabled` as text and a button that fires the save callback, because
 * a prop is only meaningfully "wired" if something can observe it arriving.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils/test-utils';

vi.mock('../../hooks/useUserSettings', () => ({
  useUserSettings: vi.fn(),
}));

vi.mock('../../components/settings/ThemeSettings', () => ({
  ThemeSettings: vi.fn(({ currentTheme, onThemeChange, disabled }) => (
    <div data-testid="theme-settings">
      <span>theme:{currentTheme}</span>
      <span>disabled:{String(disabled)}</span>
      <button onClick={() => onThemeChange('dark')}>save-theme</button>
    </div>
  )),
}));

vi.mock('../../components/settings/ProfileSettings', () => ({
  ProfileSettings: vi.fn(({ profile, onSave, onSettingsReplaced, disabled }) => (
    <div data-testid="profile-settings">
      <span>name:{profile.displayName ?? ''}</span>
      <span>disabled:{String(disabled)}</span>
      <button onClick={() => onSave({ displayName: 'New', imageSource: 'provider' })}>
        save-profile
      </button>
      <button
        onClick={() =>
          onSettingsReplaced?.(
            {
              theme: 'system',
              profile: { imageSource: 'upload', imageObjectId: 'obj-1' },
              updatedAt: new Date().toISOString(),
              version: 2,
            },
            'Profile picture updated',
          )
        }
      >
        replace-settings
      </button>
    </div>
  )),
}));

// `PersonalAccessTokens` owns its own hook and API calls (`/api/pat`), none
// of which this file's mocked `useUserSettings` should ever gate — see
// `UserTokensPage` below. Stubbed for the same reason `ThemeSettings` and
// `ProfileSettings` are: it has its own test file, and the page under test
// here is thin wiring.
vi.mock('../../components/settings/PersonalAccessTokens', () => ({
  PersonalAccessTokens: vi.fn(() => <div data-testid="personal-access-tokens" />),
}));

import { useUserSettings } from '../../hooks/useUserSettings';
import UserProfilePage from '../../pages/UserProfilePage';
import UserAppearancePage from '../../pages/UserAppearancePage';
import UserTokensPage from '../../pages/UserTokensPage';

const mockUseUserSettings = vi.mocked(useUserSettings);

function mockSettings(overrides: Partial<ReturnType<typeof useUserSettings>> = {}) {
  mockUseUserSettings.mockReturnValue({
    settings: {
      theme: 'system',
      profile: {
        displayName: undefined,
        imageSource: 'provider',
        imageObjectId: undefined,
      },
      updatedAt: new Date().toISOString(),
      version: 1,
    },
    isLoading: false,
    error: null,
    isSaving: false,
    updateSettings: vi.fn().mockResolvedValue(undefined),
    updateTheme: vi.fn().mockResolvedValue(undefined),
    updateProfile: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    replaceSettings: vi.fn(),
    ...overrides,
  });
}

describe('UserSettingsSection chrome (ported from UserSettingsPage.test.tsx)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings();
  });

  it('shows a loading spinner while fetching settings', () => {
    mockSettings({ settings: null, isLoading: true });

    render(<UserAppearancePage />);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('displays the fetch error when the settings request failed', () => {
    mockSettings({ settings: null, error: 'Failed to load settings' });

    render(<UserAppearancePage />);

    expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
  });

  it('passes isSaving through to the section component as disabled', () => {
    mockSettings({ isSaving: true });

    render(<UserProfilePage />);

    expect(screen.getByText('disabled:true')).toBeInTheDocument();
  });
});

describe('UserAppearancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings();
  });

  it('displays its title and description', () => {
    render(<UserAppearancePage />);

    expect(screen.getByRole('heading', { name: /appearance/i })).toBeInTheDocument();
    expect(
      screen.getByText(/choose a light, dark, or system-matched theme/i),
    ).toBeInTheDocument();
  });

  it('renders ThemeSettings with the current theme', () => {
    render(<UserAppearancePage />);

    expect(screen.getByTestId('theme-settings')).toBeInTheDocument();
    expect(screen.getByText('theme:system')).toBeInTheDocument();
  });
});

describe('UserProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings();
  });

  it('displays its title and description', () => {
    render(<UserProfilePage />);

    expect(screen.getByRole('heading', { name: /profile/i })).toBeInTheDocument();
    expect(screen.getByText(/your display name and profile image/i)).toBeInTheDocument();
  });

  it('renders ProfileSettings, and not the appearance section', () => {
    render(<UserProfilePage />);

    expect(screen.getByTestId('profile-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-settings')).not.toBeInTheDocument();
  });
});

/**
 * The behaviour issue #96 changed and the one most likely to regress: on the
 * old stacked `UserSettingsPage` there was ONE snackbar shared by Theme,
 * Profile and Tokens, so a successful theme save raised a toast that sat
 * beside the Profile card too. Each split page now owns its own
 * `UserSettingsSection`, hence its own `useState` for the success/error
 * message — so these are exercised through the real `save()` in
 * `UserSettingsSection`, not the mocked `ThemeSettings`/`ProfileSettings`
 * stubs' own state.
 */
describe('Per-page save snackbars (issue #96)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('UserProfilePage', () => {
    it('shows "Profile updated" on a successful save', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockSettings({ updateSettings });

      render(<UserProfilePage />);
      screen.getByText('save-profile').click();

      await waitFor(() => {
        expect(screen.getByText('Profile updated')).toBeInTheDocument();
      });
      expect(updateSettings).toHaveBeenCalledWith({
        profile: { displayName: 'New', imageSource: 'provider' },
      });
    });

    it('shows the rejection message, not the success message, on a failed save', async () => {
      const updateSettings = vi.fn().mockRejectedValue(new Error('Network error'));
      mockSettings({ updateSettings });

      render(<UserProfilePage />);
      screen.getByText('save-profile').click();

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
      expect(screen.queryByText('Profile updated')).not.toBeInTheDocument();
    });

    /**
     * #367. The profile-image upload/delete responses adopt a settings
     * document through `replaceSettings` rather than `updateSettings`/PATCH —
     * see `UserSettingsSection.replaceSettings`. This exercises the REAL
     * `replaceSettings` wired in `UserSettingsSection`, via the mocked
     * `ProfileSettings`'s `onSettingsReplaced` callback.
     */
    it('adopts a settings document via replaceSettings and shows its success message', async () => {
      const replaceSettings = vi.fn();
      mockSettings({ replaceSettings });

      render(<UserProfilePage />);
      screen.getByText('replace-settings').click();

      await waitFor(() => {
        expect(screen.getByText('Profile picture updated')).toBeInTheDocument();
      });
      // replaceSettings adopts the document directly — it must never go
      // through updateSettings (no PATCH, no If-Match version to send).
      expect(replaceSettings).toHaveBeenCalledWith({
        theme: 'system',
        profile: { imageSource: 'upload', imageObjectId: 'obj-1' },
        updatedAt: expect.any(String),
        version: 2,
      });
    });

    it('falls back to "Failed to update profile" when the rejection carries no message', async () => {
      const updateSettings = vi.fn().mockRejectedValue('not an Error instance');
      mockSettings({ updateSettings });

      render(<UserProfilePage />);
      screen.getByText('save-profile').click();

      await waitFor(() => {
        expect(screen.getByText('Failed to update profile')).toBeInTheDocument();
      });
      expect(screen.queryByText('Profile updated')).not.toBeInTheDocument();
    });
  });

  describe('UserAppearancePage', () => {
    it('shows "Theme updated" on a successful theme change', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockSettings({ updateSettings });

      render(<UserAppearancePage />);
      screen.getByText('save-theme').click();

      await waitFor(() => {
        expect(screen.getByText('Theme updated')).toBeInTheDocument();
      });
      expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' });
    });

    it('shows the rejection message, not the success message, on a failed theme change', async () => {
      const updateSettings = vi.fn().mockRejectedValue(new Error('Network error'));
      mockSettings({ updateSettings });

      render(<UserAppearancePage />);
      screen.getByText('save-theme').click();

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
      expect(screen.queryByText('Theme updated')).not.toBeInTheDocument();
    });

    it('falls back to "Failed to update theme" when the rejection carries no message', async () => {
      const updateSettings = vi.fn().mockRejectedValue('not an Error instance');
      mockSettings({ updateSettings });

      render(<UserAppearancePage />);
      screen.getByText('save-theme').click();

      await waitFor(() => {
        expect(screen.getByText('Failed to update theme')).toBeInTheDocument();
      });
      expect(screen.queryByText('Theme updated')).not.toBeInTheDocument();
    });
  });

  /**
   * The regression these pin: collapsing the two pages' `UserSettingsSection`
   * mounts back into one shared instance (the way the deleted stacked page
   * had exactly one). Both pages are mounted TOGETHER here — something that
   * never happens through routing, but is the only way to prove their
   * snackbar state doesn't secretly live in one shared place. Each page keeps
   * its own local `useState`, so triggering a save on one must never surface
   * a message anywhere near the other.
   */
  describe('Isolation: a snackbar raised on one page does not appear on another', () => {
    it('a Profile save shows its snackbar only on the Profile page, not the Appearance page', async () => {
      mockSettings();
      render(
        <>
          <UserProfilePage />
          <UserAppearancePage />
        </>,
      );

      screen.getByText('save-profile').click();

      await waitFor(() => {
        expect(screen.getByText('Profile updated')).toBeInTheDocument();
      });
      expect(screen.queryByText('Theme updated')).not.toBeInTheDocument();
    });

    it('a theme change shows its snackbar only on the Appearance page, not the Profile page', async () => {
      mockSettings();
      render(
        <>
          <UserProfilePage />
          <UserAppearancePage />
        </>,
      );

      screen.getByText('save-theme').click();

      await waitFor(() => {
        expect(screen.getByText('Theme updated')).toBeInTheDocument();
      });
      expect(screen.queryByText('Profile updated')).not.toBeInTheDocument();
    });
  });
});

/**
 * Issue #96. `UserTokensPage` is the one `/settings/*` page that does NOT
 * wrap its content in `UserSettingsSection` — personal access tokens are not
 * part of the user settings document, and `PersonalAccessTokens` already owns
 * its own loading/error state behind `/api/pat`. These pin that it stays that
 * way: the page must render without ever touching `useUserSettings`.
 */
describe('UserTokensPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays its title and description', () => {
    render(<UserTokensPage />);

    expect(screen.getByRole('heading', { name: /access tokens/i })).toBeInTheDocument();
    expect(
      screen.getByText(/create and revoke personal access tokens/i),
    ).toBeInTheDocument();
  });

  it('renders PersonalAccessTokens, and not the profile or appearance sections', () => {
    render(<UserTokensPage />);

    expect(screen.getByTestId('personal-access-tokens')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-settings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('theme-settings')).not.toBeInTheDocument();
  });

  it('never calls useUserSettings — it is not wrapped in UserSettingsSection', () => {
    // Mocked to be perpetually loading, so that if this page were ever
    // (re)wrapped in `UserSettingsSection` it would render a spinner instead
    // of the page — the failure this test exists to catch.
    mockSettings({ settings: null, isLoading: true });

    render(<UserTokensPage />);

    expect(mockUseUserSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /access tokens/i })).toBeInTheDocument();
  });
});
