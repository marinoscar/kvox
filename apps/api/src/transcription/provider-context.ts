// =============================================================================
// The transcription provider context (issue #475, epic #472)
// =============================================================================
//
// What a transcription provider call receives: the resolved credential and this
// provider's validated settings. It lives here, not beside the provider interface,
// so the settings service and the runtime import the helper without importing the
// interface's whole surface, and so no AI module is involved: transcription is not
// a platform AI call (its key is a `credentials` row, its providers are its own).
// =============================================================================

/**
 * The per-call context: the resolved credential and this provider's settings.
 *
 * ⚠ CONTAINS A SECRET. See the header of `providers/transcription-provider.interface.ts`. `toJSON` is declared so that the
 * most common accidental leak — a context reaching `JSON.stringify` through a
 * log serialiser or an error's `cause` — produces a marker string rather than
 * the key. It is a backstop, not permission: the rule is still "never log this".
 */
export interface TranscriptionProviderContext<TSettings = unknown> {
  /** Plaintext API key, valid for this call only. NEVER log or persist. */
  readonly apiKey: string;
  /** This provider's validated settings — the output of `settingsSchema.parse`. */
  readonly settings: TSettings;
}

/**
 * Build a context whose accidental serialisation is inert.
 *
 * The `toJSON` is non-enumerable so it does not show up in `Object.keys` or a
 * spread, and the object is frozen so a caller cannot remove it.
 */
export function createProviderContext<TSettings>(
  apiKey: string,
  settings: TSettings,
): TranscriptionProviderContext<TSettings> {
  const ctx = { apiKey, settings };

  Object.defineProperty(ctx, 'toJSON', {
    value: () => ({ apiKey: '[redacted]', settings }),
    enumerable: false,
  });

  return Object.freeze(ctx);
}
