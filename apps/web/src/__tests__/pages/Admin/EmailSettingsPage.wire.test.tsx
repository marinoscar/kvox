/**
 * `/admin/settings/email` — the blank-password WIRE contract (issue #124,
 * epic #109, restating #115).
 *
 * Deliberately NOT mocking `useEmailSettings`: the key-omission behaviour
 * lives in the page's own `toInput()`, which the hook just forwards
 * unchanged. Asserting it therefore means capturing the ACTUAL HTTP request
 * body a real save produces — `usePermissions` and `useAuth` are real too
 * (via `mockAdminUser`), and only the network is faked, with MSW.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import EmailSettingsPage from '../../../pages/Admin/EmailSettingsPage';
import type { EmailSettings } from '../../../types';

const storedSettings: EmailSettings = {
  provider: 'smtp',
  enabled: true,
  fromAddress: 'no-reply@example.com',
  fromName: 'Example App',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpUsername: 'relay-user',
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
};

function mockGet() {
  server.use(
    http.get('*/api/email-settings', () => HttpResponse.json({ data: storedSettings })),
  );
}

function mockPut(onBody: (body: Record<string, unknown>) => void) {
  server.use(
    http.put('*/api/email-settings', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      onBody(body);
      return HttpResponse.json({
        data: { ...storedSettings, ...body, version: storedSettings.version + 1 },
      });
    }),
  );
}

describe('EmailSettingsPage — save request wire contract', () => {
  beforeEach(() => {
    server.resetHandlers();
    mockGet();
  });

  it('submitting with the password field left empty omits smtpPassword from the request body entirely', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mockPut((body) => {
      capturedBody = body;
    });

    const user = userEvent.setup();
    render(<EmailSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

    // Wait for the real hook's initial GET to land and the form to mount.
    await screen.findByLabelText(/from name/i);

    // Dirty the form WITHOUT touching the password field.
    await user.type(screen.getByLabelText(/from name/i), ' Edited');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(capturedBody as object, 'smtpPassword')).toBe(
      false,
    );
  });

  it('typing a new password DOES include smtpPassword, with the typed value, in the request body', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mockPut((body) => {
      capturedBody = body;
    });

    const user = userEvent.setup();
    render(<EmailSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByLabelText(/^password$/i);

    await user.type(screen.getByLabelText(/^password$/i), 'a-freshly-typed-password');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect((capturedBody as unknown as { smtpPassword?: string })?.smtpPassword).toBe(
      'a-freshly-typed-password',
    );
  });
});
