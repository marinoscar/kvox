// =============================================================================
// What a kg:eval runner writes, one file per fixture: `<outDir>/<fixtureId>.json`
// (issue #362). `from`/`to`/`subject`/`owner`/`counterparty` name either a
// prediction entity `ref` or a `knownEntities` id from the fixture.
// =============================================================================

import { z } from 'zod';

import { ITEM_LABEL_KINDS, validPrecisionSchema } from '../fixtures/index.js';

/**
 * One citation of a predicted row: a segment (`segmentId`) or the note, and the quote.
 *
 * @stability experimental
 */
export const predictedEvidenceSchema = z.object({
  source: z.enum(['segment', 'note']),
  segmentId: z.string().nullable(),
  quote: z.string(),
});
/**
 * A parsed {@link predictedEvidenceSchema}.
 *
 * @stability experimental
 */
export type PredictedEvidence = z.infer<typeof predictedEvidenceSchema>;

/**
 * What resolution decided for a predicted entity: linked (to `entityId`, with its score
 * and whether the pre-check accepted it), new, or uncertain.
 *
 * @stability experimental
 */
export const predictedResolutionSchema = z.object({
  outcome: z.enum(['linked', 'new', 'uncertain']),
  entityId: z.string().nullable(),
  score: z.number().nullable(),
  prechecked: z.boolean(),
});

/**
 * A predicted entity: its `ref` (what relations and items point at), type, label,
 * aliases, resolution and evidence.
 *
 * @stability experimental
 */
export const predictedEntitySchema = z.object({
  ref: z.string(),
  type: z.string(),
  label: z.string(),
  aliases: z.array(z.string()).default([]),
  resolution: predictedResolutionSchema.nullable().default(null),
  evidence: z.array(predictedEvidenceSchema).default([]),
});
/**
 * A parsed {@link predictedEntitySchema}.
 *
 * @stability experimental
 */
export type PredictedEntity = z.infer<typeof predictedEntitySchema>;

/**
 * A predicted edge between two refs or known ids, with its temporal bounds and precision.
 *
 * @stability experimental
 */
export const predictedRelationSchema = z.object({
  type: z.string(),
  from: z.string(),
  to: z.string(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  precision: validPrecisionSchema,
  evidence: z.array(predictedEvidenceSchema).default([]),
});
/**
 * A parsed {@link predictedRelationSchema}.
 *
 * @stability experimental
 */
export type PredictedRelation = z.infer<typeof predictedRelationSchema>;

/**
 * A predicted commitment, decision, claim or person fact.
 *
 * @stability experimental
 */
export const predictedItemSchema = z.object({
  kind: z.enum(ITEM_LABEL_KINDS),
  subject: z.string(),
  owner: z.string().nullable().default(null),
  counterparty: z.string().nullable().default(null),
  title: z.string(),
  statement: z.string(),
  occurredAt: z.string().nullable().default(null),
  dueAt: z.string().nullable().default(null),
  sensitivity: z.enum(['business', 'personal', 'sensitive']).nullable().default(null),
  evidence: z.array(predictedEvidenceSchema).default([]),
});
/**
 * A parsed {@link predictedItemSchema}.
 *
 * @stability experimental
 */
export type PredictedItem = z.infer<typeof predictedItemSchema>;

/**
 * What a runner writes for one fixture, `<outDir>/<fixtureId>.json`: the entities,
 * relations and items a run proposed, the model id (never a key) and the dropped counts.
 *
 * @stability experimental
 */
export const kgEvalPredictionSchema = z.object({
  fixtureId: z.string(),
  /** The model id only — never a key, never a provider credential. */
  model: z.string().nullable(),
  entities: z.array(predictedEntitySchema),
  relations: z.array(predictedRelationSchema),
  items: z.array(predictedItemSchema),
  /** Passthrough from the proposal (`uncited`, `invalid`, … dropped counts). */
  stats: z.record(z.string(), z.number()).default({}),
});
/**
 * A parsed {@link kgEvalPredictionSchema}.
 *
 * @stability experimental
 */
export type KgEvalPrediction = z.infer<typeof kgEvalPredictionSchema>;
/**
 * A prediction as written on disk (before defaults).
 *
 * @stability experimental
 */
export type KgEvalPredictionInput = z.input<typeof kgEvalPredictionSchema>;

/**
 * A prediction with nothing in it: what a missing prediction file scores as.
 *
 * @stability experimental
 */
export function emptyPrediction(fixtureId: string, model: string | null = null): KgEvalPrediction {
  return { fixtureId, model, entities: [], relations: [], items: [], stats: {} };
}
