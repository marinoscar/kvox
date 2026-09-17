/**
 * "You are in the middle of setting something up" — issue #280, epic #271.
 *
 * =============================================================================
 * THE FAILURE THIS EXISTS TO PREVENT
 * =============================================================================
 *
 * Every step on both checklists links OUT. `admin.transcription` sends an
 * administrator to `/admin/settings/transcription`; `user.ai_key` sends a user
 * to `/settings/ai`, and from there to a vendor console in another tab. The
 * research on BYOK onboarding records exactly what happens next and it is not
 * subtle: the user comes back, the flow appears to have reset, and in the
 * reported case saved keys looked WIPED because the wizard merely reopened
 * blank. Nothing had been lost. The user had no way to tell.
 *
 * So the destination page says, in one slim strip: this is the step you are on,
 * here is the way back to the list, and — once the step is actually done — here
 * is the next one. It is the thread back out.
 *
 * =============================================================================
 * ⚠ MOUNTED ONCE, IN `Layout.tsx`. NOT ADDED TO EACH DESTINATION PAGE.
 * =============================================================================
 *
 * The steps point at eight or so pages today and more later. Adding this to
 * each of them would be eight copies to keep in step, eight places for the
 * "back" link to drift from the audience that actually owns the step, and a
 * ninth page added later with no bar at all and nothing failing anywhere.
 *
 * And it would be redundant work: `?setup=<stepKey>` is a query parameter,
 * which is already shell-level state — the shell can read it as easily as any
 * page can, and it is the one component that every destination has in common.
 * `MaintenanceBanner`, `OnboardingBanner` and `NotificationPermissionBanner`
 * are all mounted on the same argument.
 *
 * =============================================================================
 * ⚠ AN UNRECOGNISED `?setup=` VALUE RENDERS NOTHING. SILENCE IS THE DEFAULT.
 * =============================================================================
 *
 * The parameter is in the URL, so it is user-controllable input and anyone can
 * type anything into it. Three cases and one answer:
 *
 *   • A key that matches no step in this caller's own state → nothing.
 *   • A key belonging to the OTHER audience's checklist — `admin.transcription`
 *     for a user who is not an administrator → nothing, and for free: the
 *     provider never fetched the admin checklist for them, so there is no state
 *     for the lookup to find it in.
 *   • A malformed value, or one 4KB long → nothing.
 *
 * ⚠ AND THE RAW PARAMETER IS NEVER RENDERED, in any branch. Everything this bar
 * displays — the step's title, its href — comes from the checklist the SERVER
 * returned, found by looking the key up. That is what makes the strip safe
 * rather than merely validated: there is no path by which a string from the URL
 * reaches the DOM, so there is no escaping rule for a later change to forget.
 *
 * =============================================================================
 * `refresh()` ON ARRIVAL, AND ONLY ON ARRIVAL
 * =============================================================================
 *
 * The state cached when the user LEFT says the step is not done — it was
 * fetched before they went and did it. So this asks the provider to re-read
 * when a `?setup=` key appears or changes.
 *
 * ⚠ GUARDED ON THE PARAMETER, NOT RUN ON MOUNT. This component is mounted by
 * the shell, i.e. on every page for the whole session, and an unconditional
 * mount effect would fire a second copy of the provider's own first read on
 * every single page load for every user — most of whom will never see this bar.
 * The provider runs no timer by design (see its header); this is one of the two
 * things that ever refetches, and it costs a request exactly when a request is
 * the point.
 *
 * =============================================================================
 * ⚠ NOT ONE `useMediaQuery`
 * =============================================================================
 *
 * `sx` breakpoint objects only, for the reason `OnboardingBanner`'s header
 * gives: CLAUDE.md's Settings UI Pattern rule 5 fixes the coupled breakpoint
 * gates at five, and a hook in a component the shell mounts would be a sixth.
 * `SetupChecklist.test.tsx` greps this directory to keep it that way.
 */

import { useEffect } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import { Link as RouterLink, useLocation, useSearchParams } from 'react-router-dom';

import { useOnboarding, type OnboardingContextValue } from '../../contexts/OnboardingContext';
import type { OnboardingState, OnboardingStepState } from '../../services/onboarding';
import {
  ADMIN_SETUP_PATH,
  GETTING_STARTED_PATH,
  SETUP_RETURN_PARAM,
  withSetupReturn,
} from './onboardingPaths';

/** The DOM id the `<section>` is named by. Fixed: there is at most one. */
const TITLE_ID = 'return-to-setup-title';

/** The standard visually-hidden recipe, inlined — `OnboardingBanner` does the same. */
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

/** A step, together with the checklist it was found in. */
export interface SetupStepMatch {
  step: OnboardingStepState;
  state: OnboardingState;
  /** The hub the step's `audience` implies. Never guessed from the key's prefix. */
  hubPath: string;
}

/**
 * Find a `?setup=` key in the checklists this caller actually holds.
 *
 * ⚠ THE AUDIENCE COMES FROM THE STATE THE STEP WAS FOUND IN, never from the
 * key. Keys happen to be namespaced (`admin.transcription`, `user.ai_key`) and
 * parsing that prefix would work today — and would be a second source of truth
 * about which checklist a step belongs to, diverging the first time a key is
 * named without a prefix. `OnboardingState.audience` is the server's own
 * answer, and one answer is the point.
 *
 * Admin is searched first only so the result is deterministic if a key ever
 * appears on both lists; nothing in the registry produces that today.
 *
 * Exported so the suite can assert the lookup directly — including the three
 * "renders nothing" cases, which are a property of this function rather than of
 * the markup that never gets rendered.
 */
export function findSetupStep(
  onboarding: Pick<OnboardingContextValue, 'user' | 'admin'>,
  rawKey: string | null,
): SetupStepMatch | null {
  if (!rawKey) return null;

  const candidates: Array<{ state: OnboardingState | null; hubPath: string }> = [
    { state: onboarding.admin, hubPath: ADMIN_SETUP_PATH },
    { state: onboarding.user, hubPath: GETTING_STARTED_PATH },
  ];

  for (const { state, hubPath } of candidates) {
    if (!state) continue;
    const step = state.steps.find((candidate) => candidate.key === rawKey);
    if (step) return { step, state, hubPath };
  }

  return null;
}

/**
 * The step to offer next, once the current one is done.
 *
 * "The next one still outstanding", NOT "the one after this index". A user who
 * works down the list from the top gets the same answer either way; a user who
 * did the third item first would be offered nothing at all by an index-based
 * rule, which is precisely the person a "next step" link is for.
 *
 * `pending` only: a `blocked` step is one somebody ELSE has to act on, and
 * offering it as the next thing to do would send the user to a page where the
 * action is disabled and a sentence explains they are waiting. A skipped step
 * is a decision they already made.
 */
export function nextOutstandingStep(
  state: OnboardingState,
  afterKey: string,
): OnboardingStepState | null {
  return (
    state.steps.find(
      (candidate) =>
        candidate.key !== afterKey && candidate.status === 'pending' && !candidate.skipped,
    ) ?? null
  );
}

export function ReturnToSetupBar() {
  const onboarding = useOnboarding();
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();

  // A plain string (or null), so this is a stable effect dependency — the
  // `URLSearchParams` object itself is a fresh identity on every render.
  const rawKey = searchParams.get(SETUP_RETURN_PARAM);
  const refresh = onboarding?.refresh;

  useEffect(() => {
    // See the header: guarded on the parameter precisely because the shell
    // mounts this on every page, for every user, for the whole session.
    if (!rawKey) return;
    void refresh?.();
  }, [rawKey, refresh]);

  // No provider (several suites render pages on their own), no marker, or a
  // read that has not settled — all three are "nothing true to say yet", and a
  // strip that flashes in and out above every page is worse than one that
  // appears a beat late.
  if (!rawKey || !onboarding || onboarding.isLoading) return null;

  const match = findSetupStep(onboarding, rawKey);
  // ⚠ Unknown, malformed, or belonging to a checklist this caller does not
  // hold. Silence — see the header.
  if (!match) return null;

  const { step, state, hubPath } = match;

  // Suppressed on the hub itself, the position `OnboardingBanner` takes for the
  // same reason: a "Back to setup" button pointing at the page it is already on
  // reads as a broken control. Only reachable if somebody hand-edits the URL —
  // `withSetupReturn` is applied to a step's own destination, never to a hub.
  if (pathname === hubPath) return null;

  const satisfied = step.status === 'satisfied';
  const next = satisfied ? nextOutstandingStep(state, step.key) : null;

  return (
    <Paper component="section" variant="outlined" aria-labelledby={TITLE_ID} sx={{ p: 1.5, mb: 3 }}>
      {/* The landmark's name. Visually hidden because the line below already
          says this in the user's own words, and a landmark announced as
          "region" is a landmark nobody can navigate to. */}
      <Box component="span" id={TITLE_ID} sx={VISUALLY_HIDDEN}>
        Setup in progress
      </Box>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2">
            <Box component="span" sx={{ fontWeight: 600 }}>
              {satisfied ? 'Done:' : 'Setting up:'}
            </Box>{' '}
            {/* The step's own title, from the server's checklist — never the
                raw query parameter. See the header. */}
            {step.title}
          </Typography>
          {satisfied && (
            <Typography variant="caption" color="text.secondary">
              That one is finished. Pick up where you left off.
            </Typography>
          )}
        </Box>

        <Stack
          direction="row"
          spacing={1}
          sx={{ flexShrink: 0, justifyContent: { xs: 'flex-end', sm: 'flex-start' } }}
        >
          <Button
            component={RouterLink}
            to={hubPath}
            size="small"
            startIcon={<ArrowBackOutlinedIcon />}
          >
            Back to setup
          </Button>
          {next && (
            <Button
              component={RouterLink}
              // The marker travels with the link, exactly as it does from the
              // checklist pages — so the bar is still there on the next
              // destination, which is the whole point of a thread back out.
              to={withSetupReturn(next.href, next.key)}
              variant="contained"
              size="small"
              // Names the step it leads to. "Next step" alone announces
              // identically on every page this bar ever appears on.
              aria-label={`Next step: ${next.title}`}
            >
              Next step
            </Button>
          )}
        </Stack>
      </Stack>
    </Paper>
  );
}

export default ReturnToSetupBar;
