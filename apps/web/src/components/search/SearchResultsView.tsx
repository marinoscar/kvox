/**
 * The library's search results — issue #176, epic #164.
 *
 * ONE component, rendered by both `TranscriptsLibraryView` and
 * `NotesLibraryView`, because a search result is the same thing in both places:
 * a title, when it changed, and the snippets saying WHY it matched. The rows
 * those two views render from their own list endpoints are genuinely different
 * (a transcript row carries a play control and an overflow menu; a note row
 * carries its provenance), but `GET /api/search` returns neither of those
 * shapes — it returns `{ type, id, title, score, updatedAt, status, snippets }`
 * for both types — so two copies of this would be two copies of the same row.
 *
 * =============================================================================
 * THE TWO EMPTY STATES ARE THE POINT
 * =============================================================================
 *
 * "No matches for *zzz*" and "Type to search" are DIFFERENT SITUATIONS and this
 * component never renders one for the other:
 *
 *   • **Type to search** — the box holds nothing to search for (it is empty, or
 *     all whitespace). Nothing has been asked, so nothing can have failed to
 *     match. Telling this user "no matches" reports a result for a question
 *     they did not ask, and the obvious next move — retyping the same word —
 *     will appear to change nothing.
 *   • **No matches** — a real query ran and the corpus had nothing. The remedy
 *     is a different word, and the copy says so.
 *
 * A third state sits between them and is just as important: while the debounce
 * is still running, {@link UseSearchResult.isLoading} is already true, so the
 * gap between a keystroke and the request renders a SPINNER. Without that, every
 * search would flash "No matches" before its own results arrived.
 *
 * =============================================================================
 * `matchedDocuments` IS A CAP, NOT A COUNT — SOMETIMES
 * =============================================================================
 *
 * `truncated: false` makes it exact and this component says so plainly.
 * `truncated: true` means the server's candidate window FILLED UP, and the
 * number is then the size of that window rather than a fact about the user's
 * data — so the sentence becomes "the top N matches", never "N matches" and
 * never "N results". Getting this wrong is not a wording nit: it would put this
 * endpoint's internal constant on screen as if it described the corpus. See
 * `apps/api/src/search/dto/search.dto.ts`, which opens with the argument for
 * why there is no `total` field to render instead.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { SearchSnippet } from './SearchSnippet';
import type { UseSearchResult } from '../../hooks/useSearch';
import type { SearchResult, SearchType } from '../../services/search';
import { formatRelativeTime } from '../../utils/relativeTime';

/** Wording for the one type a view asked about. */
const TYPE_NOUNS: Record<SearchType, { singular: string; plural: string }> = {
  transcript: { singular: 'transcript', plural: 'transcripts' },
  note: { singular: 'note', plural: 'notes' },
};

function SearchResultRow({
  result,
  dense,
  onOpen,
}: {
  result: SearchResult;
  dense: boolean;
  onOpen: () => void;
}) {
  return (
    <Card variant="outlined" component="li" sx={{ listStyle: 'none' }}>
      <CardActionArea
        onClick={onOpen}
        sx={{
          p: dense ? 1.25 : 2,
          display: 'block',
          minWidth: 0,
        }}
      >
        {/* `h2`, for the reason both library views state at their own rows: the
            page's one `h1` is the frame's ("Transcripts" / "Notes") and nothing
            sits between it and this row, so `h3` would skip a level. */}
        <Typography variant="subtitle1" component="h2" noWrap sx={{ fontWeight: 600 }}>
          {result.title}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          {formatRelativeTime(result.updatedAt)}
        </Typography>
        {/* WHY IT MATCHED. A relevance-ordered list whose rows show only titles
            is a list the reader has to take on faith — the whole reason this
            endpoint exists is that a word spoken once in the middle of a
            three-hour recording finds that recording, and the snippet is the
            only thing on screen that shows it did. */}
        {result.snippets.map((snippet, index) => (
          <SearchSnippet key={index} snippet={snippet} />
        ))}
      </CardActionArea>
    </Card>
  );
}

export interface SearchResultsViewProps {
  /** The one type this view asked the endpoint for. */
  type: SearchType;
  /** The raw box contents, echoed back in the "no matches" copy. */
  query: string;
  /** Everything `useSearch` returned, passed through whole. */
  search: UseSearchResult;
  dense: boolean;
  onOpen: (result: SearchResult) => void;
  /**
   * The status filter the view is showing but cannot apply, if any.
   *
   * `GET /api/search` has no status parameter, and filtering the ranked page
   * client-side would silently disagree with the count beside it — twenty rows
   * fetched, four rendered, "the top 200 matches" above them. So the view
   * disables the control and this component says why, and ONLY when the user
   * actually has one set: a note about an inapplicable filter nobody chose is
   * noise on every search.
   */
  unappliedStatusFilter?: boolean;
}

export function SearchResultsView({
  type,
  query,
  search,
  dense,
  onOpen,
  unappliedStatusFilter = false,
}: SearchResultsViewProps) {
  const {
    results,
    isLoading,
    isLoadingMore,
    error,
    nextCursor,
    matchedDocuments,
    truncated,
    degraded,
    searchedTypes,
    isIdle,
    loadMore,
  } = search;

  const nouns = TYPE_NOUNS[type];

  /**
   * Did the server search what this view asked for?
   *
   * `searchedTypes` is `null` until an answer lands, and that is NOT the same
   * as an answer that omitted this type — see `useSearch`. A caller holding
   * only one of `transcripts:read`/`notes:read` gets a 200 with the half they
   * may have rather than a 403 (the controller explains why at length), so this
   * field is the only thing that distinguishes "you have nothing matching" from
   * "this application never looked".
   */
  const typeNotSearched = searchedTypes !== null && !searchedTypes.includes(type);

  const countLine = (() => {
    if (matchedDocuments === 0) return null;
    if (truncated) {
      // A CAP. Never "N matches" — see the file header.
      return `Showing the top ${matchedDocuments} matches. There are more — narrow your search to see them.`;
    }
    return matchedDocuments === 1 ? '1 match' : `${matchedDocuments} matches`;
  })();

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {typeNotSearched && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Your account cannot search {nouns.plural}, so none were included in these results.
        </Alert>
      )}

      {/* A QUIET LINE, not an alert and not a toast: nothing went wrong, the
          answer is simply a narrower kind of answer than usual and the reader
          should be able to tell. */}
      {degraded === 'stopwords' && !isLoading && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Your search was made up entirely of common words, so these are title matches only.
        </Typography>
      )}

      {unappliedStatusFilter && !isLoading && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          The status filter does not apply while searching.
        </Typography>
      )}

      {countLine && !isLoading && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {countLine}
        </Typography>
      )}

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress aria-label={`Searching ${nouns.plural}`} />
        </Box>
      ) : isIdle ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="h6" component="h2" gutterBottom>
            Type to search
          </Typography>
          <Typography color="text.secondary">
            Search looks inside your {nouns.plural}, not just at their titles.
          </Typography>
        </Paper>
      ) : results.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="h6" component="h2" gutterBottom>
            No matches for “{query.trim()}”
          </Typography>
          <Typography color="text.secondary">
            Nothing in your {nouns.plural} contains that. Try a different word or a shorter
            phrase.
          </Typography>
        </Paper>
      ) : (
        <Stack component="ul" spacing={1} sx={{ p: 0, m: 0 }}>
          {results.map((result) => (
            <SearchResultRow
              key={`${result.type}:${result.id}`}
              result={result}
              dense={dense}
              onOpen={() => onOpen(result)}
            />
          ))}
        </Stack>
      )}

      {nextCursor && !isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={() => void loadMore()} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default SearchResultsView;
