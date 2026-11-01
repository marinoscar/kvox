// =============================================================================
// Graph export formats (issue #386) — plain constants, no RDF library, so the
// DTOs, the service and the web contract can name a format without pulling
// `serializers.ts` (and with it `n3`/`jsonld`) into the request path (§18.4).
// =============================================================================


// =============================================================================
// Graph export formats (issue #386) — plain constants, no RDF library, so the
// DTOs, the service and the web contract can name a format without pulling
// `serializers.ts` (and with it `n3`/`jsonld`) into the request path (§18.4).
// =============================================================================

/**
 * Wire constant: graph export formats.
 *
 * @stability experimental
 */
export const GRAPH_EXPORT_FORMATS = ['jsonld', 'turtle', 'nquads'] as const;
/**
 * The `GraphExportFormat` type (graph export format).
 *
 * @stability experimental
 */
export type GraphExportFormat = (typeof GRAPH_EXPORT_FORMATS)[number];

/**
 * Filename extension and media type per format.
 *
 * @stability experimental
 */
export const GRAPH_EXPORT_FORMAT_INFO: Readonly<Record<GraphExportFormat, { extension: string; mimeType: string }>> = {
  jsonld: { extension: 'jsonld', mimeType: 'application/ld+json' },
  turtle: { extension: 'ttl', mimeType: 'text/turtle' },
  nquads: { extension: 'nq', mimeType: 'application/n-quads' },
};

/**
 * The `YYYY-MM-DD` day an instant falls on in an IANA time zone; UTC when the zone is absent or
 * unknown. Pure `Intl`, so this package needs no time zone dependency.
 */
function dayKeyIn(instant: Date, timeZone: string | undefined): string {
  if (timeZone) {
    try {
      // `en-CA` formats a date as `YYYY-MM-DD`.
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
    } catch {
      // An unknown zone id: fall through to UTC.
    }
  }
  return instant.toISOString().slice(0, 10);
}

/**
 * `<app-slug>-graph-<YYYY-MM-DD>.<ext>` — the download's filename, dated by
 * the day the export was requested in the owner's time zone (`timeZone`, an IANA
 * id; UTC when absent). Signed into the download URL's
 * `Content-Disposition`, never added by a client.
 *
 * @stability experimental
 */
export function graphExportFilename(appSlug: string, createdAt: Date, format: GraphExportFormat, timeZone?: string): string {
  return `${appSlug}-graph-${dayKeyIn(createdAt, timeZone)}.${GRAPH_EXPORT_FORMAT_INFO[format].extension}`;
}
