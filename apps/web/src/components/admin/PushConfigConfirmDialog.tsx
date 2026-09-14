/**
 * The rotate / remove confirmation dialog for Web Push (VAPID) config,
 * issue #355.
 *
 * ONE COMPONENT FOR BOTH INTENTS, mirroring `DbBackupRestoreDialog`'s reason
 * for being one: rotate and remove need exactly the same safety machinery —
 * a stated consequence and a TYPED CONFIRMATION LITERAL — and differ only in
 * their copy and which literal they require. `action` selects between them
 * and nothing else forks.
 *
 * THE TWO LITERALS ARE DIFFERENT WORDS ON PURPOSE (`ROTATE_CONFIRMATION` /
 * `REMOVE_CONFIRMATION`, `services/pushConfig.ts`) — the same reasoning as
 * `RESTORE`/`ROLLBACK`: a confirmation typed for the wrong dialog, or a body
 * copied from one route to the other, must not satisfy the other action.
 * The typed text is cleared every time the dialog opens or `action` changes,
 * so a value typed for Rotate can never be reused to confirm Remove.
 *
 * ⚠ THE ROTATE WARNING'S RECOVERY CLAIM IS DELIBERATELY MODEST. As of this
 * writing there is no client-side re-subscribe-on-reopen mechanism anywhere
 * in this codebase (`docs/runbooks/vapid-keys.md` §4, checked directly) — a
 * subscriber's browser must call `pushManager.subscribe` again through
 * whatever flow does that (e.g. toggling notifications off and back on), and
 * nothing makes that happen automatically just because the app is reopened.
 * Do not soften this copy to "reopening the app fixes it" without re-reading
 * that section first; it will be wrong again the moment it is written.
 *
 * =============================================================================
 * THE MACHINERY MOVED OUT; THE COPY AND THE LITERALS STAYED
 * =============================================================================
 *
 * Issue #80 needed a fourth type-to-confirm dialog and extracted the shared
 * half into `components/common/ConfirmByTypingDialog` — the clear-on-open-AND-
 * on-action-change effect, the exact `typed.trim() === literal` comparison, the
 * disabled-until-match error button, the warning alert, the accessible label.
 * What is left here is what was always feature-specific: WHICH literal each
 * action requires, and the precisely-worded consequence above, which is the
 * part of this file that took reading a runbook to get right. The rendered
 * dialog is unchanged; `PushConfigPage.test.tsx` exercises it unmocked and is
 * the check on that.
 */

import {
  ConfirmByTypingDialog,
} from '../common/ConfirmByTypingDialog';
import { REMOVE_CONFIRMATION, ROTATE_CONFIRMATION } from '../../services/pushConfig';

export type PushConfigDialogAction = 'rotate' | 'remove';

export interface PushConfigConfirmDialogProps {
  /** `null` closes the dialog; a specific action opens it in that mode. */
  action: PushConfigDialogAction | null;
  isWorking: boolean;
  /** The last failure from the hook's action, or `null`. */
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

const COPY: Record<
  PushConfigDialogAction,
  { title: string; consequence: string; confirmLabel: string }
> = {
  rotate: {
    title: 'Rotate the VAPID key pair?',
    consequence:
      'Rotating replaces the key pair. Every existing push subscriber stops receiving ' +
      'notifications immediately. Recovery is not automatic — this app has no ' +
      're-subscribe-on-reopen mechanism, so each subscriber has to re-trigger their ' +
      "browser's subscribe flow (for example, turning notifications off and back on) " +
      'before push works for them again.',
    confirmLabel: 'Rotate keys',
  },
  remove: {
    title: 'Remove the web push configuration?',
    consequence:
      'Removing deletes the stored key pair entirely — there is no key left to fall back ' +
      'to. Every existing push subscriber stops receiving notifications, exactly as with ' +
      'a rotation, and the same manual re-subscribe is needed to recover once a new key ' +
      'pair is generated. This app keeps working; only web push stops.',
    confirmLabel: 'Remove configuration',
  },
};

export function PushConfigConfirmDialog({
  action,
  isWorking,
  error,
  onConfirm,
  onClose,
}: PushConfigConfirmDialogProps) {
  if (!action) return null;

  const literal = action === 'rotate' ? ROTATE_CONFIRMATION : REMOVE_CONFIRMATION;
  const copy = COPY[action];

  return (
    <ConfirmByTypingDialog
      open
      // `action` is what the shared dialog clears the typed text on, which is
      // the whole reason the two literals being different words is enforceable
      // rather than merely hoped for.
      resetKey={action}
      literal={literal}
      title={copy.title}
      consequence={copy.consequence}
      confirmLabel={copy.confirmLabel}
      isWorking={isWorking}
      error={error}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

/** For a component test asserting Rotate's literal doesn't satisfy Remove's dialog, and vice versa. */
export const PUSH_CONFIG_CONFIRM_LITERALS: Record<PushConfigDialogAction, string> = {
  rotate: ROTATE_CONFIRMATION,
  remove: REMOVE_CONFIRMATION,
};
