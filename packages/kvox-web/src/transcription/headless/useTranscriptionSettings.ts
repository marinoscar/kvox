/**
 * Load, save, test and remove the deployment's transcription configuration.
 *
 * Issue #23, epic #19. Shaped after `usePushConfig` and `useEmailSettings` —
 * same `isMounted` discipline, same "an error is a string the page renders"
 * contract, same `If-Match`/409 handling — with the three departures that are
 * specific to this endpoint:
 *
 *   1. THE TEST IS NOT A SAVE, and it tests the key TYPED INTO THE FORM rather
 *      than the stored one. `testConnection` takes the draft key as an
 *      argument for exactly that reason: proving a key before committing it is
 *      the workflow the endpoint exists for, and a hook that could only ever
 *      probe what was already saved would make it useless.
 *
 *   2. A FAILED PROBE IS NOT A REJECTED PROMISE. The endpoint answers 200 with
 *      `{ ok: false, detail }` when the provider refuses the credential — that
 *      IS the interesting case. Both that and a genuine call failure end up in
 *      the same `testResult` with `ok: false`, so the page has one region to
 *      render and no way to read a resolved promise as a successful probe.
 *
 *   3. REMOVING A KEY IS A THIRD FLAG GROUP. It is destructive and reached from
 *      a different control than Save, so sharing `isSaving` would make the Save
 *      button spin while a key is being deleted.
 */

import { useCallback, useEffect, useState } from 'react';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../core/headless/index.js';
import {
  getTranscriptionSettings,
  removeTranscriptionCredential,
  testTranscriptionConnection,
  updateTranscriptionSettings,
} from './transcription-client.js';
import type {
  TestTranscriptionConnectionInput,
  TranscriptionConnectionTest,
  TranscriptionSettingsAdminView,
  UpdateTranscriptionSettingsInput,
} from './transcription-client.js';

/** 403 is named explicitly — it is the one failure an admin can act on themselves. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof KvoxApiError) {
    if (err.status === 403) {
      return 'You do not have permission to manage transcription settings';
    }
    return err.message || fallback;
  }
  return fallback;
}

/**
 * What {@link useTranscriptionSettings} returns.
 *
 * @stability experimental
 */
export interface UseTranscriptionSettingsReturn {
  /** The loaded value, `null` until it loads. */
  data: TranscriptionSettingsAdminView | null;
  /** Whether a load is in flight. */
  isLoading: boolean;
  /** Failure to LOAD — "nothing to edit", as distinct from "your edit did not stick". */
  loadError: string | null;

  /** Whether a save is in flight. */
  isSaving: boolean;
  /** The message of the last failed save, or `null`. */
  saveError: string | null;
  /** Resolves `true` when the save landed, `false` when it did not — never throws. */
  save: (input: UpdateTranscriptionSettingsInput) => Promise<boolean>;
  /** Forgets the last save error. */
  clearSaveError: () => void;

  /** Whether a probe is in flight. */
  isTesting: boolean;
  /** The last probe, success or failure, until the page clears it. */
  testResult: TranscriptionConnectionTest | null;
  /** Probes the key passed in — which does NOT have to have been saved. */
  testConnection: (input: TestTranscriptionConnectionInput) => Promise<void>;
  /** Forgets the last probe result. */
  clearTestResult: () => void;

  /** Whether a key removal is in flight. */
  isRemovingKey: boolean;
  /** The message of the last failed removal, or `null`. */
  removeKeyError: string | null;
  /** DESTRUCTIVE. The only way to erase a stored key. */
  removeKey: (providerId: string) => Promise<boolean>;
  /** Forgets the last removal error. */
  clearRemoveKeyError: () => void;

  /** Reloads the settings from the server. */
  refresh: () => Promise<void>;
}

/**
 * Loads the deployment's transcription configuration and offers save, test and
 * remove-key actions over it.
 *
 * @returns The state and the actions. Errors are strings the page renders.
 *
 * @stability experimental
 */
export function useTranscriptionSettings(): UseTranscriptionSettingsReturn {
  const host = useKvoxHost();
  const [data, setData] = useState<TranscriptionSettingsAdminView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] =
    useState<TranscriptionConnectionTest | null>(null);
  const [isRemovingKey, setIsRemovingKey] = useState(false);
  const [removeKeyError, setRemoveKeyError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. Only the state
  // write is skipped — what these functions return is unchanged.
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const next = await getTranscriptionSettings(host);
      if (isMounted()) setData(next);
    } catch (err) {
      if (isMounted()) {
        setLoadError(messageFor(err, 'Failed to load transcription settings'));
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [host, isMounted]);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  /**
   * PUT the form, adopt whatever the server says the settings now are.
   *
   * Returns a boolean instead of throwing because every caller is a click
   * handler that needs to branch, and the error has ALREADY been captured in
   * `saveError` for rendering.
   *
   * THE RESPONSE IS THE NEW BASELINE, not the input. The server owns
   * `keyStatuses`, `version`, `updatedAt` and `updatedBy` — and the key status
   * in particular must come back from the server: after a save that stored a
   * key for the first time, a page still holding the old `configured: false`
   * would keep telling the administrator no key is stored while one is.
   */
  const save = useCallback(
    async (input: UpdateTranscriptionSettingsInput): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        // `?? 0` rather than "omit when we have none": 0 is the API's way of
        // asserting "I believe nothing is stored yet", so even a first save on
        // a fresh deployment is guarded rather than being the one unprotected
        // write.
        const next = await updateTranscriptionSettings(host, input, data?.version ?? 0);
        if (isMounted()) setData(next);
        return true;
      } catch (err) {
        // 409 IS NOT A GENERIC FAILURE. Somebody else saved between this page's
        // load and this click, so the version asserted is stale and every retry
        // would 409 identically until the form is rebuilt. Reload it, and say
        // plainly that the fields on screen have been replaced — a message
        // alone, over a form still holding the stale values, would invite the
        // admin to press Save again and (version now current) overwrite the
        // colleague's change for real.
        if (err instanceof KvoxApiError && err.status === 409) {
          await fetchSettings();
          if (isMounted()) {
            setSaveError(
              'Someone else changed the system settings while you were editing. ' +
                'The form has been reloaded with the current configuration — review it and save again.',
            );
          }
          return false;
        }
        if (isMounted()) {
          setSaveError(messageFor(err, 'Failed to save transcription settings'));
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [data, fetchSettings, host, isMounted],
  );

  /**
   * Probe a provider credential and record what it said.
   *
   * TWO KINDS OF FAILURE, ONE SURFACE — see the file header. This never throws,
   * for the same reason `save` does not: the outcome is state to render, not an
   * exception to handle.
   */
  const testConnection = useCallback(
    async (input: TestTranscriptionConnectionInput) => {
      try {
        setIsTesting(true);
        setTestResult(null);
        const result = await testTranscriptionConnection(host, input);
        if (isMounted()) setTestResult(result);
      } catch (err) {
        if (isMounted()) {
          setTestResult({
            ok: false,
            latencyMs: 0,
            // The API's message verbatim — a 403 from a read-only admin and a
            // 400 for "no key supplied and none stored" read very differently,
            // and flattening both to "test failed" throws away the only clue.
            detail: messageFor(err, 'The test request could not be sent'),
          });
        }
      } finally {
        if (isMounted()) setIsTesting(false);
      }
    },
    [host, isMounted],
  );

  /**
   * Erase one provider's stored key, then re-read.
   *
   * RE-READS RATHER THAN PATCHING LOCAL STATE: the endpoint answers 204 with no
   * body, and guessing the resulting `keyStatuses` here would be a second
   * implementation of a fact the server already owns.
   */
  const removeKey = useCallback(
    async (providerId: string): Promise<boolean> => {
      try {
        setIsRemovingKey(true);
        setRemoveKeyError(null);
        await removeTranscriptionCredential(host, providerId);
        await fetchSettings();
        return true;
      } catch (err) {
        if (isMounted()) {
          setRemoveKeyError(messageFor(err, 'Failed to remove the API key'));
        }
        return false;
      } finally {
        if (isMounted()) setIsRemovingKey(false);
      }
    },
    [fetchSettings, host, isMounted],
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);
  const clearTestResult = useCallback(() => setTestResult(null), []);
  const clearRemoveKeyError = useCallback(() => setRemoveKeyError(null), []);

  return {
    data,
    isLoading,
    loadError,
    isSaving,
    saveError,
    save,
    clearSaveError,
    isTesting,
    testResult,
    testConnection,
    clearTestResult,
    isRemovingKey,
    removeKeyError,
    removeKey,
    clearRemoveKeyError,
    refresh: fetchSettings,
  };
}
