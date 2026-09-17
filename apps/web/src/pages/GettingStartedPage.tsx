/**
 * Settings → Getting Started (`/settings/getting-started`).
 *
 * Issue #279, epic #271. A card in `config/userSettingsSections.tsx`'s
 * `Account` group and a route in `App.tsx` — a registry destination, never a
 * free route (CLAUDE.md's MANDATORY Settings UI Pattern rule 1), which is also
 * what gives this page its AppBar drill-down title and its position in the hub
 * for free.
 *
 * ⚠ UNGATED, like every `/settings/*` sibling. `ProtectedRoute` establishes
 * that somebody is signed in and that is the only question this route has:
 * `GET /api/onboarding` is `@Auth()` with no permission string, because the
 * resource is the caller's own activation state. A `RequirePermission` here
 * would be a gate the API does not have, and it would lock out a Viewer — the
 * default role, and so most of the people this page exists for.
 *
 * =============================================================================
 * ⚠ THE BYOK EXPLAINER IS THE REASON THIS PAGE EXISTS, AND IT IS ABOVE THE LIST
 * =============================================================================
 *
 * An ordinary user's first session has exactly one genuine surprise in it, and
 * the product otherwise never mentions it: AI FEATURES RUN ON THE USER'S OWN
 * PROVIDER KEY. `user_ai_credentials` has no deployment-wide fallback by design
 * (`docs/specs/notes.md` §9), so generating a note means going to a vendor
 * console, creating a key, and pasting it back here.
 *
 * Today that is discovered by hitting `AiKeyRequired` PARTWAY THROUGH a task
 * the user had already decided to do — which is the moment a task is abandoned,
 * not the moment somebody cheerfully opens a new browser tab and signs up to a
 * vendor. `AiKeyRequired` is the right GATE and the wrong INTRODUCTION; both
 * are kept, and this is the introduction.
 *
 * It says three things, all of them explicitly, because each is separately
 * surprising: the key is YOURS, the usage is billed to YOUR account, and this
 * deployment stores NO key of its own. And it sits ABOVE the checklist rather
 * than beside the `user.ai_key` row, because it has to be readable BEFORE the
 * user needs it — copy that only appears next to the step is copy that arrives
 * at the same moment the gate would have.
 *
 * =============================================================================
 * WHAT THIS PAGE DELIBERATELY DOES NOT DO
 * =============================================================================
 *
 * ⚠ IT OFFERS NO ADMIN SHORTCUT ON A BLOCKED STEP. When transcription is
 * unconfigured, `user.first_transcript` arrives `blocked` with a
 * `blockedReason` naming the administrator, and `SetupChecklist` renders that
 * sentence and disables the action. It does NOT offer the "Set up
 * transcription" link `NewTranscriptButton` shows to administrators: an
 * ordinary user cannot act on it, and a button that leads to a 403 is worse
 * than a sentence that explains who to ask.
 *
 * ⚠ IT CHANGES NOTHING ON `HomePage`. See `OnboardingBanner`'s header: that
 * page's test asserts an exact three-request set and renders it without
 * `Layout`, and this epic keeps both facts true by never touching it.
 *
 * A skipped step keeps its Undo — `SetupChecklist` renders one for any row the
 * server returned with `skipped: true`, which is exactly why #275 returns
 * skipped steps rather than filtering them out. A skip a user cannot reverse is
 * a decision they made once, permanently, from a row they may have clicked by
 * accident.
 *
 * =============================================================================
 * ⚠ NOT ONE `useMediaQuery`
 * =============================================================================
 *
 * `sx` breakpoint objects only, for the reason `SetupChecklist`'s header gives:
 * CLAUDE.md's Settings UI Pattern rule 5 fixes the coupled breakpoint gates at
 * five, and a hook here would be a sixth. Asserted against this file's source
 * in `__tests__/components/onboarding/SetupChecklist.test.tsx`.
 */

import { useEffect } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ReplayOutlinedIcon from '@mui/icons-material/ReplayOutlined';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { SetupChecklist } from '../components/onboarding/SetupChecklist';
import { withSetupReturn } from '../components/onboarding/onboardingPaths';
import { useOnboarding } from '../contexts/OnboardingContext';
import type { OnboardingStepState } from '../services/onboarding';

/**
 * Mirrors the `Getting Started` card in `config/userSettingsSections.tsx` word
 * for word, so the hub card, the rail row, the compact AppBar title and this
 * `h1` all name the page identically.
 */
export const PAGE_TITLE = 'Getting Started';
export const PAGE_DESCRIPTION =
  'The few things that make this account yours: your AI provider key, your first recording, and your name.';

/** Where the explainer sends somebody who wants to do it now. */
export const AI_SETTINGS_PATH = '/settings/ai';

/**
 * The three facts the explainer states, exported so the suite asserts THEM
 * rather than asserting that some paragraph exists.
 *
 * ⚠ Each one is separately surprising and none implies the others. "You provide
 * the key" does not tell a user who pays; "you pay" does not tell them whether
 * this deployment also holds one it could fall back to. A test that only
 * checked for the word "key" would pass over copy that omitted the other two.
 */
export const BYOK_FACTS = [
  'The key is yours. You create it in your provider’s own console and paste it here — nobody else can see it, and you can remove it at any time.',
  'The usage is billed to your account. Every note you generate is a request made with your key, against whatever plan or credit you hold with that provider.',
  'This deployment stores no key of its own. There is no shared key to fall back on: without yours, the AI features stay switched off for you and nothing is generated.',
] as const;

export default function GettingStartedPage() {
  const onboarding = useOnboarding();
  const navigate = useNavigate();

  // Re-read on mount, the one thing that ever refetches — the provider runs no
  // timer by design. A user arrives here straight from the page that satisfied
  // a step, and a checklist still showing the state from before they went is a
  // checklist that makes them doubt what they just did.
  const refresh = onboarding?.refresh;
  useEffect(() => {
    void refresh?.();
  }, [refresh]);

  const state = onboarding?.user ?? null;

  /**
   * ⚠ `?setup=<stepKey>` IS APPENDED HERE, not declared on the step — the
   * registry's `href` is where the step LIVES, and the marker says where the
   * user came FROM. #280's return-to-setup bar reads it on the far side.
   */
  const goToStep = (step: OnboardingStepState) => {
    navigate(withSetupReturn(step.href, step.key));
  };

  /**
   * ⚠⚠ SEAM FOR #280 — THE WELCOME DIALOG IS NOT BUILT YET.
   * ==========================================================================
   * "Replay the intro" re-opens the welcome dialog #280 ships. It exists here,
   * now, and wired to a deliberate no-op, for one reason: an intro you can only
   * ever see once is one a user who dismissed it on reflex can never get back,
   * and the place they will look for it is this page. Declaring the control
   * with the page means #280 replaces ONE function body rather than also
   * finding a home, a label and a position for a button.
   *
   * ⚠ IT MUST NOT CLEAR `welcomeSeenAt` (#279's acceptance criteria). That
   * timestamp records the first run and nothing else; replaying the intro is a
   * user asking to watch something again, not the first run happening twice.
   * `markWelcomeSeen` already refuses to rewrite a timestamp that exists, so
   * the correct implementation here OPENS the dialog and touches no setting at
   * all — which is exactly what this no-op does, and why it takes no argument
   * and returns nothing.
   *
   * There is no `TODO` comment above this and no placeholder alert inside it:
   * a stub that renders "coming soon" is a stub that ships.
   */
  const replayIntro = () => {
    // #280 opens the welcome dialog here. Nothing else changes.
  };

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: { sm: 'flex-start' }, justifyContent: 'space-between', mb: 3 }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h4" component="h1" gutterBottom>
              {PAGE_TITLE}
            </Typography>
            <Typography color="text.secondary">{PAGE_DESCRIPTION}</Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<ReplayOutlinedIcon />}
            onClick={replayIntro}
            sx={{ flexShrink: 0 }}
          >
            Replay the intro
          </Button>
        </Stack>

        {/* A PAGE may say a read failed; a shell surface may not. See
            `OnboardingContext`'s header for why the two differ. */}
        {onboarding?.error && !state && (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            action={
              <Button color="inherit" size="small" onClick={() => void onboarding.refresh()}>
                Retry
              </Button>
            }
          >
            {onboarding.error}
          </Alert>
        )}

        <Stack spacing={3}>
          {/* ⚠ ABOVE THE CHECKLIST. See the header: this has to be readable
              before the user needs it, not at the moment the gate would have
              told them anyway. */}
          <Paper component="section" variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" component="h2">
              About AI features and your own key
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Notes are generated by an AI provider, and this application asks you to
              bring your own account for that. Three things follow from it:
            </Typography>
            <Stack component="ul" spacing={1} sx={{ mt: 1.5, mb: 0, pl: 3 }}>
              {BYOK_FACTS.map((fact) => (
                <Typography component="li" variant="body2" key={fact}>
                  {fact}
                </Typography>
              ))}
            </Stack>
            <Typography variant="body2" sx={{ mt: 2 }}>
              <Link component={RouterLink} to={AI_SETTINGS_PATH}>
                Connect your AI provider key
              </Link>{' '}
              whenever you are ready. Nothing else on this page depends on it.
            </Typography>
          </Paper>

          <SetupChecklist
            state={state}
            isLoading={Boolean(onboarding?.isLoading) && !state}
            onSkip={(key) => void onboarding?.skip(key)}
            onUnskip={(key) => void onboarding?.unskip(key)}
            onAction={goToStep}
          />
        </Stack>
      </Box>
    </Container>
  );
}
