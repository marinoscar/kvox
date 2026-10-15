/**
 * Allowlist reminders (issue #301), the KVox-only half of the Users page.
 *
 * Issue #465, epic #462. The platform's identity slice owns `/api/allowlist`,
 * but it has no reminder feature, so KVox serves two routes of its own next to
 * the platform's (`apps/api/src/allowlist-reminders/`):
 *
 *   - `GET  /api/allowlist/reminders?ids=a,b` (`allowlist:read`): the reminder
 *     bookkeeping for those allowlist rows, `{ allowedEmailId, reminderCount,
 *     lastReminderAt }[]`. A row that was never reminded has no entry.
 *   - `POST /api/allowlist/{id}/reminder` (`allowlist:write`): re-email an
 *     invitee who has not signed in. 200 with `{ reminderCount, lastReminderAt }`,
 *     404 for an id that is gone, 409 (`details.reason: 'already_claimed'`) when
 *     the invitee already signed in.
 *
 * The counts are NOT on the platform's `AllowedEmailEntry`, which is why the
 * Reminders tab joins them in the browser by id. This module is the only place
 * the web app names these two routes.
 */

import { api, ApiError } from './api';

/** The reminder bookkeeping of one allowlist row. */
export interface AllowlistReminderState {
  allowedEmailId: string;
  reminderCount: number;
  /** ISO 8601, or `null` when no reminder was ever sent. */
  lastReminderAt: string | null;
}

/** What `POST /api/allowlist/{id}/reminder` answers. */
export interface SentAllowlistReminder {
  reminderCount: number;
  lastReminderAt: string | null;
}

/**
 * The reminder bookkeeping for a page of allowlist rows.
 *
 * Resolves to `[]` for no ids without a request. The ids go in the query
 * string, so callers pass one PAGE of rows (a few dozen uuids), never the
 * whole list.
 */
export async function getAllowlistReminders(
  ids: readonly string[],
): Promise<AllowlistReminderState[]> {
  if (ids.length === 0) return [];
  const query = new URLSearchParams({ ids: ids.join(',') });
  return api.get<AllowlistReminderState[]>(`/allowlist/reminders?${query}`);
}

/**
 * Email an invitee again about an invitation they have not used yet.
 *
 * A 200 with a BODY, not a 204: the new `reminderCount`/`lastReminderAt` let
 * the caller update its row without re-listing.
 *
 * Two refusals worth knowing at the call site: **409** when the entry is
 * already claimed (the invitee signed in, so there is nobody left to remind)
 * and **404** for an id that is not there. Neither is a generic failure; see
 * {@link reminderErrorMessage}.
 */
export async function sendAllowlistReminder(id: string): Promise<SentAllowlistReminder> {
  // No body: the id is the whole request.
  return api.post<SentAllowlistReminder>(`/allowlist/${id}/reminder`);
}

/**
 * What to say when `POST /api/allowlist/{id}/reminder` refuses.
 *
 * THE TWO NAMED STATUSES ARE NOT FAILURES OF THE SAME KIND, AND NEITHER IS A
 * GENERIC ONE:
 *
 *   - **409** when the entry is already claimed. The invitee signed in, which
 *     is the outcome the invitation was for, so this reads as news rather than
 *     an apology, and it tells the administrator what to do about the stale row
 *     in front of them (reload). The button is not rendered for a claimed row
 *     at all, and the tab lists only pending entries, so reaching this means
 *     the list is older than the database, not that the gate leaked.
 *   - **404** for an id that is gone: somebody removed the entry elsewhere.
 *     Retrying cannot help; re-reading can.
 *
 * Everything else keeps the server's own sentence, falling back to a plain
 * statement only when there is none. Maintenance windows are intercepted
 * centrally in `services/api.ts` and never reach here.
 */
export function reminderErrorMessage(error: unknown, email: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return `${email} has already signed in, so there is nobody left to remind. Reload the list to see the current status.`;
    }
    if (error.status === 404) {
      return 'That allowlist entry no longer exists — it was removed somewhere else. Reload the list.';
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Failed to send reminder';
}
