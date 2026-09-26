import { z } from 'zod';
import type { EffectiveAttribute, EffectiveSchema } from './effective-schema.js';
export type PropsPurpose = 'write' | 'extract';
export interface BuildPropsSchemaOptions {
    purpose: PropsPurpose;
    /** When true, `typeKey` names a relation type and its `props` are used. */
    relation?: boolean;
}
export interface PropsIssue {
    /** Dotted path into the props object (`'topics.2'`); `''` for the object itself. */
    path: string;
    message: string;
}
export type ValidatePropsResult = {
    ok: true;
    value: Record<string, unknown>;
} | {
    ok: false;
    issues: PropsIssue[];
};
/**
 * The attributes a props object for `typeKey` may carry, or undefined when the
 * type is not in this effective schema.
 */
export declare function propsAttributes(schema: EffectiveSchema, typeKey: string, opts?: {
    relation?: boolean;
}): readonly EffectiveAttribute[] | undefined;
/** Whether an attribute is asked of the model: extractable and not deprecated. */
export declare function isExtractAttribute(attr: EffectiveAttribute): boolean;
/**
 * A closed (strict) Zod object for one type's props, for the given purpose.
 * Throws when `typeKey` is not a type of this effective schema.
 */
export declare function buildPropsSchema(schema: EffectiveSchema, typeKey: string, opts: BuildPropsSchemaOptions): z.ZodType<Record<string, unknown>>;
/**
 * Validate a props object for WRITE (the closed schema, deprecated attributes
 * accepted). Returns the parsed value (text trimmed) or path-specific issues.
 */
export declare function validateProps(schema: EffectiveSchema, typeKey: string, props: unknown, opts?: {
    relation?: boolean;
}): ValidatePropsResult;
