/**
 * This app's welcome panes for the platform `WelcomeDialog` (issue #481, epic #478).
 *
 * The packaged dialog owns the chrome: the title, the "Later" and primary buttons, the
 * routing (an administrator to the Setup guide, everyone else to Get started), the
 * "seen" write on every way out, and the accessibility wiring. What this file supplies
 * are the two BODIES it takes through `slots.userPane` and `slots.adminPane`: the same
 * three panes the retired dialog had, with the copy kept word for word.
 *
 *   1. What this product does: one sentence.
 *   2. AI runs on YOUR OWN provider key. **This pane is why the introduction exists.**
 *   3. Here is your checklist (or, for an administrator, the deployment's setup).
 *
 * Not four panes and not a tour: a tour arrives before the user has any need for what it
 * says, so it is skipped and forgotten, and setup flows lose a third or more of their
 * users past five steps. Three panes make one claim each and get out of the way.
 *
 * ⚠ THE BYOK PANE IS NOT OPTIONAL COPY. A user who meets "Add your AI provider key" with
 * no context reads it as a product demanding a credential it has not earned, and the
 * checklist row is the worst place to explain it: copy that only appears beside the step
 * arrives at the moment the task is abandoned. The three facts are separately surprising
 * and none implies the others ("you provide the key" does not say who pays; "you pay"
 * does not say whether the deployment holds a fallback), so `BYOK_DIALOG_FACTS` states all
 * three and the spec asserts each by name.
 *
 * NOT ONE `useMediaQuery` here: the five coupled breakpoint gates are fixed
 * (`AGENTS.md`), and this body renders inside a dialog the platform already sizes.
 */

import { useEffect, useState, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MobileStepper from '@mui/material/MobileStepper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import type { WelcomePaneProps } from '@marinoscar/platform-web/onboarding/ui';

import { APP_NAME } from '@app/shared';

/** The audience a pane set is written for. */
export type WelcomeAudience = 'user' | 'admin';

/** One pane's copy. Data, so the suite asserts the claims rather than the markup. */
export interface WelcomePane {
  key: 'what' | 'byok' | 'checklist';
  /** The pane's heading. */
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
 * (`JourneyEmptyState` of `@marinoscar/kvox-web/home/ui`), and they are RESTATED rather than imported on
 * purpose: that module pulls in `NewTranscriptButton`, which pulls in the transcription
 * capability probe, and the shell must not acquire a request path because a dialog wanted
 * four strings. Reword this list only together with that one, never against it.
 */
const JOURNEY_LINES = [
  'Capture — upload a recording and get a transcript that knows who spoke.',
  'Correct — fix names, merge speakers, edit the words. It becomes yours.',
  'Transform — turn a conversation into notes, decisions and summaries.',
  'Find — search everything you have ever recorded, months later.',
] as const;

/** The three BYOK facts, as the dialog states them. */
export const BYOK_DIALOG_FACTS = [
  'The key is yours. You create it in your provider’s own console and paste it into your settings, and you can remove it whenever you like.',
  'The usage is billed to your account, against whatever plan or credit you hold with that provider.',
  'This deployment stores no key of its own. There is no shared key to fall back on — without yours, the AI features simply stay switched off for you.',
] as const;

const WHAT_PANE: WelcomePane = {
  key: 'what',
  title: `Welcome to ${APP_NAME}`,
  lead: 'Capture a conversation, correct the transcript until it is really yours, transform it into notes you can use, and find it again months later.',
  points: JOURNEY_LINES,
};

const BYOK_PANE: WelcomePane = {
  key: 'byok',
  title: 'AI runs on your own provider key',
  lead: 'Generating notes from a conversation is done by an AI provider — on an account you hold with them, not on one this deployment holds.',
  points: BYOK_DIALOG_FACTS,
};

/** The two third panes: the account checklist, and the deployment's setup for an administrator. */
const CHECKLIST_PANES: Record<WelcomeAudience, WelcomePane> = {
  user: {
    key: 'checklist',
    title: 'Here is what is left to set up',
    lead: 'A short checklist tracks what is still missing. Nothing on it stops you looking around first, and it stays in Settings for whenever you want it.',
    points: [
      'Each item says what it is for and links straight to the page that does it.',
      'You can skip anything that is not required, and undo the skip later.',
    ],
  },
  admin: {
    key: 'checklist',
    title: 'Here is what this deployment still needs',
    lead: 'The setup guide checks each thing people here depend on against the live deployment, and links to the page that fixes it. Nothing on it stops you looking around first.',
    points: [
      'Each item says what it unlocks and links straight to the page that does it.',
      'You can skip anything that is not required, and undo the skip later.',
    ],
  },
};

/** The three panes for an audience, in order. Exported so the suite asserts the SEQUENCE. */
export function welcomePanesFor(audience: WelcomeAudience): readonly WelcomePane[] {
  return [WHAT_PANE, BYOK_PANE, CHECKLIST_PANES[audience]];
}

/** Button labels, exported so the suite names them once rather than five times. */
export const NEXT_LABEL = 'Next';
export const BACK_LABEL = 'Back';

/**
 * The three panes as one dialog body, with its own Back / Next.
 *
 * `descriptionId` goes on the container, which exists for as long as the dialog is open:
 * an id on the pane itself would move with every `Next` and point at a removed node for
 * one frame. The position is stated in words ("Step 2 of 3") because `MobileStepper`'s
 * dots are anonymous `<div>`s, so they are `aria-hidden`.
 */
export function KvoxWelcomePanes({
  audience,
  descriptionId,
}: {
  audience: WelcomeAudience;
  descriptionId: string;
}): ReactElement {
  const panes = welcomePanesFor(audience);
  const [index, setIndex] = useState(0);

  // Reset when the audience changes (an account that gains the admin block mid-session).
  useEffect(() => setIndex(0), [audience]);

  const pane = panes[index] ?? panes[0]!;

  return (
    <Box id={descriptionId}>
      <Typography variant="overline" color="text.secondary" component="p" sx={{ m: 0, lineHeight: 1.6 }}>
        Step {index + 1} of {panes.length}
      </Typography>
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        {pane.title}
      </Typography>
      <Typography variant="body1">{pane.lead}</Typography>
      <Stack component="ul" spacing={1} sx={{ mt: 2, mb: 0, pl: 3 }}>
        {pane.points.map((point) => (
          <Typography component="li" variant="body2" color="text.secondary" key={point}>
            {point}
          </Typography>
        ))}
      </Stack>
      <MobileStepper
        variant="dots"
        steps={panes.length}
        position="static"
        activeStep={index}
        slotProps={{ dots: { 'aria-hidden': true } }}
        sx={{ bgcolor: 'transparent', px: 0, mt: 1 }}
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
          <Button
            size="small"
            onClick={() => setIndex((current) => Math.min(panes.length - 1, current + 1))}
            disabled={index === panes.length - 1}
            endIcon={<KeyboardArrowRightIcon />}
          >
            {NEXT_LABEL}
          </Button>
        }
      />
    </Box>
  );
}

/** `slots.userPane` of the packaged `WelcomeDialog`. */
export const userWelcomePane = ({ descriptionId }: WelcomePaneProps): ReactElement => (
  <KvoxWelcomePanes audience="user" descriptionId={descriptionId} />
);

/** `slots.adminPane` of the packaged `WelcomeDialog`. */
export const adminWelcomePane = ({ descriptionId }: WelcomePaneProps): ReactElement => (
  <KvoxWelcomePanes audience="admin" descriptionId={descriptionId} />
);
