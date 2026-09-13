/**
 * Load, save, generate, rotate and remove the deployment's Web Push (VAPID)
 * configuration. Issue #355.
 *
 * TWO SEPARATE FLAG GROUPS, on purpose. `save` (the enable/disable switch
 * plus the subject field) is a routine, non-destructive edit — shaped after
 * `useEmailSettings`'s `save`, including the same `If-Match` / 409 handling.
 * `generate` / `rotate` / `remove` share one `isActing` / `actionError` pair
 * instead — shaped after `useDbBackupActions` — because they are triggered
 * from the same confirmation dialog and only one of them is ever "in
 * flight" for this page at a time; collapsing them into `save`'s flags would
 * make the ordinary Save button spin while a rotation is confirmed, or vice
 * versa.
 *
 * Every write RESOLVES `true`/`false` rather than throwing, for the same
 * reason `useEmailSettings.save` does: every caller is a click handler that
 * needs to branch, and the error has already been captured for rendering.
 *
 * THE RESPONSE IS ALWAYS THE NEW BASELINE. Every one of these five calls
 * returns the full `PushConfigAdminView`, and this hook adopts it every
 * time — including after `remove`, which comes back `configured: false` and
 * is what flips the page back to its empty state with no reload.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  generatePushConfig,
  getPushConfig,
  removePushConfig,
  rotatePushConfig,
  updatePushConfig,
} from '../services/pushConfig';
import type { PushConfigAdminView, PushConfigSubjectInput, UpdatePushConfigInput } from '../services/pushConfig';
import { useIsMounted } from './useIsMounted';

/** 403 is named explicitly — it is the one failure an admin can act on themselves. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to manage web push configuration';
    return err.message || fallback;
  }
  return fallback;
}

interface UsePushConfigReturn {
  config: PushConfigAdminView | null;
  isLoading: boolean;
  /** Failure to LOAD. Distinct from the write errors below: "nothing to show" vs. "your change did not stick". */
  loadError: string | null;

  isSaving: boolean;
  saveError: string | null;
  /** `PUT` — enable/disable and the subject. Non-destructive; keys are retained either way. */
  save: (input: UpdatePushConfigInput) => Promise<boolean>;
  clearSaveError: () => void;

  /** True while generate, rotate or remove is in flight. */
  isActing: boolean;
  /** The last failure from generate/rotate/remove, or `null`. */
  actionError: string | null;
  clearActionError: () => void;
  /** First-time setup. `409` if already configured. */
  generate: (input?: PushConfigSubjectInput) => Promise<boolean>;
  /** DESTRUCTIVE — every existing subscriber goes dark until it re-subscribes. */
  rotate: (input?: PushConfigSubjectInput) => Promise<boolean>;
  /** DESTRUCTIVE — deletes the key pair entirely. */
  remove: () => Promise<boolean>;

  refresh: () => Promise<void>;
}

export function usePushConfig(): UsePushConfigReturn {
  const [config, setConfig] = useState<PushConfigAdminView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const fetchConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getPushConfig();
      if (isMounted()) setConfig(data);
    } catch (err) {
      if (isMounted()) setLoadError(messageFor(err, 'Failed to load web push configuration'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  /**
   * `PUT`, adopting whatever the server says the config now is.
   *
   * A `409` means someone else saved between this page's load and this
   * click (or a stale `version` from before a generate/rotate/remove that
   * happened in another tab) — reload rather than retry, exactly as
   * `useEmailSettings.save` does, so the next save is asserted against the
   * row that is actually live.
   */
  const save = useCallback(
    async (input: UpdatePushConfigInput): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        const data = await updatePushConfig(input, config?.version ?? 0);
        if (isMounted()) setConfig(data);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await fetchConfig();
          if (isMounted()) {
            setSaveError(
              'Someone else changed the web push configuration while you were editing. ' +
                'The form has been reloaded with the current configuration — review it and save again.',
            );
          }
          return false;
        }
        if (isMounted()) setSaveError(messageFor(err, 'Failed to save web push configuration'));
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [config, fetchConfig, isMounted],
  );

  const runAction = useCallback(
    async (operation: () => Promise<PushConfigAdminView>, fallback: string): Promise<boolean> => {
      try {
        setIsActing(true);
        setActionError(null);
        const data = await operation();
        if (isMounted()) setConfig(data);
        return true;
      } catch (err) {
        if (isMounted()) setActionError(messageFor(err, fallback));
        return false;
      } finally {
        if (isMounted()) setIsActing(false);
      }
    },
    [isMounted],
  );

  const generate = useCallback(
    (input: PushConfigSubjectInput = {}) =>
      runAction(() => generatePushConfig(input), 'Failed to generate a key pair'),
    [runAction],
  );

  const rotate = useCallback(
    (input: PushConfigSubjectInput = {}) =>
      runAction(() => rotatePushConfig(input), 'Failed to rotate the key pair'),
    [runAction],
  );

  const remove = useCallback(
    () => runAction(() => removePushConfig(), 'Failed to remove the web push configuration'),
    [runAction],
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);
  const clearActionError = useCallback(() => setActionError(null), []);

  return {
    config,
    isLoading,
    loadError,
    isSaving,
    saveError,
    save,
    clearSaveError,
    isActing,
    actionError,
    clearActionError,
    generate,
    rotate,
    remove,
    refresh: fetchConfig,
  };
}
