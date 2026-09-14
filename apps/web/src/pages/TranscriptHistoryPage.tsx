/**
 * `/transcripts/:id/history` — A PLACEHOLDER FOR ISSUE #31.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS AT ALL, GIVEN THAT IT RENDERS ALMOST NOTHING
 * =============================================================================
 *
 * Issue #30 owns the routing, the AppBar's drill-down table and the destination
 * model; issue #31 owns version history. Leaving the route out until #31 lands
 * means that, in the meantime, `/transcripts/abc/history` falls through to the
 * catch-all and lands silently on `/` — the same failure `App.tsx` documents at
 * length about the pre-#92 `/admin/users` bookmark, where "did the user reach
 * the right page" and "did the user reach home" were the same observation.
 *
 * Declaring it now also means the AppBar's `DRILL_DOWN_ROUTES` entry for it
 * (`Version history`, up to the transcript) is live and tested rather than
 * pointing at nothing.
 *
 * =============================================================================
 * WHAT #31 SHOULD DO WITH IT
 * =============================================================================
 *
 * REPLACE THE BODY, KEEP THE FILE PATH AND THE DEFAULT EXPORT. `App.tsx` lazy-
 * imports `./pages/TranscriptHistoryPage`, `destinations.ts` already owns the
 * route through its `/transcripts` prefix, and `AppBar` already titles it — so
 * a replacement that keeps those three facts needs no change anywhere else.
 * The `id` param is read here purely to prove the route carries it.
 *
 * It deliberately does NOT fetch anything. A placeholder that polls an endpoint
 * would be a placeholder with a bug surface.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useNavigate, useParams } from 'react-router-dom';

export function TranscriptHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <Box sx={{ maxWidth: 700, mx: 'auto' }}>
      <Typography variant="h5" component="h1" gutterBottom>
        Version history
      </Typography>
      <Alert severity="info">
        Version history is not available yet. When it is, every correction made
        to this transcript will be listed here, with the option to restore an
        earlier version.
      </Alert>
      <Button sx={{ mt: 2 }} onClick={() => navigate(`/transcripts/${id ?? ''}`)}>
        Back to the transcript
      </Button>
    </Box>
  );
}

export default TranscriptHistoryPage;
