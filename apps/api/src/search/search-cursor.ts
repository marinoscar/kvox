// =============================================================================
// The fingerprinted relevance cursor (issue #175, epic #164)
// =============================================================================
//
// THIS CURSOR REFUSES. `decodeCursor` IN `transcripts.service.ts` FORGIVES.
// THE DIFFERENCE IS DELIBERATE AND IT IS THE POINT OF THIS FILE.
// -----------------------------------------------------------------------------
//
// `transcripts.service.ts`'s `decodeCursor` returns `null` for anything it
// cannot parse, and its own doc comment says why: "a stale or truncated one
// should restart the list from the top, not 500". That is exactly right for
// `GET /api/transcripts` - a newest-first feed whose page 1 is a meaningful,
// self-explanatory answer. A user who lands back at the top of their own
// transcript list can SEE that they are at the top.
//
// A relevance list has no such tell. Restarting it silently hands the user
// page 1 again - the same rows, in the same order, under a "next page" they
// just clicked - and nothing on screen distinguishes that from a genuine page
// 2 whose contents happen to resemble page 1. They scroll a ranked list
// believing they are making progress through it while the server quietly
// serves them the same twenty rows forever. So every mismatch here is a
// **400** with a message naming the problem, and a client that gets one knows
// to re-run the search rather than to trust what it is holding.
//
// WHAT THE FINGERPRINT COVERS, AND WHY EACH ONE IS IN IT
// -----------------------------------------------------------------------------
//
// The cursor carries an OFFSET into a candidate window, so it means nothing
// except relative to the window that produced it. Four inputs decide that
// window, and a change to any one of them silently renumbers it:
//
//   - THE QUERY TEXT. A different `q` is a different ranking over a different
//     set of documents; offset 20 into it is an arbitrary row.
//   - THE TYPE FILTER. Dropping `note` from the search removes rows from the
//     middle of the ranking, so every offset after the first removed row now
//     names a different document. This is the SEARCHED types (what the server
//     actually looked at), not the requested ones - see
//     {@link SearchCursorScope.types}.
//   - THE CALLER. Visibility is applied INSIDE the candidate window, so two
//     users running the identical query get different windows. Without the
//     user id in the fingerprint, a cursor leaked or copied between accounts
//     would page into somebody else's numbering - it would still only ever
//     return rows the second caller may see (the window is rebuilt under
//     their own visibility predicate), but it would return the WRONG ones,
//     with no error.
//   - {@link RANKING_MODEL_VERSION}. The scoring itself. See below.
//
// THE VERSION CONSTANT IS THE MECHANISM, NOT A COMMENT
// -----------------------------------------------------------------------------
//
// Ranking changes. Somebody will weight titles differently, swap `ts_rank_cd`
// for something else, or change the roll-up. The moment that ships, every
// cursor a client is holding points into a window that no longer exists in
// that order - and there is nothing IN the cursor that could notice, because
// `q`, the types and the user are all unchanged. Bumping
// {@link RANKING_MODEL_VERSION} invalidates them all at once, by construction:
// the old fingerprint cannot be reproduced under the new constant, so every
// in-flight cursor becomes a 400 and every client re-runs its search. A
// changelog entry saying "remember to tell clients" is not the same mechanism
// and does not survive a deploy nobody read the changelog for.
//
// >>> A LATER ISSUE ADDS A SEMANTIC (EMBEDDING) AXIS TO THIS SEARCH. <<<
// >>> ITS MODEL/INDEX IDENTITY BELONGS IN THE FINGERPRINT, NEXT TO THE   <<<
// >>> MARKED SLOT IN `fingerprintScope` BELOW - AND SWITCHING EMBEDDING  <<<
// >>> MODELS THEN INVALIDATES CURSORS FOR FREE, THE SAME WAY BUMPING     <<<
// >>> THE CONSTANT DOES. Adding the axis WITHOUT touching the            <<<
// >>> fingerprint is the failure this block exists to make loud.         <<<
// =============================================================================

import { createHash } from 'node:crypto';

import { normalizeQueryText, type SearchType } from './search-query';

/**
 * The scoring model's identity. BUMP THIS whenever the ranking changes.
 *
 * "The ranking" means anything that can reorder the candidate window: the rank
 * function, the roll-up rule, the weighting, the candidate cap, the tie-break.
 * When in doubt, bump it - the cost is that clients re-run their searches
 * once, and the cost of not bumping it is a user paging through a list that
 * renumbered underneath them with no error anywhere.
 */
export const RANKING_MODEL_VERSION = 1;

/** Everything that decides which candidate window an offset refers to. */
export interface SearchCursorScope {
  /** The raw `q`; normalised by {@link normalizeQueryText} before hashing. */
  q: string;
  /**
   * The types actually SEARCHED, not the types requested.
   *
   * A caller holding only `notes:read` who asks for both is answered from a
   * notes-only window (see `search.service.ts` - a partial answer, never a
   * 403). Fingerprinting the request would let that caller's page-2 cursor be
   * accepted against a window built from a different type set the moment
   * their permissions changed mid-session, which is the one case where the
   * numbering moves without the request moving.
   */
  types: readonly SearchType[];
  /** The authenticated caller. Visibility is part of the window. */
  userId: string;
}

/** A cursor that does not belong to the search it was presented against. */
export class SearchCursorError extends Error {}

/** The wire shape, before base64url. Short keys - it is opaque either way. */
interface CursorPayload {
  /** Fingerprint of the scope. */
  f: string;
  /** Offset into the candidate window. */
  o: number;
}

/**
 * A stable hash of everything the window depends on.
 *
 * The inputs are joined with a delimiter that cannot occur in any of them
 * (`\n` - types are a fixed enum, a uuid has none, and `normalizeQueryText`
 * collapses every whitespace run to a single space), so two different scopes
 * cannot serialise to the same string. Truncated to 160 bits, which is a
 * collision probability nobody will ever meet and a cursor short enough to sit
 * in a query string.
 */
export function fingerprintScope(scope: SearchCursorScope): string {
  const inputs = [
    String(RANKING_MODEL_VERSION),
    normalizeQueryText(scope.q),
    [...scope.types].sort().join(','),
    scope.userId,
    // >>> SEMANTIC AXIS GOES HERE <<<
    // A later issue adds embedding-backed retrieval. Append its model/index
    // identity as one more line - do not replace a line above, and do not add
    // it anywhere else. Every value this array carries is one the window
    // depends on; anything that reorders results and is missing from here is
    // a cursor that survives a change it should not have survived.
  ];

  return createHash('sha256').update(inputs.join('\n'), 'utf8').digest('hex').slice(0, 40);
}

/** `{f,o}` as base64url. Opaque to the client, trivially decodable here. */
export function encodeSearchCursor(scope: SearchCursorScope, offset: number): string {
  const payload: CursorPayload = { f: fingerprintScope(scope), o: offset };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * The offset this cursor names, or a {@link SearchCursorError}.
 *
 * EVERY failure mode throws, including a malformed or truncated cursor. See
 * the file header: on a relevance list there is no such thing as a safe
 * silent restart, and "the client sent us something we cannot read" is a
 * client that needs to be told, not a client to be quietly handed page 1.
 */
export function decodeSearchCursor(cursor: string, scope: SearchCursorScope): number {
  let payload: CursorPayload;

  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw new SearchCursorError('This cursor is not readable. Re-run the search.');
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new SearchCursorError('This cursor is not readable. Re-run the search.');
  }

  if (typeof payload.f !== 'string' || payload.f !== fingerprintScope(scope)) {
    throw new SearchCursorError(
      'This cursor belongs to a different search. Cursors are tied to the query, the type ' +
        'filter, the caller and the ranking model; re-run the search to page through the new ' +
        'results.',
    );
  }

  if (!Number.isInteger(payload.o) || payload.o < 0) {
    throw new SearchCursorError('This cursor is not readable. Re-run the search.');
  }

  return payload.o;
}
