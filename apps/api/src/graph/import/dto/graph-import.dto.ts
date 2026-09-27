import { ATTRIBUTE_KINDS } from '@app/shared/ontology';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { graphAttributeDefSchema } from '../../dto/graph-attribute-def.dto';

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

export const GRAPH_IMPORT_FORMATS = ['turtle', 'jsonld', 'nquads'] as const;
export type GraphImportFormat = (typeof GRAPH_IMPORT_FORMATS)[number];

export const GRAPH_IMPORT_FAILURE_REASONS = [
  'parse_error',
  'too_large',
  'ontology_version_newer',
  'migration_pending',
  'shacl_violations',
  'empty',
] as const;
export type GraphImportFailureReason = (typeof GRAPH_IMPORT_FAILURE_REASONS)[number];

export const GRAPH_IMPORT_OFFER_STATUSES = ['offered', 'accepted', 'rejected'] as const;
export type GraphImportOfferStatus = (typeof GRAPH_IMPORT_OFFER_STATUSES)[number];

/** Most violations `stats.validation.violations` stores; `violationCount` is the true total. */
export const GRAPH_IMPORT_MAX_VIOLATIONS = 200;

export const graphImportViolationSchema = z.object({
  focusNode: z.string().describe('The node that failed — its IRI, or `_:label` for a blank node.'),
  path: z.string().nullable().describe('The property the constraint is about, when it has one.'),
  message: z.string(),
  severity: z.enum(['Violation', 'Warning']),
});
export type GraphImportViolation = z.infer<typeof graphImportViolationSchema>;

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
export type GraphImportOffer = z.infer<typeof graphImportOfferSchema>;

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
export type GraphImportStats = z.infer<typeof graphImportStatsSchema>;

export const createGraphImportResponseSchema = z.object({
  proposalId: z.uuid().describe('The `kind: import` proposal, `extracting` until `kg.import` finishes.'),
  jobId: z.uuid(),
});
export type CreateGraphImportResponse = z.infer<typeof createGraphImportResponseSchema>;
export class CreateGraphImportResponseDto extends createZodDto(createGraphImportResponseSchema) {}

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
export type AcceptAttributeOfferDto = z.infer<typeof acceptAttributeOfferSchema>;
export class AcceptAttributeOfferBodyDto extends createZodDto(acceptAttributeOfferSchema) {}

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
export type AttributeOfferResponse = z.infer<typeof attributeOfferResponseSchema>;
export class AttributeOfferResponseDto extends createZodDto(attributeOfferResponseSchema) {}
