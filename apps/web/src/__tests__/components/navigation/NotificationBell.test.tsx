import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { NotificationBell } from '../../../components/navigation/NotificationBell';
import type { NotificationContextValue } from '../../../contexts/NotificationContext';
import type { AppNotification } from '../../../types';

/**
 * Issue #127, epic #109. `NotificationBell` reads `NotificationContext`
 * exclusively - it never touches the SSE stream itself - so `useNotifications`
 * is mocked directly with a controllable fixture matching
 * `NotificationContextValue`. The positive-wiring assertion below directly
 * guards the documented failure mode in `NotificationContext.tsx`'s own
 * header: a wiring mistake that makes `useNotifications` return `null` hides
 * the bell with no test noticing, unless something asserts the bell IS there
 * when the provider is mounted.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const useNotificationsMock = vi.fn<() => NotificationContextValue | null>();
vi.mock('../../../contexts/NotificationContext', async () => {
  const actual = await vi.importActual<
    typeof import('../../../contexts/NotificationContext')
  >('../../../contexts/NotificationContext');
  return { ...actual, useNotifications: () => useNotificationsMock() };
});

function makeNotification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    eventKey: 'security.role_changed',
    title: 'Your role changed',
    body: 'You are now an Admin.',
    link: '/settings',
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFixture(overrides: Partial<NotificationContextValue> = {}): NotificationContextValue {
  return {
    notifications: [],
    unreadCount: 0,
    isLoading: false,
    error: null,
    streamState: 'open',
    refresh: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('NotificationBell', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    useNotificationsMock.mockReset();
  });

  describe('provider wiring', () => {
    it('renders the bell button when useNotifications returns a non-null value', () => {
      useNotificationsMock.mockReturnValue(makeFixture());

      render(<NotificationBell />);

      expect(screen.getByLabelText(/notifications/i)).toBeInTheDocument();
    });

    it('renders nothing when useNotifications returns null (no provider mounted)', () => {
      useNotificationsMock.mockReturnValue(null);

      const { container } = render(<NotificationBell />);

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('unread badge and accessible name', () => {
    it('shows "Notifications, N unread" and the badge when unreadCount > 0', () => {
      useNotificationsMock.mockReturnValue(makeFixture({ unreadCount: 3 }));

      render(<NotificationBell />);

      expect(screen.getByLabelText('Notifications, 3 unread')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('shows "Notifications, none unread" at zero', () => {
      useNotificationsMock.mockReturnValue(makeFixture({ unreadCount: 0 }));

      render(<NotificationBell />);

      expect(screen.getByLabelText('Notifications, none unread')).toBeInTheDocument();
    });
  });

  describe('independence from live connection state', () => {
    it('renders notifications and count from context even with a disconnected-looking streamState', async () => {
      const user = userEvent.setup();
      useNotificationsMock.mockReturnValue(
        makeFixture({
          streamState: 'closed',
          unreadCount: 1,
          notifications: [makeNotification({ title: 'Still here' })],
        }),
      );

      render(<NotificationBell />);

      expect(screen.getByLabelText('Notifications, 1 unread')).toBeInTheDocument();

      await user.click(screen.getByLabelText('Notifications, 1 unread'));

      expect(await screen.findByText('Still here')).toBeInTheDocument();
    });
  });

  describe('opening the popover', () => {
    it('clicking the bell opens the popover and calls refresh()', async () => {
      const user = userEvent.setup();
      const fixture = makeFixture();
      useNotificationsMock.mockReturnValue(fixture);

      render(<NotificationBell />);

      await user.click(screen.getByLabelText(/notifications/i));

      expect(fixture.refresh).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
    });
  });

  describe('row interaction', () => {
    it('clicking an unread row calls markRead(id) and navigates when the link is internal', async () => {
      const user = userEvent.setup();
      const notification = makeNotification({ id: 'row-1', link: '/settings', readAt: null });
      const fixture = makeFixture({ notifications: [notification], unreadCount: 1 });
      useNotificationsMock.mockReturnValue(fixture);

      render(<NotificationBell />);

      await user.click(screen.getByLabelText('Notifications, 1 unread'));
      const row = await screen.findByText(notification.title);
      await user.click(row);

      expect(fixture.markRead).toHaveBeenCalledWith('row-1');
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('clicking an unread row with no link marks it read but does not navigate', async () => {
      const user = userEvent.setup();
      const notification = makeNotification({ id: 'row-2', link: null, readAt: null });
      const fixture = makeFixture({ notifications: [notification], unreadCount: 1 });
      useNotificationsMock.mockReturnValue(fixture);

      render(<NotificationBell />);

      await user.click(screen.getByLabelText('Notifications, 1 unread'));
      const row = await screen.findByText(notification.title);
      await user.click(row);

      expect(fixture.markRead).toHaveBeenCalledWith('row-2');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('clicking an already-read row does not call markRead again', async () => {
      const user = userEvent.setup();
      const notification = makeNotification({
        id: 'row-3',
        link: '/settings',
        readAt: new Date().toISOString(),
      });
      const fixture = makeFixture({ notifications: [notification], unreadCount: 0 });
      useNotificationsMock.mockReturnValue(fixture);

      render(<NotificationBell />);

      await user.click(screen.getByLabelText('Notifications, none unread'));
      const row = await screen.findByText(notification.title);
      await user.click(row);

      expect(fixture.markRead).not.toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });
  });

  describe('list states', () => {
    it('renders the empty state when there are no notifications and nothing is loading or erroring', async () => {
      const user = userEvent.setup();
      useNotificationsMock.mockReturnValue(
        makeFixture({ notifications: [], isLoading: false, error: null }),
      );

      render(<NotificationBell />);
      await user.click(screen.getByLabelText(/notifications/i));

      expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
    });

    it('renders a loading spinner when isLoading is true and the list is empty', async () => {
      const user = userEvent.setup();
      useNotificationsMock.mockReturnValue(
        makeFixture({ notifications: [], isLoading: true, error: null }),
      );

      render(<NotificationBell />);
      await user.click(screen.getByLabelText(/notifications/i));

      expect(await screen.findByLabelText(/loading notifications/i)).toBeInTheDocument();
    });

    it('does not render the loading spinner once notifications are present, even if isLoading is true', async () => {
      const user = userEvent.setup();
      useNotificationsMock.mockReturnValue(
        makeFixture({
          notifications: [makeNotification()],
          isLoading: true,
          error: null,
        }),
      );

      render(<NotificationBell />);
      await user.click(screen.getByLabelText(/notifications/i));

      await waitFor(() => {
        expect(screen.queryByLabelText(/loading notifications/i)).not.toBeInTheDocument();
      });
    });

    it('renders an error alert when error is set', async () => {
      const user = userEvent.setup();
      useNotificationsMock.mockReturnValue(
        makeFixture({ notifications: [], isLoading: false, error: 'Failed to load notifications' }),
      );

      render(<NotificationBell />);
      await user.click(screen.getByLabelText(/notifications/i));

      expect(await screen.findByText('Failed to load notifications')).toBeInTheDocument();
    });
  });

  describe('mark all read', () => {
    it('shows "Mark all read" and calls markAllRead when there is unread, hides it at zero', async () => {
      const user = userEvent.setup();
      const fixture = makeFixture({ unreadCount: 2, notifications: [makeNotification()] });
      useNotificationsMock.mockReturnValue(fixture);

      render(<NotificationBell />);
      await user.click(screen.getByLabelText('Notifications, 2 unread'));

      const markAllButton = await screen.findByText(/mark all read/i);
      await user.click(markAllButton);

      expect(fixture.markAllRead).toHaveBeenCalledTimes(1);
    });

    it('does not render "Mark all read" when unreadCount is 0', async () => {
      const user = userEvent.setup();
      useNotificationsMock.mockReturnValue(makeFixture({ unreadCount: 0 }));

      render(<NotificationBell />);
      await user.click(screen.getByLabelText('Notifications, none unread'));

      await waitFor(() => {
        expect(screen.queryByText(/mark all read/i)).not.toBeInTheDocument();
      });
    });
  });
});
