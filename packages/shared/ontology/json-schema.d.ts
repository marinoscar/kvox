import type { EffectiveSchema } from './types.js';
/** The strict-mode `props` JSON Schema for one entity or relation type. */
export declare function buildPropsJsonSchema(schema: EffectiveSchema, typeKey: string, opts?: {
    relation?: boolean;
}): Record<string, unknown>;
/** Entity and item types the model may propose (Meeting and deprecated types excluded). */
export declare function extractableEntityTypes(schema: EffectiveSchema): string[];
/** Relation types the model may propose: extractable, non-deprecated edges. */
export declare function extractableRelationTypes(schema: EffectiveSchema): string[];
