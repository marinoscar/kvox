/**
 * The one list every onboarding surface renders — issue #276, epic #271.
 *
 * =============================================================================
 * ONE COMPONENT, TWO AUDIENCES
 * =============================================================================
 *
 * The admin setup page (#278) and the getting-started page (#279) render the
 * same thing: steps with a status, an action and a skip. #275 returns ONE
 * response shape from both routes precisely so this can be one component.
 *
 * Two components — one per audience — was the obvious alternative and is
 * rejected on a specific ground rather than on taste: the rendering is
 * identical, so the second implementation would exist only to be kept in step
 * with the first, and the second implementation is reliably where the
 * accessibility work below gets skipped.
 *
 * It takes a `state` and three callbacks and owns no data of its own. It does
 * not navigate — `onAction` hands the step back to the page, which knows
 * whether it is routing, opening a dialog, or closing a welcome modal first.
 * A `useNavigate` in here would make the component untestable outside a router
 * and would take the decision away from the only place that has the context to
 * make it.
 *
 * =============================================================================
 * ACCESSIBILITY IS THE REQUIREMENT, NOT THE POLISH PASS
 * =============================================================================
 *
 * 1. ⚠ STATUS IS TEXT. `Done` / `Not set up` / `Waiting on your administrator`,
 *    rendered as words, with every icon `aria-hidden`. A green tick and a grey
 *    circle are the same shape to a screen reader and the same colour to a
 *    meaningful fraction of sighted users; a checklist whose entire meaning is
 *    carried by colour and icon is a checklist that cannot be read. The icons
 *    stay because they make the list scannable — they are decoration ON the
 *    text, never a replacement for it.
 *
 * 2. ⚠ A BLOCKED STEP'S REASON IS ASSOCIATED, NOT MERELY NEARBY. The action is
 *    `disabled`, and `aria-describedby` points at the visible sentence saying
 *    who has to act first. A disabled button with an unassociated explanation
 *    two lines below announces as "Set up transcription, dimmed" and nothing
 *    else — which is the exact moment the user needs to be told they are
 *    waiting on somebody rather than looking at a broken button.
 *
 * 3. ⚠ IT IS A REAL `<ol>` OF `<li>`s, so a screen reader announces position
 *    and size ("3 of 7"). Rejected alternative: three `<ol>`s with a heading
 *    each, one per tier. It reads better on screen and it breaks exactly that —
 *    the count resets per group, so "3 of 7" becomes three separate "1 of 2"s
 *    and the user loses any sense of how much is left. The tiers are instead
 *    CONTIGUOUS (required first) inside one list, with each row carrying its
 *    tier as a word, which preserves both the grouping and the count.
 *
 * 4. Progress is a `<LinearProgress>` with an `aria-label` AND a text
 *    equivalent beside it, for the same reason as (1): a bar is not a number.
 *
 * =============================================================================
 * ⚠ NOT ONE `useMediaQuery` — HERE OR ANYWHERE IN THIS EPIC
 * =============================================================================
 *
 * Every responsive decision below is an `sx`/`Grid` breakpoint object resolved
 * in CSS. CLAUDE.md's Settings UI Pattern rule 5 says the coupled breakpoint
 * gates are exactly five and that they move together or not at all; a
 * `useMediaQuery` in a component mounted by two settings surfaces would be a
 * sixth, and it would be one nobody remembers to move with the other five.
 * `HomePage.tsx` and `JourneyEmptyState.tsx` keep the same discipline, and
 * `__tests__/components/onboarding/SetupChecklist.test.tsx` greps this file's
 * source to keep it that way.
 *
 * `prefers-reduced-motion` is honoured on the one thing here that animates.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import type { ReactNode } from 'react';

import type {
  OnboardingState,
  OnboardingStepState,
  OnboardingStepStatus,
  OnboardingTier,
} from '../../services/onboarding';

/**
 * The words a status is rendered as.
 *
 * ⚠ THIS MAP IS THE ACCESSIBLE NAME OF THE STATUS, not a caption under an icon.
 * Exported so the suite asserts the WORDS rather than the icons, which is the
 * only assertion that can tell this component apart from one that conveys
 * status by colour alone and passes every visual check.
 *
 * `Waiting on your administrator` is deliberately a sentence about a PERSON.
 * "Blocked" is the API's word for a state machine; it tells a user nothing about
 * what to do next, and what to do next here is "wait, or go and ask somebody".
 */
export const STATUS_LABELS: Record<OnboardingStepStatus, string> = {
  satisfied: 'Done',
  pending: 'Not set up',
  blocked: 'Waiting on your administrator',
};

/** The word each tier is rendered as. Shown per row — see point 3 of the header. */
export const TIER_LABELS: Record<OnboardingTier, string> = {
  required: 'Required',
  recommended: 'Recommended',
  optional: 'Optional',
};

/**
 * Required first, then recommended, then optional.
 *
 * The ORDER IS THE GROUPING (header point 3). Within a tier the server's
 * registry order is preserved, which is why the sort below must be stable —
 * `Array.prototype.sort` is required to be stable in every engine this app
 * targets, so a plain sort on this rank is enough.
 */
const TIER_RANK: Record<OnboardingTier, number> = {
  required: 0,
  recommended: 1,
  optional: 2,
};

const STATUS_ICONS: Record<OnboardingStepStatus, ReactNode> = {
  satisfied: <CheckCircleIcon fontSize="small" />,
  pending: <RadioButtonUncheckedIcon fontSize="small" />,
  blocked: <HourglassEmptyIcon fontSize="small" />,
};

const STATUS_COLORS: Record<OnboardingStepStatus, string> = {
  satisfied: 'success.main',
  pending: 'text.secondary',
  blocked: 'warning.main',
};

/**
 * A DOM id derived from a step key.
 *
 * Step keys are dotted (`admin.transcription`). A dot is legal in an HTML id
 * but is a class selector in CSS and in `querySelector`, which is how a
 * perfectly valid `aria-describedby` ends up untestable and, worse, how a
 * later stylesheet silently fails to match. Normalised once, here.
 */
export function stepDomId(key: string, suffix: string): string {
  return `onboarding-${key.replace(/[^a-zA-Z0-9]+/g, '-')}-${suffix}`;
}

/** Required first; registry order within a tier. */
export function sortStepsByTier(
  steps: readonly OnboardingStepState[],
): OnboardingStepState[] {
  return [...steps].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}

export interface SetupChecklistProps {
  /**
   * The checklist to render.
   *
   * ⚠ `null` RENDERS NOTHING AT ALL — not an empty state, not an error. This
   * component is mounted inside the app shell's surfaces, and a read that
   * failed must degrade to occupying no space rather than to an error banner
   * that would then appear above every page in the application. The provider
   * holds the same position; see `contexts/OnboardingContext.tsx`.
   */
  state: OnboardingState | null;
  /** The first read has not settled. Renders a skeleton rather than an empty list. */
  isLoading?: boolean;
  /** The user chose not to do this step. Never offered for a `required` one. */
  onSkip: (stepKey: string) => void;
  /** The user changed their mind. The reason #275 returns skipped steps at all. */
  onUnskip: (stepKey: string) => void;
  /**
   * The user wants to go and do this step.
   *
   * Handed the whole step rather than its `href`, so a caller can branch on
   * the key (close a welcome dialog first, record where the user went) without
   * this component having to know that any of that exists.
   */
  onAction: (step: OnboardingStepState) => void;
}

function StatusLine({ step }: { step: OnboardingStepState }) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{ alignItems: 'center', color: STATUS_COLORS[step.status] }}
    >
      {/* Decoration ON the text below, never a replacement for it. */}
      <Box aria-hidden sx={{ display: 'flex' }}>
        {STATUS_ICONS[step.status]}
      </Box>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {STATUS_LABELS[step.status]}
      </Typography>
    </Stack>
  );
}

function StepRow({
  step,
  onSkip,
  onUnskip,
  onAction,
}: { step: OnboardingStepState } & Omit<SetupChecklistProps, 'state' | 'isLoading'>) {
  const isBlocked = step.status === 'blocked';
  const reasonId = stepDomId(step.key, 'reason');
  // Offered only where it means something: a satisfied step has nothing left to
  // skip, a skipped one is already skipped, and `skippable` is always false for
  // a required step (the API's own invariant — this trusts it rather than
  // re-deriving it from `tier`, so one place decides).
  const canSkip = step.skippable && !step.skipped && step.status !== 'satisfied';

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        // A skipped row stays fully legible — it is dimmed, not hidden, because
        // the whole point of returning it is that the user can undo it.
        opacity: step.skipped ? 0.65 : 1,
      }}
    >
      <Stack
        // Stacked on a phone, side by side from `sm`. One CSS breakpoint object,
        // no hook — see the header.
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: { xs: 'stretch', sm: 'flex-start' } }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography
            variant="overline"
            component="p"
            color="text.secondary"
            sx={{ lineHeight: 1.6 }}
          >
            {TIER_LABELS[step.tier]}
          </Typography>
          <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
            {step.title}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {step.description}
          </Typography>

          <Stack
            direction="row"
            spacing={1.5}
            sx={{ mt: 1, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <StatusLine step={step} />
            {step.skipped && (
              <Typography variant="body2" color="text.secondary">
                Skipped
              </Typography>
            )}
          </Stack>

          {/* Visible prose, and the thing `aria-describedby` points at. Rendered
              whenever the server sent one, so a reason that arrives on a status
              this build does not expect is still shown rather than swallowed. */}
          {step.blockedReason && (
            <Typography id={reasonId} variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {step.blockedReason}
            </Typography>
          )}
        </Box>

        <Stack
          direction="row"
          spacing={1}
          sx={{ flexShrink: 0, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Button
            variant={step.status === 'pending' && !step.skipped ? 'contained' : 'outlined'}
            size="small"
            disabled={isBlocked}
            // Associated, not merely adjacent. See header point 2.
            aria-describedby={isBlocked && step.blockedReason ? reasonId : undefined}
            onClick={() => onAction(step)}
          >
            {step.actionLabel}
          </Button>
          {canSkip && (
            <Button size="small" color="inherit" onClick={() => onSkip(step.key)}>
              Skip
            </Button>
          )}
          {step.skipped && (
            <Button size="small" color="inherit" onClick={() => onUnskip(step.key)}>
              Undo skip
            </Button>
          )}
        </Stack>
      </Stack>
    </Paper>
  );
}

function LoadingChecklist() {
  return (
    <Box aria-busy="true" aria-live="polite">
      {/* The text equivalent, for the same reason the progress bar has one: a
          row of grey rectangles announces as nothing at all. */}
      <Typography variant="body2" color="text.secondary">
        Checking what is left to set up…
      </Typography>
      <Stack spacing={1.5} sx={{ mt: 2 }} aria-hidden>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} variant="rounded" height={96} />
        ))}
      </Stack>
    </Box>
  );
}

export function SetupChecklist({
  state,
  isLoading = false,
  onSkip,
  onUnskip,
  onAction,
}: SetupChecklistProps) {
  if (isLoading) return <LoadingChecklist />;

  // Nothing, in both senses: no state (a failed read — see the prop's own
  // comment) and no steps (a deployment where every step was filtered out as
  // inapplicable). Neither is an error and neither has anything to say.
  if (!state || state.steps.length === 0) return null;

  const total = state.steps.length;
  // "Settled" rather than "done": a skipped step is counted out of
  // `totalRemaining` by the server, so the bar and the sentence both reflect
  // the decision the user made rather than pretending the step is still owed.
  const settled = total - state.totalRemaining;
  const percent = total === 0 ? 0 : Math.round((settled / total) * 100);
  const progressText = `${settled} of ${total} complete`;

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={{ xs: 1, sm: 2 }}
        sx={{ alignItems: { sm: 'center' }, mb: 2 }}
      >
        <LinearProgress
          variant="determinate"
          value={percent}
          aria-label="Setup progress"
          sx={{
            flexGrow: 1,
            width: '100%',
            height: 8,
            borderRadius: 1,
            // The one thing here that animates, and it is switched off for
            // anyone who asked for that. A progress bar sliding across the
            // screen is exactly the motion the preference exists to suppress.
            '@media (prefers-reduced-motion: reduce)': {
              '& .MuiLinearProgress-bar': { transition: 'none' },
            },
          }}
        />
        {/* The number, in words, beside the bar — not inside its aria-label,
            where a sighted user could not read it. */}
        <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
          {progressText}
        </Typography>
      </Stack>

      <Stack
        component="ol"
        spacing={1.5}
        aria-label="Setup steps"
        sx={{ listStyle: 'none', p: 0, m: 0 }}
      >
        {sortStepsByTier(state.steps).map((step) => (
          <Box component="li" key={step.key}>
            <StepRow
              step={step}
              onSkip={onSkip}
              onUnskip={onUnskip}
              onAction={onAction}
            />
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

export default SetupChecklist;
