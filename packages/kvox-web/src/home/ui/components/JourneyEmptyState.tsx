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
 * ⚠ ONE OF THE FOUR IS MARKED "Coming soon", AND THAT IS DELIBERATE HONESTY.
 * Epic #19 shipped Capture and Correct; epic #45 shipped Transform, and issue
 * #107 — which put notes on this very page — is what took its `comingSoon`
 * flag off. Find is the vision's next stage and does not exist yet. Drawing it
 * as though it worked would buy one pleasant first impression and spend it on a
 * user hunting for a feature that is not there — so it is drawn, because the
 * shape of the journey is the point, and it is labelled, because the shape is
 * not a promise about today. When it ships, delete its `comingSoon` flag; there
 * is nothing else to change.
 *
 * The "Use" stage of the vision is deliberately not one of the four cards: at
 * this width four is already the most a phone can show without scrolling past
 * the call to action, and "Use" is what the other three are FOR rather than a
 * separate step a user performs.
 */

import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import { Link as RouterLink } from 'react-router-dom';

import type { KvoxJourneyStep } from '../../headless/index.js';

/**
 * Props of {@link JourneyEmptyState}.
 *
 * @stability experimental
 */
export interface JourneyEmptyStateProps {
  /**
   * The steps to offer, already filtered for the viewer (see
   * `resolveJourneySteps`). The first one that is not done is the primary
   * action; the rest are secondary. None: the stage cards stand alone.
   */
  steps?: readonly KvoxJourneyStep[];
  /** The four stage cards. Default {@link JOURNEY_STAGES}. */
  stages?: readonly JourneyStage[];
  /** The sentence under "Start here". Default {@link JOURNEY_INTRO}. */
  intro?: string;
}

/**
 * One card of the journey.
 *
 * @stability experimental
 */
export interface JourneyStage {
  /** A stable key, unique within the journey. */
  key: string;
  /** The stage's name. */
  label: string;
  /** One sentence about it. */
  description: string;
  /** The stage's icon. */
  icon: ReactNode;
  /** Drawn, but explicitly not available yet. See the file header. */
  comingSoon?: boolean;
}

/**
 * The sentence under "Start here" when the host gives none.
 *
 * @stability experimental
 */
export const JOURNEY_INTRO = 'You have no transcripts yet. Here is what happens once you do.';

/**
 * The journey, in order. Exported so the page's test asserts the SEQUENCE
 * rather than four independent strings — the order is the meaning here.
 *
 * @stability experimental
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

/**
 * One step: its control, then what it has to say. A done step is a quiet
 * statement instead of a control.
 */
function StepItem({ step, primary }: { step: KvoxJourneyStep; primary: boolean }) {
  const { action } = step;

  const control = step.done ? (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', color: 'text.secondary' }}>
      <CheckCircleIcon fontSize="small" color="success" aria-hidden />
      <Typography variant="body2">{`${step.title} (done)`}</Typography>
    </Stack>
  ) : action.element !== undefined ? (
    action.element
  ) : action.to === undefined && action.onClick === undefined ? null : (
    <Button
      variant={primary ? 'contained' : 'outlined'}
      size="large"
      startIcon={action.icon}
      disabled={action.disabled === true}
      aria-describedby={action.describedBy}
      sx={{ width: { xs: '100%', sm: 'auto' } }}
      {...(action.to === undefined
        ? { onClick: action.onClick }
        : { component: RouterLink, to: action.to, onClick: action.onClick })}
    >
      {action.label}
    </Button>
  );

  return (
    <Box role="group" aria-label={step.title} sx={{ minWidth: 0 }}>
      {control}
      {typeof step.body === 'string' ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 1, maxWidth: '36ch', overflowWrap: 'break-word' }}
        >
          {step.body}
        </Typography>
      ) : (
        step.body
      )}
    </Box>
  );
}

/**
 * The first-run walkthrough: "Start here", the stage cards of the product's flow and the
 * steps the person can take now.
 *
 * @param props - see {@link JourneyEmptyStateProps}.
 * @returns the section.
 *
 * @stability experimental
 */
export function JourneyEmptyState({
  steps = [],
  stages = JOURNEY_STAGES,
  intro = JOURNEY_INTRO,
}: JourneyEmptyStateProps) {
  // The first step still to do is THE action; the others sit beside it.
  const primaryKey = steps.find((step) => !step.done)?.key;

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
        {intro}
      </Typography>

      {/* Two-up at `sm` rather than four-up: the four stages read as a
          progression, and four 220px columns on a tablet turn the progression
          into a row of unrelated tiles. Four across only from `lg`, where each
          card still has room for its sentence. */}
      <Grid container spacing={1.5} component="ol" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {stages.map((stage) => (
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

      {steps.length > 0 && (
        <Box
          sx={{
            mt: 2.5,
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            flexWrap: { xs: 'nowrap', sm: 'wrap' },
            gap: 1.5,
            alignItems: { xs: 'stretch', sm: 'flex-start' },
          }}
        >
          {steps.map((step) => (
            <StepItem key={step.key} step={step} primary={step.key === primaryKey} />
          ))}
        </Box>
      )}
    </Box>
  );
}

export default JourneyEmptyState;
