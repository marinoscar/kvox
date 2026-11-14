/**
 * `useEntityVoiceprint` — what the server has learned of one Person's voice
 * (#827, epic #820), and "Forget voice".
 *
 * The section it feeds is secondary on the Person page, so a failed read is
 * reported as `error` for the section alone and never takes the page down.
 */

import { useCallback, useEffect, useState } from 'react';

import { forgetEntityVoiceprint, getEntityVoiceprint } from '../clients/voiceprints.js';
import type { PersonVoiceprint } from '../clients/voiceprints.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * What {@link useEntityVoiceprint} returns.
 *
 * @stability experimental
 */
export interface UseEntityVoiceprintResult {
  /** The voiceprint state, or `null` until it loads or when it could not be read. */
  data: PersonVoiceprint | null;
  /** The read is in flight. */
  isLoading: boolean;
  /** Why the read failed, else `null`. */
  error: string | null;
  /** A forget is in flight. */
  isForgetting: boolean;
  /** Why the last forget failed, else `null`. */
  forgetError: string | null;
  /** Deletes the Person's voice samples. Resolves `true` when it landed. */
  forget: () => Promise<boolean>;
  /** Reads the state again. */
  refresh: () => Promise<void>;
}

/** The state after a forget: nothing learned. */
const NOT_ENROLLED: PersonVoiceprint = {
  enrolled: false,
  samples: 0,
  speechMs: 0,
  lastUpdatedAt: null,
  modelId: null,
};

/**
 * Loads one Person's voiceprint state. Does nothing while `entityId` is
 * undefined or `enabled` is `false` (a non-Person entity has no voice).
 *
 * @param entityId - The Person, or `undefined`.
 * @param enabled - `false` to skip the read.
 * @returns The state and `forget`.
 *
 * @stability experimental
 */
export function useEntityVoiceprint(entityId: string | undefined, enabled = true): UseEntityVoiceprintResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  const [data, setData] = useState<PersonVoiceprint | null>(null);
  const [isLoading, setIsLoading] = useState(enabled && Boolean(entityId));
  const [error, setError] = useState<string | null>(null);
  const [isForgetting, setIsForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const controller = nextController();
    if (!enabled || !entityId) {
      setData(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const next = await getEntityVoiceprint(host, entityId, controller.signal);
      if (!isMounted() || controller.signal.aborted) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!isMounted() || controller.signal.aborted || isAbortError(err)) return;
      setData(null);
      setError(graphErrorMessage(err, 'Could not load what was learned of this voice'));
    } finally {
      if (isMounted() && !controller.signal.aborted) setIsLoading(false);
    }
  }, [enabled, entityId, host, isMounted, nextController]);

  useEffect(() => {
    setData(null);
    setError(null);
    setForgetError(null);
    void load();
  }, [load]);

  const forget = useCallback(async (): Promise<boolean> => {
    if (!entityId) return false;
    setIsForgetting(true);
    setForgetError(null);
    try {
      await forgetEntityVoiceprint(host, entityId);
      if (isMounted()) setData(NOT_ENROLLED);
      return true;
    } catch (err) {
      if (isMounted()) {
        setForgetError(err instanceof KvoxApiError && err.message ? err.message : 'Could not forget this voice');
      }
      return false;
    } finally {
      if (isMounted()) setIsForgetting(false);
    }
  }, [entityId, host, isMounted]);

  return { data, isLoading, error, isForgetting, forgetError, forget, refresh: load };
}
