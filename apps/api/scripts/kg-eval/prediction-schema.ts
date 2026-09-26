// =============================================================================
// What a kg:eval runner writes, one file per fixture: `<outDir>/<fixtureId>.json`
// (issue #362). `from`/`to`/`subject`/`owner`/`counterparty` name either a
// prediction entity `ref` or a `knownEntities` id from the fixture.
// =============================================================================

import { z } from 'zod';

import { ITEM_LABEL_KINDS, validPrecisionSchema } from './fixture-schema';

export const predictedEvidenceSchema = z.object({
  source: z.enum(['segment', 'note']),
  segmentId: z.string().nullable(),
  quote: z.string(),
});
export type PredictedEvidence = z.infer<typeof predictedEvidenceSchema>;

export const predictedResolutionSchema = z.object({
  outcome: z.enum(['linked', 'new', 'uncertain']),
  entityId: z.string().nullable(),
  score: z.number().nullable(),
  prechecked: z.boolean(),
});

export const predictedEntitySchema = z.object({
  ref: z.string(),
  type: z.string(),
  label: z.string(),
  aliases: z.array(z.string()).default([]),
  resolution: predictedResolutionSchema.nullable().default(null),
  evidence: z.array(predictedEvidenceSchema).default([]),
});
export type PredictedEntity = z.infer<typeof predictedEntitySchema>;

export const predictedRelationSchema = z.object({
  type: z.string(),
  from: z.string(),
  to: z.string(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  precision: validPrecisionSchema,
  evidence: z.array(predictedEvidenceSchema).default([]),
});
export type PredictedRelation = z.infer<typeof predictedRelationSchema>;

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
export type PredictedItem = z.infer<typeof predictedItemSchema>;

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
export type KgEvalPrediction = z.infer<typeof kgEvalPredictionSchema>;
export type KgEvalPredictionInput = z.input<typeof kgEvalPredictionSchema>;

/** A prediction with nothing in it: what a missing prediction file scores as. */
export function emptyPrediction(fixtureId: string, model: string | null = null): KgEvalPrediction {
  return { fixtureId, model, entities: [], relations: [], items: [], stats: {} };
}
