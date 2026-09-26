import { createHash } from 'node:crypto';

// =============================================================================
// The conversation-list cursor (issue #376, epic #348)
// =============================================================================
//
// base64url JSON `{ v, f, k, id }`: a KEYSET cursor naming the previous page's
// last row by `(updated_at, id)` — the list's own order — plus a fingerprint
// `f` of what decides the list (the caller and the `scopeEntityId` filter),
// the `search-cursor.ts` pattern.
//
// THIS CURSOR REFUSES. A malformed cursor, one of another version, or one
// minted for a different caller or filter is an {@link AskCursorError}, which
// the service maps to a 400. Silently restarting at page 1 would hand the
// client the same rows under a "next page" it asked for.
//
// `k` is the row's `updated_at` rendered BY POSTGRES to microseconds
// (`timestamptz(6)`), never a JS `Date` (milliseconds): a key truncated to
// milliseconds would skip every row whose timestamp falls inside the dropped
// microseconds on the next page. It is compared as `timestamptz` in SQL.
// =============================================================================

export const ASK_CURSOR_VERSION = 1;

/** What decides which list a cursor pages through. */
export interface AskCursorScope {
  userId: string;
  scopeEntityId: string | null;
}

/** The previous page's last row. */
export interface AskCursorPosition {
  /** `updated_at` as an ISO 8601 string with microseconds. */
  k: string;
  id: string;
}

export class AskCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskCursorError';
  }
}

const UNREADABLE = 'This cursor is not readable. Reload the list from the start.';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `YYYY-MM-DDTHH:MM:SS[.ffffff]Z` — exactly what the list query renders.
const KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function fingerprintAskScope(scope: AskCursorScope): string {
  return createHash('sha256')
    .update([String(ASK_CURSOR_VERSION), scope.userId, scope.scopeEntityId ?? ''].join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function encodeAskCursor(scope: AskCursorScope, position: AskCursorPosition): string {
  const payload = { v: ASK_CURSOR_VERSION, f: fingerprintAskScope(scope), k: position.k, id: position.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** The position, or an {@link AskCursorError} for anything that is not this list's own cursor. */
export function decodeAskCursor(cursor: string, scope: AskCursorScope): AskCursorPosition {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AskCursorError(UNREADABLE);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new AskCursorError(UNREADABLE);
  }

  const p = payload as Record<string, unknown>;
  if (p.v !== ASK_CURSOR_VERSION) throw new AskCursorError(UNREADABLE);
  if (typeof p.f !== 'string') throw new AskCursorError(UNREADABLE);
  if (p.f !== fingerprintAskScope(scope)) {
    throw new AskCursorError(
      'This cursor belongs to a different list (another caller or another scopeEntityId filter). ' +
        'Reload the list from the start.',
    );
  }
  if (typeof p.id !== 'string' || !UUID_PATTERN.test(p.id)) throw new AskCursorError(UNREADABLE);
  if (typeof p.k !== 'string' || !KEY_PATTERN.test(p.k) || Number.isNaN(Date.parse(p.k))) {
    throw new AskCursorError(UNREADABLE);
  }

  return { k: p.k, id: p.id };
}
