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
 * `<app-slug>-graph-<YYYY-MM-DD>.<ext>` — the download's filename, dated by
 * when the export was requested (UTC). Signed into the download URL's
 * `Content-Disposition`, never added by a client.
 *
 * @stability experimental
 */
export function graphExportFilename(appSlug: string, createdAt: Date, format: GraphExportFormat): string {
  return `${appSlug}-graph-${createdAt.toISOString().slice(0, 10)}.${GRAPH_EXPORT_FORMAT_INFO[format].extension}`;
}
