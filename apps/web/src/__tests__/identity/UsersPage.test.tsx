/**
 * The Reminders tab on the packaged Users & Allowlist page (issue #465).
 *
 * The packaged page's own behaviour (user table, role dialog, allowlist table)
 * is proved by `@marinoscar/platform-web`'s suite. What is KVox's, and so
 * asserted here, is the WIRING: the Reminders tab is appended after the two
 * packaged tabs, only for a viewer holding `allowlist:read`, and it mounts
 * KVox's panel. The panel is stubbed with a marker; its own suite is
 * `components/admin/AllowlistRemindersPanel.test.tsx`.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IdentityWebAdaptersProvider } from '@marinoscar/platform-web/identity/headless';
import type { IdentityApi } from '@marinoscar/platform-web/identity/headless';
import { render, mockAdminUser, type MockUser } from '../utils/test-utils';
import UsersPage from '../../identity/UsersPage';
import { USERS_PAGE_SLOTS } from '../../identity/usersPageSlots';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../services/api';

vi.mock('../../components/admin/AllowlistRemindersPanel', () => ({
  AllowlistRemindersPanel: () => <div data-testid="reminders-panel">reminders panel</div>,
}));

const emptyPage = { items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 };

/** Only what the Users and Allowlist tabs call on mount. */
const fakeIdentityApi = {
  getRoles: vi.fn().mockResolvedValue([]),
  getUsers: vi.fn().mockResolvedValue(emptyPage),
  getAllowlist: vi.fn().mockResolvedValue(emptyPage),
} as unknown as IdentityApi;

const adapters = { api: fakeIdentityApi };

function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

function renderPage(permissions: string[]) {
  setInitialContainerWidth(1400);
  return render(
    <IdentityWebAdaptersProvider adapters={adapters}>
      <UsersPage />
    </IdentityWebAdaptersProvider>,
    { wrapperOptions: { user: userWith(permissions) } },
  );
}

describe('USERS_PAGE_SLOTS', () => {
  it('declares exactly one tab, Reminders, behind allowlist:read', () => {
    expect(USERS_PAGE_SLOTS.Tabs).toHaveLength(1);
    expect(USERS_PAGE_SLOTS.Tabs?.[0]).toMatchObject({
      id: 'reminders',
      label: 'Reminders',
      permission: 'allowlist:read',
    });
  });
});

describe('Users & Allowlist page with the Reminders tab', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends Reminders after Users and Allowlist for a holder of allowlist:read', async () => {
    renderPage(['users:read', 'allowlist:read']);

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Users', 'Allowlist', 'Reminders']);
  });

  it('mounts the Reminders panel when its tab is selected', async () => {
    const user = userEvent.setup();
    renderPage(['users:read', 'allowlist:read']);

    expect(screen.queryByTestId('reminders-panel')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('tab', { name: 'Reminders' }));

    await waitFor(() => expect(screen.getByTestId('reminders-panel')).toBeInTheDocument());
  });

  it('hides the Reminders tab from a viewer without allowlist:read', async () => {
    renderPage(['users:read']);

    await screen.findByRole('tab', { name: 'Users' });
    expect(screen.queryByRole('tab', { name: 'Reminders' })).not.toBeInTheDocument();
  });
});
