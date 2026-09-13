/**
 * Load, save and test-send the deployment's email configuration.
 *
 * Issue #124, epic #109. Shaped after `useSystemSettings` — same `isMounted`
 * discipline, same "error is a string the page renders" contract — with three
 * departures that are specific to this endpoint and are the reason it is a
 * separate hook rather than another branch of the system settings document:
 *
 *   1. SAVE IS A PUT of the whole document, not a PATCH of one branch. Email
 *      settings are a dozen coupled fields edited on one screen; a per-field
 *      merge would let a half-saved provider switch (SMTP host written, SES
 *      region not) exist as a state nothing in the UI can show.
 *
 *   2. THE TEST IS NOT A SAVE. `sendTest` mutates nothing and is deliberately
 *      tracked by its own `isTesting` flag and its own result, because the page
 *      must be able to say "the save worked and the send did not" — which is
 *      the single most common real outcome and the whole reason the page exists.
 *
 *   3. A FAILED SEND IS NOT A REJECTED PROMISE. See `sendTest` below; getting
 *      this wrong is how a page ends up announcing success over a provider that
 *      refused the message.
 */

import { useState, useEffect, useCallback } from 'react';
import { ApiError, getEmailSettings, sendTestEmail, updateEmailSettings } from '../services/api';
import type { EmailSettings, EmailSettingsInput, EmailTestResult } from '../types';
import { useIsMounted } from './useIsMounted';

interface UseEmailSettingsReturn {
  settings: EmailSettings | null;
  isLoading: boolean;
  /** Failure to LOAD. Distinct from `saveError`: one means "nothing to edit", the other "your edit did not stick". */
  loadError: string | null;
  isSaving: boolean;
  saveError: string | null;
  isTesting: boolean;
  /** The last test attempt, success or failure, until the page clears it. */
  testResult: EmailTestResult | null;
  /** Resolves `true` when the save landed, `false` when it did not — never throws. */
  save: (input: EmailSettingsInput) => Promise<boolean>;
  sendTest: () => Promise<void>;
  clearTestResult: () => void;
  clearSaveError: () => void;
  refresh: () => Promise<void>;
}

export function useEmailSettings(): UseEmailSettingsReturn {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<EmailTestResult | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. Only the state
  // write is skipped — what these functions return is unchanged. Same rule as
  // `useSystemSettings` and `useAllowlist`.
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getEmailSettings();
      if (isMounted()) setSettings(data);
    } catch (err) {
      if (isMounted()) {
        // 403 is named explicitly because it is the one failure the admin can
        // act on themselves; everything else surfaces the API's own message.
        if (err instanceof ApiError && err.status === 403) {
          setLoadError('You do not have permission to view email settings');
        } else {
          setLoadError(err instanceof ApiError ? err.message : 'Failed to load email settings');
        }
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  /**
   * PUT the form, adopt whatever the server says the settings now are.
   *
   * Returns a boolean instead of throwing because every caller of this is a
   * click handler that needs to branch (raise the "saved" snackbar or not), and
   * a rethrow would make each one write the same try/catch around a call whose
   * error has ALREADY been captured in `saveError` for rendering.
   *
   * THE RESPONSE IS THE NEW BASELINE, not the input. The server owns
   * `smtpPasswordStatus`, `settingsError`, `version`, `updatedAt` and
   * `updatedBy`, and the password status in particular must come back from the
   * server: after a save that set a password for the first time, a page still
   * holding the old `configured: false` would keep telling the admin no
   * password is stored while one is. `version` matters for the same reason —
   * the response carries the number the NEXT save must send as `If-Match`, so
   * two saves in a row work without a reload in between.
   */
  const save = useCallback(
    async (input: EmailSettingsInput): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        // The version this form was built from, as `If-Match`. `?? 0` rather
        // than "omit when we have none": 0 is the API's way of asserting "I
        // believe nothing is stored yet", so even a first save on a fresh
        // deployment is guarded rather than being the one unprotected write.
        const data = await updateEmailSettings(input, settings?.version ?? 0);
        if (isMounted()) setSettings(data);
        return true;
      } catch (err) {
        // 409 IS NOT A GENERIC FAILURE. Somebody else saved between this
        // page's load and this click, so the version we asserted is stale and
        // every retry would 409 identically until the form is rebuilt from the
        // current row. Reload it, and say plainly that the fields on screen
        // have been replaced — a message alone, over a form still holding the
        // stale values, would invite the admin to press Save again and
        // (version now current) overwrite the colleague's change for real.
        if (err instanceof ApiError && err.status === 409) {
          await fetchSettings();
          if (isMounted()) {
            setSaveError(
              'Someone else changed the email settings while you were editing. ' +
                'The form has been reloaded with the current configuration — review it and save again.',
            );
          }
          return false;
        }
        if (isMounted()) {
          setSaveError(err instanceof ApiError ? err.message : 'Failed to save email settings');
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [settings, fetchSettings, isMounted],
  );

  /**
   * Ask the API to send a real message to the signed-in user, and record what
   * the provider said.
   *
   * TWO KINDS OF FAILURE, ONE SURFACE. The endpoint answers 200 with
   * `{ success: false, error }` when the provider refuses the message — that is
   * the interesting case, and it is NOT an exception. It rejects only when the
   * call itself fails (403, 500, connection dropped). Both are failed tests, so
   * both end up in the same `testResult` with `success: false`; the page has one
   * red region to render and no way to accidentally treat a resolved promise as
   * a successful send.
   *
   * This function deliberately never throws, for the same reason `save` does
   * not: the outcome is state to render, not an exception to handle.
   */
  const sendTest = useCallback(async () => {
    try {
      setIsTesting(true);
      setTestResult(null);
      const result = await sendTestEmail();
      if (isMounted()) setTestResult(result);
    } catch (err) {
      if (isMounted()) {
        setTestResult({
          success: false,
          // The API's message verbatim — a 403 from a read-only admin and a
          // 500 from a broken provider module read very differently, and
          // flattening both to "test failed" would throw away the only clue.
          error: err instanceof ApiError ? err.message : 'The test request could not be sent',
        });
      }
    } finally {
      if (isMounted()) setIsTesting(false);
    }
  }, [isMounted]);

  const clearTestResult = useCallback(() => setTestResult(null), []);
  const clearSaveError = useCallback(() => setSaveError(null), []);

  return {
    settings,
    isLoading,
    loadError,
    isSaving,
    saveError,
    isTesting,
    testResult,
    save,
    sendTest,
    clearTestResult,
    clearSaveError,
    refresh: fetchSettings,
  };
}
