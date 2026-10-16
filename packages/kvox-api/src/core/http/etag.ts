/**
 * The weak validator for a record at `version`.
 *
 * WEAK (`W/`) because two responses at the same version are semantically
 * equivalent rather than byte-identical — `updatedAt` moves when a poll writes
 * `last_polled_at`, and the detail response embeds timestamps that are not
 * part of what the version identifies. A strong ETag would be a promise this
 * endpoint cannot keep.
 *
 * @param version - the record's version.
 * @returns the validator, for example `W/"v3"`.
 * @stability experimental
 */
export function versionETag(version: number): string {
  return `W/"v${version}"`;
}

/**
 * Does the request's `If-None-Match` match `etag`?
 *
 * ⚠ HANDLES A LIST AND `*`, because both are legal. A client may send several
 * validators, and a proxy may rewrite one. Weak comparison is used — which is
 * the ONLY comparison RFC 9110 permits for `If-None-Match` — so `W/"v3"` and
 * `"v3"` match each other, and a caller that stripped the `W/` prefix still
 * gets its 304 rather than a body it already has.
 *
 * @param header - the `If-None-Match` header value, if any.
 * @param etag - the current validator.
 * @returns true when the client already holds the current representation.
 * @stability experimental
 */
export function matchesETag(header: string | undefined, etag: string): boolean {
  if (!header) return false;

  const normalize = (value: string): string => value.trim().replace(/^W\//, '');
  const wanted = normalize(etag);

  return header
    .split(',')
    .map(normalize)
    .some((candidate) => candidate === '*' || candidate === wanted);
}
