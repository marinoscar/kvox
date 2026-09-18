/**
 * Admin → Users & Allowlist — the Allowlist tab's "outbound email is not
 * configured" warning (issue #300, epic #271).
 *
 * A SEPARATE FILE FROM `UsersPage.test.tsx`, deliberately. That suite mocks
 * `usePermissions` wholesale and stubs both child components, which is right
 * for what it covers (the page gate, the tabs, the tab gate) and is exactly
 * wrong for this: every assertion here is about which permission the session
 * holds and which request that does or does not produce, so the real
 * `usePermissions` reading a real fixture user is the thing under test.
 *
 * What IS mocked is `useAllowlist` — the table's own data, which has nothing to
 * do with email — following `components/admin/AllowlistTable.test.tsx`. Only
 * `/api/email-settings` is faked at the network, because whether that request
 * is issued at all is one of the behaviours being asserted.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import UsersPage from '../../../pages/Admin/UsersPage';
import {
  EMAIL_SETTINGS_PATH,
  EmailNotConfiguredNotice,
} from '../../../components/admin/AllowlistEmailWarning';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import type { AllowedEmailEntry, EmailSettings } from '../../../types';

vi.mock('../../../hooks/useAllowlist', () => ({
  useAllowlist: vi.fn(),
}));

import { useAllowlist } from '../../../hooks/useAllowlist';

const mockUseAllowlist = vi.mocked(useAllowlist);

const API_BASE = 'http://localhost:3000/api';

/**
 * Every request this file's renders made, as `METHOD /path`.
 *
 * ⚠ ONE OBSERVER, REGISTERED AT MODULE SCOPE AND NEVER TORN DOWN — the
 * discipline `HomePage.test.tsx` and `OnboardingContext.test.tsx` spell out. A
 * listener removed in a `finally` removes EVERY listener on the shared server,
 * and the "no request was issued" assertion below would then pass against an
 * array nothing writes to, which is the one way it could lie.
 */
let requests: string[] = [];

server.events.on('request:start', ({ request }) => {
  requests.push(`${request.method} ${new URL(request.url).pathname}`);
});

function emailSettingsRequestCount(): number {
  return requests.filter((entry) => entry === 'GET /api/email-settings').length;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const entry: AllowedEmailEntry = {
  id: 'entry-1',
  email: 'pending@example.com',
  notes: null,
  addedAt: '2024-01-15T10:00:00Z',
  claimedAt: null,
  addedBy: { id: 'admin-user-id', email: 'admin@example.com' },
  claimedBy: null,
};

/** A stored configuration, with the two axes left to each test to set. */
function emailSettings(overrides: Partial<EmailSettings> = {}): EmailSettings {
  return {
    provider: 'smtp',
    enabled: true,
    fromAddress: 'no-reply@example.com',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUseTls: true,
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
    ...overrides,
  };
}

const mockAddEmail = vi.fn();

function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

/** Everything the Allowlist tab needs, plus the email probe's answer. */
const ALLOWLIST_PERMISSIONS = [
  'users:read',
  'allowlist:read',
  'allowlist:write',
];

function mockEmailSettings(settings: EmailSettings) {
  server.use(
    http.get(`${API_BASE}/email-settings`, () => HttpResponse.json({ data: settings })),
  );
}

/** Render the page and switch to the Allowlist tab, where the warning lives. */
async function openAllowlistTab(permissions: string[]) {
  const user = userEvent.setup();
  setInitialContainerWidth(1400);

  render(<UsersPage />, { wrapperOptions: { user: userWith(permissions) } });
  await user.click(screen.getByRole('tab', { name: /allowlist/i }));

  // The tab's own content is present, so a missing warning below is a decision
  // rather than a panel that never rendered at all.
  await screen.findByRole('heading', { name: /email allowlist/i });

  return user;
}

function warning(): HTMLElement | null {
  return screen.queryByTestId('allowlist-email-warning');
}

// ---------------------------------------------------------------------------

describe('UsersPage — outbound email warning on the Allowlist tab', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    requests = [];

    mockUseAllowlist.mockReturnValue({
      entries: [entry],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
      isLoading: false,
      error: null,
      fetchAllowlist: vi.fn(),
      addEmail: mockAddEmail,
      removeEmail: vi.fn(),
    });
    mockAddEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetContainerWidth();
  });

  describe('when the probe says mail cannot be sent', () => {
    it('warns that the invited person will not be emailed', async () => {
      mockEmailSettings(emailSettings({ provider: null, enabled: false }));

      await openAllowlistTab([...ALLOWLIST_PERMISSIONS, 'system_settings:read']);

      const strip = await screen.findByTestId('allowlist-email-warning');
      expect(strip).toHaveTextContent(/outbound email is not configured/i);
      expect(strip).toHaveTextContent(/will not receive an email/i);
    });

    /**
     * ⚠ THE PREDICATE IS `provider !== null && enabled`, both halves.
     *
     * A transport is configured here and mail is switched off, which is a real,
     * deliberate state (`email-settings.schema.ts` keeps the two axes apart so
     * a maintenance window costs no retyping) — and it sends exactly as much
     * mail as a fresh install does. A warning that read only `provider` would
     * stay silent through it.
     */
    it('warns when a transport is configured but mail is switched off', async () => {
      mockEmailSettings(emailSettings({ provider: 'smtp', enabled: false }));

      await openAllowlistTab([...ALLOWLIST_PERMISSIONS, 'system_settings:read']);

      expect(await screen.findByTestId('allowlist-email-warning')).toBeInTheDocument();
    });

    it('offers the fix to a caller holding system_settings:read', async () => {
      mockEmailSettings(emailSettings({ provider: null, enabled: false }));

      await openAllowlistTab([...ALLOWLIST_PERMISSIONS, 'system_settings:read']);

      const link = await screen.findByRole('link', { name: /configure email/i });
      expect(link).toHaveAttribute('href', EMAIL_SETTINGS_PATH);
    });

    /**
     * ⚠ IT WARNS, IT NEVER BLOCKS. An administrator inviting somebody they will
     * tell out of band is doing a legitimate thing — the thing this app did
     * before invitations existed — so the add control stays live and the
     * address still reaches the API.
     */
    it('still adds an address while the warning is up', async () => {
      mockEmailSettings(emailSettings({ provider: null, enabled: false }));

      const user = await openAllowlistTab([
        ...ALLOWLIST_PERMISSIONS,
        'system_settings:read',
      ]);
      await screen.findByTestId('allowlist-email-warning');

      const add = screen.getByRole('button', { name: /add email/i });
      expect(add).toBeEnabled();
      await user.click(add);

      const dialog = await screen.findByRole('dialog');
      await user.type(
        screen.getByRole('textbox', { name: /email address/i }),
        'invitee@example.com',
      );
      await user.click(
        within(dialog).getByRole('button', { name: /^add email$/i }),
      );

      await waitFor(() => {
        expect(mockAddEmail).toHaveBeenCalledWith('invitee@example.com', undefined);
      });

      // And the warning is still there afterwards: it describes the deployment,
      // not the submission.
      expect(warning()).toBeInTheDocument();
    });
  });

  describe('when there is nothing true to say', () => {
    it('says nothing when mail is configured', async () => {
      mockEmailSettings(emailSettings({ provider: 'smtp', enabled: true }));

      await openAllowlistTab([...ALLOWLIST_PERMISSIONS, 'system_settings:read']);

      // The probe has to have landed before "absent" means anything.
      await waitFor(() => expect(emailSettingsRequestCount()).toBe(1));
      expect(warning()).not.toBeInTheDocument();
    });

    it('says nothing while the probe is in flight', async () => {
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      server.use(
        http.get(`${API_BASE}/email-settings`, async () => {
          await held;
          return HttpResponse.json({
            data: emailSettings({ provider: null, enabled: false }),
          });
        }),
      );

      await openAllowlistTab([...ALLOWLIST_PERMISSIONS, 'system_settings:read']);

      await waitFor(() => expect(emailSettingsRequestCount()).toBe(1));
      expect(warning()).not.toBeInTheDocument();

      // Released, the same render shows it — so the silence above was the
      // in-flight state and not a warning that can never appear.
      release?.();
      expect(await screen.findByTestId('allowlist-email-warning')).toBeInTheDocument();
    });

    it('says nothing when the probe fails', async () => {
      server.use(
        http.get(`${API_BASE}/email-settings`, () =>
          HttpResponse.json(
            { error: { code: 'INTERNAL', message: 'boom' } },
            { status: 500 },
          ),
        ),
      );

      await openAllowlistTab([...ALLOWLIST_PERMISSIONS, 'system_settings:read']);

      await waitFor(() => expect(emailSettingsRequestCount()).toBe(1));
      expect(warning()).not.toBeInTheDocument();
      // Nor does the failure itself reach the page.
      expect(screen.queryByText(/failed to load email settings/i)).not.toBeInTheDocument();
    });
  });

  describe('without system_settings:read', () => {
    /**
     * The session already knows the answer: `GET /api/email-settings` is
     * `system_settings:read` (`email-settings.controller.ts`), so a caller
     * without it would collect a 403 for an answer they could not read. Nothing
     * is sent — the same position `OnboardingContext` takes for the admin
     * checklist.
     */
    it('issues no request at all, and shows nothing', async () => {
      mockEmailSettings(emailSettings({ provider: null, enabled: false }));

      await openAllowlistTab(ALLOWLIST_PERMISSIONS);

      // Settled: the table's own content rendered, and a request would have
      // been recorded by now if one had been made.
      await waitFor(() => expect(screen.getByRole('button', { name: /add email/i })).toBeEnabled());
      expect(emailSettingsRequestCount()).toBe(0);
      expect(warning()).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /configure email/i })).not.toBeInTheDocument();
    });
  });

  /**
   * The strip with no link is a real rendering, asserted directly rather than
   * through a permission set that cannot produce it today: the same string
   * gates the probe and the link, so a warning with no link is reachable only
   * if the fact is ever learned some other way. That is exactly why the notice
   * takes the decision as a prop instead of reading the permission itself.
   */
  describe('the notice on its own', () => {
    it('states the consequence without offering a page the caller cannot open', () => {
      render(<EmailNotConfiguredNotice canOpenEmailSettings={false} />, {
        wrapperOptions: { user: userWith(ALLOWLIST_PERMISSIONS) },
      });

      expect(screen.getByTestId('allowlist-email-warning')).toHaveTextContent(
        /outbound email is not configured/i,
      );
      expect(screen.queryByRole('link', { name: /configure email/i })).not.toBeInTheDocument();
    });

    it('offers the page when the caller can open it', () => {
      render(<EmailNotConfiguredNotice canOpenEmailSettings />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByRole('link', { name: /configure email/i })).toHaveAttribute(
        'href',
        EMAIL_SETTINGS_PATH,
      );
    });
  });
});
