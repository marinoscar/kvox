/**
 * The home page's counts strip — issue #170, epic #166 ("Home at Scale").
 *
 * Four numbers under the hero, each one a link into the library it counts:
 * Transcripts, Shared with me, Notes, and — only when there is something to say
 * — Needs attention.
 *
 * =============================================================================
 * IT FIRES NO REQUEST, AND THAT IS THE WHOLE POINT
 * =============================================================================
 *
 * Every number here is ALREADY IN HAND. `GET /api/transcripts/summary` returns
 * `counts.owned` / `counts.shared` / `counts.failed` and `GET
 * /api/notes/summary` returns `counts.total` / `counts.failed`, both read by
 * hooks the page already mounts for its lists. This component takes those two
 * count objects as props and does arithmetic.
 *
 * ⚠ IT MUST NEVER GROW A FETCH OF ITS OWN, and `HomePage.test.tsx` asserts the
 * call counts rather than trusting this paragraph. `HomePage`'s header states
 * the rule this obeys — ONE REQUEST PER CONTENT TYPE, fired in parallel, no
 * per-section list fetches — and a strip that asked for, say, its own
 * `GET /api/transcripts?status=failed&limit=0` to get an "accurate" failure
 * count would be the third request on the app's landing screen, in service of a
 * number the first request already answered. A count this strip wants and a
 * summary endpoint does not return is a reason to extend that endpoint.
 *
 * =============================================================================
 * WHY IT IS NOT THE STATS DASHBOARD `HomePage` REJECTED
 * =============================================================================
 *
 * `HomePage`'s header rejects a stats dashboard — minutes transcribed, charts —
 * because it helps a user neither capture nor find anything. This is the
 * opposite shape and survives that same test: every entry is a NAVIGATION
 * TARGET whose number is the reason to press it. "Shared with me: 3" takes you
 * to `/transcripts?scope=shared`; "Needs attention: 2" takes you to
 * `/transcripts?status=failed`. Nothing here is a figure to admire, which is
 * why the deep-link seeding in `transcriptsLibraryFilters.ts` had to exist
 * before this component could.
 *
 * =============================================================================
 * IT RENDERS NOTHING WITHOUT A TRANSCRIPT SUMMARY
 * =============================================================================
 *
 * ⚠ `transcripts === null` RETURNS NULL, and it is the same load-bearing clause
 * `HomePage` applies to `isNewUser`. A summary read that FAILED leaves the page
 * with no counts because nothing was ever read, not because nothing exists —
 * and a strip that treated "no data" as zero would tell a user with a hundred
 * recordings that they have none, in large type, directly above the alert
 * saying the read failed.
 *
 * The notes half is separately nullable for two different reasons that happen
 * to want the same behaviour: the caller may not hold `notes:read` (the page
 * never issues the request), or the request may have failed. Either way there
 * is no honest notes number, so the Notes entry is ABSENT rather than zero.
 *
 * =============================================================================
 * AND NOTHING ON THE NEW-USER JOURNEY
 * =============================================================================
 *
 * `HomePage` mounts this only when `isNewUser` is false. A first-run account's
 * strip would read 0 · 0 · 0 above the walkthrough that is explaining how to
 * stop it reading zero — four empty counters as the first thing on the screen,
 * competing with the one instruction that screen exists to give. The decision
 * lives at the call site because `isNewUser` does: it is a fact about the whole
 * page, not about these numbers.
 *
 * =============================================================================
 * NO `useMediaQuery` HERE, EVER
 * =============================================================================
 *
 * The layout is one `Grid` breakpoint object — two columns on a phone, one row
 * from `sm` up — resolved entirely in CSS. `HomePage`'s header states the rule
 * for the whole page: a JavaScript breakpoint read here would be a sixth thing
 * to check every time the five coupled gates in `docs/specs/settings-ui.md` §5
 * move, in exchange for a layout CSS already does.
 */

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import type { NoteSummary } from '../../services/notes';
import type { TranscriptSummary } from '../../services/transcripts';

export interface CountsStripProps {
  /** `GET /api/transcripts/summary`'s counts, or null if it never answered. */
  transcripts: TranscriptSummary['counts'] | null;
  /** `GET /api/notes/summary`'s counts; null without `notes:read`, or on a failed read. */
  notes: NoteSummary['counts'] | null;
}

interface CountsEntry {
  key: string;
  label: string;
  value: number;
  to: string;
  /** A theme colour token for the number. `null` means the ordinary text colour. */
  emphasis: 'error' | null;
}

/**
 * The entries, derived from the two count objects and nothing else.
 *
 * EXPORTED AND PURE, so the rules below — which entries exist, which are
 * conditional, where each one points — are asserted as data rather than
 * through six queries against a rendered grid.
 */
export function countsEntries(
  transcripts: TranscriptSummary['counts'] | null,
  notes: NoteSummary['counts'] | null,
): CountsEntry[] {
  if (!transcripts) return [];

  const entries: CountsEntry[] = [
    {
      key: 'transcripts',
      label: 'Transcripts',
      value: transcripts.owned,
      to: '/transcripts',
      emphasis: null,
    },
    {
      key: 'shared',
      label: 'Shared with me',
      value: transcripts.shared,
      // The scope tab this lands on is seeded from the query string — see
      // `transcriptsLibraryFilters.ts`. Linking to `/transcripts` and expecting
      // the user to find the tab is the version of this entry that does not
      // earn its place.
      to: '/transcripts?scope=shared',
      emphasis: null,
    },
  ];

  // Absent, never zero: see the header. "0 notes" and "we could not read your
  // notes" are different sentences and only one of them is true here.
  if (notes) {
    entries.push({
      key: 'notes',
      label: 'Notes',
      value: notes.total,
      to: '/notes',
      emphasis: null,
    });
  }

  /**
   * ONE NUMBER ACROSS BOTH CONTENT TYPES, and only when it is not zero.
   *
   * A user does not have "a failed transcript problem" and "a failed note
   * problem" — they have work that did not finish, and splitting the answer in
   * two would make them read two counters to ask one question. The link goes to
   * the transcripts library because that is where a failure is usually
   * actionable (retry re-runs the pipeline); a notes failure is reached one tap
   * further on, which is the honest cost of one entry rather than two.
   *
   * Hidden at zero because the steady state of a healthy account is zero, and a
   * permanent "Needs attention: 0" is a warning-coloured tile that never means
   * anything — the same argument `SharedWithMe` and `InProgressSection` make
   * for disappearing entirely rather than rendering an empty heading.
   */
  const needsAttention = transcripts.failed + (notes?.failed ?? 0);
  if (needsAttention > 0) {
    entries.push({
      key: 'attention',
      label: 'Needs attention',
      value: needsAttention,
      to: '/transcripts?status=failed',
      emphasis: 'error',
    });
  }

  return entries;
}

export function CountsStrip({ transcripts, notes }: CountsStripProps) {
  const entries = countsEntries(transcripts, notes);

  if (entries.length === 0) return null;

  return (
    <Box
      component="section"
      // A LABEL, not a visible heading. Every other section on this page heads
      // itself with an `h2` a reader can see; this one is four links whose own
      // names say everything the heading would, and "At a glance" above them
      // would be a line of chrome explaining a row that explains itself. The
      // region label exists so a screen-reader user can still skip the strip as
      // a unit, which is the part a missing heading would genuinely cost them.
      aria-label="Your library at a glance"
      sx={{ mb: { xs: 3, sm: 4 } }}
    >
      <Grid container spacing={1.5} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {entries.map((entry) => (
          <Grid
            key={entry.key}
            component="li"
            // Two columns on a phone — a 360px screen cannot give four numbers a
            // legible column each — and one row from `sm` up. `sm: 3` rather
            // than `sm: 'grow'` so that the three-entry case (an account with no
            // failures and no notes permission) keeps the SAME tile width as the
            // four-entry case, instead of the tiles quietly resizing when a
            // transcript fails.
            size={{ xs: 6, sm: 3 }}
            sx={{ display: 'flex' }}
          >
            <Card variant="outlined" sx={{ width: '100%' }}>
              <CardActionArea
                component={RouterLink}
                to={entry.to}
                // BOTH FACTS IN THE ACCESSIBLE NAME. The two lines below are
                // separate elements, and a reader that concatenated them without
                // a separator would announce this link as "12Transcripts" — or,
                // worse for the bare-number case this rule exists to prevent,
                // just "12". Spelling the name out is deterministic; the visible
                // text is the same words in the same order, so it satisfies
                // label-in-name rather than replacing what is on screen.
                aria-label={`${entry.value} ${entry.label}`}
                sx={{ p: { xs: 1.5, sm: 2 }, height: '100%' }}
              >
                <Typography
                  component="span"
                  variant="h5"
                  sx={{
                    display: 'block',
                    fontWeight: 600,
                    lineHeight: 1.2,
                    // `error.main` is the colour this application already gives a
                    // failure — `transcriptStatusDescriptor` maps `failed` to the
                    // `error` palette, and the status chip beside every failed row
                    // is drawn from it. A warning amber here would be a third
                    // opinion about how alarming a failure is.
                    color: entry.emphasis === 'error' ? 'error.main' : 'text.primary',
                  }}
                >
                  {entry.value.toLocaleString()}
                </Typography>
                <Typography
                  component="span"
                  variant="body2"
                  sx={{ display: 'block', color: 'text.secondary', mt: 0.25 }}
                >
                  {entry.label}
                </Typography>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

export default CountsStrip;
