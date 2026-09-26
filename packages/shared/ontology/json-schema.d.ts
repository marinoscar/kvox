import type { EffectiveSchema } from './effective-schema.js';
/**
 * The strict JSON Schema of one type's extractable props (an object whose
 * `required` is every key). Throws when `typeKey` is not in this schema.
 */
export declare function buildPropsJsonSchema(schema: EffectiveSchema, typeKey: string, opts?: {
    relation?: boolean;
}): Record<string, unknown>;
/** Entity and item types the extractor may propose (`extractable !== false`, not deprecated). */
export declare function extractableEntityTypes(schema: EffectiveSchema): string[];
/** Relation types the extractor may propose: edges, extractable, not deprecated. */
export declare function extractableRelationTypes(schema: EffectiveSchema): string[];
