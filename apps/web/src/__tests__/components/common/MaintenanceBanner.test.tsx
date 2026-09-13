/**
 * `MaintenanceBanner` — issue #258, epic #254.
 *
 * The acceptance criterion is "appears only for an admin bypassing an active
 * window", and it splits into three independently testable halves:
 *
 *   * AN ACTIVE WINDOW — the banner is driven by the API's answer, not by a
 *     guess, so a closed window renders nothing;
 *   * AN ADMIN — `system_settings:read`, the exact string the maintenance
 *     controller enforces, and for anyone else the component does not even ASK
 *     (asserted below by counting requests, not just by looking at the DOM —
 *     a component that renders null while firing a 403 a minute per viewer
 *     would pass the visual assertion and still be wrong);
 *   * BYPASSING — which is structural rather than a predicate: the banner
 *     renders inside `MaintenanceGate`'s children, and a blocked viewer never
 *     reaches it because the gate has replaced that subtree. The composition
 *     test at the bottom pins exactly that, so the property cannot quietly
 *     become untrue if the banner is ever mounted somewhere else.
 *
 * The API is driven through msw rather than by mocking `useMaintenance`: the
 * permission-to-request relationship is the interesting part and a mocked hook
 * makes it unobservable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { server } from '../../mocks/server';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import type { MockUser } from '../../utils/test-utils';
import { MaintenanceBanner } from '../../../components/common/MaintenanceBanner';
import { MaintenanceGate } from '../../../components/common/MaintenanceGate';
import { api } from '../../../services/api';
import {
  MAINTENANCE_ADMIN_PATH,
  clearMaintenanceBlock,
  reportMaintenanceBlock,
} from '../../../services/maintenance';
import type { MaintenanceStatus } from '../../../types';

function status(overrides: Partial<MaintenanceStatus> = {}): MaintenanceStatus {
  return {
    enabled: true,
    message: 'Back at 03:00 UTC.',
    allowAdmins: true,
    startedAt: '2026-01-01T02:00:00.000Z',
    startedById: 'admin-user-id',
    source: 'persisted',
    layers: {
      env: { present: false, enabled: null },
      memory: { present: false, override: null },
      persisted: {
        readable: true,
        value: {
          enabled: true,
          message: 'Back at 03:00 UTC.',
          allowAdmins: true,
          startedAt: '2026-01-01T02:00:00.000Z',
          startedById: 'admin-user-id',
        },
      },
    },
    ...overrides,
  };
}

/** Serve a status and count how many times the endpoint was actually asked. */
function serveStatus(value: MaintenanceStatus): { calls: () => number } {
  let calls = 0;
  server.use(
    http.get('*/api/admin/maintenance', () => {
      calls += 1;
      return HttpResponse.json({ data: value });
    }),
  );
  return { calls: () => calls };
}

/** A viewer holding `system_settings:read` but nothing else that matters here. */
const readOnlyAdmin: MockUser = {
  ...mockAdminUser,
  permissions: ['system_settings:read'],
};

describe('MaintenanceBanner', () => {
  beforeEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  afterEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  it('warns an administrator that a window is open', async () => {
    serveStatus(status());

    render(<MaintenanceBanner />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText('Maintenance mode is on')).toBeInTheDocument();
    // What their users are experiencing right now — the fact they are at risk
    // of forgetting.
    expect(
      screen.getByText(/Everyone except administrators is being turned away/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /manage/i })).toHaveAttribute(
      'href',
      MAINTENANCE_ADMIN_PATH,
    );
  });

  it('renders nothing when no window is open', async () => {
    const probe = serveStatus(status({ enabled: false }));

    render(<MaintenanceBanner />, { wrapperOptions: { user: mockAdminUser } });

    await waitFor(() => expect(probe.calls()).toBe(1));
    expect(screen.queryByText('Maintenance mode is on')).not.toBeInTheDocument();
  });

  it('renders nothing for a user without system_settings:read — AND never asks', async () => {
    // Two assertions, and the second is the one that would be missed. This
    // component mounts in the shell for every signed-in user; firing anyway
    // would buy one predictable 403 a minute per viewer, forever, on every
    // deployment.
    const probe = serveStatus(status());

    render(<MaintenanceBanner />, { wrapperOptions: { user: mockUser } });

    await waitFor(() => expect(screen.queryByText('Maintenance mode is on')).toBeNull());
    expect(probe.calls()).toBe(0);
  });

  it('is enough to hold system_settings:read alone — it is a reminder, not a control', async () => {
    serveStatus(status());

    render(<MaintenanceBanner />, { wrapperOptions: { user: readOnlyAdmin } });

    expect(await screen.findByText('Maintenance mode is on')).toBeInTheDocument();
  });

  it('names the environment when that is the layer holding the window open', async () => {
    // Which layer decided is not trivia here: an env override will not yield to
    // the page the banner's own "Manage" button links to, so an admin who was
    // not told would go there and find a switch that does nothing.
    serveStatus(status({ source: 'env', layers: { ...status().layers, env: { present: true, enabled: true } } }));

    render(<MaintenanceBanner />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText(/forced on by this deployment/i)).toBeInTheDocument();
  });

  it('says so when the window turns administrators away too', async () => {
    serveStatus(status({ allowAdmins: false }));

    render(<MaintenanceBanner />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText(/Administrators are not exempt/i)).toBeInTheDocument();
  });

  it('stays quiet on the maintenance page itself', async () => {
    // That page's body is a fuller, editable statement of the same thing;
    // repeating it directly above would read as two disagreeing controls for
    // one switch.
    const probe = serveStatus(status());

    render(<MaintenanceBanner />, {
      wrapperOptions: { user: mockAdminUser, route: MAINTENANCE_ADMIN_PATH },
    });

    await waitFor(() => expect(probe.calls()).toBe(1));
    expect(screen.queryByText('Maintenance mode is on')).not.toBeInTheDocument();
  });

  it('renders nothing when the status cannot be loaded', async () => {
    // A banner that appeared on an error would announce a window that may not
    // exist — the exact unverifiable guess this feature was built to avoid.
    server.use(
      http.get('*/api/admin/maintenance', () =>
        HttpResponse.json({ message: 'Boom' }, { status: 500 }),
      ),
    );

    render(<MaintenanceBanner />, { wrapperOptions: { user: mockAdminUser } });

    await waitFor(() => expect(screen.queryByText('Maintenance mode is on')).toBeNull());
  });
});

describe('MaintenanceBanner — “bypassing” is structural', () => {
  beforeEach(() => clearMaintenanceBlock());
  afterEach(() => clearMaintenanceBlock());

  it('is unreachable for an administrator who is actually being blocked', async () => {
    // The banner lives inside the gate's children. A viewer the API is
    // refusing gets the maintenance screen instead of the whole subtree, so the
    // banner cannot render for them — which is why the component itself has no
    // "am I bypassing?" predicate to get wrong.
    serveStatus(status());
    reportMaintenanceBlock({
      message: 'Everything is refused, administrators included.',
      retryAfterSeconds: 30,
      allowAdmins: false,
    });

    render(
      <MaintenanceGate>
        <MaintenanceBanner />
      </MaintenanceGate>,
      { wrapperOptions: { user: mockAdminUser } },
    );

    expect(
      await screen.findByText('Everything is refused, administrators included.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Maintenance mode is on')).not.toBeInTheDocument();
  });

  it('appears once the same administrator is let through', async () => {
    serveStatus(status());

    render(
      <MaintenanceGate>
        <MaintenanceBanner />
      </MaintenanceGate>,
      { wrapperOptions: { user: mockAdminUser } },
    );

    expect(await screen.findByText('Maintenance mode is on')).toBeInTheDocument();
  });
});
