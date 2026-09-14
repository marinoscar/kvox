/**
 * "Shared with me" — transcripts somebody else recorded and let this user in on.
 * Issue #32, epic #19.
 *
 * HIDDEN WHEN EMPTY, and for a sharper reason than `InProgressSection`'s. Most
 * accounts in most deployments are never shared anything at all, so an empty
 * "Shared with me — nothing yet" block would be permanent dead space on the
 * home page of the majority of users, advertising a feature they have no way to
 * trigger themselves (only an owner can share).
 *
 * THE ROLE CHIP IS NOT DECORATION. `access` is the difference between a
 * transcript this user may correct and one they may only read, and it is the
 * one thing about a shared row that is NOT true of their own: discovering it by
 * opening the transcript and finding the editor disabled is the failure this
 * chip exists to prevent. The wording ("Viewer" / "Editor") comes from
 * `accessRoleLabel`, shared with the card, so the home page and the viewer
 * cannot name the same grant differently.
 */

import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';

import { TranscriptSummaryCard } from './TranscriptSummaryCard';
import type { HomeTranscriptItem } from './TranscriptSummaryCard';

export interface SharedWithMeProps {
  /** At most eight, already ordered newest-first by the API. */
  items: HomeTranscriptItem[];
}

export function SharedWithMe({ items }: SharedWithMeProps) {
  if (items.length === 0) return null;

  return (
    <Box component="section" aria-labelledby="home-shared" sx={{ mb: { xs: 3, sm: 4 } }}>
      <Typography
        id="home-shared"
        variant="h6"
        component="h2"
        sx={{ mb: 1.5, fontWeight: 600 }}
      >
        Shared with me
      </Typography>

      {/* The same grid sizes as `RecentTranscripts`, deliberately: two lists of
          the same kind of thing that reflowed at different widths would look
          like a bug on exactly the tablet widths nobody tests by hand. */}
      <Grid container spacing={1.5} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {items.map((item) => (
          <Grid
            key={item.id}
            component="li"
            size={{ xs: 12, sm: 6, md: 4, lg: 3 }}
            sx={{ display: 'flex' }}
          >
            <TranscriptSummaryCard transcript={item} showOwner />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

export default SharedWithMe;
