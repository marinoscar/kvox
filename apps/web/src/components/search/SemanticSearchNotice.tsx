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
 * ⚠ THE FIELDS IT READS MAY NOT EXIST YET — AND THAT IS THE NORMAL CASE TODAY
 * =============================================================================
 *
 * `semantic`, `semanticReason` and `unindexedCount` are added to the search
 * response by the HYBRID-RANKING issue of this epic, which lands separately
 * from this one. Until it does, nothing on the wire carries them, every prop
 * here is `undefined`, and this component RENDERS NOTHING.
 *
 * That is deliberate and must stay that way. `semantic === undefined` means
 * "this build's server does not report it", which is not the same fact as
 * `semantic === false` ("it reported, and the answer was keyword-only") — and a
 * feed that showed a degradation notice because a field had not shipped yet
 * would be worse than one that said nothing. The test for this component pins
 * the undefined case for exactly that reason.
 */

import { useState } from 'react';
import { Alert, Link, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { describeIndexReason } from '../../services/searchIndex';
import type { SemanticSearchQuality } from '../../services/searchIndex';

export interface SemanticSearchNoticeProps extends SemanticSearchQuality {
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

  // ⚠ `=== false`, NOT `!semantic`. `undefined` is "the server did not report
  // it" — see the file header — and must render nothing at all.
  const isKeywordOnly = semantic === false;
  const hasUnindexed = typeof unindexedCount === 'number' && unindexedCount > 0;

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
          {describeIndexReason(semanticReason)}
        </Typography>
      )}
    </Alert>
  );
}
