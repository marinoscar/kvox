/**
 * Admin → Settings → Maintenance (`/admin/settings/maintenance`), issue #258,
 * epic #254.
 *
 * The acceptance criterion is that the page "shows the effective state and each
 * layer, and reflects an env override as unchangeable from the UI", so the
 * assertions below are about exactly those three things plus the write:
 *
 *   * THE EFFECTIVE STATE — what the deployment is doing to its users right
 *     now, and which layer decided it;
 *   * EVERY LAYER, SEPARATELY, with the "Deciding" badge on the one that won.
 *     This is the page's reason for existing rather than a switch: "I turned it
 *     off and it is still on" is unanswerable without it;
 *   * THE ENV OVERRIDE — the on/off switch is disabled and the reason is
 *     spelled out. What it must NOT disable is asserted too: `MAINTENANCE_MODE`
 *     carries a boolean and nothing else, so the message and `allowAdmins` are
 *     still live and still in force;
 *   * THE PUT — that the body is what the API's `updateMaintenanceSchema`
 *     accepts, and that the RESPONSE (not the input) becomes the new baseline.
 *
 * `usePermissions` is left real and driven through the auth fixture, because
 * read-only-versus-writable is one of the behaviours under test. The API is
 * driven through msw for the same reason it is in the banner's suite: mocking
 * the hook would hide the request shape, which is half of what this page does.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../mocks/server';
import { render, mockAdminUser } from '../../utils/test-utils';
import type { MockUser } from '../../utils/test-utils';
import AdminMaintenancePage from '../../../pages/Admin/MaintenancePage';
import { api } from '../../../services/api';
import { clearMaintenanceBlock } from '../../../services/maintenance';
import type { MaintenanceStatus } from '../../../types';

function status(overrides: Partial<MaintenanceStatus> = {}): MaintenanceStatus {
  const base: MaintenanceStatus = {
    enabled: false,
    message: 'We are performing scheduled maintenance. Please try again shortly.',
    allowAdmins: true,
    startedAt: null,
    startedById: null,
    source: 'persisted',
    layers: {
      env: { present: false, enabled: null },
      memory: { present: false, override: null },
      persisted: {
        readable: true,
        value: {
          enabled: false,
          message: 'We are performing scheduled maintenance. Please try again shortly.',
          allowAdmins: true,
          startedAt: null,
          startedById: null,
        },
      },
    },
  };
  return { ...base, ...overrides };
}

function serveStatus(value: MaintenanceStatus) {
  server.use(http.get('*/api/admin/maintenance', () => HttpResponse.json({ data: value })));
}

/** `system_settings:read` but no `:write` — the diagnosing admin. */
const readOnlyAdmin: MockUser = {
  ...mockAdminUser,
  permissions: ['system_settings:read'],
};

function layerSection() {
  return screen.getByText('Where this setting comes from').closest('div')!;
}

describe('Admin MaintenancePage — the effective state', () => {
  beforeEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  afterEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  it('reports a deployment that is serving normally', async () => {
    serveStatus(status());

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText(/Maintenance mode is off/i)).toBeInTheDocument();
    // Exact, so it matches the "Decided by:" line and not the "3. Saved
    // setting" layer heading further down the page.
    expect(screen.getByText('Saved setting')).toBeInTheDocument();
  });

  it('reports a deployment that is out of service, who is affected, and when it started', async () => {
    serveStatus(
      status({
        enabled: true,
        allowAdmins: true,
        startedAt: '2026-01-01T02:00:00.000Z',
        startedById: 'admin-user-id',
      }),
    );

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(
      await screen.findByText(/Maintenance mode is ON — the application is out of service/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Administrators keep access; everyone else is turned away/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Opened /)).toBeInTheDocument();
  });

  it('says plainly when nobody at all is getting through', async () => {
    serveStatus(status({ enabled: true, allowAdmins: false }));

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(
      await screen.findByText(/Everyone is turned away, administrators included/i),
    ).toBeInTheDocument();
  });
});

describe('Admin MaintenancePage — every contributing layer', () => {
  beforeEach(() => clearMaintenanceBlock());
  afterEach(() => clearMaintenanceBlock());

  it('lists all three layers with what each currently says', async () => {
    serveStatus(status());

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText('1. Environment variable')).toBeInTheDocument();
    expect(screen.getByText('2. Server task')).toBeInTheDocument();
    expect(screen.getByText('3. Saved setting')).toBeInTheDocument();

    expect(screen.getByText(/MAINTENANCE_MODE is not set/)).toBeInTheDocument();
    expect(screen.getByText(/No task on the API is holding the window/)).toBeInTheDocument();
  });

  it('badges the SAVED SETTING as deciding when nothing outranks it', async () => {
    serveStatus(status({ source: 'persisted' }));

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByText('3. Saved setting');
    const badges = within(layerSection()).getAllByText('Deciding');

    // Exactly one, and next to the right layer: the badge is what turns three
    // values into an answer.
    expect(badges).toHaveLength(1);
    expect(screen.getByText('3. Saved setting').parentElement).toHaveTextContent('Deciding');
  });

  it('badges the ENVIRONMENT as deciding when it is the layer that won', async () => {
    // The scenario the layer display exists for: an operator has turned the
    // saved setting off, and the application is still refusing everything.
    serveStatus(
      status({
        enabled: true,
        source: 'env',
        layers: {
          env: { present: true, enabled: true },
          memory: { present: false, override: null },
          persisted: {
            readable: true,
            value: {
              enabled: false,
              message: 'We are performing scheduled maintenance. Please try again shortly.',
              allowAdmins: true,
              startedAt: null,
              startedById: null,
            },
          },
        },
      }),
    );

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByText('1. Environment variable');
    const badges = within(layerSection()).getAllByText('Deciding');

    expect(badges).toHaveLength(1);
    expect(screen.getByText('1. Environment variable').parentElement).toHaveTextContent(
      'Deciding',
    );
    // And the contradiction is on screen rather than left for the operator to
    // infer: the environment says on, the saved row says off.
    expect(screen.getByText(/MAINTENANCE_MODE is set to/)).toBeInTheDocument();
    expect(screen.getByText(/Saved as off/)).toBeInTheDocument();
  });

  it('badges the SERVER TASK as deciding, and describes it as held in memory', async () => {
    serveStatus(
      status({
        enabled: true,
        source: 'memory',
        layers: {
          env: { present: false, enabled: null },
          memory: { present: true, override: { enabled: true } },
          persisted: status().layers.persisted,
        },
      }),
    );

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText(/A task running on the API has taken the window/)).toBeInTheDocument();
    expect(within(layerSection()).getAllByText('Deciding')).toHaveLength(1);
    expect(screen.getByText('2. Server task').parentElement).toHaveTextContent('Deciding');
  });

  it('says so when the saved row could not be read at all', async () => {
    // `readable: false` changes what every other value on the page MEANS — they
    // are the last state the API saw, not the current one.
    serveStatus(
      status({
        layers: {
          env: { present: false, enabled: null },
          memory: { present: false, override: null },
          persisted: { readable: false, value: status().layers.persisted.value },
        },
      }),
    );

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(
      await screen.findByText(/The saved setting could not be read/),
    ).toBeInTheDocument();
  });
});

describe('Admin MaintenancePage — an environment override is unchangeable from the UI', () => {
  beforeEach(() => clearMaintenanceBlock());
  afterEach(() => clearMaintenanceBlock());

  const envForcedOn = status({
    enabled: true,
    source: 'env',
    layers: {
      env: { present: true, enabled: true },
      memory: { present: false, override: null },
      persisted: status().layers.persisted,
    },
  });

  it('disables the on/off switch and explains why, naming the recovery', async () => {
    serveStatus(envForcedOn);

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    const toggle = await screen.findByRole('switch', { name: 'Maintenance mode' });
    expect(toggle).toBeDisabled();

    expect(
      screen.getByText(/environment is forcing maintenance mode/i),
    ).toBeInTheDocument();
    // A disabled control with no stated remedy is indistinguishable from a
    // broken one.
    expect(
      screen.getByText(/Remove the variable from the environment and restart/i),
    ).toBeInTheDocument();
  });

  it('leaves the message and administrator access EDITABLE — the variable carries a boolean and nothing else', async () => {
    // Greying the whole form out would be the easy gesture and the wrong one:
    // these two are resolved from the persisted row even while the environment
    // forces the window open, so they are in force right now and an operator
    // must be able to prepare them.
    serveStatus(envForcedOn);

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByLabelText(/Message shown to users/i)).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Allow administrators' })).toBeEnabled();
  });

  it('leaves the switch enabled when no variable is set', async () => {
    serveStatus(status());

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByRole('switch', { name: 'Maintenance mode' })).toBeEnabled();
  });
});

describe('Admin MaintenancePage — saving', () => {
  beforeEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  afterEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  it('PUTs exactly the fields the API accepts, and adopts the response as the new baseline', async () => {
    let body: unknown = null;
    const after = status({
      enabled: true,
      startedAt: '2026-01-01T02:00:00.000Z',
      startedById: 'admin-user-id',
    });

    serveStatus(status());
    server.use(
      http.put('*/api/admin/maintenance', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: after });
      }),
    );

    const user = userEvent.setup();
    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    await user.click(await screen.findByRole('switch', { name: 'Maintenance mode' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({
      enabled: true,
      message: 'We are performing scheduled maintenance. Please try again shortly.',
      allowAdmins: true,
    });
    // `startedAt` / `startedById` are stamped by the API and refused from a
    // caller — an audit trail the audited party can dictate is not one.
    expect(body).not.toHaveProperty('startedAt');
    expect(body).not.toHaveProperty('startedById');

    // The page now shows what the SERVER says, not what was sent.
    expect(await screen.findByText(/Maintenance mode is ON/i)).toBeInTheDocument();
  });

  it('keeps Save unavailable until something has actually changed', async () => {
    serveStatus(status());

    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('refuses to save an empty message, and says why', async () => {
    // It is the only thing a blocked user is told, and the API's own schema
    // requires it — so failing here beats a 400 the operator could not see
    // coming.
    serveStatus(status());

    const user = userEvent.setup();
    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    await user.clear(await screen.findByLabelText(/Message shown to users/i));

    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByText(/A message is required/i)).toBeInTheDocument();
  });

  it('surfaces a failed save without pretending it worked', async () => {
    serveStatus(status());
    server.use(
      http.put('*/api/admin/maintenance', () =>
        HttpResponse.json({ message: 'Someone else is editing this' }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    render(<AdminMaintenancePage />, { wrapperOptions: { user: mockAdminUser } });

    await user.click(await screen.findByRole('switch', { name: 'Maintenance mode' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Someone else is editing this')).toBeInTheDocument();
    expect(screen.getByText(/Maintenance mode is off/i)).toBeInTheDocument();
  });
});

describe('Admin MaintenancePage — permissions', () => {
  beforeEach(() => clearMaintenanceBlock());
  afterEach(() => clearMaintenanceBlock());

  it('lets a read-only admin diagnose, and lets them change nothing', async () => {
    // The card gate is about REACHABILITY: "is this deployment deliberately out
    // of service, and which layer decided" is worth reading for anyone
    // answering "why is nothing working".
    serveStatus(status({ enabled: true }));

    render(<AdminMaintenancePage />, { wrapperOptions: { user: readOnlyAdmin } });

    expect(await screen.findByText(/Maintenance mode is ON/i)).toBeInTheDocument();
    expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Maintenance mode' })).toBeDisabled();
    expect(screen.getByLabelText(/Message shown to users/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('reports a 403 as a permission problem rather than a mystery', async () => {
    server.use(
      http.get('*/api/admin/maintenance', () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );

    render(<AdminMaintenancePage />, { wrapperOptions: { user: readOnlyAdmin } });

    expect(
      await screen.findByText(/You do not have permission to view maintenance mode/i),
    ).toBeInTheDocument();
  });
});
