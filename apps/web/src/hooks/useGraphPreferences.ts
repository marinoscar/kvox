/**
 * The `graph` user-settings namespace, resolved (#369, epic #346).
 *
 * A thin layer over `useUserSettings`: the stored namespace is SPARSE (absent
 * means every default — `docs/specs/ontology.md` §7, §13, §17.2), so this hook
 * resolves it against `GRAPH_PREFERENCE_DEFAULTS` for rendering and sends only
 * the field that changed on write. It never writes a default into the row.
 *
 * `saveState` is the `SaveIndicator` vocabulary (`components/transcripts/`):
 * a settings page that saves on change must say whether the change landed.
 */

import { useCallback, useMemo, useState } from 'react';

import type {
  GraphAdjudication,
  GraphPreferencesPatch,
  GraphPreferencesSettings,
  GraphResolutionMode,
} from '../types';
import { useIsMounted } from './useIsMounted';
import { useUserSettings } from './useUserSettings';

export interface ResolvedGraphPreferences {
  extraction: { autoExtract: boolean };
  resolution: {
    mode: GraphResolutionMode;
    autoLinkThreshold: number;
    newThreshold: number;
    adjudication: GraphAdjudication;
  };
  domains: { core: true; work: boolean; personal: boolean };
}

/** Mirrors the API's `GRAPH_PREFERENCE_DEFAULTS` (graph-preferences.defaults.ts). */
export const GRAPH_PREFERENCE_DEFAULTS: ResolvedGraphPreferences = {
  extraction: { autoExtract: true },
  resolution: {
    mode: 'precheck_confident',
    autoLinkThreshold: 0.9,
    newThreshold: 0.55,
    adjudication: 'llm',
  },
  domains: { core: true, work: true, personal: false },
};

/** Bounds the API enforces (`graphPreferencesSchema`). */
export const AUTO_LINK_MIN = 0.8;
export const AUTO_LINK_MAX = 0.99;
export const NEW_MIN = 0.3;
export const NEW_MAX = 0.94;
export const THRESHOLD_MIN_GAP = 0.05;
/** The measured-safe auto-link default (§6); lower is allowed, with a warning. */
export const SAFE_AUTO_LINK = 0.9;

/** The highest `newThreshold` a given `autoLinkThreshold` allows, in hundredths. */
export function maxNewThreshold(autoLinkThreshold: number): number {
  return Math.min(NEW_MAX, Math.round((autoLinkThreshold - THRESHOLD_MIN_GAP) * 100) / 100);
}

export function resolveGraphPreferences(
  value: GraphPreferencesSettings | null | undefined,
): ResolvedGraphPreferences {
  const d = GRAPH_PREFERENCE_DEFAULTS;
  return {
    extraction: { autoExtract: value?.extraction?.autoExtract ?? d.extraction.autoExtract },
    resolution: {
      mode: value?.resolution?.mode ?? d.resolution.mode,
      autoLinkThreshold: value?.resolution?.autoLinkThreshold ?? d.resolution.autoLinkThreshold,
      newThreshold: value?.resolution?.newThreshold ?? d.resolution.newThreshold,
      adjudication: value?.resolution?.adjudication ?? d.resolution.adjudication,
    },
    domains: {
      core: true,
      work: value?.domains?.work ?? d.domains.work,
      personal: value?.domains?.personal ?? d.domains.personal,
    },
  };
}

export type GraphSaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface UseGraphPreferencesReturn {
  preferences: ResolvedGraphPreferences;
  isLoading: boolean;
  loadError: string | null;
  saveState: GraphSaveState;
  saveError: string | null;
  /** PATCH `{ graph: patch }`. Resolves `true` when the write landed. */
  update: (patch: GraphPreferencesPatch) => Promise<boolean>;
}

export function useGraphPreferences(): UseGraphPreferencesReturn {
  // `syncTheme: false` — this page never changes the theme, and must not
  // stamp the stored one back over the AppBar toggle.
  const { settings, isLoading, error, updateSettings } = useUserSettings({ syncTheme: false });
  const [saveState, setSaveState] = useState<GraphSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const preferences = useMemo(() => resolveGraphPreferences(settings?.graph), [settings?.graph]);

  const update = useCallback(
    async (patch: GraphPreferencesPatch): Promise<boolean> => {
      setSaveState('saving');
      setSaveError(null);
      try {
        await updateSettings({ graph: patch });
        if (isMounted()) setSaveState('saved');
        return true;
      } catch (err) {
        if (isMounted()) {
          setSaveState('error');
          setSaveError(err instanceof Error ? err.message : 'Failed to save');
        }
        return false;
      }
    },
    [updateSettings, isMounted],
  );

  return {
    preferences,
    isLoading,
    // Before the first load `error` is a load error; afterwards the hook's
    // own `saveError` is the one this page shows.
    loadError: settings ? null : error,
    saveState,
    saveError,
    update,
  };
}
