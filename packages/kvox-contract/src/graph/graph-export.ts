import { z } from 'zod';
import { GRAPH_EXPORT_FORMATS } from './graph-export-formats.js';

// =============================================================================
// Graph export DTOs (#386, docs/specs/ontology.md §12, §18.2)
// =============================================================================
//
// `POST /api/graph/exports` queues (or reuses) an RDF export of the caller's
// own graph; `GET /api/graph/exports/:id` polls one; `GET /api/graph/exports`
// lists the caller's unexpired ones. Zod, validated by `ZodValidationPipe`.
// =============================================================================

/**
 * Wire constant: kg export statuses.
 *
 * @stability experimental
 */
export const KG_EXPORT_STATUSES = ['pending', 'running', 'ready', 'failed'] as const;

/**
 * Zod schema for the create graph export wire shape.
 *
 * @stability experimental
 */
export const createGraphExportSchema = z
  .object({
    format: z
      .enum(GRAPH_EXPORT_FORMATS)
      .describe('`jsonld` (JSON-LD, compacted with a generated @context), `turtle` or `nquads`.'),
  })
  .strict();

/**
 * The parsed shape of {@link createGraphExportSchema}.
 *
 * @stability experimental
 */
export type CreateGraphExportDto = z.infer<typeof createGraphExportSchema>;

/**
 * Zod schema for the kg export stats wire shape.
 *
 * @stability experimental
 */
export const kgExportStatsSchema = z
  .object({
    entities: z.number().int().optional(),
    relations: z.number().int().optional(),
    items: z.number().int().optional(),
    evidence: z.number().int().optional(),
    excludedSensitive: z
      .number()
      .int()
      .optional()
      .describe('Sensitive person facts and sensitive attribute values left out — they never leave this deployment.'),
    bytes: z.number().int().optional(),
  })
  .describe('Counts, once the export is `ready`. Empty before.');

/**
 * Zod schema for the kg export wire shape.
 *
 * @stability experimental
 */
export const kgExportSchema = z.object({
  id: z.uuid(),
  format: z.enum(GRAPH_EXPORT_FORMATS),
  status: z.enum(KG_EXPORT_STATUSES).describe('`pending`/`running` while the `kg.export` job works, then `ready` or `failed`.'),
  ontologyVersion: z.string().describe('The ontology version the export was requested against.'),
  stats: kgExportStatsSchema,
  errorMessage: z.string().nullable().describe('Why the export failed, when it did. Never row data.'),
  createdAt: z.string().describe('When it was requested (ISO 8601).'),
  expiresAt: z.string().describe('When it and its file are deleted (ISO 8601) — 7 days after it was requested.'),
  downloadUrl: z
    .string()
    .nullable()
    .describe('A short-lived (15 minute) signed URL serving the file as an attachment named `filename`. Null unless ready.'),
  filename: z.string().describe('`<app>-graph-<YYYY-MM-DD>.<jsonld|ttl|nq>`, signed into the download.'),
});

/**
 * The parsed shape of {@link kgExportSchema}.
 *
 * @stability experimental
 */
export type KgExportView = z.infer<typeof kgExportSchema>;

/**
 * Zod schema for the create graph export response wire shape.
 *
 * @stability experimental
 */
export const createGraphExportResponseSchema = z.object({
  export: kgExportSchema,
  reused: z
    .boolean()
    .describe('True (and a 200) when an unexpired export of the same, unchanged graph in this format already existed.'),
});

/**
 * The parsed shape of {@link createGraphExportResponseSchema}.
 *
 * @stability experimental
 */
export type CreateGraphExportResponse = z.infer<typeof createGraphExportResponseSchema>;

/**
 * Zod schema for the graph export list wire shape.
 *
 * @stability experimental
 */
export const graphExportListSchema = z.object({
  exports: z.array(kgExportSchema).max(20).describe('Your unexpired exports, newest first (at most 20).'),
});

/**
 * The parsed shape of {@link graphExportListSchema}.
 *
 * @stability experimental
 */
export type GraphExportList = z.infer<typeof graphExportListSchema>;
