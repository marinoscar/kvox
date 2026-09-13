/**
 * Admin → Settings → Notifications (`/admin/settings/notifications`), issue
 * #225, epic #215.
 *
 * `useSystemSettings`, `usePermissions` and `useNotificationEvents` are mocked —
 * all three are thin fetch/derivation hooks with their own suites, and what is
 * under test here is what #225 actually wrote: which events the page offers a
 * control for, which direction the checkbox reads relative to the stored
 * suppression list, what exactly is PATCHed, and what the read-only admin sees.
 *
 * The events registry is a FIXTURE rather than the real list, deliberately. Only
 * `security.role_changed` declares the browser channel today, so asserting
 * against the live registry would make "email-only events are not listed" a test
 * that passes for the wrong reason the moment a second browser event is added.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import type { NotificationEventDef } from '../../../types';

vi.mock('../../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../../hooks/useNotificationEvents', () => ({
  useNotificationEvents: vi.fn(),
}));

import { useSystemSettings } from '../../../hooks/useSystemSettings';
import { usePermissions } from '../../../hooks/usePermissions';
import { useNotificationEvents } from '../../../hooks/useNotificationEvents';
import NotificationSettingsPage from '../../../pages/Admin/NotificationSettingsPage';

const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockUsePermissions = vi.mocked(usePermissions);
const mockUseNotificationEvents = vi.mocked(useNotificationEvents);

const ADMIN_PERMISSIONS = ['system_settings:read', 'system_settings:write'];

/** Email only — must never get a control here. */
const WELCOME: NotificationEventDef = {
  key: 'user.welcome',
  label: 'Welcome',
  description: 'Sent once, the first time you sign in to this application.',
  channels: ['email'],
  defaultEnabled: true,
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

const BUILD_FINISHED: NotificationEventDef = {
  key: 'build.finished',
  label: 'Build finished',
  description: 'Sent when a build completes.',
  channels: ['browser'],
  defaultEnabled: true,
  mandatory: false,
};

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(['admin']),
    hasPermission: (permission: string) => granted.includes(permission),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

function setEvents(events: NotificationEventDef[] | null, overrides = {}) {
  mockUseNotificationEvents.mockReturnValue({
    events,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

function setSettings(
  notifications: { browserEnabled: boolean; disabledEvents: string[] } = {
    browserEnabled: true,
    disabledEvents: [],
  },
  overrides: Partial<ReturnType<typeof useSystemSettings>> = {},
) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  mockUseSystemSettings.mockReturnValue({
    settings: {
      notifications,
      updatedAt: '2024-01-15T10:30:00Z',
      updatedBy: null,
      version: 7,
    },
    isLoading: false,
    error: null,
    isSaving: false,
    updateSettings,
    replaceSettings: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  });
  return updateSettings;
}

const renderAsAdmin = () =>
  render(<NotificationSettingsPage />, {
    wrapperOptions: { user: mockAdminUser },
  });

/** The checkbox for one event, found by the aria-label the page gives it. */
const eventBox = (label: string) =>
  screen.getByRole('checkbox', { name: `Browser notification for ${label}` });

// Role `switch`, not `checkbox`: MUI's `Switch` sets it, and that difference is
// the point — the global control is a switch, the per-event ones are checkboxes.
const globalSwitch = () =>
  screen.getByRole('switch', { name: /deliver browser notifications/i });

describe('NotificationSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(ADMIN_PERMISSIONS);
    setSettings();
    setEvents([WELCOME, ROLE_CHANGED, BUILD_FINISHED]);
  });

  it('renders under its own heading, with the global toggle reflecting the stored value', () => {
    renderAsAdmin();

    expect(
      screen.getByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeInTheDocument();
    expect(globalSwitch()).toBeChecked();
  });

  it('lists only events that declare the browser channel', () => {
    renderAsAdmin();

    expect(eventBox('Your roles changed')).toBeInTheDocument();
    expect(eventBox('Build finished')).toBeInTheDocument();
    // Email-only: a control here could not do anything, so there must not be
    // one. The registry is the authority on which events those are.
    expect(
      screen.queryByRole('checkbox', {
        name: 'Browser notification for Welcome',
      }),
    ).not.toBeInTheDocument();
  });

  it('renders a suppressed event as UNCHECKED — the box means "delivered", the stored list means "suppressed"', () => {
    setSettings({ browserEnabled: true, disabledEvents: ['build.finished'] });

    renderAsAdmin();

    expect(eventBox('Build finished')).not.toBeChecked();
    expect(eventBox('Your roles changed')).toBeChecked();
  });

  it('PATCHes only the notifications branch, adding the unchecked event to disabledEvents', async () => {
    const user = userEvent.setup();
    const updateSettings = setSettings();

    renderAsAdmin();
    await user.click(eventBox('Build finished'));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: {
          browserEnabled: true,
          disabledEvents: ['build.finished'],
        },
      }),
    );
  });

  it('re-checking an event removes it from the list, so a suppression can be lifted', async () => {
    const user = userEvent.setup();
    const updateSettings = setSettings({
      browserEnabled: true,
      disabledEvents: ['build.finished', 'security.role_changed'],
    });

    renderAsAdmin();
    await user.click(eventBox('Build finished'));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: {
          browserEnabled: true,
          disabledEvents: ['security.role_changed'],
        },
      }),
    );
  });

  it('saves the global toggle without disturbing the suppression list', async () => {
    const user = userEvent.setup();
    const updateSettings = setSettings({
      browserEnabled: true,
      disabledEvents: ['build.finished'],
    });

    renderAsAdmin();
    await user.click(globalSwitch());
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: {
          browserEnabled: false,
          disabledEvents: ['build.finished'],
        },
      }),
    );
  });

  it('keeps Save disabled until something actually changes', async () => {
    const user = userEvent.setup();
    renderAsAdmin();

    const save = screen.getByRole('button', { name: 'Save Changes' });
    expect(save).toBeDisabled();

    await user.click(eventBox('Build finished'));
    expect(save).toBeEnabled();

    // Back to the stored state — dirty tracking must notice, not just latch.
    await user.click(eventBox('Build finished'));
    expect(save).toBeDisabled();
  });

  it('greys the per-event boxes out when the channel is off, rather than hiding the saved list', async () => {
    const user = userEvent.setup();
    renderAsAdmin();

    await user.click(globalSwitch());

    expect(eventBox('Build finished')).toBeDisabled();
    // Still rendered: hiding them would make an existing suppression
    // invisible and unrecoverable without turning the switch back on first.
    expect(eventBox('Build finished')).toBeInTheDocument();
  });

  it('is read-only for an admin holding system_settings:read alone', () => {
    setPermissions(['system_settings:read']);

    renderAsAdmin();

    expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
    expect(globalSwitch()).toBeDisabled();
    expect(eventBox('Your roles changed')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('refuses a user without system_settings:read', () => {
    setPermissions([]);

    renderAsAdmin();

    expect(
      screen.queryByRole('heading', { name: 'Notifications', level: 1 }),
    ).not.toBeInTheDocument();
  });

  it('keeps the global switch usable when the events registry fails to load', () => {
    // The two are separate requests. A registry failure must not take the one
    // control that needs nothing from it down with it.
    setEvents(null, { error: 'Failed to load notification events' });

    renderAsAdmin();

    expect(
      screen.getByText('Failed to load notification events'),
    ).toBeInTheDocument();
    expect(globalSwitch()).toBeEnabled();
  });

  it('says so plainly when no event in this deployment can be delivered in the browser', () => {
    setEvents([WELCOME]);

    renderAsAdmin();

    expect(screen.getByText(/nothing to suppress here/i)).toBeInTheDocument();
  });

  it('renders defaults rather than crashing against an API that predates the block', () => {
    // A build of this app can be deployed in front of an older API. The
    // response schema is that API's promise, not a guarantee about every
    // server this bundle will ever talk to.
    mockUseSystemSettings.mockReturnValue({
      settings: {
        updatedAt: '2024-01-15T10:30:00Z',
        updatedBy: null,
        version: 7,
      } as never,
      isLoading: false,
      error: null,
      isSaving: false,
      updateSettings: vi.fn().mockResolvedValue(undefined),
      replaceSettings: vi.fn(),
      refresh: vi.fn(),
    });

    renderAsAdmin();

    expect(globalSwitch()).toBeChecked();
    expect(eventBox('Build finished')).toBeChecked();
  });
});

/**
 * `SystemSettingsSection`'s own chrome (issue #92, epic #90) — the loading
 * spinner, the fetch-error alert, the success/failure snackbars and the
 * mid-save disable — exercised here rather than against a stubbed page, now
 * that `NotificationSettingsPage` is the one live consumer of that shared
 * component. This coverage used to live in a suite of its own alongside the
 * three sibling pages `SystemSettingsSection` was originally split out for
 * (#366 removed them); it moved here rather than disappearing with them.
 */
describe('Shared page chrome (SystemSettingsSection)', () => {
  it('shows a spinner while the document is loading', () => {
    mockUseSystemSettings.mockReturnValue({
      settings: null,
      isLoading: true,
      error: null,
      isSaving: false,
      updateSettings: vi.fn(),
      replaceSettings: vi.fn(),
      refresh: vi.fn(),
    });

    renderAsAdmin();

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Notifications', level: 1 }),
    ).not.toBeInTheDocument();
  });

  it('shows the fetch error and mounts no form over a null document', () => {
    mockUseSystemSettings.mockReturnValue({
      settings: null,
      isLoading: false,
      error: 'Failed to load system settings',
      isSaving: false,
      updateSettings: vi.fn(),
      replaceSettings: vi.fn(),
      refresh: vi.fn(),
    });

    renderAsAdmin();

    expect(screen.getByText('Failed to load system settings')).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /deliver browser notifications/i }),
    ).not.toBeInTheDocument();
  });

  it('confirms a successful save in a snackbar', async () => {
    const user = userEvent.setup();
    setSettings();

    renderAsAdmin();
    await user.click(globalSwitch());
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(screen.getByText('Settings saved')).toBeInTheDocument());
  });

  it('reports a rejected save in a snackbar instead of throwing at the page', async () => {
    const user = userEvent.setup();
    setSettings(
      { browserEnabled: true, disabledEvents: [] },
      { updateSettings: vi.fn().mockRejectedValue(new Error('Settings were updated elsewhere')) },
    );

    renderAsAdmin();
    await user.click(globalSwitch());
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(screen.getByText(/settings were updated elsewhere/i)).toBeInTheDocument(),
    );
  });

  it('disables the controls mid-save even for a writer', () => {
    setSettings(undefined, { isSaving: true });

    renderAsAdmin();

    expect(globalSwitch()).toBeDisabled();
    // The button's own label flips to "Saving..." while `isSaving` is true
    // (see `NotificationSettingsPage`'s `isSaving ? 'Saving...' : 'Save
    // Changes'`), so it must be found by that label, not the idle one.
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });
});
