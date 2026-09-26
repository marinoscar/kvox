/**
 * `ForgetPersonDialog` — "Forget this person…" (#357, spec §15).
 *
 * The shared typed-confirmation dialog, with `FORGET` as the literal — the
 * exact body #357 requires. A 202 means a `kg.purge` job was QUEUED: the person
 * stays visible until it completes, which is why the caller navigates away
 * with a "Forgetting …" snackbar rather than claiming it is already gone.
 */

import { useState } from 'react';

import { ApiError } from '../../services/api';
import { FORGET_CONFIRMATION, forgetGraphEntity } from '../../services/graph';
import { ConfirmByTypingDialog } from '../common/ConfirmByTypingDialog';

export interface ForgetPersonDialogProps {
  open: boolean;
  entityId: string;
  label: string;
  onClose: () => void;
  onForgotten: () => void;
}

export function ForgetPersonDialog({ open, entityId, label, onClose, onForgotten }: ForgetPersonDialogProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setWorking(true);
    setError(null);
    try {
      await forgetGraphEntity(entityId);
      onForgotten();
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : 'Could not forget this person');
    } finally {
      setWorking(false);
    }
  };

  return (
    <ConfirmByTypingDialog
      open={open}
      literal={FORGET_CONFIRMATION}
      title={`Forget ${label}?`}
      consequence="Removes this person, their aliases, connections and facts from your graph. Your recordings and notes are not changed."
      confirmLabel="Forget this person"
      isWorking={working}
      error={error}
      resetKey={entityId}
      onConfirm={() => void confirm()}
      onClose={() => {
        setError(null);
        onClose();
      }}
    />
  );
}

export default ForgetPersonDialog;
