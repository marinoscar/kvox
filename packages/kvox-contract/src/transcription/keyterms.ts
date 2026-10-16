
/**
 * Most keyterms `POST /api/transcripts` accepts.
 *
 * @stability experimental
 */
export const MAX_TRANSCRIPT_KEYTERMS = 200;

/**
 * Longest single keyterm, in characters.
 *
 * @stability experimental
 */
export const MAX_KEYTERM_LENGTH = 100;

/**
 * Most whitespace-separated words one keyterm may contain.
 *
 * @stability experimental
 */
export const MAX_KEYTERM_WORDS = 6;

/**
 * Whitespace-separated word count of an already-trimmed term.
 *
 * @stability experimental
 */
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
 *
 * @stability experimental
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
