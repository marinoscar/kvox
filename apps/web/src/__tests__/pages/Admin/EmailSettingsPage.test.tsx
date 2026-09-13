/**
 * `/admin/settings/email` (issue #124, epic #109).
 *
 * The hook (`useEmailSettings`) is mocked, matching the pattern the four
 * sibling Console settings pages already use for `useSystemSettings` — this
 * suite is about the PAGE's own rendering and gating logic, not the hook's
 * fetch/save plumbing, which belongs to a hook-level test.
 *
 * The one exception is the blank-password wire contract
 * (`EmailSettingsPage.wire.test.tsx`, a sibling file): that assertion needs
 * the real `toInput()` conversion feeding a real HTTP request body, so it
 * mounts the page with the REAL hook against MSW instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import type { EmailSettings, EmailTestResult } from '../../../types';

vi.mock('../../../hooks/useEmailSettings', () => ({
  useEmailSettings: vi.fn(),
}));

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { useEmailSettings } from '../../../hooks/useEmailSettings';
import { usePermissions } from '../../../hooks/usePermissions';
import EmailSettingsPage from '../../../pages/Admin/EmailSettingsPage';

const mockUseEmailSettings = vi.mocked(useEmailSettings);
const mockUsePermissions = vi.mocked(usePermissions);

const WRITE_PERMISSIONS = ['system_settings:read', 'system_settings:write'];
const READ_ONLY_PERMISSIONS = ['system_settings:read'];

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

const baseSettings: EmailSettings = {
  provider: 'smtp',
  enabled: true,
  fromAddress: 'no-reply@example.com',
  fromName: 'Example App',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpUsername: 'relay-user',
  // Deliberately absent — see the smtpUseTls default test below.
  smtpUseTls: undefined,
  smtpPasswordStatus: {
    configured: true,
    hint: '••••ab12',
    updatedAt: '2024-01-01T00:00:00.000Z',
    updatedByUserId: 'admin-user-id',
  },
  settingsError: null,
  version: 3,
  updatedAt: '2024-01-01T00:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

function setHook(overrides: Partial<ReturnType<typeof useEmailSettings>> = {}) {
  const save = vi.fn().mockResolvedValue(true);
  const sendTest = vi.fn().mockResolvedValue(undefined);
  mockUseEmailSettings.mockReturnValue({
    settings: baseSettings,
    isLoading: false,
    loadError: null,
    isSaving: false,
    saveError: null,
    isTesting: false,
    testResult: null,
    save,
    sendTest,
    clearTestResult: vi.fn(),
    clearSaveError: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  });
  return { save, sendTest };
}

const renderAsAdmin = () => render(<EmailSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

describe('EmailSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(WRITE_PERMISSIONS);
    setHook();
  });

  // ==========================================================================
  // A 200 with success: false renders as FAILURE, never success
  // ==========================================================================

  describe('test result rendering', () => {
    it('renders success: false as a failure, not a success', () => {
      const testResult: EmailTestResult = {
        success: false,
        error: 'SMTP: 535 Authentication failed',
        sentTo: 'admin@example.com',
        providerKind: 'smtp',
        messageId: null,
      };
      setHook({ testResult });

      renderAsAdmin();

      expect(screen.getByText('Test email failed')).toBeInTheDocument();
      expect(screen.queryByText('Test email accepted by the provider')).not.toBeInTheDocument();
    });

    it('renders success: true as a success', () => {
      const testResult: EmailTestResult = {
        success: true,
        error: null,
        sentTo: 'admin@example.com',
        providerKind: 'smtp',
        messageId: 'msg-123',
      };
      setHook({ testResult });

      renderAsAdmin();

      expect(screen.getByText('Test email accepted by the provider')).toBeInTheDocument();
      expect(screen.queryByText('Test email failed')).not.toBeInTheDocument();
    });

    it('renders the provider error text verbatim and in full, never truncated', () => {
      const longError =
        'SMTP: 550 5.1.1 The email account that you tried to reach does not exist. ' +
        'Please try double-checking the recipient email address for typos or unnecessary spaces. ' +
        'For more information, review the following diagnostic details: connection refused by ' +
        'relay smtp-relay.internal.example.com on port 587 after three retries over ninety seconds.';
      const testResult: EmailTestResult = {
        success: false,
        error: longError,
        sentTo: 'admin@example.com',
        providerKind: 'smtp',
        messageId: null,
      };
      setHook({ testResult });

      renderAsAdmin();

      expect(screen.getByText(longError)).toBeInTheDocument();
    });

    it('treats a call-level failure (no providerKind, hook-built result) the same way: still a failure', () => {
      const testResult: EmailTestResult = {
        success: false,
        error: 'The test request could not be sent',
      };
      setHook({ testResult });

      renderAsAdmin();

      expect(screen.getByText('Test email failed')).toBeInTheDocument();
      expect(screen.getByText('The test request could not be sent')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // The test button: disabled, with a visible reason, in five situations
  // ==========================================================================

  describe('test button disabled reasons', () => {
    it('is disabled while saving, with a stated reason', () => {
      setHook({ isSaving: true });

      renderAsAdmin();

      const button = screen.getByRole('button', { name: /send test email/i });
      expect(button).toBeDisabled();
      expect(
        screen.getByText(/saving — wait for the save to finish, then test/i),
      ).toBeInTheDocument();
    });

    it('is disabled while a test is already in flight', () => {
      setHook({ isTesting: true });

      renderAsAdmin();

      expect(screen.getByRole('button', { name: /sending…/i })).toBeDisabled();
    });

    it('is disabled when the form is dirty, with a stated reason', async () => {
      const user = userEvent.setup();
      setHook();

      renderAsAdmin();
      await user.type(screen.getByLabelText(/from name/i), '!');

      const button = screen.getByRole('button', { name: /send test email/i });
      await waitFor(() => expect(button).toBeDisabled());
      expect(
        screen.getByText(/save your changes first.*test uses the saved configuration/i),
      ).toBeInTheDocument();
    });

    it('is disabled without system_settings:write, with a stated reason', () => {
      setPermissions(READ_ONLY_PERMISSIONS);
      setHook();

      renderAsAdmin();

      const button = screen.getByRole('button', { name: /send test email/i });
      expect(button).toBeDisabled();
      expect(
        screen.getByText(/sending a test needs permission to change system settings/i),
      ).toBeInTheDocument();
    });

    it('is disabled when no provider is configured, with a stated reason', () => {
      setHook({ settings: { ...baseSettings, provider: null } });

      renderAsAdmin();

      const button = screen.getByRole('button', { name: /send test email/i });
      expect(button).toBeDisabled();
      expect(
        screen.getByText(/no provider is configured, so there is nothing to send with/i),
      ).toBeInTheDocument();
    });

    it('is enabled with none of the above blockers', () => {
      setHook();

      renderAsAdmin();

      expect(screen.getByRole('button', { name: /send test email/i })).not.toBeDisabled();
    });
  });

  // ==========================================================================
  // settingsError renders a warning saying the fields shown are defaults
  // ==========================================================================

  describe('settingsError banner', () => {
    it('renders a warning explaining the fields are defaults, not stored config', () => {
      setHook({
        settings: {
          ...baseSettings,
          settingsError:
            'The stored email configuration is invalid at: provider. Correct those fields and save to repair it.',
        },
      });

      renderAsAdmin();

      expect(
        screen.getByText('The stored email configuration could not be read'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/fields below are\s*defaults rather than your saved values/i),
      ).toBeInTheDocument();
    });

    it('is absent on the normal (settingsError: null) path', () => {
      setHook();

      renderAsAdmin();

      expect(
        screen.queryByText('The stored email configuration could not be read'),
      ).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // provider + enabled mapping
  // ==========================================================================

  describe('provider and enabled mapping', () => {
    it('provider: null selects no radio', () => {
      setHook({ settings: { ...baseSettings, provider: null, enabled: false } });

      renderAsAdmin();

      expect(screen.getByRole('radio', { name: 'Amazon SES' })).not.toBeChecked();
      expect(screen.getByRole('radio', { name: 'SMTP' })).not.toBeChecked();
    });

    it('choosing a provider does NOT flip enabled', async () => {
      const user = userEvent.setup();
      setHook({ settings: { ...baseSettings, provider: null, enabled: false } });

      renderAsAdmin();

      const enabledSwitch = screen.getByRole('switch', {
        name: 'Send email from this application',
      });
      expect(enabledSwitch).not.toBeChecked();

      await user.click(screen.getByRole('radio', { name: 'SMTP' }));

      expect(screen.getByRole('radio', { name: 'SMTP' })).toBeChecked();
      // Still unchanged — provider and enabled are separate axes.
      expect(enabledSwitch).not.toBeChecked();
    });

    it('an already-configured provider keeps its radio checked', () => {
      setHook({ settings: { ...baseSettings, provider: 'ses', enabled: true } });

      renderAsAdmin();

      expect(screen.getByRole('radio', { name: 'Amazon SES' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'SMTP' })).not.toBeChecked();
    });
  });

  // ==========================================================================
  // smtpUseTls defaults to ON when absent (load-bearing: maps to requireTLS)
  // ==========================================================================

  describe('smtpUseTls default', () => {
    it('defaults the Require TLS switch to ON when smtpUseTls is absent from the settings', () => {
      setHook({ settings: { ...baseSettings, provider: 'smtp', smtpUseTls: undefined } });

      renderAsAdmin();

      const tlsSwitch = screen.getByRole('switch', { name: 'Require TLS' });
      expect(tlsSwitch).toBeChecked();
    });

    it('the control is labelled about requiring TLS, not about port 465', () => {
      setHook({ settings: { ...baseSettings, provider: 'smtp' } });

      renderAsAdmin();

      // A query for a switch literally named "Require TLS" is itself the
      // assertion: if the control were mislabelled around port 465 instead,
      // this query would not find it.
      expect(screen.getByRole('switch', { name: 'Require TLS' })).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: /465/ })).not.toBeInTheDocument();
    });

    it('reflects smtpUseTls: false when the API explicitly stored it off', () => {
      setHook({ settings: { ...baseSettings, provider: 'smtp', smtpUseTls: false } });

      renderAsAdmin();

      expect(screen.getByRole('switch', { name: 'Require TLS' })).not.toBeChecked();
    });
  });

  // ==========================================================================
  // Gating and chrome (light coverage — the deep permission-registry
  // assertions live in destinations.test.ts)
  // ==========================================================================

  describe('page gating', () => {
    it('redirects away when the user holds no system_settings permission at all', () => {
      setPermissions([]);
      setHook();

      renderAsAdmin();

      expect(screen.queryByRole('heading', { name: 'Email' })).not.toBeInTheDocument();
    });

    it('marks itself read-only in the subtitle for a reader without write access', () => {
      setPermissions(READ_ONLY_PERMISSIONS);
      setHook();

      renderAsAdmin();

      expect(screen.getByText(/\(read-only\)/i)).toBeInTheDocument();
    });
  });
});
