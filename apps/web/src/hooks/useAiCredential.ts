/**
 * Load, save, test and remove the SIGNED-IN USER'S OWN AI provider key.
 *
 * Issue #55, epic #45. Shaped after `useTranscriptionSettings` — same
 * `isMounted` discipline, same "an error is a string the page renders, never a
 * rejected promise" contract, same three separate flag groups — with the
 * departures that are specific to a per-user credential:
 *
 *   1. THE TEST IS NOT A SAVE, and it tests the key TYPED INTO THE FORM rather
 *      than the stored one. `test` takes the draft key as an argument for
 *      exactly that reason: proving a key before committing it is the workflow
 *      the endpoint exists for, and a hook that could only probe what was
 *      already saved would make it useless.
 *
 *   2. ⚠ A REFUSED PROBE IS NOT A REJECTED PROMISE. `POST /api/ai-credentials
 *      /test` answers **200** with `{ ok: false, detail }` when the provider
 *      refuses the key — that IS the interesting case, and it is a DIAGNOSIS
 *      TO DISPLAY rather than an error to throw. Both that and a genuine call
 *      failure end up in the same `testResult` with `ok: false`, so the page
 *      has one region to render and no way to read a resolved promise as a
 *      successful probe.
 *
 *   3. REMOVING A KEY IS A THIRD FLAG GROUP. It is destructive and reached from
 *      a different control than Save, so sharing `isSaving` would make the Save
 *      button spin while a key is being deleted.
 *
 * THERE IS NO PERMISSION TO CHECK. `ai-credentials.controller.ts` is `@Auth()`
 * with no permission on all four routes, deliberately: the resource is the
 * caller's own credential, scoped by `userId` in the query itself, and no role
 * should decide whether a person may manage a secret that is billed to them.
 * So nothing in this hook consults `usePermissions`, and a page built on it
 * must not either.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import {
  getAiCredentials,
  removeAiCredential,
  saveAiCredential,
  testAiCredential,
} from '../services/ai';
import type {
  AiConnectionTest,
  AiCredentialStatus,
  SaveAiCredentialInput,
  TestAiCredentialInput,
} from '../services/ai';
import { useIsMounted } from './useIsMounted';

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message || fallback;
  }
  return fallback;
}

export interface UseAiCredentialReturn {
  credentials: AiCredentialStatus[];
  /** The stored status for one provider, or `null` when nothing is stored for it. */
  statusFor: (provider: string | null | undefined) => AiCredentialStatus | null;
  isLoading: boolean;
  /** Failure to LOAD — "nothing to show", as distinct from "your edit did not stick". */
  loadError: string | null;

  isSaving: boolean;
  saveError: string | null;
  /** Resolves `true` when the save landed, `false` when it did not — never throws. */
  save: (input: SaveAiCredentialInput) => Promise<boolean>;
  clearSaveError: () => void;

  isTesting: boolean;
  /** The last probe, accepted or refused, until the page clears it. */
  testResult: AiConnectionTest | null;
  /** Probes the key passed in — which does NOT have to have been saved. */
  test: (input: TestAiCredentialInput) => Promise<void>;
  clearTestResult: () => void;

  isRemoving: boolean;
  removeError: string | null;
  /** DESTRUCTIVE. The only way to erase a stored key. */
  remove: (provider: string) => Promise<boolean>;
  clearRemoveError: () => void;

  refresh: () => Promise<void>;
}

export function useAiCredential(): UseAiCredentialReturn {
  const [credentials, setCredentials] = useState<AiCredentialStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiConnectionTest | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it.
  const isMounted = useIsMounted();

  const fetchCredentials = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const next = await getAiCredentials();
      if (isMounted()) setCredentials(next.credentials);
    } catch (err) {
      if (isMounted()) {
        setLoadError(messageFor(err, 'Failed to load your AI key status'));
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchCredentials();
  }, [fetchCredentials]);

  const statusFor = useCallback(
    (provider: string | null | undefined): AiCredentialStatus | null => {
      if (!provider) return null;
      return credentials.find((entry) => entry.provider === provider) ?? null;
    },
    [credentials],
  );

  /**
   * PUT the key, then adopt the server's own account of what is now stored.
   *
   * THE RESPONSE IS THE NEW BASELINE, not the input — and here that matters
   * more than usual: the response carries the `hint` and `updatedAt` that only
   * code holding the plaintext could compute. A page that patched its own state
   * from the draft would have to invent a mask, which is the one thing about a
   * secret nobody on this side of the wire is allowed to guess at.
   */
  const save = useCallback(
    async (input: SaveAiCredentialInput): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        const status = await saveAiCredential(input);
        if (isMounted()) {
          setCredentials((current) => {
            const rest = current.filter((entry) => entry.provider !== status.provider);
            return [...rest, status];
          });
        }
        return true;
      } catch (err) {
        if (isMounted()) {
          setSaveError(messageFor(err, 'Failed to save your API key'));
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  /**
   * Probe a key and record what the provider said.
   *
   * ⚠ NEVER THROWS AND NEVER TREATS A REFUSAL AS A FAILURE OF THE CALL. See
   * the file header: the endpoint's 200-with-`ok: false` is a successful
   * diagnosis, and the whole value of this control is which of "the key is
   * wrong", "the account is out of credit" and "the endpoint is unreachable"
   * happened. Flattening that to "test failed" throws away the only clue.
   */
  const test = useCallback(
    async (input: TestAiCredentialInput) => {
      try {
        setIsTesting(true);
        setTestResult(null);
        const result = await testAiCredential(input);
        if (isMounted()) setTestResult(result);
      } catch (err) {
        if (isMounted()) {
          setTestResult({
            ok: false,
            latencyMs: 0,
            // The API's message verbatim — a 400 for "no key supplied and none
            // stored" reads very differently from a dropped connection.
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
   * Erase one provider's stored key, then re-read.
   *
   * RE-READS RATHER THAN PATCHING LOCAL STATE: the endpoint answers 204 with no
   * body, and guessing the resulting list here would be a second implementation
   * of a fact the server already owns.
   */
  const remove = useCallback(
    async (provider: string): Promise<boolean> => {
      try {
        setIsRemoving(true);
        setRemoveError(null);
        await removeAiCredential(provider);
        await fetchCredentials();
        return true;
      } catch (err) {
        if (isMounted()) {
          setRemoveError(messageFor(err, 'Failed to remove your API key'));
        }
        return false;
      } finally {
        if (isMounted()) setIsRemoving(false);
      }
    },
    [fetchCredentials, isMounted],
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);
  const clearTestResult = useCallback(() => setTestResult(null), []);
  const clearRemoveError = useCallback(() => setRemoveError(null), []);

  return {
    credentials,
    statusFor,
    isLoading,
    loadError,
    isSaving,
    saveError,
    save,
    clearSaveError,
    isTesting,
    testResult,
    test,
    clearTestResult,
    isRemoving,
    removeError,
    remove,
    clearRemoveError,
    refresh: fetchCredentials,
  };
}
