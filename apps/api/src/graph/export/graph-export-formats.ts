// =============================================================================
// Graph export formats (issue #386) — plain constants, no RDF library, so the
// DTOs, the service and the web contract can name a format without pulling
// `serializers.ts` (and with it `n3`/`jsonld`) into the request path (§18.4).
// =============================================================================

export const GRAPH_EXPORT_FORMATS = ['jsonld', 'turtle', 'nquads'] as const;
export type GraphExportFormat = (typeof GRAPH_EXPORT_FORMATS)[number];

/** Filename extension and media type per format. */
export const GRAPH_EXPORT_FORMAT_INFO: Readonly<Record<GraphExportFormat, { extension: string; mimeType: string }>> = {
  jsonld: { extension: 'jsonld', mimeType: 'application/ld+json' },
  turtle: { extension: 'ttl', mimeType: 'text/turtle' },
  nquads: { extension: 'nq', mimeType: 'application/n-quads' },
};
