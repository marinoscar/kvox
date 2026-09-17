/**
 * Console → Settings → Setup (`/admin/settings/setup`).
 *
 * Issue #278, epic #271. A REGISTRY CARD and a route, per CLAUDE.md's MANDATORY
 * Settings UI Pattern: one entry in `ADMIN_SECTIONS`
 * (`config/adminSections.tsx`), one route in `App.tsx` gated on the same
 * permission string, and no tab anywhere. The hub, the Console rail and the
 * compact AppBar title all pick this page up from that single declaration —
 * a route without the card would be a page all three are blind to, because none
 * of them has any way to learn it exists.
 *
 * It is a DESTINATION and not a tab on `/admin/settings`, which is rule 2's
 * exact distinction: a destination gate is about REACHABILITY and a tab gate is
 * about CONTENT. Setup is not a parallel view of the hub's question; it is the
 * answer to a different one ("what is missing"), and a tab strip presenting it
 * as content of the hub is the mistake epic #90 fixed when it split
 * `SystemSettingsPage`'s three hierarchical tabs into three cards.
 *
 * =============================================================================
 * ⚠ EVERY STEP LINKS OUT. THERE IS EXACTLY ONE EXCEPTION AND IT IS ARGUED FOR.
 * =============================================================================
 *
 * The obvious build is a wizard: transcription, AI, email and push forms
 * embedded as steps. It is rejected on two grounds, and the second is the real
 * one.
 *
 *   • It is six forked forms, six places to drift from the pages they copy, and
 *     the opposite of the Settings UI Pattern's rule 4 ("reuse the shared
 *     component, do not fork it") applied one level up.
 *   • The destination pages already have BETTER empty states than a wizard step
 *     would — Push's "No key pair has been generated yet" panel, Email's
 *     "Choose a provider, or leave email switched off". A wizard step would be
 *     a worse copy of a screen that already exists.
 *
 * `admin.access` is the exception, and it gets one because BOTH halves of the
 * argument above fail for it specifically:
 *
 *   • It is one text field. There is no form to fork.
 *   • It is the only step whose destination page is about something ELSE.
 *     `/admin/settings/users` is where you MANAGE access — a table of accounts
 *     and a table of allowlisted addresses — not where you grant it for the
 *     first time. Sending a first-run administrator there to find the Allowlist
 *     tab and then its Add button is three clicks to do the one thing this page
 *     is about.
 *
 * So it reuses `components/admin/AddEmailDialog.tsx` UNCHANGED — the same
 * dialog `AllowlistTable` mounts, with the same validation and the same
 * endpoint — and calls `refresh()` afterwards so `admin.access` flips without a
 * reload. Gated on `allowlist:write`, the string `allowlist.controller.ts`
 * enforces on its POST; an administrator without it never sees the control,
 * because a button that leads to a 403 is worse than no button.
 *
 * =============================================================================
 * THE COPY STATES THE ONE THING AN ADMINISTRATOR WILL OTHERWISE GO LOOKING FOR
 * =============================================================================
 *
 * ⚠ THERE IS NO DEPLOYMENT AI KEY, AND THE PAGE SAYS SO IN WORDS. Epic #45 is
 * strict bring-your-own-key: every key belongs to an individual user
 * (`/settings/ai`) and is billed to their own provider account, and
 * `ai-settings.schema.ts` carries a compile-time proof that no secret-bearing
 * field can enter the AI settings document. An administrator who finishes
 * `admin.ai` and then hunts the settings pages for the key field will not find
 * one, because it deliberately does not exist — and "the field is missing" is
 * indistinguishable from "the page is broken" unless somebody says otherwise.
 *
 * =============================================================================
 * ⚠ NOT ONE `useMediaQuery`
 * =============================================================================
 *
 * `sx` breakpoint objects only, for the reason `SetupChecklist`'s header gives:
 * CLAUDE.md's Settings UI Pattern rule 5 fixes the coupled breakpoint gates at
 * five, and a hook here would be a sixth that nobody remembers to move with the
 * other five. Asserted against this file's source in
 * `__tests__/components/onboarding/SetupChecklist.test.tsx`.
 */

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import PersonAddAltOutlinedIcon from '@mui/icons-material/PersonAddAltOutlined';
import { useNavigate } from 'react-router-dom';

import { AddEmailDialog } from '../../components/admin/AddEmailDialog';
import { SetupChecklist } from '../../components/onboarding/SetupChecklist';
import { withSetupReturn } from '../../components/onboarding/onboardingPaths';
import { useOnboarding } from '../../contexts/OnboardingContext';
import { usePermissions } from '../../hooks/usePermissions';
import { addToAllowlist } from '../../services/api';
import type { OnboardingState, OnboardingStepState } from '../../services/onboarding';

/**
 * Mirrors the `Setup` card in `config/adminSections.tsx` word for word.
 *
 * The hub card, the Console rail row, the compact AppBar title and this `h1`
 * then all name the page identically — `AboutPage` establishes the convention,
 * and the reason is that a user who clicked "Setup" must land on something
 * called "Setup" rather than on a page whose author picked a better word later.
 */
export const PAGE_TITLE = 'Setup';
export const PAGE_DESCRIPTION =
  'What this deployment still needs before it can transcribe and generate notes, and where to go to finish it.';

/**
 * The permission `allowlist.controller.ts` enforces on `POST /api/allowlist`.
 *
 * Spelled once, exported, and asserted in the suite — CLAUDE.md's Settings UI
 * Pattern rule 3 applied to a control inside a page rather than to a card: the
 * exact string the API checks, never invented, never approximated.
 */
export const INVITE_PERMISSION = 'allowlist:write';

/**
 * The checklist with its `required` rows taken out, counts recomputed.
 *
 * Used ONLY in the `allRequiredSatisfied` state, where the required rows are
 * replaced by the ready panel and what is left worth showing is the
 * recommended and optional work. The counts are recomputed rather than passed
 * through because `SetupChecklist` renders a progress bar over the rows it was
 * given: handing it two fewer rows and the original `totalRemaining` would draw
 * a bar that disagrees with the list directly beneath it.
 *
 * ⚠ This is the same shape of local recount `applySkipOverlay` performs in
 * `OnboardingContext`, and it is allowed for the same reason: it describes a
 * FILTERED VIEW, not a second opinion about what is owed. Nothing here is ever
 * shown as the deployment's real progress — `allRequiredSatisfied` has already
 * answered that question, in the panel above.
 */
export function withoutRequiredSteps(state: OnboardingState): OnboardingState {
  const steps = state.steps.filter((step) => step.tier !== 'required');
  const remaining = steps.filter((step) => step.status !== 'satisfied' && !step.skipped);

  return {
    ...state,
    steps,
    requiredRemaining: 0,
    totalRemaining: remaining.length,
    allRequiredSatisfied: true,
  };
}

export default function SetupPage() {
  const onboarding = useOnboarding();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [invited, setInvited] = useState<string | null>(null);

  // Re-read on mount, which is the whole reason the provider exposes `refresh`
  // and runs no timer of its own: an administrator arrives here straight from
  // the page that satisfied a step, and a checklist showing the state from
  // before they went is a checklist that makes them doubt the thing they just
  // did. `refresh` is stable unless the admin gate flips, so this fires once.
  const refresh = onboarding?.refresh;
  useEffect(() => {
    void refresh?.();
  }, [refresh]);

  const state = onboarding?.admin ?? null;
  const canInvite = hasPermission(INVITE_PERMISSION);

  /**
   * Send the administrator to the page that satisfies a step.
   *
   * ⚠ `?setup=<stepKey>` IS APPENDED HERE, not declared on the step. The
   * registry's `href` is where the step LIVES; the marker says where the user
   * came FROM, which is a property of this navigation and not of the step — and
   * #280's return-to-setup bar reads it on the far side to offer a way back.
   * Baking it into the registry would put it on a link the hub, the rail and
   * any future surface would also carry, all of them claiming the user came
   * from a checklist they never opened.
   */
  const goToStep = (step: OnboardingStepState) => {
    navigate(withSetupReturn(step.href, step.key));
  };

  const handleInvite = async (email: string, notes?: string) => {
    // The existing endpoint, through the existing service function — not
    // `useAllowlist`, whose `addEmail` also refetches a paginated list this
    // page does not render. One POST, then one checklist re-read.
    await addToAllowlist(email, notes);
    setInvited(email);
    await onboarding?.refresh();
  };

  const ready = Boolean(state?.allRequiredSatisfied);
  const checklistState = state && ready ? withoutRequiredSteps(state) : state;

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
        </Typography>

        {/* ⚠ NOT AN ERROR PAGE. A failed read leaves the checklist null and
            `SetupChecklist` renders nothing; this says why the page is empty,
            which is the one thing a shell surface must not do and a PAGE
            must — see `OnboardingContext`'s header for the split. */}
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
          {ready ? (
            <Alert severity="success">
              <AlertTitle>This deployment is ready</AlertTitle>
              Every required step is done: people here can record a conversation and
              generate notes from it. What is left below is optional — worth doing, but
              nothing is waiting on it.
            </Alert>
          ) : (
            <Alert severity="info">
              <AlertTitle>What the required steps unlock</AlertTitle>
              {/* Concrete, and in this order, because these are the two steps
                  whose absence looks like a broken product rather than an
                  unconfigured one: the upload button is disabled with no
                  explanation, and a note refuses to generate. */}
              Until transcription is configured, nobody here can turn a recording into a
              transcript. Until an AI provider and at least one model are permitted,
              nobody can generate a note from one.
            </Alert>
          )}

          {/* ⚠ THE FACT AN ADMINISTRATOR WILL OTHERWISE HUNT FOR. See the
              header: there is no deployment-wide AI key anywhere in this
              application, by design and by compile-time proof. */}
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
              AI keys belong to each user, not to this deployment
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              The AI settings page sets policy — which provider, which models, which
              ceilings — and holds no API key, because there is no field for one. Every
              user connects their own key under Settings → AI Provider, and their usage
              is billed to their own provider account. Nothing you do here gives anybody
              an AI key.
            </Typography>
          </Paper>

          {canInvite && (
            /* The one inline action on this page. Everything else links out —
               see the header for why this step alone is different. */
            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={2}
                sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
              >
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
                    Invite someone
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    Only allowlisted email addresses can sign in. Add one here and they
                    can log in with it straight away.
                  </Typography>
                </Box>
                <Button
                  variant="outlined"
                  startIcon={<PersonAddAltOutlinedIcon />}
                  onClick={() => setInviteOpen(true)}
                  sx={{ flexShrink: 0 }}
                >
                  Invite by email
                </Button>
              </Stack>
            </Paper>
          )}

          <SetupChecklist
            state={checklistState}
            isLoading={Boolean(onboarding?.isLoading) && !state}
            onSkip={(key) => void onboarding?.skip(key)}
            onUnskip={(key) => void onboarding?.unskip(key)}
            onAction={goToStep}
          />
        </Stack>
      </Box>

      {/* Mounted unconditionally rather than behind `inviteOpen` so the dialog
          keeps its own field state across a close-and-reopen — its `open` prop
          is what it is for. Still absent entirely without the permission,
          because the control that opens it is. */}
      {canInvite && (
        <AddEmailDialog
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          onAdd={handleInvite}
        />
      )}

      <Snackbar
        open={Boolean(invited)}
        autoHideDuration={6000}
        onClose={() => setInvited(null)}
        message={invited ? `${invited} can now sign in.` : ''}
      />
    </Container>
  );
}
