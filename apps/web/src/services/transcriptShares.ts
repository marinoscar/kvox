/**
 * The transcript sharing API, as the web app sees it (issue #29, epic #19).
 *
 * Shaped after `services/transcription.ts`: `services/api.ts` stays the
 * transport — the `ApiService` instance, the refresh dance, the maintenance
 * recogniser — and this module holds the four calls next to the types they
 * produce.
 *
 * =============================================================================
 * ⚠ THERE IS NO `searchUsers` IN HERE, AND THERE MUST NEVER BE ONE
 * =============================================================================
 *
 * The API's share endpoint takes ONE exact address and answers a generic 404
 * for a miss, precisely so that no client can turn it into an autocomplete over
 * the user directory — the alternative issue #29 rejected outright. A helper in
 * this file that called the endpoint speculatively as somebody typed would
 * rebuild that enumerator on the client and burn the server's per-caller rate
 * limit doing it. `addShare` is called on SUBMIT, once, and nowhere else.
 *
 * =============================================================================
 * FOUR CALLS, AND WHO MAY MAKE THEM
 * =============================================================================
 *
 * `getShares`, `addShare` and `updateShareRole` are owner-only at the API and
 * answer 404 for anyone else — so a UI that offers them to a non-owner is
 * offering a button that cannot work. `removeShare` is the exception: passing
 * your OWN user id is "leave", which any share holder may do.
 */

import { api } from './api';

/** The two levels a share can grant. `owner` is not a share — it is the row. */
export type TranscriptShareRole = 'viewer' | 'editor';

/** One person a transcript is shared with. */
export interface TranscriptShare {
  /** The SHARE row's id. Never a path segment — `userId` is what routes use. */
  id: string;
  userId: string;
  email: string;
  /** Null for an account that has never set one. Render the email instead. */
  displayName: string | null;
  role: TranscriptShareRole;
  grantedById: string;
  createdAt: string;
}

/** What the API returns for the whole list. Unpaginated by design. */
export interface TranscriptSharesResponse {
  items: TranscriptShare[];
}

const base = (transcriptId: string): string =>
  `/transcripts/${encodeURIComponent(transcriptId)}/shares`;

/** Everyone this transcript is shared with. Owner only; 404 for anyone else. */
export async function getShares(transcriptId: string): Promise<TranscriptShare[]> {
  const response = await api.get<TranscriptSharesResponse>(base(transcriptId));

  return response.items;
}

/**
 * Grant access to one address, or change what an existing share grants.
 *
 * Re-sharing with somebody already on the list updates their role rather than
 * failing, so the caller does not have to check the list first.
 */
export async function addShare(
  transcriptId: string,
  input: { email: string; role: TranscriptShareRole },
): Promise<TranscriptShare> {
  return api.post<TranscriptShare>(base(transcriptId), input);
}

/** Promote or demote an existing share. Takes effect on their next request. */
export async function updateShareRole(
  transcriptId: string,
  userId: string,
  role: TranscriptShareRole,
): Promise<TranscriptShare> {
  return api.patch<TranscriptShare>(
    `${base(transcriptId)}/${encodeURIComponent(userId)}`,
    { role },
  );
}

/**
 * Revoke a share — or leave one, by passing your own user id.
 *
 * The same route serves both, which is why this function takes a plain user id
 * and does not care which of the two it is doing.
 */
export async function removeShare(transcriptId: string, userId: string): Promise<void> {
  await api.delete<void>(`${base(transcriptId)}/${encodeURIComponent(userId)}`);
}

/** How a recipient is labelled in the UI: their name, falling back to the address. */
export function shareDisplayLabel(share: TranscriptShare): string {
  return share.displayName?.trim() || share.email;
}

/** What a role lets somebody do, in one line, for the dialog's role select. */
export function shareRoleDescription(role: TranscriptShareRole): string {
  return role === 'editor'
    ? 'Can play, read, export and correct. Corrections create versions.'
    : 'Can play, read and export. Cannot change anything.';
}
