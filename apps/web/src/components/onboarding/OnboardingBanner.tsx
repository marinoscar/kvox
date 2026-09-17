/**
 * The shell-level onboarding prompt — issue #277, epic #271.
 *
 * =============================================================================
 * WHY THIS IS SHELL CHROME AND NOT A SECTION OF THE HOME PAGE
 * =============================================================================
 *
 * Home is the obvious place for a setup checklist and it is the wrong one, for
 * two reasons that are independent of each other:
 *
 *  1. IT BREAKS HOME'S REQUEST CONTRACT. `HomePage.tsx`'s binding rule is one
 *     request per content type, fired in parallel, and `HomePage.test.tsx`
 *     asserts an exact `EXPECTED_REQUESTS` set of three. A checklist fetch
 *     mounted on that page breaks the assertion, and "it is chrome, not
 *     content" is an argument somebody has to make once per future addition
 *     rather than a rule. Mounted HERE, the page is untouched: its test renders
 *     `HomePage` WITHOUT `Layout`, so this component never mounts there and the
 *     three-request assertion is not merely still passing, it is still about
 *     the same thing.
 *  2. IT IS NOT WHERE THE USER IS. An entry point on Home is a thing you have
 *     to navigate BACK to. A checklist you abandon on step 2 and cannot see
 *     again from `/settings/ai` is not resumable, and resumability is the whole
 *     point — the BYOK research records exactly this failure, where leaving the
 *     flow to fetch a provider key appeared to lose the flow.
 *
 * So it sits in `Layout.tsx`'s `<main>` beside the two components that already
 * do this job — `MaintenanceBanner` (#258) and `NotificationPermissionBanner`
 * (#365). Both render `null` for most users and sit above every page; this is
 * the third, and the precedent is exact.
 *
 * =============================================================================
 * ⚠ ONE BANNER. AN ADMINISTRATOR WITH BOTH CHECKLISTS OUTSTANDING SEES THE
 *    ADMIN ONE.
 * =============================================================================
 *
 * An administrator is also a user, so on a fresh deployment both checklists
 * have required steps left. Rendering both would put two stacked banners above
 * every page in the application, competing for the same action and for the same
 * strip of screen a phone does not have.
 *
 * The admin one wins because the two facts are not equally urgent: a deployment
 * that cannot transcribe is blocking everybody, while an unset display name is
 * blocking nobody. The user checklist is not lost — it is a permanent registry
 * card at `/settings/getting-started` (#279), which is exactly what makes
 * picking one here safe.
 *
 * =============================================================================
 * ⚠ DISMISSAL IS FOREVER, AND THE BANNER SAYS WHERE THE CHECKLIST WENT
 * =============================================================================
 *
 * `dismissedAt`/`adminDismissedAt` (#272) is a decision about THE CHECKLIST,
 * not about a particular set of steps. So:
 *
 *   • The banner does NOT come back when the registry grows a step. Re-showing
 *     it because this release added `admin.push` would make every upgrade feel
 *     like a regression to every existing user, and it is a decision they
 *     already made.
 *   • Dismissing therefore hides the only prompt there is, which is a dismiss a
 *     user regrets unless they are told where it went. The confirmation names
 *     the settings destination in prose — both checklists are registry cards
 *     (#278, #279), so they are findable in Settings forever.
 *
 * The banner disappears the instant the control is pressed, BEFORE the PATCH
 * resolves, because the provider's optimistic overlay is what decides and it
 * applies locally first. The confirmation is rendered in the banner's place by
 * this component's own `dismissedAudience` state rather than by the provider,
 * which is what lets it survive the moment the gate below starts answering
 * "nothing to show".
 *
 * =============================================================================
 * ACCESSIBILITY
 * =============================================================================
 *
 * 1. A REAL `<section>` WITH AN ACCESSIBLE NAME, so it is a landmark a screen
 *    reader user can skip or jump to rather than an unannounced slab of text
 *    above every page.
 * 2. ⚠ NOT AN `Alert`. MUI's `Alert` carries `role="alert"`, which is an
 *    ASSERTIVE live region — it interrupts whatever is being read, on every
 *    navigation, for a message that is not urgent and has not changed.
 *    `MaintenanceBanner` uses one correctly because "this deployment is out of
 *    service" genuinely is an interruption; "you have two setup steps left" is
 *    not, and borrowing the shape would borrow the announcement with it.
 * 3. THE PROGRESS BAR HAS A TEXT EQUIVALENT beside it, never only an
 *    `aria-label`: a bar is not a number, and a number inside a label is a
 *    number a sighted user cannot read.
 * 4. ⚠ THE DISMISS CONTROL NAMES WHAT IT DISMISSES. A bare "×" (or a bare
 *    "Dismiss") announces as nothing useful when two banners can be stacked in
 *    this same strip; the accessible name says which checklist is going away.
 *
 * =============================================================================
 * ⚠ NOT ONE `useMediaQuery`
 * =============================================================================
 *
 * Every responsive decision here is an `sx` breakpoint object resolved in CSS.
 * CLAUDE.md's Settings UI Pattern rule 5 says the coupled breakpoint gates are
 * exactly five and move together or not at all; a `useMediaQuery` in a
 * component mounted by the SHELL — i.e. on every page at every width — would be
 * a sixth, and the one nobody remembers to move with the other five.
 * `__tests__/components/onboarding/SetupChecklist.test.tsx` greps this file to
 * keep it that way.
 */

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import { Link as RouterLink, useLocation } from 'react-router-dom';

import { APP_NAME } from '@app/shared';

import { useOnboarding, type OnboardingContextValue } from '../../contexts/OnboardingContext';
import type { OnboardingAudience, OnboardingState } from '../../services/onboarding';
import { ADMIN_SETUP_PATH, GETTING_STARTED_PATH } from './onboardingPaths';

/** The DOM id the `<section>` is named by. Fixed: there is at most one. */
const TITLE_ID = 'onboarding-banner-title';

/**
 * The standard visually-hidden recipe, inlined.
 *
 * `@mui/utils`' `visuallyHidden` is the same eight declarations; inlining keeps
 * this component's imports to `@mui/material` and `react-router-dom`, which is
 * what every other file in this directory does.
 */
const VISUALLY_HIDDEN = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: -1,
  overflow: 'hidden',
  padding: 0,
  position: 'absolute' as const,
  whiteSpace: 'nowrap' as const,
  width: '1px',
};

/**
 * Everything that differs between the two banners, in one table.
 *
 * A table rather than two components or a `audience === 'admin' ?` sprinkled
 * through the JSX: the markup, the landmark, the progress wiring and the
 * accessibility work are identical, and the second copy of a component is
 * reliably where the accessible name stops naming what it dismisses.
 */
interface AudienceCopy {
  /** Where `Continue` goes, and the checklist's permanent home. */
  path: string;
  /** The `<section>`'s accessible name. */
  landmark: string;
  /** Sentence under the heading — what is still blocked. */
  detail: string;
  /** ⚠ The dismiss control's accessible name. It names the checklist. */
  dismissLabel: string;
  /** Rendered in the banner's place afterwards. Names where the checklist lives. */
  confirmation: string;
}

export const BANNER_COPY: Record<OnboardingAudience, AudienceCopy> = {
  admin: {
    path: ADMIN_SETUP_PATH,
    landmark: 'Deployment setup',
    detail: `Until they are done, the people using this ${APP_NAME} deployment cannot use the features behind them.`,
    dismissLabel: 'Dismiss the deployment setup checklist',
    confirmation: 'Setup is still here whenever you want it: Settings → Setup.',
  },
  user: {
    path: GETTING_STARTED_PATH,
    landmark: 'Getting started',
    detail: 'A few small things make this account yours. None of them takes long.',
    dismissLabel: 'Dismiss the getting started checklist',
    confirmation:
      'Your checklist is still here whenever you want it: Settings → Getting Started.',
  },
};

/**
 * Which checklist — if either — this shell should be prompting about.
 *
 * ⚠ EXPORTED SO THE SUITE CAN ASSERT THE PRECEDENCE DIRECTLY, rather than
 * inferring it from which of two headings rendered. The rule it encodes is the
 * header's: an audience qualifies when it has a REQUIRED step outstanding and
 * has not been put away, and `admin` beats `user` when both qualify.
 *
 * `requiredRemaining` and not `totalRemaining`: a shell banner interrupting
 * every page over an OPTIONAL step is the front-loaded friction epic #271
 * exists to avoid. A recommended or optional step is something the two pages
 * offer; it is not something the application should ask for unprompted.
 */
export function chooseBannerAudience(
  onboarding: Pick<OnboardingContextValue, 'user' | 'admin' | 'dismissed'>,
): OnboardingAudience | null {
  const outstanding = (state: OnboardingState | null, dismissed: boolean) =>
    Boolean(state && !dismissed && state.requiredRemaining > 0);

  if (outstanding(onboarding.admin, onboarding.dismissed.admin)) return 'admin';
  if (outstanding(onboarding.user, onboarding.dismissed.user)) return 'user';
  return null;
}

/**
 * How many required steps there are, and how many are left.
 *
 * `requiredRemaining` is the SERVER'S number (or the provider's skip overlay
 * laid over it) and is never recomputed here — #275 computes the counts
 * server-side precisely because three independent derivations are three places
 * to disagree, and the disagreement surfaces as a banner reading "2 steps left"
 * above a page listing three.
 *
 * The TOTAL is counted from the rows because no count of it crosses the wire:
 * it is a denominator for a progress bar, not a fact about what is owed, and a
 * fourth response field for it would be a fourth thing to keep in step.
 */
function requiredProgress(state: OnboardingState) {
  const total = state.steps.filter((step) => step.tier === 'required').length;
  const remaining = state.requiredRemaining;
  const done = Math.max(0, total - remaining);
  return { total, remaining, done, percent: total === 0 ? 0 : (done / total) * 100 };
}

export function OnboardingBanner() {
  const onboarding = useOnboarding();
  const { pathname } = useLocation();
  // Local, and deliberately not derived from `dismissed`: the provider's flag
  // flips for a reload too, and this is about the act that just happened in
  // front of the user. Cleared when the confirmation auto-hides.
  const [dismissedAudience, setDismissedAudience] = useState<OnboardingAudience | null>(null);

  // The confirmation outranks the gate below, because dismissing is exactly
  // what makes the gate start answering "nothing to show" — reading the gate
  // first would race the optimistic overlay and blank the banner with no word
  // about where the checklist went.
  if (dismissedAudience) {
    const copy = BANNER_COPY[dismissedAudience];
    return (
      <Snackbar
        open
        autoHideDuration={8000}
        onClose={() => setDismissedAudience(null)}
        message={copy.confirmation}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        action={
          <Button component={RouterLink} to={copy.path} color="inherit" size="small">
            Open
          </Button>
        }
      />
    );
  }

  // No provider (several suites render pages on their own), still loading, or
  // a read that failed — all three are "nothing true to say yet", and a banner
  // that flashes into view for one frame before a stored dismissal arrives is
  // worse than one that appears a beat late.
  if (!onboarding || onboarding.isLoading) return null;

  const audience = chooseBannerAudience(onboarding);
  if (!audience) return null;

  const state = audience === 'admin' ? onboarding.admin : onboarding.user;
  if (!state) return null;

  const copy = BANNER_COPY[audience];

  // Suppressed on the checklist's own page, the position `MaintenanceBanner`
  // takes for the same reason: that page's whole body is a fuller statement of
  // what this summarises, and a "Continue" button pointing at the page it is
  // already on reads as a broken control rather than as a prompt.
  if (pathname === copy.path || pathname.startsWith(`${copy.path}/`)) return null;

  const { total, remaining, percent } = requiredProgress(state);
  const subject = audience === 'admin' ? APP_NAME : 'your account';
  const headline = `${remaining} of ${total} required ${
    total === 1 ? 'step' : 'steps'
  } left to finish setting up ${subject}`;

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={TITLE_ID}
      sx={{ p: 2, mb: 3 }}
    >
      {/* The landmark's name, visually hidden: the heading below already says
          this in the user's own words, and a landmark called "region" is a
          landmark nobody can navigate to. */}
      <Box component="span" id={TITLE_ID} sx={VISUALLY_HIDDEN}>
        {copy.landmark}
      </Box>

      <Stack
        // Stacked on a phone, side by side from `sm`. One CSS breakpoint
        // object, no hook — see the header.
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        <Box aria-hidden sx={{ display: { xs: 'none', sm: 'flex' }, color: 'primary.main' }}>
          <RocketLaunchOutlinedIcon />
        </Box>

        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
            {headline}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {copy.detail}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={percent}
            aria-label="Required setup progress"
            sx={{
              mt: 1.5,
              height: 6,
              borderRadius: 1,
              // The one thing here that animates, switched off for anyone who
              // asked for that — a bar sliding across the screen above every
              // page is precisely the motion the preference exists to suppress.
              '@media (prefers-reduced-motion: reduce)': {
                '& .MuiLinearProgress-bar': { transition: 'none' },
              },
            }}
          />
        </Box>

        <Stack
          direction="row"
          spacing={1}
          sx={{ flexShrink: 0, justifyContent: { xs: 'flex-end', sm: 'flex-start' } }}
        >
          <Button component={RouterLink} to={copy.path} variant="contained" size="small">
            Continue
          </Button>
          <Button
            size="small"
            color="inherit"
            // ⚠ The accessible name says WHICH checklist. See header point 4.
            aria-label={copy.dismissLabel}
            onClick={() => {
              // Order matters only in one direction: the confirmation is shown
              // synchronously, so the banner is gone this frame whatever the
              // PATCH does afterwards. `dismiss` never rejects — the provider
              // swallows and reverts — so there is nothing to await here.
              setDismissedAudience(audience);
              void onboarding.dismiss(audience);
            }}
          >
            Dismiss
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

export default OnboardingBanner;
