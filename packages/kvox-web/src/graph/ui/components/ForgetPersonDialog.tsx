/**
 * `ForgetPersonDialog` — "Forget this person…" (#357, spec §15).
 *
 * The shared typed-confirmation dialog, with `FORGET` as the literal — the
 * exact body #357 requires. A 202 means a `kg.purge` job was QUEUED: the person
 * stays visible until it completes, which is why the caller navigates away
 * with a "Forgetting …" snackbar rather than claiming it is already gone.
 */

import { useState } from 'react';

import { FORGET_CONFIRMATION, forgetGraphEntity } from '../../headless/clients/graph.js';
import { ConfirmByTypingDialog } from './ConfirmByTypingDialog.js';

import { KvoxApiError, useKvoxHost, useKvoxTranscriptionEnabled } from '../../../core/headless/index.js';
export interface ForgetPersonDialogProps {
  open: boolean;
  entityId: string;
  label: string;
  onClose: () => void;
  onForgotten: () => void;
}

export function ForgetPersonDialog({ open, entityId, label, onClose, onForgotten }: ForgetPersonDialogProps) {
  const host = useKvoxHost();
  // #731 — a host without transcription has no recordings to reassure about.
  const transcription = useKvoxTranscriptionEnabled();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setWorking(true);
    setError(null);
    try {
      await forgetGraphEntity(host, entityId);
      onForgotten();
    } catch (err) {
      setError(err instanceof KvoxApiError && err.message ? err.message : 'Could not forget this person');
    } finally {
      setWorking(false);
    }
  };

  return (
    <ConfirmByTypingDialog
      open={open}
      literal={FORGET_CONFIRMATION}
      title={`Forget ${label}?`}
      consequence={`Removes this person, their aliases, connections and facts from your graph. ${
        transcription ? 'Your recordings and notes are not changed.' : 'Your notes and transcripts are not changed.'
      }`}
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

