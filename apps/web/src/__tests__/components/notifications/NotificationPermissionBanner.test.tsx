import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import {
  NotificationPermissionBanner,
  NOTIFICATION_SETTINGS_PATH,
  BANNER_DISMISSED_STORAGE_KEY,
} from '../../../components/notifications/NotificationPermissionBanner';
import type { NotificationCapability } from '../../../hooks/useNotificationCapability';
import type { NotificationConfigResponse } from '../../../types';

/**
 * Issue #365, epic #215. The app-wide banner rendered by `Layout.tsx` under
 * `usePushSubscriptionSync` — see that component's own header for the full
 * design: which of the eight `NotificationCapability` states get a banner at
 * all, why dismissal is per-STATE rather than global, and why it hides on
 * `/settings/notifications` (which carries the fuller version of the same
 * message).
 */

const ENABLED_CONFIG: NotificationConfigResponse = {
  browserEnabled: true,
  pushEnabled: true,
  vapidPublicKey: 'BKey123',
};

function renderBanner(
  capability: NotificationCapability,
  overrides: {
    config?: NotificationConfigResponse | null;
    onRequestPermission?: () => void;
    isRequestingPermission?: boolean;
    route?: string;
  } = {},
) {
  const onRequestPermission = overrides.onRequestPermission ?? vi.fn();
  const utils = render(
    <NotificationPermissionBanner
      config={overrides.config === undefined ? ENABLED_CONFIG : overrides.config}
      capability={capability}
      onRequestPermission={onRequestPermission}
      isRequestingPermission={overrides.isRequestingPermission}
    />,
    { wrapperOptions: { route: overrides.route ?? '/' } },
  );
  return { ...utils, onRequestPermission };
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('NotificationPermissionBanner', () => {
  describe('default: needs a prompt', () => {
    it('renders an Enable notifications button that calls onRequestPermission when clicked', async () => {
      const user = userEvent.setup();
      const { onRequestPermission } = renderBanner('default');

      expect(
        screen.getByText(/notifications are not enabled on this device/i),
      ).toBeInTheDocument();

      const button = screen.getByRole('button', { name: /enable notifications/i });
      await user.click(button);

      expect(onRequestPermission).toHaveBeenCalledTimes(1);
    });

    it('disables the button and shows a waiting label while a request is in flight', () => {
      renderBanner('default', { isRequestingPermission: true });

      const button = screen.getByRole('button', { name: /waiting for your browser/i });
      expect(button).toBeDisabled();
    });

    it('also offers a link to the fuller settings page', () => {
      renderBanner('default');

      expect(
        screen.getByRole('link', { name: /notification settings/i }),
      ).toHaveAttribute('href', NOTIFICATION_SETTINGS_PATH);
    });
  });

  describe('denied: blocked by the browser', () => {
    it('renders instructions and a link to notification settings, with no Enable button', () => {
      renderBanner('denied');

      expect(
        screen.getByText(/notifications are blocked on this device/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/site settings/i)).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /notification settings/i }),
      ).toHaveAttribute('href', NOTIFICATION_SETTINGS_PATH);
      expect(
        screen.queryByRole('button', { name: /enable notifications/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('ios-needs-install: needs Add to Home Screen', () => {
    it('renders the install hint with a "Show me how" link to settings', () => {
      renderBanner('ios-needs-install');

      expect(
        screen.getByText(/add this app to your home screen to get notifications/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /show me how/i }),
      ).toHaveAttribute('href', NOTIFICATION_SETTINGS_PATH);
    });
  });

  describe('hidden states', () => {
    it.each([
      'granted',
      'unsupported',
      'insecure-context',
      'admin-disabled',
      'sw-unavailable',
    ] as const)('renders nothing for capability "%s"', (capability) => {
      const { container } = renderBanner(capability);

      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing before the config has loaded (config: null)', () => {
      const { container } = renderBanner('default', { config: null });

      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when the deployment offers neither push nor browser notifications', () => {
      const { container } = renderBanner('default', {
        config: { browserEnabled: false, pushEnabled: false, vapidPublicKey: null },
      });

      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing on /settings/notifications itself', () => {
      const { container } = renderBanner('default', { route: NOTIFICATION_SETTINGS_PATH });

      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing on a sub-path of /settings/notifications', () => {
      const { container } = renderBanner('default', {
        route: `${NOTIFICATION_SETTINGS_PATH}/anything`,
      });

      expect(container).toBeEmptyDOMElement();
    });

    it('still renders on an unrelated settings page', () => {
      renderBanner('default', { route: '/settings/appearance' });

      expect(
        screen.getByText(/notifications are not enabled on this device/i),
      ).toBeInTheDocument();
    });
  });

  describe('session dismissal, per state', () => {
    it('hides after the dismiss button is clicked, and records the dismissed state in sessionStorage', async () => {
      const user = userEvent.setup();
      const { container } = renderBanner('default');

      await user.click(screen.getByRole('button', { name: /dismiss notification banner/i }));

      expect(container).toBeEmptyDOMElement();
      expect(sessionStorage.getItem(BANNER_DISMISSED_STORAGE_KEY)).toBe('default');
    });

    it('reappears when the capability changes to a different state after being dismissed', async () => {
      const user = userEvent.setup();
      const { rerender, container } = renderBanner('default');

      await user.click(screen.getByRole('button', { name: /dismiss notification banner/i }));
      expect(container).toBeEmptyDOMElement();

      rerender(
        <NotificationPermissionBanner
          config={ENABLED_CONFIG}
          capability="denied"
          onRequestPermission={vi.fn()}
        />,
      );

      expect(
        screen.getByText(/notifications are blocked on this device/i),
      ).toBeInTheDocument();
    });

    it('a dismissal recorded by a previous mount (e.g. sessionStorage from an earlier page load) hides the banner on first render too', () => {
      sessionStorage.setItem(BANNER_DISMISSED_STORAGE_KEY, 'denied');

      const { container } = renderBanner('denied');

      expect(container).toBeEmptyDOMElement();
    });

    it('does not carry a dismissal over to a different capability on first render', () => {
      sessionStorage.setItem(BANNER_DISMISSED_STORAGE_KEY, 'denied');

      renderBanner('default');

      expect(
        screen.getByText(/notifications are not enabled on this device/i),
      ).toBeInTheDocument();
    });

    it('does not break rendering when sessionStorage.getItem throws', () => {
      const getItemSpy = vi
        .spyOn(window.sessionStorage.__proto__, 'getItem')
        .mockImplementation(() => {
          throw new Error('storage blocked (private browsing)');
        });

      expect(() => renderBanner('default')).not.toThrow();
      expect(
        screen.getByText(/notifications are not enabled on this device/i),
      ).toBeInTheDocument();

      getItemSpy.mockRestore();
    });

    it('does not break the dismiss click when sessionStorage.setItem throws — the banner still hides in-memory', async () => {
      const setItemSpy = vi
        .spyOn(window.sessionStorage.__proto__, 'setItem')
        .mockImplementation(() => {
          throw new Error('storage blocked (private browsing)');
        });
      const user = userEvent.setup();

      const { container } = renderBanner('default');
      await user.click(screen.getByRole('button', { name: /dismiss notification banner/i }));

      expect(container).toBeEmptyDOMElement();

      setItemSpy.mockRestore();
    });
  });
});
