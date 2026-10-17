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

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  KvoxApiError,
  kvoxGet,
  kvoxPatch,
  useIsMounted,
  useKvoxHost,
} from '../../../core/headless/index.js';

/**
 * How the resolver treats a candidate it can link on its own.
 *
 * @stability experimental
 */
export type GraphResolutionMode = 'precheck_confident' | 'review_all';

/**
 * Whether an AI adjudication step runs on ambiguous candidates.
 *
 * @stability experimental
 */
export type GraphAdjudication = 'llm' | 'off';

/**
 * The stored (sparse) `graph` namespace of the user's settings, mirroring the
 * API's `graphPreferencesSchema`.
 *
 * @stability experimental
 */
export interface GraphPreferencesSettings {
  /** Extraction preferences. */
  extraction?: {
    /** Whether auto extract applies. */
    autoExtract: boolean;
  };
  /** Entity-resolution preferences. */
  resolution?: {
    /** How confident links are handled. */
    mode: GraphResolutionMode;
    /** The score at or above which a candidate is linked automatically. */
    autoLinkThreshold: number;
    /** The score below which a candidate is a new entity. */
    newThreshold: number;
    /** Whether an AI step adjudicates ambiguous candidates. */
    adjudication: GraphAdjudication;
  };
  /** `core` is always on and never stored. `personal` is off by default (#383). */
  domains?: {
    /** Whether work applies. */
    work: boolean;
    /** Whether personal applies. */
    personal: boolean;
  };
}

/**
 * PATCH form of {@link GraphPreferencesSettings}: every field optional; `null`
 * resets it to the default.
 *
 * @stability experimental
 */
export interface GraphPreferencesPatch {
  /** Extraction preferences, or `null` to reset them. */
  extraction?: {
    /** The auto extract. */
    autoExtract?: boolean | null;
  } | null;
  /** Entity-resolution preferences, or `null` to reset them. */
  resolution?: {
    /** How confident links are handled. */
    mode?: GraphResolutionMode | null;
    /** The automatic-link score. */
    autoLinkThreshold?: number | null;
    /** The new-entity score. */
    newThreshold?: number | null;
    /** Whether an AI step adjudicates. */
    adjudication?: GraphAdjudication | null;
  } | null;
  /** Domain switches, or `null` to reset them. */
  domains?: {
    /** The work. */
    work?: boolean | null;
    /** The personal. */
    personal?: boolean | null;
  } | null;
}

/**
 * The resolved graph preferences.
 *
 * @stability experimental
 */
export interface ResolvedGraphPreferences {
  /** The extraction. */
  extraction: {
    /** Whether auto extract applies. */
    autoExtract: boolean;
  };
  /** The resolution. */
  resolution: {
    /** The mode. */
    mode: GraphResolutionMode;
    /** The auto link threshold. */
    autoLinkThreshold: number;
    /** The new threshold. */
    newThreshold: number;
    /** The adjudication. */
    adjudication: GraphAdjudication;
  };
  /** The domains. */
  domains: {
    /** The core. */
    core: true;
    /** Whether work applies. */
    work: boolean;
    /** Whether personal applies. */
    personal: boolean;
  };
}

/**
 * Mirrors the API's `GRAPH_PREFERENCE_DEFAULTS` (graph-preferences.defaults.ts).
 *
 * @stability experimental
 */
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

/**
 * Bounds the API enforces (`graphPreferencesSchema`).
 *
 * @stability experimental
 */
export const AUTO_LINK_MIN = 0.8;
/**
 * The AUTO LINK MAX.
 *
 * @stability experimental
 */
export const AUTO_LINK_MAX = 0.99;
/**
 * The NEW MIN.
 *
 * @stability experimental
 */
export const NEW_MIN = 0.3;
/**
 * The NEW MAX.
 *
 * @stability experimental
 */
export const NEW_MAX = 0.94;
/**
 * The THRESHOLD MIN GAP.
 *
 * @stability experimental
 */
export const THRESHOLD_MIN_GAP = 0.05;
/**
 * The measured-safe auto-link default (§6); lower is allowed, with a warning.
 *
 * @stability experimental
 */
export const SAFE_AUTO_LINK = 0.9;

/**
 * The highest `newThreshold` a given `autoLinkThreshold` allows, in hundredths.
 *
 * @stability experimental
 */
export function maxNewThreshold(autoLinkThreshold: number): number {
  return Math.min(NEW_MAX, Math.round((autoLinkThreshold - THRESHOLD_MIN_GAP) * 100) / 100);
}

/**
 * Resolves graph preferences.
 *
 * @stability experimental
 */
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

/**
 * The `SaveIndicator` vocabulary: whether a change landed.
 *
 * @stability experimental
 */
export type GraphSaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * What {@link useGraphPreferences} returns.
 *
 * @stability experimental
 */
export interface UseGraphPreferencesReturn {
  /** The stored namespace resolved against the defaults. */
  preferences: ResolvedGraphPreferences;
  /** The first read has not settled yet. */
  isLoading: boolean;
  /** A message when the first read failed, else `null`. */
  loadError: string | null;
  /** Whether the last write landed. */
  saveState: GraphSaveState;
  /** A message when the last write failed, else `null`. */
  saveError: string | null;
  /** PATCH `{ graph: patch }`. Resolves `true` when the write landed. */
  update: (patch: GraphPreferencesPatch) => Promise<boolean>;
}

/** The part of `GET /api/user-settings` this hook reads. */
interface UserSettingsDocument {
  version: number;
  graph?: GraphPreferencesSettings;
}

/** What the platform's settings hook says after a lost optimistic-concurrency race. */
const CONFLICT_MESSAGE = 'Settings were updated elsewhere. Please try again.';

/**
 * The `graph` user-settings namespace, resolved, with a write that sends only
 * the field that changed.
 *
 * @remarks
 * The document is read from and written to `/api/user-settings` through the
 * host, with `If-Match` carrying its version. A 409 (another writer bumped the
 * version: the navigation rail, onboarding) is retried ONCE against the fresh
 * document with the same patch; a second 409 surfaces as the conflict message.
 * The theme is never touched.
 *
 * @returns The preferences, the load and save state, and `update`.
 *
 * @stability experimental
 */
export function useGraphPreferences(): UseGraphPreferencesReturn {
  const host = useKvoxHost();
  const [settings, setSettings] = useState<UserSettingsDocument | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<GraphSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    void (async () => {
      try {
        setIsLoading(true);
        setError(null);
        const document = await kvoxGet<UserSettingsDocument>(host, '/user-settings');
        if (isMounted()) setSettings(document);
      } catch (err) {
        if (isMounted()) {
          setError(err instanceof KvoxApiError ? err.message : 'Failed to load settings');
        }
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    })();
  }, [host, isMounted]);

  const preferences = useMemo(() => resolveGraphPreferences(settings?.graph), [settings?.graph]);

  const update = useCallback(
    async (patch: GraphPreferencesPatch): Promise<boolean> => {
      setSaveState('saving');
      setSaveError(null);
      try {
        if (settings) {
          const write = (version: number) =>
            kvoxPatch<UserSettingsDocument>(
              host,
              '/user-settings',
              { graph: patch },
              { headers: { 'If-Match': String(version) } },
            );
          let saved: UserSettingsDocument;
          try {
            saved = await write(settings.version);
          } catch (err) {
            if (!(err instanceof KvoxApiError) || err.status !== 409) throw err;
            try {
              const fresh = await kvoxGet<UserSettingsDocument>(host, '/user-settings');
              saved = await write(fresh.version);
            } catch (retryErr) {
              if (retryErr instanceof KvoxApiError && retryErr.status === 409) {
                throw new Error(CONFLICT_MESSAGE);
              }
              throw retryErr;
            }
          }
          if (isMounted()) setSettings(saved);
        }
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
    [host, settings, isMounted],
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
