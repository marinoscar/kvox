// =============================================================================
// KVOX_VOICEPRINTS: the on-device speaker-voiceprint port (issue marinoscar/kvox#825)
// =============================================================================
//
// Lets the graph slice learn what a named person sounds like and suggest a name
// for an unnamed speaker, without importing `@marinoscar/kvox-ai` (which depends
// on this package). The host binds it over `@marinoscar/kvox-ai/voiceprints`;
// an unbound port is `NOOP_KVOX_VOICEPRINTS` (`available()` is false, so the
// jobs do nothing).
//
// BIOMETRIC DATA. A vector or an audio sample crossing this port is never logged,
// never put in an error, a span or an audit payload, and never leaves the
// deployment. The model runs locally; its one network use is a one-time download.
// =============================================================================

/**
 * Injection token of {@link KvoxVoiceprintsPort}. The description string is
 * permanent. Optional in `KvoxPortsModule.forRoot`: the default is unavailable.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_VOICEPRINTS = Symbol.for('@marinoscar/kvox/KVOX_VOICEPRINTS');

/**
 * A time window of a recording, in milliseconds.
 *
 * @stability experimental
 */
export interface KvoxVoiceWindow {
  /** Start, in milliseconds. */
  startMs: number;
  /** End, in milliseconds. */
  endMs: number;
}

/**
 * One scored candidate for {@link KvoxVoiceprintsPort.decide}.
 *
 * @stability experimental
 */
export interface KvoxVoiceCandidate {
  /** The person (entity) id. */
  entityId: string;
  /** Cosine similarity of the voices, higher is closer. */
  score: number;
}

/**
 * A confident suggestion.
 *
 * @stability experimental
 */
export interface KvoxVoiceDecision {
  /** The suggested person. */
  entityId: string;
  /** Its score. */
  score: number;
  /** The lead over the runner-up. */
  margin: number;
}

/**
 * The voiceprint port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxVoiceprintsPort {
  /**
   * Whether voiceprints can run here. A binding may install its model on first call (inside a
   * job, so the download is queue work) and answers false when it cannot.
   */
  available(): Promise<boolean>;
  /** The model id the vectors belong to; vectors of different ids are not comparable. */
  readonly modelId: string;
  /** The vector width. */
  readonly dimensions: number;
  /** Most voiceprints kept per person. */
  readonly maxSamplesPerPerson: number;
  /**
   * The voiceprint of 16 kHz mono samples in [-1, 1], L2-normalised.
   *
   * @throws when the audio is too short or the model is unavailable.
   */
  embed(samples: Float32Array): Promise<Float32Array>;
  /** Picks which windows of a speaker's segments to decode, and how much speech they hold. */
  selectWindows(segments: ReadonlyArray<KvoxVoiceWindow>): {
    /** The windows chosen for decoding. */
    windows: KvoxVoiceWindow[];
    /** The total speech, in milliseconds, those windows hold. */
    speechMs: number;
  };
  /** The best candidate when it is confident and clearly ahead, else `null`. */
  decide(candidates: ReadonlyArray<KvoxVoiceCandidate>): KvoxVoiceDecision | null;
}

/**
 * A voiceprint port that cannot run: the default when a host binds none.
 *
 * @stability experimental
 */
export const NOOP_KVOX_VOICEPRINTS: KvoxVoiceprintsPort = Object.freeze({
  async available(): Promise<boolean> {
    return false;
  },
  modelId: 'none',
  dimensions: 0,
  maxSamplesPerPerson: 0,
  async embed(): Promise<Float32Array> {
    throw new Error('Speaker voiceprints are not available in this host');
  },
  selectWindows() {
    return { windows: [], speechMs: 0 };
  },
  decide() {
    return null;
  },
});
