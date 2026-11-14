/**
 * `useVoiceprintSettings` — the viewer's voiceprint opt-in and counts (#827,
 * epic #820), for the "Voice recognition" section of the Knowledge graph
 * settings page.
 *
 * The opt-in is the `graph.voiceprints` sub-object of the user's settings, so
 * the switch writes through the SAME preferences write the page already uses
 * (`useGraphPreferences().update`, passed in): one settings document, one
 * version, one save indicator. Enabling stamps `consentAt` on the server and
 * starts a backfill job; the summary is read again after every change.
 */

import { useCallback, useEffect, useState } from 'react';

import { deleteAllVoiceprints, getVoiceprintsSummary } from '../clients/voiceprints.js';
import type { DeleteAllVoiceprintsResult, VoiceprintsSummary } from '../clients/voiceprints.js';
import type { GraphPreferencesPatch } from './useGraphPreferences.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * Options of {@link useVoiceprintSettings}.
 *
 * @stability experimental
 */
export interface UseVoiceprintSettingsOptions {
  /** The preferences write (`useGraphPreferences().update`). Resolves `true` when it landed. */
  update: (patch: GraphPreferencesPatch) => Promise<boolean>;
}

/**
 * What {@link useVoiceprintSettings} returns.
 *
 * @stability experimental
 */
export interface UseVoiceprintSettingsResult {
  /** The opt-in and the counts, or `null` until they load. */
  summary: VoiceprintsSummary | null;
  /** The summary is loading. */
  isLoading: boolean;
  /** Why the summary could not be read, else `null`. */
  error: string | null;
  /** A change or a delete is in flight. */
  isWorking: boolean;
  /** Why the last delete failed, else `null` (a failed switch is the page's save error). */
  actionError: string | null;
  /** Turns suggestions from voices on or off. Resolves `true` when it landed. */
  setEnabled: (enabled: boolean) => Promise<boolean>;
  /** Deletes every voiceprint and pending suggestion. Resolves the counts, or `null` on failure. */
  deleteAll: () => Promise<DeleteAllVoiceprintsResult | null>;
  /** Reads the summary again. */
  refresh: () => Promise<void>;
}

/**
 * The voiceprint opt-in and counts, with the switch and "Delete all".
 *
 * @param options - The preferences write the switch goes through.
 * @returns The summary, its state and the actions.
 *
 * @stability experimental
 */
export function useVoiceprintSettings({ update }: UseVoiceprintSettingsOptions): UseVoiceprintSettingsResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  const [summary, setSummary] = useState<VoiceprintsSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const controller = nextController();
    try {
      const next = await getVoiceprintsSummary(host, controller.signal);
      if (!isMounted() || controller.signal.aborted) return;
      setSummary(next);
      setError(null);
    } catch (err) {
      if (!isMounted() || controller.signal.aborted || isAbortError(err)) return;
      setError(graphErrorMessage(err, 'Could not load your voice recognition settings'));
    } finally {
      if (isMounted() && !controller.signal.aborted) setIsLoading(false);
    }
  }, [host, isMounted, nextController]);

  useEffect(() => {
    void load();
  }, [load]);

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      setIsWorking(true);
      setActionError(null);
      try {
        const ok = await update({ voiceprints: { enabled } });
        if (ok) await load();
        return ok;
      } finally {
        if (isMounted()) setIsWorking(false);
      }
    },
    [isMounted, load, update],
  );

  const deleteAll = useCallback(async (): Promise<DeleteAllVoiceprintsResult | null> => {
    setIsWorking(true);
    setActionError(null);
    try {
      const result = await deleteAllVoiceprints(host);
      await load();
      return result;
    } catch (err) {
      if (isMounted()) {
        setActionError(err instanceof KvoxApiError && err.message ? err.message : 'Could not delete your voiceprints');
      }
      return null;
    } finally {
      if (isMounted()) setIsWorking(false);
    }
  }, [host, isMounted, load]);

  return { summary, isLoading, error, isWorking, actionError, setEnabled, deleteAll, refresh: load };
}
