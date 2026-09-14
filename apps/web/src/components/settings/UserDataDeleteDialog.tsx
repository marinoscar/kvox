/**
 * The confirmation dialog for deleting your own data — issue #80.
 *
 * ONE COMPONENT FOR ALL FIVE SCOPES, the same reason `PushConfigConfirmDialog`
 * is one for two: every scope needs identical safety machinery — a stated
 * consequence and a typed confirmation literal — and differs only in its copy
 * and its literal. `scope` selects between them and nothing else forks. The
 * machinery itself is `components/common/ConfirmByTypingDialog`, extracted by
 * this issue rather than copied a fourth time; see that file's header.
 *
 * FIVE LITERALS, ALL DIFFERENT WORDS, and here that is not a nicety. The three
 * narrow scopes and the two compound ones sit on the same page, three clicks
 * apart, and their consequences differ by orders of magnitude: `NOTES` deletes
 * a folder of documents, `EVERYTHING` also takes the API tokens a user's
 * scripts authenticate with. A single shared `DELETE` literal would mean text
 * typed for the smallest action on this page is sufficient for the largest.
 * The literals come from `USER_DATA_CONFIRMATION` in `services/userData.ts` —
 * the same record that fills in the request body — so what a user types and
 * what the API validates are one object, not two spellings of one.
 *
 * =============================================================================
 * THE FORCE SEMANTICS ARE STATED IN EVERY DIALOG, ON PURPOSE
 * =============================================================================
 *
 * This deletion is a FORCE delete, and it diverges from the per-item delete
 * buttons everywhere else in this application in ways a reasonable user would
 * not predict from having used those:
 *
 *   • A note that is mid-generation is deleted anyway. `DELETE /api/notes/:id`
 *     answers **409** while a note is generating; this does not.
 *   • A note generated FROM something being deleted survives with its text
 *     intact but permanently loses the link back to its source. Again the
 *     single-item path refuses instead (409 while another note names this one).
 *   • There is no undo, and no restore a user can trigger. Database backups
 *     exist, but they are an administrator's operational tool over the whole
 *     deployment — not a recycle bin, and not something this page can offer.
 *
 * Someone who has learned from those buttons that the app refuses destructive
 * ambiguity would reasonably assume it does so here too. So `FORCE_SEMANTICS`
 * is rendered in FULL in every dialog, for every scope including the narrow
 * ones, rather than only in the two compound ones — the "just my notes" path is
 * precisely where a user is least braced for a surprise, and a warning shown
 * only for the scary-sounding actions teaches people to skip it.
 *
 * ⚠ REJECTED: putting these three sentences once at the top of the page instead
 * of in each dialog. The dialog is the last screen before the action and the
 * only one that has the user's full attention; page-level copy above three rows
 * of buttons is read once, on the first visit, by someone who was not yet
 * deleting anything.
 */

import { Box, List, ListItem, ListItemText, Typography } from '@mui/material';

import { ConfirmByTypingDialog } from '../common/ConfirmByTypingDialog';
import { USER_DATA_CONFIRMATION } from '../../services/userData';
import type { UserDataScope } from '../../services/userData';

export interface UserDataDeleteDialogProps {
  /** `null` closes the dialog; a scope opens it for that scope. */
  scope: UserDataScope | null;
  isWorking: boolean;
  /** The last failure from the hook's request, including the API's own 409 message. */
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

interface ScopeCopy {
  title: string;
  /** What goes, in this scope's own terms. */
  consequence: string;
  confirmLabel: string;
  /** What deliberately SURVIVES — stated only where a user could reasonably doubt it. */
  survives?: string;
}

/**
 * Per-scope copy.
 *
 * Each `consequence` names what is destroyed in concrete nouns rather than in
 * the scope's own id: "recordings, their transcripts and every correction you
 * made" is checkable against what the user believes they have, where
 * "transcripts data" is not. The two compound scopes additionally state what
 * SURVIVES, because "delete everything" is exactly the phrase a user will read
 * as "and my account", and leaving that unanswered would make the safest
 * available action feel like the most dangerous one.
 */
const COPY: Record<UserDataScope, ScopeCopy> = {
  transcripts: {
    title: 'Delete all recordings and transcripts?',
    consequence:
      'Every recording you have uploaded is deleted, along with its transcript, every ' +
      'correction you made to it, its version history, its exports, and any sharing you ' +
      'set up. Notes you generated from those recordings are kept.',
    confirmLabel: 'Delete recordings',
  },
  notes: {
    title: 'Delete all notes?',
    consequence:
      'Every note you have is deleted, along with its full version history and any ' +
      'exports of it. The recordings and documents the notes were generated from are ' +
      'kept, as are your note templates.',
    confirmLabel: 'Delete notes',
  },
  files: {
    title: 'Delete all uploaded files?',
    consequence:
      'Every file you uploaded to storage directly is deleted. Audio belonging to a ' +
      'recording, and documents a note was generated from, are managed by those features ' +
      'and are not touched by this.',
    confirmLabel: 'Delete files',
  },
  content: {
    title: 'Delete all of your content?',
    consequence:
      'Every recording, transcript, note, note template and uploaded file is deleted, ' +
      'together with all of their version history and exports.',
    survives:
      'Your account is not deleted and you stay signed in. Your profile, your settings, ' +
      'your AI provider keys and your personal access tokens are all kept.',
    confirmLabel: 'Delete all content',
  },
  everything: {
    title: 'Delete everything stored for your account?',
    consequence:
      'Every recording, transcript, note, note template and uploaded file is deleted, ' +
      'together with all of their version history and exports — and so are your stored ' +
      'AI provider keys and every personal access token you have created. Any CLI, ' +
      'script or integration using one of those tokens stops working immediately.',
    survives:
      'Your account itself is NOT deleted and you stay signed in. Your profile and your ' +
      'settings are kept, and you can upload and generate again straight away — you will ' +
      'need to paste your AI provider key back in first.',
    confirmLabel: 'Delete everything',
  },
};

/**
 * The three ways this differs from the per-item delete buttons elsewhere.
 *
 * Exported so a test binds to the same strings the dialog renders rather than
 * re-typing prose that would then drift silently.
 */
export const FORCE_SEMANTICS: string[] = [
  'A note that is being generated right now is deleted anyway — it is not waited for.',
  'A note generated from something being deleted keeps its text, but permanently loses ' +
    'the link back to the recording or document it came from.',
  'This is permanent. There is no undo, and no backup you can restore from yourself.',
];

export function UserDataDeleteDialog({
  scope,
  isWorking,
  error,
  onConfirm,
  onClose,
}: UserDataDeleteDialogProps) {
  if (!scope) return null;

  const copy = COPY[scope];
  const literal = USER_DATA_CONFIRMATION[scope];

  return (
    <ConfirmByTypingDialog
      open
      // `scope` is what the shared dialog clears the typed text on: five
      // different literals only protect anything if text typed for one is gone
      // by the time another dialog opens.
      resetKey={scope}
      literal={literal}
      title={copy.title}
      consequence={copy.consequence}
      confirmLabel={copy.confirmLabel}
      isWorking={isWorking}
      error={error}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <Box sx={{ mt: 2 }}>
        <Typography variant="subtitle2" component="p">
          Before you confirm
        </Typography>
        {/* `disablePadding` on the list and dense items: this is explanatory
            prose in list form, not a menu, so it should read as a paragraph
            with bullets rather than as a stack of tappable rows. */}
        <List dense disablePadding sx={{ listStyleType: 'disc', pl: 3 }}>
          {FORCE_SEMANTICS.map((line) => (
            <ListItem key={line} disablePadding sx={{ display: 'list-item' }}>
              <ListItemText
                primary={line}
                slotProps={{ primary: { variant: 'body2', color: 'text.secondary' } }}
              />
            </ListItem>
          ))}
        </List>
        {copy.survives && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {copy.survives}
          </Typography>
        )}
      </Box>
    </ConfirmByTypingDialog>
  );
}

/** For a test asserting one scope's literal does not satisfy another scope's dialog. */
export const USER_DATA_DELETE_LITERALS: Record<UserDataScope, string> = USER_DATA_CONFIRMATION;
