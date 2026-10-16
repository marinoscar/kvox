import { ATTRIBUTE_KINDS } from '../ontology/index.js';
import { z } from 'zod';
import { graphAttributeDefSchema } from './graph-attribute-def.js';

// =============================================================================
// Graph import DTOs (#387, docs/specs/ontology.md §12, §18.3)
// =============================================================================
//
// `POST /api/graph/imports` stores an uploaded RDF file and queues `kg.import`,
// which fills an ordinary `kind: 'import'` proposal. Everything the import has
// to say beyond the proposal's own rows lives in `kg_proposals.stats` — this
// file is the Zod contract for that shape (`graphImportStatsSchema`), so the
// handler that writes it and the OpenAPI document that describes it agree.
//
// The two attribute-offer routes are additive to #366's proposal surface:
// accepting an offer creates a `kg_attribute_defs` row through #355's service
// and moves the property's values into the affected rows' `props`.
// =============================================================================

/**
 * Wire constant: graph import formats.
 *
 * @stability experimental
 */
export const GRAPH_IMPORT_FORMATS = ['turtle', 'jsonld', 'nquads'] as const;
/**
 * The `GraphImportFormat` type (graph import format).
 *
 * @stability experimental
 */
export type GraphImportFormat = (typeof GRAPH_IMPORT_FORMATS)[number];

/**
 * Wire constant: graph import failure reasons.
 *
 * @stability experimental
 */
export const GRAPH_IMPORT_FAILURE_REASONS = [
  'parse_error',
  'too_large',
  'ontology_version_newer',
  'migration_pending',
  'shacl_violations',
  'empty',
] as const;
/**
 * The `GraphImportFailureReason` type (graph import failure reason).
 *
 * @stability experimental
 */
export type GraphImportFailureReason = (typeof GRAPH_IMPORT_FAILURE_REASONS)[number];

/**
 * Wire constant: graph import offer statuses.
 *
 * @stability experimental
 */
export const GRAPH_IMPORT_OFFER_STATUSES = ['offered', 'accepted', 'rejected'] as const;
/**
 * The `GraphImportOfferStatus` type (graph import offer status).
 *
 * @stability experimental
 */
export type GraphImportOfferStatus = (typeof GRAPH_IMPORT_OFFER_STATUSES)[number];

/**
 * Most violations `stats.validation.violations` stores; `violationCount` is the true total.
 *
 * @stability experimental
 */
export const GRAPH_IMPORT_MAX_VIOLATIONS = 200;

/**
 * Zod schema for the graph import violation wire shape.
 *
 * @stability experimental
 */
export const graphImportViolationSchema = z.object({
  focusNode: z.string().describe('The node that failed — its IRI, or `_:label` for a blank node.'),
  path: z.string().nullable().describe('The property the constraint is about, when it has one.'),
  message: z.string(),
  severity: z.enum(['Violation', 'Warning']),
});
/**
 * The parsed shape of {@link graphImportViolationSchema}.
 *
 * @stability experimental
 */
export type GraphImportViolation = z.infer<typeof graphImportViolationSchema>;

/**
 * Zod schema for the graph import offer wire shape.
 *
 * @stability experimental
 */
export const graphImportOfferSchema = z.object({
  offerId: z.string().describe('Stable within this proposal; names the offer in the accept/reject routes.'),
  iri: z.string().describe('The property IRI the file used.'),
  label: z
    .string()
    .nullable()
    .describe('A label for it: the file’s own `rdfs:label` for the property when it states one, else null.'),
  count: z.number().int().describe('How many values of it the file carried.'),
  subjectTypes: z
    .array(z.string())
    .describe('The types of the nodes carrying it. `Assertion` (a relation) can never become an attribute.'),
  sampleValues: z.array(z.string()).max(3).describe('At most three values, each at most 80 characters.'),
  suggestedKind: z.enum(ATTRIBUTE_KINDS).describe('From the values’ datatypes.'),
  status: z.enum(GRAPH_IMPORT_OFFER_STATUSES),
});
/**
 * The parsed shape of {@link graphImportOfferSchema}.
 *
 * @stability experimental
 */
export type GraphImportOffer = z.infer<typeof graphImportOfferSchema>;

/**
 * Zod schema for the graph import stats wire shape.
 *
 * @stability experimental
 */
export const graphImportStatsSchema = z
  .object({
    filename: z.string(),
    format: z.enum(GRAPH_IMPORT_FORMATS),
    bytes: z.number().int(),
    triples: z.number().int(),
    sourceOntologyVersion: z.string().nullable().describe('The file’s `owl:versionInfo` (or most common `kv:ontologyVersion`).'),
    migratedFrom: z.string().nullable().describe('Set when the file was older and declared migrations reshaped it in memory.'),
    validation: z.object({
      conforms: z.boolean(),
      violations: z.array(graphImportViolationSchema).max(GRAPH_IMPORT_MAX_VIOLATIONS),
      violationCount: z.number().int(),
    }),
    unknownProperties: z.array(graphImportOfferSchema),
    counts: z.object({
      entities: z.number().int(),
      relations: z.number().int(),
      items: z.number().int(),
      skippedSensitive: z.number().int().describe('`sensitive` person facts and attribute values the file carried — never imported in bulk.'),
    }),
    failureReason: z.enum(GRAPH_IMPORT_FAILURE_REASONS).nullable(),
  })
  .describe('`kg_proposals.stats` for `kind: import` once `kg.import` has run. Only `filename`/`format`/`bytes` exist while `extracting`.');
/**
 * The parsed shape of {@link graphImportStatsSchema}.
 *
 * @stability experimental
 */
export type GraphImportStats = z.infer<typeof graphImportStatsSchema>;

/**
 * Zod schema for the create graph import response wire shape.
 *
 * @stability experimental
 */
export const createGraphImportResponseSchema = z.object({
  proposalId: z.uuid().describe('The `kind: import` proposal, `extracting` until `kg.import` finishes.'),
  jobId: z.uuid(),
});
/**
 * The parsed shape of {@link createGraphImportResponseSchema}.
 *
 * @stability experimental
 */
export type CreateGraphImportResponse = z.infer<typeof createGraphImportResponseSchema>;

/**
 * Zod schema for the accept attribute offer wire shape.
 *
 * @stability experimental
 */
export const acceptAttributeOfferSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('The new attribute’s label. Default: the offer’s label, else the IRI’s last segment.'),
  })
  .strict();
/**
 * The parsed shape of {@link acceptAttributeOfferSchema}.
 *
 * @stability experimental
 */
export type AcceptAttributeOfferDto = z.infer<typeof acceptAttributeOfferSchema>;

/**
 * Zod schema for the attribute offer response wire shape.
 *
 * @stability experimental
 */
export const attributeOfferResponseSchema = z.object({
  offer: graphImportOfferSchema,
  attributeDefs: z
    .array(graphAttributeDefSchema)
    .describe('The definitions created — one per entity type carrying the property. Empty on reject.'),
  rowsUpdated: z.number().int().describe('Proposal rows whose `props` now carry the values.'),
  valuesDropped: z
    .number()
    .int()
    .describe('Values that could not be kept (a reference to a row not linked to an existing entity, or a value the kind cannot hold).'),
});
/**
 * The parsed shape of {@link attributeOfferResponseSchema}.
 *
 * @stability experimental
 */
export type AttributeOfferResponse = z.infer<typeof attributeOfferResponseSchema>;
