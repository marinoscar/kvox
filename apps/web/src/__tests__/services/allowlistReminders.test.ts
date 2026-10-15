import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  getAllowlistReminders,
  reminderErrorMessage,
  sendAllowlistReminder,
} from '../../services/allowlistReminders';
import { ApiError } from '../../services/api';

describe('allowlistReminders service (issue #465: the KVox-owned reminder routes)', () => {
  describe('getAllowlistReminders', () => {
    it('sends the ids comma-separated and resolves the unwrapped rows', async () => {
      let ids: string | null = null;
      server.use(
        http.get('*/api/allowlist/reminders', ({ request }) => {
          ids = new URL(request.url).searchParams.get('ids');
          return HttpResponse.json({
            data: [{ allowedEmailId: 'a', reminderCount: 2, lastReminderAt: '2024-01-18T09:30:00Z' }],
          });
        }),
      );

      const rows = await getAllowlistReminders(['a', 'b']);

      expect(ids).toBe('a,b');
      expect(rows).toEqual([
        { allowedEmailId: 'a', reminderCount: 2, lastReminderAt: '2024-01-18T09:30:00Z' },
      ]);
    });

    it('makes no request for no ids', async () => {
      let called = false;
      server.use(
        http.get('*/api/allowlist/reminders', () => {
          called = true;
          return HttpResponse.json({ data: [] });
        }),
      );

      await expect(getAllowlistReminders([])).resolves.toEqual([]);
      expect(called).toBe(false);
    });
  });

  describe('sendAllowlistReminder', () => {
    it('POSTs with no body to /allowlist/:id/reminder and resolves the new count', async () => {
      let contentType: string | null = 'unset';
      server.use(
        http.post('*/api/allowlist/entry-1/reminder', ({ request }) => {
          contentType = request.headers.get('Content-Type');
          return HttpResponse.json({
            data: { reminderCount: 1, lastReminderAt: '2024-01-19T08:00:00Z' },
          });
        }),
      );

      await expect(sendAllowlistReminder('entry-1')).resolves.toEqual({
        reminderCount: 1,
        lastReminderAt: '2024-01-19T08:00:00Z',
      });
      // Fastify 5 is strict: no body, so no Content-Type.
      expect(contentType).toBeNull();
    });

    it('rejects with an ApiError carrying the 409 status when the entry is claimed', async () => {
      server.use(
        http.post('*/api/allowlist/entry-1/reminder', () =>
          HttpResponse.json(
            { message: 'already claimed', details: { reason: 'already_claimed' } },
            { status: 409 },
          ),
        ),
      );

      await expect(sendAllowlistReminder('entry-1')).rejects.toMatchObject({
        status: 409,
        details: { reason: 'already_claimed' },
      });
    });
  });

  describe('reminderErrorMessage', () => {
    it('reads a 409 as news, not an apology, and names the address', () => {
      expect(reminderErrorMessage(new ApiError('x', 409), 'a@example.com')).toMatch(
        /a@example\.com has already signed in/,
      );
    });

    it('reads a 404 as an entry removed elsewhere', () => {
      expect(reminderErrorMessage(new ApiError('x', 404), 'a@example.com')).toMatch(
        /no longer exists/,
      );
    });

    it('keeps the server\'s sentence for anything else', () => {
      expect(reminderErrorMessage(new ApiError('Mail is down', 503), 'a@example.com')).toBe(
        'Mail is down',
      );
      expect(reminderErrorMessage(new Error('boom'), 'a@example.com')).toBe('boom');
    });

    it('falls back to a plain statement when there is nothing to show', () => {
      expect(reminderErrorMessage('???', 'a@example.com')).toBe('Failed to send reminder');
    });
  });
});
