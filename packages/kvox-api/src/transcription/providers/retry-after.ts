// =============================================================================
// Retry-After parsing (issue #492, epic #491)
// =============================================================================
//
// RFC 9110 allows exactly two forms of `Retry-After`, and providers genuinely
// use both. This is the transcription providers' copy of the host queue's
// parser: the package cannot import the platform, and the parse is twelve lines.
// It is internal to the slice (not exported from its entry point).
// =============================================================================

/**
 * Parses an HTTP `Retry-After` header into milliseconds.
 *
 * - `Retry-After: 120` is delta-seconds, so `120000`. Anchored and digit-only,
 *   deliberately: `parseInt` would read `30 minutes` as 30 and `1e3` as 1.
 * - `Retry-After: Wed, 21 Oct 2015 07:28:00 GMT` is an HTTP-date, converted to a
 *   delay relative to `now`. A date at or before `now` describes no wait at all
 *   and reads as "no opinion", not zero.
 *
 * @param header - the header value, or `null` when the response had none.
 * @param now - the current time in epoch milliseconds (a parameter so a test can pin it).
 * @returns the delay in milliseconds, or `null` when the provider named none.
 */
export function parseRetryAfterMs(
  header: string | number | null | undefined,
  now: number = Date.now(),
): number | null {
  if (header === null || header === undefined) return null;

  const raw = String(header).trim();
  if (raw.length === 0) return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return null;

  const delta = timestamp - now;
  return delta > 0 ? delta : null;
}
