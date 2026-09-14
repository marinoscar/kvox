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
 *
 * =============================================================================
 * #78 ADDS A SECOND PROBE, AND IT FAILS IN THREE WAYS, NOT TWO
 * =============================================================================
 *
 * `discoverModels` follows `testReachability` exactly — one in-flight flag, one
 * result that survives until the page clears it, never throws — with ONE
 * structural difference that the page depends on:
 *
 * ⚠ `ai_key_missing` IS ITS OWN STATE, NOT AN ERROR STRING. Flattening it into
 * `discoverError` would compile, read fine, and lose the only thing that makes
 * the failure actionable: the fix is on a DIFFERENT PAGE, under the reader's
 * own account, and the reason there is no deployment key to fall back on is an
 * argument (docs/specs/notes.md §9) the settings page already makes in full at
 * the top. A generic red box saying "409 Conflict" — or even the API's own
 * sentence rendered as an error — invites an administrator to look for a
 * deployment key field that does not and will never exist. So the three
 * outcomes stay distinguishable all the way to the render:
 *
 *   `discoverResult.ok === true`   the provider listed models
 *   `discoverResult.ok === false`  it refused — `detail` names which of the
 *                                  three fixes applies, and is the whole value
 *                                  of the call (arrives as a **200**)
 *   `discoverError.kind`           the call itself could not be made:
 *                                  `'key-missing'` (409, the caller's own key)
 *                                  or `'other'` (a 400, a dropped connection)
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import {
  aiDiscoveryConflictReason,
  discoverAiModels,
  getAiSettings,
  testAiReachability,
  updateAiSettings,
} from '../services/ai';
import type {
  AiModelDiscovery,
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

/**
 * Why a discovery call could not be made at all (#78).
 *
 * A DISCRIMINATED UNION RATHER THAN A STRING, so the page's branch on
 * `'key-missing'` is exhaustive and a future kind is a compile error rather
 * than a message that silently falls through to the generic box. `message` is
 * always present — the API's own sentence for the `key-missing` case is worth
 * showing alongside the page's cross-reference, not instead of it.
 */
export type AiDiscoveryError =
  | { kind: 'key-missing'; message: string }
  | { kind: 'other'; message: string };

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

  isDiscovering: boolean;
  /**
   * The last model list, INCLUDING a refusal (`ok: false`), until cleared.
   *
   * ⚠ A refusal is a 200 and lands here, not in `discoverError`. See the header.
   */
  discoverResult: AiModelDiscovery | null;
  /** Set only when the call itself failed. Mutually exclusive with `discoverResult`. */
  discoverError: AiDiscoveryError | null;
  /**
   * Ask the provider for its models. `provider` defaults to the active one.
   *
   * ⚠ SPENDS THE CALLING ADMINISTRATOR'S OWN API KEY on a real vendor request
   * — never call it from an effect. Never throws; the outcome is state.
   *
   * `includeAll` drops the API's chat-model heuristic and returns every id the
   * vendor listed (#97). It is a SECOND REQUEST, billed like the first, which is
   * why the dialog's toggle is a deliberate press rather than a filter applied
   * to a list already in hand — the unfiltered list is not a subset this client
   * holds, it is an answer only the API can give.
   */
  discoverModels: (provider?: string | null, includeAll?: boolean) => Promise<void>;
  clearDiscoverResult: () => void;

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
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<AiModelDiscovery | null>(null);
  const [discoverError, setDiscoverError] = useState<AiDiscoveryError | null>(null);

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

  /**
   * Ask the provider for its models (#78).
   *
   * ⚠ THE 409 IS SEPARATED HERE, ONCE, rather than at the call site. It is the
   * one failure whose fix is neither on this page nor in this deployment's
   * configuration — the administrator has saved no key of their OWN — and
   * `aiDiscoveryConflictReason` is the only correct way to recognise it, since
   * the API's global filter derives the top-level `code` from the status and
   * overwrites the endpoint's reason. Reading `err.code` would compile, never
   * match, and quietly demote this to the generic branch.
   *
   * ⚠ BOTH RESULT SLOTS ARE CLEARED BEFORE THE CALL, so a second attempt can
   * never render last attempt's answer beside this attempt's spinner — the
   * failure mode that makes a stale success look like a fresh one.
   */
  const discoverModels = useCallback(
    async (provider?: string | null, includeAll?: boolean) => {
      try {
        setIsDiscovering(true);
        setDiscoverResult(null);
        setDiscoverError(null);

        const result = await discoverAiModels(provider, includeAll);
        if (isMounted()) setDiscoverResult(result);
      } catch (err) {
        if (!isMounted()) return;

        if (aiDiscoveryConflictReason(err) === 'ai_key_missing') {
          setDiscoverError({
            kind: 'key-missing',
            message: messageFor(
              err,
              'You have not saved an API key for this provider.',
            ),
          });
          return;
        }

        setDiscoverError({
          kind: 'other',
          message: messageFor(err, 'The provider could not be asked for its models'),
        });
      } finally {
        if (isMounted()) setIsDiscovering(false);
      }
    },
    [isMounted],
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);
  const clearTestResult = useCallback(() => setTestResult(null), []);
  const clearDiscoverResult = useCallback(() => {
    // BOTH, from one control: the page offers a single dismissal, and leaving
    // one of the two set would make the dialog reopen showing an outcome the
    // administrator has already dismissed.
    setDiscoverResult(null);
    setDiscoverError(null);
  }, []);

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
    isDiscovering,
    discoverResult,
    discoverError,
    discoverModels,
    clearDiscoverResult,
    refresh: fetchSettings,
  };
}
