/**
 * Issue #126, epic #109. `UserNotificationsPage` wiring, exercised through the
 * REAL `UserSettingsSection` (only `useUserSettings` is mocked, matching
 * `UserSettingsPages.test.tsx`'s pattern for `UserAppearancePage` /
 * `UserProfilePage`) and the REAL `NotificationSettings` matrix, so these
 * assertions are about the actual PATCH bodies the page sends, not a stub's
 * promise to send them.
 *
 * `useNotificationEvents` and `useNotificationCapability` are mocked because
 * they own their own fetch/observation concerns with their own test files
 * (`useNotificationEvents` is a thin fetch hook exercised like its siblings
 * elsewhere; `useNotificationCapability.test.ts` covers the 8-state capability
 * resolution and its precedence directly, and
 * `useBrowserNotificationPermission.test.ts` the raw permission underneath it).
 *
 * #221 swapped the mocked hook here from `useBrowserNotificationPermission` to
 * the capability hook layered over it - this page now asks "what can this
 * device do", not "what did the browser say", because only the former has an
 * actionable remedy attached to every one of its answers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

vi.mock('../../hooks/useUserSettings', () => ({
  useUserSettings: vi.fn(),
}));

vi.mock('../../hooks/useNotificationEvents', () => ({
  useNotificationEvents: vi.fn(),
}));

vi.mock('../../hooks/useNotificationCapability', () => ({
  useNotificationCapability: vi.fn(),
}));

vi.mock('../../hooks/useNotificationConfig', () => ({
  useNotificationConfig: vi.fn(),
}));

import { useUserSettings } from '../../hooks/useUserSettings';
import { useNotificationEvents } from '../../hooks/useNotificationEvents';
import { useNotificationCapability } from '../../hooks/useNotificationCapability';
import { useNotificationConfig } from '../../hooks/useNotificationConfig';
import UserNotificationsPage from '../../pages/UserNotificationsPage';
import type { NotificationEventDef, NotificationConfigResponse } from '../../types';
import type { NotificationCapability } from '../../hooks/useNotificationCapability';

const mockUseUserSettings = vi.mocked(useUserSettings);
const mockUseNotificationEvents = vi.mocked(useNotificationEvents);
const mockUseNotificationCapability = vi.mocked(useNotificationCapability);
const mockUseNotificationConfig = vi.mocked(useNotificationConfig);

const WELCOME: NotificationEventDef = {
  key: 'user.welcome',
  label: 'Welcome',
  description: 'Sent once, the first time you sign in to this application.',
  channels: ['email'],
  defaultEnabled: true,
  mandatory: false,
};

// Synthetic defaultEnabled:false event - none of the seeded API registry
// events default to off, and "opting IN sends the explicit boolean, opting
// back OUT sends null" needs one that does.
const WEEKLY_DIGEST: NotificationEventDef = {
  key: 'weekly.digest',
  label: 'Weekly digest',
  description: 'A weekly summary of activity.',
  channels: ['email'],
  defaultEnabled: false,
  mandatory: false,
};

const ROLE_CHANGED: NotificationEventDef = {
  key: 'security.role_changed',
  label: 'Your roles changed',
  description: 'Sent when an administrator changes your roles.',
  channels: ['email', 'browser'],
  defaultEnabled: true,
  mandatory: true,
};

function mockSettings(overrides: Partial<ReturnType<typeof useUserSettings>> = {}) {
  mockUseUserSettings.mockReturnValue({
    settings: {
      theme: 'system',
      profile: { imageSource: 'provider' },
      updatedAt: new Date().toISOString(),
      version: 1,
      // No `notifications` key at all - the untouched-account case.
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

function mockEvents(events: NotificationEventDef[] | null, overrides: Partial<ReturnType<typeof useNotificationEvents>> = {}) {
  mockUseNotificationEvents.mockReturnValue({
    events,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

function mockCapability(capability: NotificationCapability = 'granted') {
  mockUseNotificationCapability.mockReturnValue({
    capability,
    // The raw permission underneath. Only meaningful for the states that are
    // permission-shaped; anything else reports what the browser said, which is
    // deliberately NOT the same claim as the capability.
    permission:
      capability === 'granted' || capability === 'denied' || capability === 'default'
        ? capability
        : 'unsupported',
    refresh: vi.fn(),
  });
}

// #227. `config: null` is the "first read has not resolved yet" state - NOT
// the same as `browserEnabled: false` - so the default here is a resolved,
// enabled config, and the loading window is exercised as its own explicit
// case below.
function mockConfig(config: NotificationConfigResponse | null = { browserEnabled: true, pushEnabled: false, vapidPublicKey: null }) {
  mockUseNotificationConfig.mockReturnValue({
    config,
    isLoading: config === null,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
}

describe('UserNotificationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings();
    mockEvents([WELCOME, WEEKLY_DIGEST, ROLE_CHANGED]);
    mockCapability('granted');
    mockConfig();
  });

  it('displays its title and description', () => {
    render(<UserNotificationsPage />);

    expect(screen.getByRole('heading', { name: /notifications/i, level: 1 })).toBeInTheDocument();
    expect(
      screen.getByText(/choose which events notify you, and whether they arrive by email or in your browser/i),
    ).toBeInTheDocument();
  });

  // THE PRIMARY FAILURE MODE #126 GUARDS AGAINST. A local defaulted mirror of
  // preferences, materialised for rendering, is exactly the shape that ends
  // up serialised and PATCHed on mount - which mutes nobody but freezes every
  // account's preferences at whatever the defaults happened to be the day
  // they first opened this page.
  it('makes no request on mount - zero calls to updateSettings after the page has rendered', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    mockSettings({ updateSettings });

    render(<UserNotificationsPage />);

    // Let any pending effects/microtasks flush.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /notifications/i, level: 1 })).toBeInTheDocument();
    });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('an untouched account (no notifications key at all) renders every control at its registry default', () => {
    render(<UserNotificationsPage />);

    // WELCOME defaults to true, WEEKLY_DIGEST defaults to false.
    expect(
      screen.getByRole('switch', { name: /email notifications for welcome/i }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /email notifications for weekly digest/i }),
    ).not.toBeChecked();
  });

  it('toggling one switch PATCHes exactly one channel and one event key, nothing else', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    mockSettings({ updateSettings });
    const user = userEvent.setup();

    render(<UserNotificationsPage />);

    const toggle = screen.getByRole('switch', { name: /email notifications for welcome/i });
    await user.click(toggle);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // Exact body: one channel (email), one event key (user.welcome), and
    // nothing else - no browser channel, no weekly.digest, no other field.
    expect(updateSettings).toHaveBeenCalledWith({
      notifications: { email: { 'user.welcome': false } },
    });
  });

  describe('returning a control to its default sends null, not the default value', () => {
    it('un-muting a defaultEnabled:true event sends null', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockSettings({
        updateSettings,
        settings: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          updatedAt: new Date().toISOString(),
          version: 1,
          notifications: { email: { 'user.welcome': false } },
        },
      });
      const user = userEvent.setup();

      render(<UserNotificationsPage />);

      const toggle = screen.getByRole('switch', { name: /email notifications for welcome/i });
      expect(toggle).not.toBeChecked();

      await user.click(toggle);

      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: { email: { 'user.welcome': null } },
      });
    });

    it('opting back OUT of a defaultEnabled:false event sends null', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockSettings({
        updateSettings,
        settings: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          updatedAt: new Date().toISOString(),
          version: 1,
          notifications: { email: { 'weekly.digest': true } },
        },
      });
      const user = userEvent.setup();

      render(<UserNotificationsPage />);

      const toggle = screen.getByRole('switch', { name: /email notifications for weekly digest/i });
      expect(toggle).toBeChecked();

      await user.click(toggle);

      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: { email: { 'weekly.digest': null } },
      });
    });

    it('opting IN to a defaultEnabled:false event sends the explicit true (contrast case, not a null-delete)', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockSettings({ updateSettings });
      const user = userEvent.setup();

      render(<UserNotificationsPage />);

      const toggle = screen.getByRole('switch', { name: /email notifications for weekly digest/i });
      expect(toggle).not.toBeChecked();

      await user.click(toggle);

      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: { email: { 'weekly.digest': true } },
      });
    });
  });

  describe('mandatory events', () => {
    it('renders locked, with the reason, and every declared channel disabled', () => {
      render(<UserNotificationsPage />);

      expect(screen.getByText('Always on')).toBeInTheDocument();
      expect(
        screen.getByText(/this is a security notification and cannot be turned off/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('switch', { name: /email notifications for your roles changed/i }),
      ).toBeDisabled();
      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).toBeDisabled();
    });

    it('a stale stored false for a mandatory event still renders ON - that is what the user actually receives', () => {
      mockSettings({
        settings: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          updatedAt: new Date().toISOString(),
          version: 1,
          notifications: {
            email: { 'security.role_changed': false },
            browser: { 'security.role_changed': false },
          },
        },
      });

      render(<UserNotificationsPage />);

      expect(
        screen.getByRole('switch', { name: /email notifications for your roles changed/i }),
      ).toBeChecked();
      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).toBeChecked();
    });
  });

  it('shows a loading spinner while the registry is loading, even once settings have loaded', () => {
    mockEvents(null, { isLoading: true });

    render(<UserNotificationsPage />);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows the registry fetch error inline, distinct from the settings fetch error', () => {
    mockEvents(null, { isLoading: false, error: 'Failed to load notification events' });

    render(<UserNotificationsPage />);

    expect(screen.getByText(/failed to load notification events/i)).toBeInTheDocument();
  });

  // #227. The page's job here is to translate `GET /notifications/config`
  // into `useNotificationCapability`'s `adminDisabled` option - and,
  // critically, to get the loading window right: `config` is `null` until the
  // first read resolves, and `config?.browserEnabled === false` (not
  // `!config?.browserEnabled`) is what keeps that window from being
  // mis-reported as "disabled". See `useNotificationConfig`'s own header and
  // the call site in `UserNotificationsPage.tsx`.
  describe('wiring GET /notifications/config into adminDisabled (#227)', () => {
    it('passes adminDisabled: true when the fetched config says browserEnabled: false', () => {
      mockConfig({ browserEnabled: false, pushEnabled: false, vapidPublicKey: null });

      render(<UserNotificationsPage />);

      expect(mockUseNotificationCapability).toHaveBeenCalledWith(
        expect.objectContaining({ adminDisabled: true }),
      );
    });

    it('passes adminDisabled: false while the config is still loading (config: null)', () => {
      mockConfig(null);

      render(<UserNotificationsPage />);

      expect(mockUseNotificationCapability).toHaveBeenCalledWith(
        expect.objectContaining({ adminDisabled: false }),
      );
    });

    it('passes adminDisabled: false when the fetched config says browserEnabled: true', () => {
      mockConfig({ browserEnabled: true, pushEnabled: false, vapidPublicKey: null });

      render(<UserNotificationsPage />);

      expect(mockUseNotificationCapability).toHaveBeenCalledWith(
        expect.objectContaining({ adminDisabled: false }),
      );
    });
  });

  // #221. The page's ONLY job here is to hand the capability down; this is
  // what proves it hands down the capability and not the raw permission, which
  // would render the iOS lie the epic exists to delete.
  describe('the capability reaches the matrix', () => {
    it('an iOS tab gets the Add to Home Screen remedy, not "not supported"', () => {
      mockCapability('ios-needs-install');

      render(<UserNotificationsPage />);

      expect(screen.getByText('Add this app to your Home Screen')).toBeInTheDocument();
      expect(
        screen.queryByText('This browser cannot show notifications'),
      ).not.toBeInTheDocument();
    });

    it('renders the "Allow notifications" button only in the default state', () => {
      mockCapability('default');
      const { unmount } = render(<UserNotificationsPage />);
      expect(
        screen.getByRole('button', { name: /allow notifications/i }),
      ).toBeInTheDocument();
      unmount();

      // Every other state either has nothing to ask for or could not use the
      // answer, and the prompt is a one-shot, effectively permanent resource.
      for (const capability of ['granted', 'denied', 'admin-disabled', 'sw-unavailable'] as const) {
        mockCapability(capability);
        const view = render(<UserNotificationsPage />);
        expect(
          screen.queryByRole('button', { name: /allow notifications/i }),
        ).not.toBeInTheDocument();
        view.unmount();
      }
    });
  });

  // ===========================================================================
  // Issue #365: `pushEnabled` used to be hardcoded `false` regardless of what
  // `GET /api/notifications/config` actually returned. This proves the real
  // fetched value reaches `NotificationSettings`'s push column, using a
  // synthetic event that declares `push` (no seeded `NOTIFICATION_EVENTS`
  // entry declares it yet - same synthetic-fixture rationale as
  // `NotificationSettings.test.tsx`'s own `PUSH_CAPABLE`).
  // ===========================================================================
  describe('#365: pushEnabled reaches the matrix from GET /notifications/config', () => {
    const PUSH_CAPABLE: NotificationEventDef = {
      key: 'synthetic.push_capable',
      label: 'Synthetic push event',
      description: 'Exercises the push column before a real event declares it.',
      channels: ['push'],
      defaultEnabled: true,
      mandatory: false,
    };

    it('disables the push switch when the fetched config says pushEnabled: false', () => {
      mockEvents([PUSH_CAPABLE]);
      mockConfig({ browserEnabled: true, pushEnabled: false, vapidPublicKey: null });

      render(<UserNotificationsPage />);

      expect(
        screen.getByRole('switch', { name: /push notifications for synthetic push event/i }),
      ).toBeDisabled();
    });

    it('enables the push switch when the fetched config says pushEnabled: true - no longer hardcoded off', () => {
      mockEvents([PUSH_CAPABLE]);
      mockConfig({ browserEnabled: true, pushEnabled: true, vapidPublicKey: 'BKey123' });

      render(<UserNotificationsPage />);

      expect(
        screen.getByRole('switch', { name: /push notifications for synthetic push event/i }),
      ).not.toBeDisabled();
      expect(
        screen.queryByText('Push notifications are not available yet'),
      ).not.toBeInTheDocument();
    });

    it('treats a still-loading config (null) as pushEnabled: false - the safe default while unknown', () => {
      mockEvents([PUSH_CAPABLE]);
      mockConfig(null);

      render(<UserNotificationsPage />);

      expect(
        screen.getByRole('switch', { name: /push notifications for synthetic push event/i }),
      ).toBeDisabled();
    });
  });

  it('never calls Notification.requestPermission on this page - observed only, see #127', async () => {
    const originalNotification = (window as any).Notification;
    const requestPermission = vi.fn();
    (window as any).Notification = { permission: 'default', requestPermission };
    mockCapability('default');

    const user = userEvent.setup();
    render(<UserNotificationsPage />);

    expect(requestPermission).not.toHaveBeenCalled();

    // Interact with an unrelated (non-browser-channel) control too, to prove
    // the prohibition holds through interaction, not only at mount.
    const toggle = screen.getByRole('switch', { name: /email notifications for welcome/i });
    await user.click(toggle);

    expect(requestPermission).not.toHaveBeenCalled();

    (window as any).Notification = originalNotification;
  });
});
