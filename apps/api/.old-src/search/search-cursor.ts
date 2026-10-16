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
// except relative to the window that produced it. FIVE inputs decide that
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
//   - THE SEMANTIC AXIS. Whether the embedding arm ran for this request, and
//     under which model. See the section after next.
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
// THE SEMANTIC AXIS - FILLED IN BY ISSUE #189, EPIC #165
// -----------------------------------------------------------------------------
//
// The block that used to stand here reserved a slot for "a later issue adds a
// semantic (embedding) axis to this search", and warned that adding the axis
// without touching the fingerprint would be a silent renumbering. That issue is
// #189, the axis is {@link SearchCursorScope.semantic}, and both halves of what
// it asked for are done:
//
//   - THE AXIS IS IN THE FINGERPRINT. It is `provider:model` when the vector
//     arm actually ran for this request, and `null` when it did not - so an
//     FTS-only window and a fused window can never share a fingerprint. That
//     matters for a reason the four original inputs do not cover: whether the
//     semantic arm runs depends on THE CALLER'S OWN API KEY and on the
//     provider being reachable, neither of which is part of the request. A user
//     who pastes a key between page 1 and page 2 - or a vendor that starts
//     timing out between them - changes the ranking without changing anything
//     the client sent. With the axis in the fingerprint, page 2 is a 400 and
//     the client re-runs; without it, page 2 would be an arbitrary slice of a
//     ranking that had been rebuilt underneath it. Switching the deployment's
//     embedding model invalidates every in-flight cursor for free, by the same
//     mechanism.
//
//   - {@link RANKING_MODEL_VERSION} IS BUMPED TO 2, and that is NOT redundant
//     with the axis. The axis is `null` for an FTS-only request both before and
//     after #189, so a cursor minted yesterday by a keyless user would
//     reproduce today's fingerprint exactly - and would then index into a
//     window that is now built by reciprocal rank fusion over a single list
//     instead of by raw `ts_rank_cd` ordering. The two mechanisms answer
//     different questions ("did the RANKING CODE change" versus "did THIS
//     REQUEST'S retrieval change"), and TOGETHER they make "the ranking changed
//     and nobody noticed" unrepresentable as a silent re-page: any change to
//     how results are ordered is either a new constant or a new axis value, and
//     either one is a 400 a client can act on.
// =============================================================================

import { createHash } from 'node:crypto';

import { normalizeQueryText, type SearchType } from './search-query';

/**
 * The scoring model's identity. BUMP THIS whenever the ranking changes.
 *
 * "The ranking" means anything that can reorder the candidate window: the rank
 * function, the roll-up rule, the weighting, the candidate cap, the tie-break,
 * the fusion constant (`RRF_K`) and the semantic arm's similarity floor
 * (`MIN_SEMANTIC_SIMILARITY` - it decides which documents are REACHABLE at all,
 * which is the candidate cap's kind of change rather than a scoring tweak).
 * When in doubt, bump it - the cost is that clients re-run their searches
 * once, and the cost of not bumping it is a user paging through a list that
 * renumbered underneath them with no error anywhere.
 *
 * Bumped to 2 by #189, which made the window a fusion of two rankings rather
 * than one `ts_rank_cd` ordering. See the header's semantic-axis section for
 * why the axis alone would not have covered it.
 */
export const RANKING_MODEL_VERSION = 2;

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
  /**
   * The semantic arm's identity for THIS request: `provider:model` when the
   * vector arm ran, `null` when the ranking was full-text only (#189).
   *
   * See the header's semantic-axis section. Produced by `semanticAxis()` in
   * `search-semantic.ts`, which is the only thing that should ever build this
   * string.
   */
  semantic: string | null;
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
    // THE SEMANTIC AXIS (#189). Appended as one more line rather than folded
    // into any line above - every value this array carries is one the window
    // depends on, and anything that reorders results while missing from here is
    // a cursor that survives a change it should not have survived. `''` for
    // `null` keeps the delimiter argument below intact: the axis is either a
    // `provider:model` pair or empty, and neither can contain a newline.
    scope.semantic ?? '',
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
        'filter, the caller, the ranking model and whether semantic ranking was available; ' +
        're-run the search to page through the new results.',
    );
  }

  if (!Number.isInteger(payload.o) || payload.o < 0) {
    throw new SearchCursorError('This cursor is not readable. Re-run the search.');
  }

  return payload.o;
}
