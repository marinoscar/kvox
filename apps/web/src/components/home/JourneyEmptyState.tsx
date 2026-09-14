/**
 * The first thing a brand-new account sees — issue #32, epic #19.
 *
 * =============================================================================
 * WHY AN EMPTY STATE IS A PRODUCT EXPLANATION HERE AND NOT A SHRUG
 * =============================================================================
 *
 * `VISION.md` describes this product as one flow — **Capture → Correct →
 * Transform → Use → Find it again later** — and a user with no transcripts has
 * no way to infer any of it from a page that says "Nothing here yet". The four
 * steps below ARE the product's thesis, rendered at the one moment the user has
 * nothing else to look at.
 *
 * ⚠ TWO OF THE FOUR ARE MARKED "Coming soon", AND THAT IS DELIBERATE HONESTY.
 * Epic #19 ships Capture and Correct. Transform and Find are the vision's next
 * two stages and do not exist yet. Drawing all four as though they worked would
 * buy one pleasant first impression and spend it on a user hunting for a
 * feature that is not there — so they are drawn, because the shape of the
 * journey is the point, and they are labelled, because the shape is not a
 * promise about today. When either ships, delete its `comingSoon` flag; there
 * is nothing else to change.
 *
 * The "Use" stage of the vision is deliberately not one of the four cards: at
 * this width four is already the most a phone can show without scrolling past
 * the call to action, and "Use" is what the other three are FOR rather than a
 * separate step a user performs.
 */

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import EditNoteIcon from '@mui/icons-material/EditNote';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import MicIcon from '@mui/icons-material/Mic';
import SearchIcon from '@mui/icons-material/Search';
import type { ReactNode } from 'react';

import { NewTranscriptButton } from './NewTranscriptButton';

export interface JourneyEmptyStateProps {
  /** `GET /api/transcription/config` said this deployment can transcribe. */
  transcriptionAvailable: boolean;
  /** The capability probe has not answered yet. */
  isCheckingTranscription?: boolean;
}

interface JourneyStage {
  key: string;
  label: string;
  description: string;
  icon: ReactNode;
  /** Drawn, but explicitly not available yet. See the file header. */
  comingSoon?: boolean;
}

/**
 * The journey, in order. Exported so the page's test asserts the SEQUENCE
 * rather than four independent strings — the order is the meaning here.
 */
export const JOURNEY_STAGES: readonly JourneyStage[] = [
  {
    key: 'capture',
    label: 'Capture',
    description: 'Upload a recording and get a transcript that knows who spoke.',
    icon: <MicIcon />,
  },
  {
    key: 'correct',
    label: 'Correct',
    description: 'Fix names, merge speakers, edit the words. It becomes yours.',
    icon: <EditNoteIcon />,
  },
  {
    key: 'transform',
    label: 'Transform',
    description: 'Turn a conversation into notes, decisions and summaries.',
    icon: <AutoAwesomeIcon />,
    comingSoon: true,
  },
  {
    key: 'find',
    label: 'Find',
    description: 'Search everything you have ever recorded, months later.',
    icon: <SearchIcon />,
    comingSoon: true,
  },
];

function StageCard({ stage }: { stage: JourneyStage }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        height: '100%',
        width: '100%',
        // The two unavailable stages are dimmed as well as labelled. The chip
        // alone is easy to miss on a phone, where the four cards stack and a
        // reader's eye is travelling down a column of identically-weighted
        // boxes.
        opacity: stage.comingSoon ? 0.6 : 1,
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Box sx={{ display: 'flex', color: 'primary.main' }} aria-hidden>
          {stage.icon}
        </Box>
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
          {stage.label}
        </Typography>
        {stage.comingSoon && <Chip size="small" label="Coming soon" />}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {stage.description}
      </Typography>
    </Paper>
  );
}

export function JourneyEmptyState({
  transcriptionAvailable,
  isCheckingTranscription = false,
}: JourneyEmptyStateProps) {
  return (
    <Box component="section" aria-labelledby="home-journey" sx={{ mb: { xs: 3, sm: 4 } }}>
      <Typography
        id="home-journey"
        variant="h6"
        component="h2"
        sx={{ mb: 0.5, fontWeight: 600 }}
      >
        Start here
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        You have no transcripts yet. Here is what happens once you do.
      </Typography>

      {/* Two-up at `sm` rather than four-up: the four stages read as a
          progression, and four 220px columns on a tablet turn the progression
          into a row of unrelated tiles. Four across only from `lg`, where each
          card still has room for its sentence. */}
      <Grid container spacing={1.5} component="ol" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {JOURNEY_STAGES.map((stage) => (
          <Grid
            key={stage.key}
            component="li"
            size={{ xs: 12, sm: 6, lg: 3 }}
            sx={{ display: 'flex' }}
          >
            <StageCard stage={stage} />
          </Grid>
        ))}
      </Grid>

      <Box sx={{ mt: 2.5 }}>
        <NewTranscriptButton
          available={transcriptionAvailable}
          isChecking={isCheckingTranscription}
        />
      </Box>
    </Box>
  );
}

export default JourneyEmptyState;
