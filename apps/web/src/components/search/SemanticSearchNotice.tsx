/**
 * "These results are keyword-only" — the library feed's half of issue #191,
 * epic #165.
 *
 * =============================================================================
 * IT IS A QUIET LINE, NEVER AN ERROR AND NEVER AN EMPTY STATE
 * =============================================================================
 *
 * A search that fell back to keyword matching STILL ANSWERED THE QUESTION. The
 * user typed a word, the rows below this line contain that word, and everything
 * on screen is correct. What they have lost is a capability they may not know
 * exists — finding a recording by what it was ABOUT — and the only honest way
 * to report that is a line that explains the degradation and points at the one
 * page that fixes it.
 *
 * So, three rules, all of them about not overreacting:
 *
 *   • `severity="info"`, never `warning` and never `error`. Nothing failed.
 *   • DISMISSIBLE, and the dismissal is remembered for the session. A user who
 *     has read it once and decided not to index is not helped by reading it on
 *     every keystroke of every subsequent search.
 *   • IT NEVER REPLACES RESULTS. It sits above them, and a feed with zero rows
 *     renders its own empty state as it always did — "no results" and "results
 *     are keyword-only" are different sentences and both may be true.
 *
 * =============================================================================
 * IT READS THE SEARCH RESPONSE, AND ONLY THE SEARCH RESPONSE
 * =============================================================================
 *
 * `semantic`, `semanticReason` and `unindexedCount` are fields of
 * `GET /api/search` (`apps/api/src/search/dto/search.dto.ts`) and of nothing
 * else. They were briefly wired to the LIST endpoints as a placeholder, before
 * `services/search.ts` existed; that guess is corrected here. The list feeds
 * never carried these fields and never will — a list is not a ranking, so
 * there is no semantic arm for it to have skipped.
 *
 * ⚠ THE FIELDS ARE REQUIRED ON THE WIRE, so the props below are required too
 * (they were shaped around the optional-field world and are tightened here).
 * The one value that is still absent is `semantic: null`, which is `useSearch`
 * saying NO ANSWER HAS LANDED YET — not a claim about the server. Hence the
 * `=== false` test below rather than `!semantic`: a notice that appeared during
 * the debounce of every first keystroke would be worse than no notice.
 */

import { useState } from 'react';
import { Alert, Link, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { describeIndexReason } from '../../services/searchIndex';
import type { SemanticReason } from '../../services/search';

/**
 * The two reasons `GET /api/search` can report that INDEXING never can, so
 * `describeIndexReason` — which is about one document's failed index attempt —
 * has no sentence for them and would render the raw token.
 *
 * Kept here rather than added to that lookup because they are not indexing
 * outcomes: nothing failed to index, there is simply nothing to compare a query
 * vector against, or the query's OWN embedding call did not come back.
 */
const SEARCH_ONLY_REASON_TEXT: Partial<Record<SemanticReason, string>> = {
  no_indexed_content:
    'Nothing in your library has been indexed for semantic search yet, so there was nothing to compare your search against.',
  embedding_failed:
    'Your AI provider could not turn this search into an embedding just now, so these results fall back to keyword matching. Trying again may work.',
};

/** One `semanticReason`, in a sentence. */
function describeSemanticReason(reason: SemanticReason): string {
  return SEARCH_ONLY_REASON_TEXT[reason] ?? describeIndexReason(reason);
}

export interface SemanticSearchNoticeProps {
  /**
   * Whether the semantic arm ran. `null` is `useSearch`'s "no answer yet" and
   * renders nothing — see the file header.
   */
  semantic: boolean | null;
  /** Why it did not. `null` when it did, and before an answer lands. */
  semanticReason: SemanticReason | null;
  /** The caller's own documents missing from the semantic index. */
  unindexedCount: number;
  /**
   * Distinguishes one feed's dismissal from another's, so dismissing it on
   * Recordings does not silently hide it on Notes — two feeds, two libraries,
   * two independently indexable sets of documents.
   */
  storageKey?: string;
}

/**
 * Where a dismissal is remembered.
 *
 * `sessionStorage`, not `localStorage`: the underlying fact is expected to
 * CHANGE — the user is one button press away from making it false — so a
 * permanent dismissal would hide the notice for a user who never indexed and
 * has long since forgotten why their searches are worse than they could be. A
 * session is the right horizon: quiet for as long as they are working, honest
 * again next time.
 *
 * Wrapped in try/catch at both ends: a private window, blocked site data or a
 * storage quota can throw on either access, and a feed must not fail to render
 * because a dismissal could not be remembered.
 */
function readDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(key: string): void {
  try {
    sessionStorage.setItem(key, '1');
  } catch {
    // Not remembering a dismissal is a worse experience, never a broken one.
  }
}

export function SemanticSearchNotice({
  semantic,
  semanticReason,
  unindexedCount,
  storageKey = 'semantic-search-notice',
}: SemanticSearchNoticeProps) {
  const [dismissed, setDismissed] = useState(() => readDismissed(storageKey));

  // ⚠ `=== false`, NOT `!semantic`. `null` is "no answer has landed yet" — see
  // the file header — and must render nothing at all.
  const isKeywordOnly = semantic === false;
  const hasUnindexed = unindexedCount > 0;

  if (!isKeywordOnly || dismissed) return null;

  return (
    <Alert
      severity="info"
      sx={{ mb: 2 }}
      onClose={() => {
        writeDismissed(storageKey);
        setDismissed(true);
      }}
    >
      <Typography variant="body2" component="span">
        These results are keyword-only — they match the words you typed rather than what your
        recordings are about.{' '}
        {hasUnindexed && (
          <>
            {unindexedCount} of your documents {unindexedCount === 1 ? 'is' : 'are'} not indexed
            for semantic search yet.{' '}
          </>
        )}
        <Link component={RouterLink} to="/settings/search-index">
          Set up search indexing
        </Link>
        .
      </Typography>
      {semanticReason && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {describeSemanticReason(semanticReason)}
        </Typography>
      )}
    </Alert>
  );
}
