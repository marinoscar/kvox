/**
 * `GET|PUT /api/ai-tasks/settings` — the app's slice of the `ai` namespace
 * (issue #477, epic #472): the per-task model map, the connected-knowledge
 * switch, the default model and the ceilings. The former admin settings hook, shrunk
 * to what the platform's AI page does not cover.
 *
 * `save` resolves `true` when the write landed and `false` when it did not,
 * and never throws: the outcome is state the section renders. A 409 means the
 * `If-Match` version was stale (someone else saved), so the document is reloaded
 * and the message says the fields on screen were replaced, because a message
 * alone over a form still holding stale values invites a second Save that would
 * overwrite the colleague's change for real.
 *
 * No key travels through this hook: the document has no field that could hold
 * one.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import { getAiTasksSettings, putAiTasksSettings } from '../services/aiTasks';
import type { AiTasksSettings, AiTasksSettingsView } from '../services/aiTasks';
import { useIsMounted } from '@marinoscar/kvox-web/core/headless';

/** 403 is named explicitly: it is the one failure an admin can act on themselves. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'You do not have permission to manage AI settings';
    }
    return err.message || fallback;
  }
  return fallback;
}

export interface UseAiTasksSettingsReturn {
  data: AiTasksSettingsView | null;
  isLoading: boolean;
  /** Failure to LOAD: "nothing to edit", as distinct from "your edit did not stick". */
  loadError: string | null;
  isSaving: boolean;
  saveError: string | null;
  /**
   * The `details` of the ApiError behind `saveError`. A 400 from the PUT names
   * the offending task in `details.task` (and `details.reason`) so the section
   * can highlight that row. `null` when none.
   */
  saveErrorDetails: unknown;
  save: (values: AiTasksSettings) => Promise<boolean>;
  clearSaveError: () => void;
  refresh: () => Promise<void>;
}

export function useAiTasksSettings(): UseAiTasksSettingsReturn {
  const [data, setData] = useState<AiTasksSettingsView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveErrorDetails, setSaveErrorDetails] = useState<unknown>(null);

  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const next = await getAiTasksSettings();
      if (isMounted()) setData(next);
    } catch (err) {
      if (isMounted()) setLoadError(messageFor(err, 'Failed to load AI task settings'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const save = useCallback(
    async (values: AiTasksSettings): Promise<boolean> => {
      if (!data) return false;
      try {
        setIsSaving(true);
        setSaveError(null);
        setSaveErrorDetails(null);
        const next = await putAiTasksSettings(values, data.version);
        if (isMounted()) setData(next);
        return true;
      } catch (err) {
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
          setSaveError(messageFor(err, 'Failed to save AI task settings'));
          setSaveErrorDetails(err instanceof ApiError ? (err.details ?? null) : null);
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [data, fetchSettings, isMounted],
  );

  const clearSaveError = useCallback(() => {
    setSaveError(null);
    setSaveErrorDetails(null);
  }, []);

  return {
    data,
    isLoading,
    loadError,
    isSaving,
    saveError,
    saveErrorDetails,
    save,
    clearSaveError,
    refresh: fetchSettings,
  };
}
