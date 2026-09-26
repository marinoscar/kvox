import { z } from 'zod';
import type { EffectiveAttribute, EffectiveSchema, ValidatePropsResult } from './types.js';
export interface BuildPropsSchemaOptions {
    purpose: 'write' | 'extract';
    /** true: `typeKey` names a relation type and its `props` are validated. */
    relation?: boolean;
}
/** The attributes a purpose admits, in effective-schema order. */
export declare function attributesForPurpose(attributes: readonly EffectiveAttribute[], purpose: 'write' | 'extract'): EffectiveAttribute[];
/**
 * The closed Zod schema for one type's `props`. Throws when `typeKey` is not
 * in the effective schema (a caller bug, not user input).
 */
export declare function buildPropsSchema(schema: EffectiveSchema, typeKey: string, opts: BuildPropsSchemaOptions): z.ZodType<Record<string, unknown>>;
/**
 * Validates a whole `props` object for a write (create, or the merged result
 * of a patch). Never throws: an unknown type is reported as an issue at the
 * root path.
 */
export declare function validateProps(schema: EffectiveSchema, typeKey: string, props: unknown, opts?: {
    relation?: boolean;
}): ValidatePropsResult;
