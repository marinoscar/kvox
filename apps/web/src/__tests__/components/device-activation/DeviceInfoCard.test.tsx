/**
 * Component tests — `DeviceInfoCard` (issue #141).
 *
 * This is the review step of `/activate`: what the device says it is, WHAT IT
 * WILL GET, and the Approve/Deny decision. Everything under
 * `deviceInfo.clientInfo` is attacker-controlled (`POST /auth/device/code` is
 * public), so this suite is mostly about making sure that untrusted blob can
 * never make the card lie, crash, or hide the controls it renders next to.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { DeviceInfoCard } from '../../../components/device-activation/DeviceInfoCard';
import { DEVICE_NAME_MAX_DISPLAY } from '../../../components/device-activation/credential';
import type { DeviceActivationInfo } from '../../../types';

// Named by codepoint, per the convention in credential.test.ts and the API's
// own spec — a hostile-input test file should never carry literal invisible
// glyphs in its own source.
const RIGHT_TO_LEFT_OVERRIDE = '\u202E';
const ZERO_WIDTH_SPACE = '\u200B';

const FUTURE_EXPIRY = new Date(Date.now() + 15 * 60 * 1000).toISOString();

function baseDeviceInfo(
  overrides: Partial<DeviceActivationInfo> = {},
): DeviceActivationInfo {
  return {
    userCode: 'ABCD-1234',
    clientInfo: {
      deviceName: 'My Laptop',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      ipAddress: '10.0.0.1',
    },
    expiresAt: FUTURE_EXPIRY,
    ...overrides,
  };
}

function renderCard(deviceInfo: DeviceActivationInfo, error: string | null = null) {
  return render(
    <DeviceInfoCard
      deviceInfo={deviceInfo}
      onApprove={vi.fn().mockResolvedValue(undefined)}
      onDeny={vi.fn().mockResolvedValue(undefined)}
      error={error}
    />,
  );
}

describe('DeviceInfoCard', () => {
  describe('session credential', () => {
    it('renders the ordinary wording and an "Approve" control', () => {
      renderCard(baseDeviceInfo());

      expect(screen.getByText('Standard sign-in session')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^approve$/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
    });

    it('does not show the PAT-specific chip label', () => {
      renderCard(baseDeviceInfo());

      expect(screen.queryByText('Long-lived access token')).not.toBeInTheDocument();
    });
  });

  describe('PAT credential', () => {
    const patDeviceInfo = baseDeviceInfo({
      clientInfo: {
        deviceName: 'CLI on build-server',
        userAgent: 'my-cli/1.0',
        ipAddress: '203.0.113.5',
        tokenType: 'pat',
      },
    });

    it('is visibly distinguished with the long-lived-token chip', () => {
      renderCard(patDeviceInfo);

      expect(screen.getByText('Long-lived access token')).toBeInTheDocument();
      expect(screen.queryByText('Standard sign-in session')).not.toBeInTheDocument();
    });

    it('states the ~90-day lifetime and that it survives sign-out', () => {
      renderCard(patDeviceInfo);

      expect(screen.getByText(/about 90 days/i)).toBeInTheDocument();
      expect(
        screen.getByText(/keeps working while you are signed out/i),
      ).toBeInTheDocument();
    });

    it('links to where the token can be revoked', () => {
      renderCard(patDeviceInfo);

      const link = screen.getByRole('link', { name: /settings.*access tokens/i });
      expect(link).toHaveAttribute('href', '/settings/tokens');
    });

    it('labels the approve control with the credential kind', () => {
      renderCard(patDeviceInfo);

      expect(
        screen.getByRole('button', { name: /approve token/i }),
      ).toBeInTheDocument();
      // The plain "Approve" (session) label must not also be present.
      expect(
        screen.queryByRole('button', { name: /^approve$/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('unexpected or absent tokenType', () => {
    it('renders the session treatment when tokenType is absent', () => {
      renderCard(
        baseDeviceInfo({
          clientInfo: { deviceName: 'Old client, pre-#141' },
        }),
      );

      expect(screen.getByText('Standard sign-in session')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^approve$/i }),
      ).toBeInTheDocument();
    });

    it('renders the session treatment when tokenType is an unexpected value', () => {
      renderCard(
        baseDeviceInfo({
          clientInfo: { deviceName: 'Probe', tokenType: 'admin' },
        }),
      );

      expect(screen.getByText('Standard sign-in session')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^approve$/i }),
      ).toBeInTheDocument();
    });

    it('renders the session treatment when tokenType is "PAT" in the wrong case', () => {
      renderCard(
        baseDeviceInfo({
          clientInfo: { deviceName: 'Typo client', tokenType: 'PAT' },
        }),
      );

      expect(screen.getByText('Standard sign-in session')).toBeInTheDocument();
      expect(screen.queryByText('Long-lived access token')).not.toBeInTheDocument();
    });
  });

  describe('missing clientInfo', () => {
    it('does not crash the page when clientInfo is absent', () => {
      expect(() =>
        renderCard(
          baseDeviceInfo({ clientInfo: undefined }),
        ),
      ).not.toThrow();

      expect(screen.getByText('Standard sign-in session')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
    });

    it('does not render device-name/user-agent/IP rows when clientInfo is absent', () => {
      renderCard(baseDeviceInfo({ clientInfo: undefined }));

      expect(screen.queryByText('Device Name')).not.toBeInTheDocument();
      expect(screen.queryByText('Browser / Device')).not.toBeInTheDocument();
      expect(screen.queryByText('IP Address')).not.toBeInTheDocument();
    });
  });

  describe('hostile deviceName', () => {
    it('renders as inert text rather than markup', () => {
      const { container } = renderCard(
        baseDeviceInfo({
          clientInfo: { deviceName: '<img src=x onerror=alert(1)>' },
        }),
      );

      // No actual <img> element was created from the payload.
      expect(container.querySelector('img')).toBeNull();
      // The angle brackets survive as literal, escaped text content.
      expect(
        screen.getByText('<img src=x onerror=alert(1)>'),
      ).toBeInTheDocument();
      // And the raw markup source never appears un-escaped in the DOM.
      expect(container.innerHTML).not.toContain('<img src=x');
      expect(container.innerHTML).toContain('&lt;img');
    });

    it('strips bidi overrides and zero-width characters from the displayed name', () => {
      const hostile = `Oscar${ZERO_WIDTH_SPACE}'s${RIGHT_TO_LEFT_OVERRIDE} laptop`;
      renderCard(baseDeviceInfo({ clientInfo: { deviceName: hostile } }));

      expect(screen.getByText("Oscar's laptop")).toBeInTheDocument();
      expect(screen.queryByText(hostile)).not.toBeInTheDocument();
    });

    it('does not let an extremely long deviceName push Approve/Deny out of the document', () => {
      const huge = 'A'.repeat(5000);
      renderCard(baseDeviceInfo({ clientInfo: { deviceName: huge } }));

      // The display bound is a security control: it stops the warning (and
      // the action buttons next to it) from being buried under attacker text.
      const shown = screen.getByText(
        (content) => content.startsWith('AAAA') && content.length <= DEVICE_NAME_MAX_DISPLAY,
      );
      expect(shown.textContent!.length).toBeLessThanOrEqual(DEVICE_NAME_MAX_DISPLAY);
      expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
    });
  });

  describe('countdown label', () => {
    it('labels the countdown as the code expiry, not a generic "time remaining"', () => {
      renderCard(baseDeviceInfo());

      expect(screen.getByText('Code expires in')).toBeInTheDocument();
      expect(screen.queryByText(/^time remaining$/i)).not.toBeInTheDocument();
    });
  });

  describe('error prop', () => {
    it('renders a passed-in error message', () => {
      renderCard(baseDeviceInfo(), 'Something went wrong');

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });
});
