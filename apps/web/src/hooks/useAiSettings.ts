/**
 * Load, save and probe the DEPLOYMENT'S AI policy — issue #55, epic #45.
 *
 * Shaped after `useTranscriptionSettings` to the letter where the two are the
 * same shape (the `If-Match`/409 handling, the `isMounted` discipline, the
 * "an error is a string the page renders" contract), with one structural
 * difference that is the whole point of this epic:
 *
 * ⚠ THERE IS NO KEY HERE, SO THERE IS NO `removeKey` AND NO KEY FLAG GROUP.
 * `useTranscriptionSettings` has three flag groups because a transcription key
 * is a deployment credential an admin can store and erase. This deployment
 * stores NO AI key at all — every AI key belongs to an individual user
 * (`useAiCredential`) — so the only destructive act this hook can perform is
 * saving a narrower policy, and a `removeKey` here would be a control with
 * nothing behind it.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import { getAiSettings, testAiReachability, updateAiSettings } from '../services/ai';
import type {
  AiReachabilityTest,
  AiSettingsAdminView,
  TestAiReachabilityInput,
  UpdateAiSettingsInput,
} from '../services/ai';
import { useIsMounted } from './useIsMounted';

/** 403 is named explicitly — it is the one failure an admin can act on themselves. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'You do not have permission to manage AI settings';
    }
    return err.message || fallback;
  }
  return fallback;
}

export interface UseAiSettingsReturn {
  data: AiSettingsAdminView | null;
  isLoading: boolean;
  /** Failure to LOAD — "nothing to edit", as distinct from "your edit did not stick". */
  loadError: string | null;

  isSaving: boolean;
  saveError: string | null;
  /** Resolves `true` when the save landed, `false` when it did not — never throws. */
  save: (input: UpdateAiSettingsInput) => Promise<boolean>;
  clearSaveError: () => void;

  isTesting: boolean;
  /** The last reachability probe, success or failure, until the page clears it. */
  testResult: AiReachabilityTest | null;
  /** Probes the base URL passed in — which does NOT have to have been saved. */
  testReachability: (input: TestAiReachabilityInput) => Promise<void>;
  clearTestResult: () => void;

  refresh: () => Promise<void>;
}

export function useAiSettings(): UseAiSettingsReturn {
  const [data, setData] = useState<AiSettingsAdminView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiReachabilityTest | null>(null);

  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const next = await getAiSettings();
      if (isMounted()) setData(next);
    } catch (err) {
      if (isMounted()) {
        setLoadError(messageFor(err, 'Failed to load AI settings'));
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const save = useCallback(
    async (input: UpdateAiSettingsInput): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        // `?? 0` rather than "omit when we have none": 0 is the API's way of
        // asserting "I believe nothing is stored yet", so even a first save on
        // a fresh deployment is guarded rather than being the one unprotected
        // write.
        const next = await updateAiSettings(input, data?.version ?? 0);
        if (isMounted()) setData(next);
        return true;
      } catch (err) {
        // 409 IS NOT A GENERIC FAILURE. Somebody else saved between this page's
        // load and this click, so every retry would 409 identically until the
        // form is rebuilt. Reload it, and say plainly that the fields on screen
        // have been replaced — a message alone, over a form still holding the
        // stale values, would invite a second Save that (version now current)
        // overwrites the colleague's change for real.
        if (err instanceof ApiError && err.status === 409) {
          await fetchSettings();
          if (isMounted()) {
            setSaveError(
              'Someone else changed the AI settings while you were editing. ' +
                'The form has been reloaded with the current configuration — review it and save again.',
            );
          }
          return false;
        }
        if (isMounted()) {
          setSaveError(messageFor(err, 'Failed to save AI settings'));
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [data, fetchSettings, isMounted],
  );

  /**
   * Probe a base URL. Never throws — the outcome is state to render.
   *
   * ⚠ A 401 FROM THE PROVIDER IS A PASS, not a failure: an unauthenticated
   * request to a working API root is supposed to be refused, and the refusal
   * proves the endpoint exists and speaks the protocol. The server decides
   * that; this hook only carries the answer.
   */
  const testReachability = useCallback(
    async (input: TestAiReachabilityInput) => {
      try {
        setIsTesting(true);
        setTestResult(null);
        const result = await testAiReachability(input);
        if (isMounted()) setTestResult(result);
      } catch (err) {
        if (isMounted()) {
          setTestResult({
            ok: false,
            latencyMs: 0,
            detail: messageFor(err, 'The test request could not be sent'),
          });
        }
      } finally {
        if (isMounted()) setIsTesting(false);
      }
    },
    [isMounted],
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);
  const clearTestResult = useCallback(() => setTestResult(null), []);

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
    testReachability,
    clearTestResult,
    refresh: fetchSettings,
  };
}
