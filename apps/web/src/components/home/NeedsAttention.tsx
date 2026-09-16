/**
 * "Needs attention" — the work that STOPPED. Issue #171, epic #166.
 *
 * =============================================================================
 * A COUNT IS NOT NAVIGATION
 * =============================================================================
 *
 * `GET /api/transcripts/summary` has carried `counts.failed` since #32, and on
 * its own it is a dead end: it tells a person that three of their recordings
 * did not make it and gives them nowhere to go. They still have to guess which
 * three, open the full library, and filter it by hand — and the most common
 * outcome of that is that they never do, so a recording they uploaded and a
 * note they paid their own provider account to generate sit failed forever with
 * nobody ever pressing the one button that would fix them. This section is the
 * rows behind those two counts, with the retry a tap away.
 *
 * ⚠ THE LISTS ARE CAPPED AND THE COUNTS ARE NOT, and the section says so rather
 * than quietly rendering eight rows as though they were everything. Both
 * summaries cap their `failed` list at eight (`SUMMARY_LIST_SIZE`), while
 * `counts.failed` stays the true total from its own `count()` — a user whose
 * provider account lapsed for a week can have hundreds. Printing "8 of 30"
 * costs one caption and is the difference between a summary and a lie.
 *
 * =============================================================================
 * PROPS ONLY — IT FETCHES NOTHING
 * =============================================================================
 *
 * Both lists arrive from `HomePage`, which already holds both summaries.
 * `apps/web/src/pages/HomePage.tsx`'s header states the rule this obeys — ONE
 * REQUEST PER CONTENT TYPE, all fired in parallel, and no per-section list
 * fetches — so a `GET /api/transcripts?status=failed` fired from here would be
 * that rule broken for the sake of two arrays the page is already holding.
 * The API put the rows in `summary()` for exactly this reason; see its header.
 *
 * The retry POSTs are the one exception, and they are not a contradiction of
 * the rule: they happen because a person pressed a button, not because the page
 * loaded. `onTranscriptRetried`/`onNoteRetried` are two callbacks rather than
 * one, so retrying a note refreshes the notes summary and nothing else — a
 * single `onRetried` would make every note retry re-read the transcripts too,
 * which is a request nothing on screen is waiting for.
 *
 * =============================================================================
 * A FAILURE IS REPORTED ON THE ROW IT HAPPENED TO
 * =============================================================================
 *
 * A retry that is itself refused writes under that row, never into a
 * page-level alert. `components/library/TranscriptsLibraryView.tsx` already
 * makes this argument for its audio preview and it applies here unchanged: a
 * message about a recording the reader would then have to go and find is a
 * message about nothing they can act on. With two content types in one list it
 * is sharper still — "Retry failed" at the top of the page does not even say
 * which of the two kinds of thing it is about.
 *
 * THE LIVE REGION IS PERSISTENT, NOT INSERTED WITH ITS TEXT. Every row mounts
 * its status container empty and fills it later, because a `role="status"`
 * element that appears at the same moment as the text inside it is announced by
 * some screen readers and silently ignored by others — the same trap the
 * library view documents, solved here by the container outliving the message.
 *
 * =============================================================================
 * TWO GATES, TWO STRINGS, AND NEITHER IS INVENTED
 * =============================================================================
 *
 * `canRetryTranscripts` is `transcripts:write` and `canRetryNotes` is
 * `notes:write` — the exact strings `transcripts.controller.ts` and
 * `notes.controller.ts` enforce on `POST /:id/retry` and `POST
 * /:id/regenerate`. Without one, the ROW still renders and only its button is
 * withheld: a user who cannot retry still benefits from knowing the recording
 * failed, and hiding the row too would leave them wondering why a transcript
 * they made never appeared. (Both permissions are seeded to all three roles,
 * so this is a deployment that took one away, not the ordinary case.)
 *
 * The notes half is gated one level up instead: `HomePage` passes `[]` unless
 * the caller holds `notes:read`, because a user with no notes permission has no
 * notes summary at all and there is nothing to withhold a button from.
 *
 * =============================================================================
 * NOTHING AT ALL WHEN BOTH LISTS ARE EMPTY
 * =============================================================================
 *
 * Not an empty box, not a reassuring "nothing needs attention" card — the
 * section does not exist on a healthy account. That is the steady state of this
 * application for almost every user on almost every visit, and a permanent
 * empty block would push the recent list below the fold on a phone to say
 * nothing. `InProgressSection` returns `null` for the identical reason.
 *
 * NO `useMediaQuery` HERE, AND NONE MAY BE ADDED. Every responsive decision is
 * an `sx` breakpoint object resolved in CSS, so the five coupled gates in
 * `docs/specs/settings-ui.md` §5 stay exactly five — see `HomePage`'s header.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useIsMounted } from '../../hooks/useIsMounted';
import { ApiError } from '../../services/api';
import { regenerateNote } from '../../services/notes';
import type { NoteListItem } from '../../services/notes';
import { retryTranscript } from '../../services/transcripts';
import type { TranscriptListItem } from '../../services/transcripts';
import { failureMessage } from '../../utils/transcriptDisplay';
import { formatRelativeTime } from '../../utils/relativeTime';

export interface NeedsAttentionProps {
  /** `GET /api/transcripts/summary`'s `failed` list — owner-scoped, max eight. */
  transcripts: TranscriptListItem[];
  /** `counts.failed` — the TRUE total, which the list above is a capped view of. */
  transcriptTotal: number;
  /** `GET /api/notes/summary`'s `failed` list. `[]` without `notes:read`. */
  notes: NoteListItem[];
  /** The notes `counts.failed`. */
  noteTotal: number;
  /** The caller holds `transcripts:write`. Gates the button, never the row. */
  canRetryTranscripts: boolean;
  /** The caller holds `notes:write`. Gates the button, never the row. */
  canRetryNotes: boolean;
  /** `useTranscriptSummary().refresh` — a retried transcript leaves this list. */
  onTranscriptRetried: () => void;
  /** `useNoteSummary().refresh`, kept separate on purpose. See the header. */
  onNoteRetried: () => void;
}

/**
 * The sentence shown under a failed note, always non-empty.
 *
 * `NotePage` states the same order for the same reason: the recorded reason
 * first, and only when the provider returned none a sentence that at least says
 * what happened. The transcript half has `failureMessage` in
 * `utils/transcriptDisplay.ts` and this is deliberately NOT folded into it —
 * that helper reads `transcriptionStatus` to tell a cancellation from a
 * failure, a field a note does not have and never will.
 */
function noteFailureMessage(note: NoteListItem): string {
  return (
    note.failureReason ?? 'Your AI provider did not return a note, and recorded no reason.'
  );
}

/** One row's identity across both content types, for the per-row state maps. */
type RowKey = `transcript:${string}` | `note:${string}`;

interface AttentionRow {
  key: RowKey;
  title: string;
  /** Why it failed — never empty, so the row always says something. */
  reason: string;
  /** When it stopped. `updatedAt`: a failure is the last thing that happened. */
  failedAt: string;
  /** Where the title goes. */
  href: string;
  /**
   * The button's label, or `null` to withhold it.
   *
   * THE VERBS DIFFER ON PURPOSE. "Retry" re-runs a pipeline the deployment
   * already paid for; "Regenerate" spends the user's own AI key again (see
   * CLAUDE.md on why `note.generate` is `maxAttempts: 1` and this button is its
   * only retry path). Naming both "Retry" would hide that difference behind one
   * word, and would also make the two rows' controls indistinguishable to a
   * screen reader listing the page's buttons.
   */
  action: { verb: string; run: () => Promise<unknown>; onDone: () => void } | null;
}

function NeedsAttentionRow({
  row,
  busy,
  error,
  onRetry,
}: {
  row: AttentionRow;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const navigate = useNavigate();

  return (
    <Card variant="outlined" component="li" sx={{ listStyle: 'none' }}>
      {/* TWO SIBLINGS, NOT ONE ACTION AREA. The body opens the item and the
          button retries it, and neither may contain the other: a button inside
          a button is invalid HTML, fails axe, and leaves a keyboard user
          tabbing to a control their screen reader has just described as part of
          something else. `TranscriptsLibraryView`'s rows are built the same way
          and for the same reason. */}
      <Box
        sx={{
          display: 'flex',
          // A phone stacks the button under the text rather than squeezing it
          // beside a title; from `sm` the two sit on one line. One `sx` object,
          // no breakpoint read in JavaScript — see the header.
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          minWidth: 0,
        }}
      >
        <CardActionArea
          onClick={() => navigate(row.href)}
          sx={{ p: 1.75, display: 'block', minWidth: 0, flexGrow: 1 }}
        >
          <Typography variant="subtitle2" component="h3" noWrap sx={{ fontWeight: 600 }}>
            {row.title}
          </Typography>
          <Typography variant="caption" color="error" component="p">
            {row.reason}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p">
            {`Failed ${formatRelativeTime(row.failedAt)}`}
          </Typography>
        </CardActionArea>

        {row.action && (
          <Box sx={{ px: 1.75, pb: { xs: 1.75, sm: 0 }, pr: { sm: 1.75 }, flexShrink: 0 }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<RefreshIcon />}
              loading={busy}
              onClick={onRetry}
              // NAMED WITH THE ITEM, not just the verb: eight rows whose
              // buttons all announce "Retry" are eight controls a screen
              // reader user cannot tell apart.
              aria-label={`${row.action.verb} ${row.title}`}
            >
              {row.action.verb}
            </Button>
          </Box>
        )}
      </Box>

      {/* PERSISTENT AND EMPTY UNTIL IT IS NOT — see the header on why this
          container is not mounted together with its message. */}
      <Box role="status" sx={{ px: 1.75, pb: error ? 1.5 : 0 }}>
        {error && (
          <Typography variant="caption" color="error" component="p">
            {error}
          </Typography>
        )}
      </Box>
    </Card>
  );
}

export function NeedsAttention({
  transcripts,
  transcriptTotal,
  notes,
  noteTotal,
  canRetryTranscripts,
  canRetryNotes,
  onTranscriptRetried,
  onNoteRetried,
}: NeedsAttentionProps) {
  const isMounted = useIsMounted();
  const [busyKey, setBusyKey] = useState<RowKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<RowKey, string>>>({});

  const rows: AttentionRow[] = [
    // TRANSCRIPTS FIRST, THEN NOTES — the same order `InProgressSection` puts
    // the two content types in, so a user whose eye has learned one list does
    // not have to re-learn the other.
    ...transcripts.map((item): AttentionRow => ({
      key: `transcript:${item.id}`,
      title: item.title,
      reason: failureMessage(item),
      failedAt: item.updatedAt,
      href: `/transcripts/${item.id}`,
      action: canRetryTranscripts
        ? {
            verb: 'Retry',
            run: () => retryTranscript(item.id),
            onDone: onTranscriptRetried,
          }
        : null,
    })),
    ...notes.map((item): AttentionRow => ({
      key: `note:${item.id}`,
      title: item.title,
      reason: noteFailureMessage(item),
      failedAt: item.updatedAt,
      href: `/notes/${item.id}`,
      action: canRetryNotes
        ? {
            verb: 'Regenerate',
            run: () => regenerateNote(item.id),
            onDone: onNoteRetried,
          }
        : null,
    })),
  ];

  const retry = useCallback(
    async (row: AttentionRow) => {
      if (!row.action) return;
      setBusyKey(row.key);
      setErrors((current) => ({ ...current, [row.key]: undefined }));
      try {
        await row.action.run();
        if (!isMounted()) return;
        // The refreshed summary is what takes this row off the list — nothing
        // here removes it locally. A row spliced out optimistically would
        // disappear from a section whose whole job is to be accurate about what
        // is broken, on the evidence of a 202 that only means the work was
        // queued again.
        row.action.onDone();
      } catch (err) {
        if (!isMounted()) return;
        setErrors((current) => ({
          ...current,
          [row.key]:
            err instanceof ApiError
              ? err.message || 'That could not be started again.'
              : 'That could not be started again.',
        }));
      } finally {
        if (isMounted()) setBusyKey(null);
      }
    },
    [isMounted],
  );

  // BOTH EMPTY MEANS ABSENT — see the header. Read off the rows rather than the
  // counts, deliberately: `counts.failed` is the true total and stays non-zero
  // for a deployment whose lists this page could not read, and a heading over
  // no rows is the one thing this section must never be.
  if (rows.length === 0) return null;

  // "8 of 30", only when the caps actually bit. `counts.failed` per content
  // type, summed — never `rows.length`, which is the capped view.
  const total = transcriptTotal + noteTotal;
  const capped = total > rows.length;

  return (
    <Box
      component="section"
      aria-labelledby="home-needs-attention"
      sx={{ mb: { xs: 3, sm: 4 } }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'baseline', flexWrap: 'wrap', mb: 1.5 }}
      >
        {/* `h2`, like every other section on this page: the page's one `h1` is
            the greeting in the hero, and an `h3` here would skip a level. */}
        <Typography
          id="home-needs-attention"
          variant="h6"
          component="h2"
          sx={{ fontWeight: 600 }}
        >
          Needs attention
        </Typography>
        {capped && (
          <Typography variant="caption" color="text.secondary">
            {`Showing ${rows.length} of ${total}`}
          </Typography>
        )}
      </Stack>

      <Stack component="ul" spacing={1.5} sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {rows.map((row) => (
          <NeedsAttentionRow
            key={row.key}
            row={row}
            busy={busyKey === row.key}
            error={errors[row.key] ?? null}
            onRetry={() => void retry(row)}
          />
        ))}
      </Stack>
    </Box>
  );
}

export default NeedsAttention;
