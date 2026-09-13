/**
 * `MaintenanceGate` — issue #258, epic #254.
 *
 * THE ACCEPTANCE CRITERION OF THE WHOLE ISSUE, asserted end to end rather than
 * against the store: a child component makes an ordinary API call, the server
 * refuses it, and the only difference between the two headline cases is whether
 * that 503 carries the marker.
 *
 * Nothing here calls `reportMaintenanceBlock` by hand. Seeding the store
 * directly would prove the gate renders what it is told and would prove nothing
 * about the path that actually matters — a page that knows nothing about
 * maintenance, an interception it never asked for, and a 503 that must be
 * classified correctly on the way past. The child below is deliberately a
 * component of the dullest possible kind for that reason.
 */

import { useEffect, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../mocks/server';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { MaintenanceGate } from '../../../components/common/MaintenanceGate';
import { api } from '../../../services/api';
import {
  MAINTENANCE_ADMIN_PATH,
  MAINTENANCE_ERROR_MARKER,
  clearMaintenanceBlock,
} from '../../../services/maintenance';

const OPERATOR_MESSAGE = 'Upgrading the database. Back at 03:00 UTC.';

function maintenance503() {
  return HttpResponse.json(
    {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: OPERATOR_MESSAGE,
      details: {
        reason: MAINTENANCE_ERROR_MARKER,
        retryAfterSeconds: 30,
        allowAdmins: true,
      },
    },
    { status: 503 },
  );
}

function plain503() {
  return HttpResponse.json(
    { statusCode: 503, code: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable' },
    { status: 503 },
  );
}

/**
 * A page that knows nothing about maintenance: it fetches, and it renders
 * whatever error it got, exactly as every real page in this app already does.
 * That ignorance is the point — it is what "every existing call site inherits
 * it with no change" means.
 */
function OrdinaryPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get('/users').catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div>
      <h1>Ordinary page</h1>
      {error && <p>Something went wrong: {error}</p>}
    </div>
  );
}

describe('MaintenanceGate', () => {
  beforeEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  afterEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  it('renders the maintenance screen — with the operator’s own message — for a 503 CARRYING the marker', async () => {
    server.use(http.get('*/api/users', () => maintenance503()));

    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
    );

    expect(await screen.findByText(OPERATOR_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/under maintenance/i);
    // The application is GONE, not merely covered: the gate swaps the subtree
    // so the retry can remount it and re-run its fetches.
    expect(screen.queryByText('Ordinary page')).not.toBeInTheDocument();
  });

  it('does NOT render the maintenance screen for an ordinary 503 with no marker — the page keeps its own error', async () => {
    // The distinction the whole feature rests on. A crashed API, an exhausted
    // pool or a proxy with no backend answers 503 too, and the user must be
    // shown the failure their page already knew how to describe.
    server.use(http.get('*/api/users', () => plain503()));

    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
    );

    expect(
      await screen.findByText(/Something went wrong: Service Unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByText('Ordinary page')).toBeInTheDocument();
    expect(screen.queryByText(/under maintenance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(OPERATOR_MESSAGE)).not.toBeInTheDocument();
  });

  it('renders the application untouched when nothing has failed at all', async () => {
    server.use(http.get('*/api/users', () => HttpResponse.json({ data: [] })));

    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
    );

    expect(await screen.findByText('Ordinary page')).toBeInTheDocument();
    expect(screen.queryByText(/under maintenance/i)).not.toBeInTheDocument();
  });

  it('brings the application back — and re-runs its requests — when the retry is pressed', async () => {
    // The window closes between the two calls. Remounting the subtree is what
    // makes the second one happen: the gate does not reload the document, which
    // would throw away the in-memory access token and send the user back
    // through sign-in.
    let calls = 0;
    server.use(
      http.get('*/api/users', () => {
        calls += 1;
        return calls === 1 ? maintenance503() : HttpResponse.json({ data: [] });
      }),
    );

    const user = userEvent.setup();
    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
    );

    expect(await screen.findByText(OPERATOR_MESSAGE)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Ordinary page')).toBeInTheDocument();
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.queryByText(/under maintenance/i)).not.toBeInTheDocument();
  });

  it('never gates the maintenance settings route itself', async () => {
    // The client mirror of `@AllowDuringMaintenance()` on the API's own
    // maintenance controller. Without this, an administrator caught by an
    // `allowAdmins: false` window can reach the endpoint that would close it
    // and not the page in front of that endpoint.
    server.use(http.get('*/api/users', () => maintenance503()));

    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
      { wrapperOptions: { route: MAINTENANCE_ADMIN_PATH, user: mockAdminUser } },
    );

    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
    expect(screen.getByText('Ordinary page')).toBeInTheDocument();
    expect(screen.queryByText(/under maintenance/i)).not.toBeInTheDocument();
  });

  it('does not extend that exemption to a route that merely starts with the same characters', async () => {
    server.use(http.get('*/api/users', () => maintenance503()));

    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
      { wrapperOptions: { route: `${MAINTENANCE_ADMIN_PATH}-history`, user: mockAdminUser } },
    );

    expect(await screen.findByText(OPERATOR_MESSAGE)).toBeInTheDocument();
  });
});

describe('the maintenance screen’s copy', () => {
  beforeEach(() => clearMaintenanceBlock());
  afterEach(() => clearMaintenanceBlock());

  it('offers an administrator the page that closes the window', async () => {
    server.use(http.get('*/api/users', () => maintenance503()));

    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
      { wrapperOptions: { user: mockAdminUser } },
    );

    const link = await screen.findByRole('link', { name: /open maintenance settings/i });
    expect(link).toHaveAttribute('href', MAINTENANCE_ADMIN_PATH);
  });

  it('offers an ordinary user no such link, and tells them what allowAdmins means for them', async () => {
    // `allowAdmins` is on the 503 body precisely so the client can tell "come
    // back later" apart from "sign in as an administrator and carry on" —
    // different instructions, and guessing would send half the audience down a
    // path that cannot work.
    server.use(http.get('*/api/users', () => maintenance503()));

    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
      { wrapperOptions: { user: mockUser } },
    );

    expect(await screen.findByText(OPERATOR_MESSAGE)).toBeInTheDocument();
    expect(
      screen.getByText(/Administrators can still use the application/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /open maintenance settings/i }),
    ).not.toBeInTheDocument();
  });

  it('says nothing about administrators when the window turns them away too', async () => {
    server.use(
      http.get('*/api/users', () =>
        HttpResponse.json(
          {
            message: OPERATOR_MESSAGE,
            details: {
              reason: MAINTENANCE_ERROR_MARKER,
              retryAfterSeconds: 30,
              allowAdmins: false,
            },
          },
          { status: 503 },
        ),
      ),
    );

    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
      { wrapperOptions: { user: mockUser } },
    );

    expect(await screen.findByText(OPERATOR_MESSAGE)).toBeInTheDocument();
    expect(
      screen.queryByText(/Administrators can still use the application/i),
    ).not.toBeInTheDocument();
  });

  it('reports the delay the API actually asked for, not a hardcoded one', async () => {
    server.use(
      http.get('*/api/users', () =>
        HttpResponse.json(
          {
            message: OPERATOR_MESSAGE,
            details: {
              reason: MAINTENANCE_ERROR_MARKER,
              retryAfterSeconds: 90,
              allowAdmins: true,
            },
          },
          { status: 503 },
        ),
      ),
    );

    render(
      <MaintenanceGate>
        <OrdinaryPage />
      </MaintenanceGate>,
    );

    expect(await screen.findByText(/about 90 seconds/i)).toBeInTheDocument();
  });
});
