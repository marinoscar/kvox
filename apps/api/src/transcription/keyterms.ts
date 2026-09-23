// =============================================================================
// Keyterms — names and domain terms fed forward to the provider (issue #327)
// =============================================================================
//
// A user uploading a recording usually knows words the model does not: the
// people in the room, a product name, an acronym. Handing those to the vendor
// as a recognition HINT is the cheapest accuracy win available, and it is the
// same class of hint as `speakersExpected` — it biases, it never forces.
//
// TWO LIMITS, AND THEY ARE DIFFERENT THINGS:
//
//   • THIS API's input limits (below) — what `POST /api/transcripts` accepts.
//     Deliberately tighter than any vendor's: 200 terms is far beyond what a
//     person types into an upload form, and a smaller ceiling bounds what is
//     stored in `transcripts.provider_options` for every row.
//   • The PROVIDER's limits (`capabilities.keyterms`) — what one submission
//     may carry. Applied at submit time by `clampKeytermsToCapability`, because
//     the active provider can change between upload and submit.
//
// The terms are STORED whatever the active provider can do, and dropped only
// at submit. A deployment that switches to a provider with keyterm support
// then honours them on a retry, rather than having thrown them away at upload.
// =============================================================================

import type { TranscriptionKeytermsCapability } from './providers/transcription-provider.interface';

/** Most keyterms `POST /api/transcripts` accepts. */
export const MAX_TRANSCRIPT_KEYTERMS = 200;

/** Longest single keyterm, in characters. */
export const MAX_KEYTERM_LENGTH = 100;

/** Most whitespace-separated words one keyterm may contain. */
export const MAX_KEYTERM_WORDS = 6;

/** Whitespace-separated word count of an already-trimmed term. */
export function keytermWordCount(term: string): number {
  return term.length === 0 ? 0 : term.split(/\s+/).length;
}

/**
 * Trim, collapse internal whitespace, drop empties, and de-duplicate
 * case-insensitively keeping the FIRST spelling — the user's own capitalisation
 * of a name is the one worth sending.
 *
 * Pure normalisation; it never rejects. Validation of the normalised list is
 * the schema's job.
 */
export function normalizeKeyterms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of terms) {
    const term = raw.trim().replace(/\s+/g, ' ');

    if (term.length === 0) continue;

    const key = term.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(term);
  }

  return out;
}

/**
 * Read the stored keyterms back out of `transcripts.provider_options`.
 *
 * Defensive in the same way `readSpeakersExpected` is: a row written before
 * #327 has no `keyterms` key, and a malformed value reads as "none" rather than
 * failing a submission over a hint.
 */
export function readKeyterms(options: unknown): string[] {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return [];
  }

  const value = (options as Record<string, unknown>).keyterms;

  if (!Array.isArray(value)) return [];

  return normalizeKeyterms(value.filter((v): v is string => typeof v === 'string'));
}

/**
 * The terms a provider with this capability may actually be sent.
 *
 * `null` capability → none at all (the provider cannot take them). Otherwise
 * terms over the provider's per-term word limit are dropped and the list is
 * cut at its term limit. Silent by design: the terms are a hint, and failing a
 * transcription because a hint does not fit would be the wrong trade.
 */
export function clampKeytermsToCapability(
  terms: readonly string[],
  capability: TranscriptionKeytermsCapability | null,
): string[] {
  if (!capability) return [];

  return terms
    .filter((term) => keytermWordCount(term) <= capability.maxWordsPerTerm)
    .slice(0, capability.maxTerms);
}

/**
 * What `GET /api/transcription/config` publishes as `maxKeyterms`: the smaller
 * of this API's input limit and the provider's, or 0 when unsupported.
 */
export function maxKeytermsFor(
  capability: TranscriptionKeytermsCapability | null,
): number {
  return capability ? Math.min(MAX_TRANSCRIPT_KEYTERMS, capability.maxTerms) : 0;
}
