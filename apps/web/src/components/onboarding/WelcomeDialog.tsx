/**
 * The first-run introduction — issue #280, epic #271.
 *
 * =============================================================================
 * WHY A DIALOG EXISTS AT ALL WHEN A CHECKLIST ALREADY DOES
 * =============================================================================
 *
 * `SetupChecklist` (#276) answers "what is missing". It cannot answer "what is
 * this, and why is it asking me for an API key" — and the second question is
 * the one a brand-new account actually has. A user who meets `user.ai_key` with
 * no context reads it as a product demanding a credential it has not earned,
 * and the checklist row itself is the worst possible place to explain that:
 * copy that only appears beside the step arrives at the same moment the gate
 * would have, which is the moment the task is abandoned.
 *
 * So the introduction is separate from the list, it comes first, and it says
 * exactly three things.
 *
 * =============================================================================
 * ⚠ THREE PANES. NOT FOUR, AND NOT A TOUR.
 * =============================================================================
 *
 *   1. What this product does — one sentence.
 *   2. AI runs on YOUR OWN provider key. **This pane is why the dialog exists.**
 *   3. Here is your checklist, and here is the button to it.
 *
 * Setup flows lose 30–50% of users past five steps, and this is not even setup
 * — it is a preamble to it. A fourth pane would be a fourth thing to click
 * through before the product, bought with the attention the checklist needs.
 *
 * The epic rejected a guided tour with coach marks for the same reason it
 * rejected the fourth pane, only harder: a tour arrives before the user has any
 * need for what it says, so it is skipped and then forgotten. Three panes of
 * context is not a tour — it makes one claim per pane and gets out of the way.
 *
 * =============================================================================
 * ⚠ IT IS NOT A GATE, AND EVERY CLOSE ROUTE IS EQUALLY VALID
 * =============================================================================
 *
 * Escape closes it. The close button closes it. A click on the backdrop closes
 * it. `Skip` sits in the same row as `Next`, at the SAME VISUAL WEIGHT — both
 * are plain text buttons in the same colour, because a greyed-out `Skip` beside
 * a filled `Next` is a dismissal the design is discouraging, and a modal you
 * are discouraged from dismissing on a product you are still evaluating is
 * where the evaluation stops.
 *
 * Whichever route is taken, {@link FirstRunWelcomeDialog} writes
 * `onboarding.welcomeSeenAt` (#272) and the dialog never opens by itself again.
 * Notably it does NOT come back when the step registry later grows a step:
 * `welcomeSeenAt` records a decision about THE INTRODUCTION, not about a
 * particular set of steps, and re-showing an introduction because a release
 * added `admin.push` would make every upgrade feel like a regression to every
 * existing user. The gate below is `welcomeSeen` and nothing else — it reads no
 * count, so there is no count that could bring it back.
 *
 * =============================================================================
 * ⚠ REPLAY DOES NOT CLEAR `welcomeSeenAt`
 * =============================================================================
 *
 * `GettingStartedPage` (#279) renders {@link WelcomeDialog} directly, with its
 * own `open` state, and closing it there touches no setting at all. That split
 * — a CONTROLLED dialog plus a shell-mounted host that owns the first-run
 * decision — is the whole reason this file exports two components rather than
 * one with a `replay` flag.
 *
 * Clearing the timestamp on replay would mean watching it once, deliberately,
 * made it ambush the user again on their next session. That reads as a bug,
 * and it is one the `replay` flag would have made easy to write by accident.
 *
 * =============================================================================
 * ACCESSIBILITY IS ASSERTED, NOT INHERITED
 * =============================================================================
 *
 * Over 70% of pages carrying a modal fail at least one WCAG criterion on the
 * same three points — focus never moved in, focus never restored, and the
 * screen reader never told a dialog opened. MUI's `Dialog` supplies all three,
 * which is exactly why they are easy to lose: a `PaperComponent` swap, a
 * `disableRestoreFocus` added to quiet a test, or a hand-rolled overlay put in
 * its place would silently take them away and nothing would look different.
 *
 * So `__tests__/components/onboarding/WelcomeDialog.test.tsx` asserts each one
 * separately: `role="dialog"` with `aria-labelledby`/`aria-describedby`
 * resolving to elements that exist and carry text, focus trapped inside while
 * open, focus RESTORED to the element that was focused before it opened, and
 * Escape closing it.
 *
 * Two smaller decisions in the same spirit:
 *
 *  • THE PANE INDICATOR IS TEXT AS WELL AS DOTS. `MobileStepper`'s dots are
 *    `<div>`s with no accessible role or name; "Step 2 of 3" is rendered in the
 *    title, and the dots are `aria-hidden` so the position is stated once
 *    rather than announced as three anonymous elements.
 *  • THE CLOSE BUTTON IS NAMED. A bare "×" announces as "button" and nothing
 *    else, and this dialog is opened unprompted over whatever page the user
 *    landed on.
 *
 * =============================================================================
 * ⚠ NOT ONE `useMediaQuery`
 * =============================================================================
 *
 * Every responsive decision here is an `sx` breakpoint object resolved in CSS,
 * and `prefers-reduced-motion` is handled the same way — {@link
 * REDUCED_MOTION_SX} is a CSS media block on the paper and the backdrop, not a
 * hook reading the preference in JavaScript. CLAUDE.md's Settings UI Pattern
 * rule 5 fixes the coupled breakpoint gates at exactly five; a hook in a
 * component the SHELL mounts would be a sixth, and the one nobody remembers to
 * move with the other five. `SetupChecklist.test.tsx` greps this directory to
 * keep it that way.
 */

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import MobileStepper from '@mui/material/MobileStepper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import { Link as RouterLink } from 'react-router-dom';

import { APP_NAME } from '@app/shared';

import { ONBOARDING_ADMIN_PERMISSION, useOnboarding } from '../../contexts/OnboardingContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ADMIN_SETUP_PATH, GETTING_STARTED_PATH } from './onboardingPaths';

/** The DOM ids the dialog is named and described by. Fixed: there is at most one. */
const TITLE_ID = 'welcome-dialog-title';
const DESCRIPTION_ID = 'welcome-dialog-description';

/**
 * Suppress the dialog's own transition for anyone who asked for that.
 *
 * ⚠ CSS, NOT A HOOK. The obvious implementation is
 * `useMediaQuery('(prefers-reduced-motion: reduce)')` fed into
 * `transitionDuration`, and it is the one thing this directory may not do —
 * see the header. `!important` is load-bearing rather than lazy: MUI's
 * transition writes `transition` as an INLINE style on the paper, and an
 * ordinary rule from a class cannot outrank that however specific it is.
 *
 * Exported so the suite can assert it is applied rather than assert that some
 * media query appears somewhere in the emitted stylesheet.
 */
export const REDUCED_MOTION_SX = {
  '@media (prefers-reduced-motion: reduce)': {
    transition: 'none !important',
    animation: 'none !important',
  },
} as const;

/** One pane's copy. Data, so the suite can assert the claims rather than the markup. */
export interface WelcomePane {
  key: 'what' | 'byok' | 'checklist';
  /** The dialog's accessible name while this pane is showing. */
  title: string;
  /** The one sentence this pane is actually making. */
  lead: string;
  /** Supporting lines, rendered as a list. */
  points: readonly string[];
}

/**
 * The product's thesis, restated.
 *
 * ⚠ THE FOUR LINES ARE `JOURNEY_STAGES`' OWN DESCRIPTIONS, WORD FOR WORD
 * (`components/home/JourneyEmptyState.tsx`), and they are RESTATED rather than
 * imported on purpose: that module pulls in `NewTranscriptButton`, which pulls
 * in the transcription capability probe, and the shell must not acquire a
 * request path because a dialog wanted four strings. Two copies of copy is a
 * real cost, so the rule is the narrow one — this list may be reworded only
 * together with that one, never against it.
 *
 * `Find` carries no "Coming soon" chip here, unlike the home page's card,
 * because this pane is describing the SHAPE of the product rather than
 * offering four things to go and click. The home page is where the honesty
 * about what has shipped belongs, and it is still there.
 */
const JOURNEY_LINES = [
  'Capture — upload a recording and get a transcript that knows who spoke.',
  'Correct — fix names, merge speakers, edit the words. It becomes yours.',
  'Transform — turn a conversation into notes, decisions and summaries.',
  'Find — search everything you have ever recorded, months later.',
] as const;

/**
 * The three BYOK facts, as the dialog states them.
 *
 * ⚠ EACH IS SEPARATELY SURPRISING AND NONE IMPLIES THE OTHERS, which is why
 * there are three of them and why the suite asserts all three by name. "You
 * provide the key" does not tell a user who pays; "you pay" does not tell them
 * whether this deployment holds one it could fall back on. A test that looked
 * for the word "key" would pass over copy that had quietly dropped two of them.
 *
 * `GettingStartedPage.BYOK_FACTS` states the same three facts at greater
 * length. They are deliberately NOT one shared constant: the page imports this
 * module for the replay control, so a constant living there and read here would
 * be a circular import, and the two are written for different moments — a
 * sentence you read while deciding whether to keep the tab open is not the
 * paragraph you read while about to paste a key.
 */
export const BYOK_DIALOG_FACTS = [
  'The key is yours. You create it in your provider’s own console and paste it into your settings, and you can remove it whenever you like.',
  'The usage is billed to your account, against whatever plan or credit you hold with that provider.',
  'This deployment stores no key of its own. There is no shared key to fall back on — without yours, the AI features simply stay switched off for you.',
] as const;

/** The three panes, in order. Exported so the suite asserts the SEQUENCE. */
export const WELCOME_PANES: readonly WelcomePane[] = [
  {
    key: 'what',
    title: `Welcome to ${APP_NAME}`,
    lead: 'Capture a conversation, correct the transcript until it is really yours, transform it into notes you can use, and find it again months later.',
    points: JOURNEY_LINES,
  },
  {
    key: 'byok',
    title: 'AI runs on your own provider key',
    lead: 'Generating notes from a conversation is done by an AI provider — on an account you hold with them, not on one this deployment holds.',
    points: BYOK_DIALOG_FACTS,
  },
  {
    key: 'checklist',
    title: 'Here is what is left to set up',
    lead: 'A short checklist tracks what is still missing. Nothing on it stops you looking around first, and it stays in Settings for whenever you want it.',
    points: [
      'Each item says what it is for and links straight to the page that does it.',
      'You can skip anything that is not required, and undo the skip later.',
    ],
  },
];

/** Button labels, exported so the suite names them once rather than five times. */
export const SKIP_LABEL = 'Skip';
export const NEXT_LABEL = 'Next';
export const BACK_LABEL = 'Back';
export const CLOSE_LABEL = 'Close the introduction';

/**
 * Where the last pane's button goes, and what it says.
 *
 * ⚠ GATED ON `ONBOARDING_ADMIN_PERMISSION` — the exact string
 * `admin-onboarding.controller.ts` enforces, imported rather than spelled
 * again. An administrator sent to `/settings/getting-started` would be shown
 * their own three-item checklist while the deployment they are responsible for
 * cannot transcribe at all; an ordinary user sent to `/admin/settings/setup`
 * would be sent to a 403. The same permission decides both, in one place.
 */
export function checklistTarget(canReadAdmin: boolean): { path: string; label: string } {
  return canReadAdmin
    ? { path: ADMIN_SETUP_PATH, label: 'Open deployment setup' }
    : { path: GETTING_STARTED_PATH, label: 'Open your checklist' };
}

export interface WelcomeDialogProps {
  /** Controlled by the caller. {@link FirstRunWelcomeDialog} owns the first-run decision. */
  open: boolean;
  /**
   * Every close route calls this and nothing else — Escape, the backdrop, the
   * close button, `Skip`, and following the last pane's link. The caller
   * decides whether closing is worth a stored timestamp; this component never
   * writes one, which is what makes the replay path safe by construction.
   */
  onClose: () => void;
}

/**
 * The introduction, as a controlled dialog.
 *
 * Presentational and data-free: it reads one permission (to pick the last
 * pane's destination) and otherwise renders the copy above. Everything about
 * WHEN it should appear lives in {@link FirstRunWelcomeDialog}.
 */
export function WelcomeDialog({ open, onClose }: WelcomeDialogProps) {
  const { hasPermission } = usePermissions();
  const [index, setIndex] = useState(0);

  // Reset on every open, not on close. Resetting on close would run an update
  // during the exit transition for no gain; leaving it unreset entirely is the
  // bug this exists to prevent — a replay from the getting-started page would
  // reopen on pane 3, i.e. on the button that sent the user to that page.
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const pane = WELCOME_PANES[index] ?? WELCOME_PANES[0]!;
  const isLast = index === WELCOME_PANES.length - 1;
  const target = checklistTarget(hasPermission(ONBOARDING_ADMIN_PERMISSION));

  return (
    <Dialog
      open={open}
      // ⚠ ONE HANDLER FOR BOTH REASONS MUI REPORTS. `onClose` is called with
      // `'backdropClick'` and `'escapeKeyDown'`, and neither is filtered here:
      // a dialog that ignores one of the two is exactly the "not a gate"
      // promise broken, and filtering is how it gets broken — by someone
      // stopping a stray backdrop click and taking Escape with it.
      onClose={onClose}
      aria-labelledby={TITLE_ID}
      aria-describedby={DESCRIPTION_ID}
      fullWidth
      maxWidth="sm"
      slotProps={{
        paper: { sx: { position: 'relative', ...REDUCED_MOTION_SX } },
        backdrop: { sx: REDUCED_MOTION_SX },
      }}
    >
      {/* ⚠ THE TITLE HOLDS THE PANE HEADING AND NOTHING ELSE. `Dialog` passes
          its `aria-labelledby` down to `DialogTitle` through its own context,
          so whatever is inside this element IS the dialog's accessible name —
          put "Step 2 of 3" in here and every announcement becomes "Step 2 of 3
          AI runs on your own provider key, dialog". The counter therefore sits
          below, as its own element.

          `pr` clears the close button, which is absolutely positioned so that
          it stays put as the title's length changes between panes. */}
      <DialogTitle id={TITLE_ID} sx={{ pr: 7, pb: 0.5 }}>
        {pane.title}
      </DialogTitle>

      {/* The pane position in words. `MobileStepper`'s dots below say the same
          thing to anyone who can see them and nothing at all to anyone who
          cannot, which is why they are `aria-hidden` and this is not. */}
      <Box
        sx={{
          px: 3,
          pb: 1,
          typography: 'overline',
          color: 'text.secondary',
          lineHeight: 1.6,
        }}
      >
        Step {index + 1} of {WELCOME_PANES.length}
      </Box>

      <IconButton
        // ⚠ NAMED. A bare "×" announces as "button", and this dialog opened
        // unprompted over whatever page the user had just reached.
        aria-label={CLOSE_LABEL}
        onClick={onClose}
        sx={{ position: 'absolute', right: 8, top: 8, color: 'text.secondary' }}
      >
        <CloseIcon />
      </IconButton>

      {/* The described-by target is the CONTAINER, which exists for as long as
          the dialog is open — an id on the pane body itself would move with
          every `Next` and point at a removed node for one frame. */}
      <DialogContent id={DESCRIPTION_ID} dividers>
        <Typography variant="body1">{pane.lead}</Typography>
        <Stack component="ul" spacing={1} sx={{ mt: 2, mb: 0, pl: 3 }}>
          {pane.points.map((point) => (
            <Typography component="li" variant="body2" color="text.secondary" key={point}>
              {point}
            </Typography>
          ))}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
        {/* ⚠ SAME VISUAL WEIGHT AS `Next`: same variant (text), same colour
            (primary), same size (small). A `color="inherit"` here would grey it
            out beside a coloured `Next` and turn "you may leave" into "you are
            being discouraged from leaving"; leaving the size at the default
            would do the same thing more quietly, by making it the larger of the
            two and the one the eye reads as the real choice. */}
        <Button size="small" onClick={onClose}>
          {SKIP_LABEL}
        </Button>

        <MobileStepper
          variant="dots"
          steps={WELCOME_PANES.length}
          position="static"
          activeStep={index}
          // The dots duplicate "Step 2 of 3" above, which is the version a
          // screen reader can actually use. Announcing three unnamed `<div>`s
          // as well adds noise and no information.
          slotProps={{ dots: { 'aria-hidden': true } }}
          sx={{ flexGrow: 1, bgcolor: 'transparent', p: 0 }}
          backButton={
            <Button
              size="small"
              onClick={() => setIndex((current) => Math.max(0, current - 1))}
              disabled={index === 0}
              startIcon={<KeyboardArrowLeftIcon />}
            >
              {BACK_LABEL}
            </Button>
          }
          nextButton={
            isLast ? (
              // The payoff, and the only filled button in the dialog: there is
              // no `Next` on this pane for it to outweigh. It closes as well as
              // navigating — leaving the dialog open over the page it just sent
              // the user to would put a modal between them and the checklist.
              <Button
                component={RouterLink}
                to={target.path}
                variant="contained"
                size="small"
                onClick={onClose}
              >
                {target.label}
              </Button>
            ) : (
              <Button
                size="small"
                onClick={() =>
                  setIndex((current) => Math.min(WELCOME_PANES.length - 1, current + 1))
                }
                endIcon={<KeyboardArrowRightIcon />}
              >
                {NEXT_LABEL}
              </Button>
            )
          }
        />
      </DialogActions>
    </Dialog>
  );
}

/**
 * The shell's mount: the one place that decides the introduction is due.
 *
 * Mounted in `Layout.tsx` beside `OnboardingBanner`, inside `OnboardingProvider`
 * — the same single mount point every surface in this epic reads, so there is
 * no second opinion about whether this user has been introduced.
 *
 * ⚠ THREE CONDITIONS, AND THE THIRD IS THE NON-OBVIOUS ONE.
 *
 *  1. The provider is present and has settled (`isLoading` covers the settings
 *     read, so a dialog cannot flash up for one frame and vanish when a stored
 *     `welcomeSeenAt` lands a tick later).
 *  2. `welcomeSeen` is false. THE ONLY STATE THIS GATE READS — no step count,
 *     no registry, so there is nothing that could make it reappear after a
 *     release adds a step.
 *  3. `onboarding.user` is non-null, i.e. the caller's own checklist actually
 *     loaded. A failed read leaves it null (the provider renders nothing rather
 *     than an error, by design), and an introduction whose last pane hands the
 *     user a button to a checklist that will not load is worse than no
 *     introduction: it is the product failing in the first ten seconds, on a
 *     screen it opened by itself.
 *
 * `openedOnce` is local and deliberately not derived from `welcomeSeen`: the
 * write is optimistic, so `welcomeSeen` flips the instant the dialog closes,
 * and a gate reading only that would reopen on the next state change if the
 * PATCH were reverted. Once per mount, whatever the write does afterwards.
 */
export function FirstRunWelcomeDialog() {
  const onboarding = useOnboarding();
  const [open, setOpen] = useState(false);
  const [openedOnce, setOpenedOnce] = useState(false);

  const due = Boolean(
    onboarding && !onboarding.isLoading && !onboarding.welcomeSeen && onboarding.user,
  );

  useEffect(() => {
    if (openedOnce || !due) return;
    setOpenedOnce(true);
    setOpen(true);
  }, [due, openedOnce]);

  const markWelcomeSeen = onboarding?.markWelcomeSeen;

  return (
    <WelcomeDialog
      open={open}
      onClose={() => {
        // Closed synchronously, whatever the PATCH does. `markWelcomeSeen`
        // never rejects (the provider swallows and reverts) and is a no-op when
        // a timestamp already exists, so there is nothing to await and nothing
        // to handle — which is also what makes it safe to call from every close
        // route rather than only from `Skip`.
        setOpen(false);
        void markWelcomeSeen?.();
      }}
    />
  );
}

export default WelcomeDialog;
