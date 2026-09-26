// =============================================================================
// Closed `props` validation (docs/specs/ontology.md §17.1, §17.3).
//
// A `props` object may carry ONLY keys the effective schema declares for its
// type — built-in, mixin or the caller's own user attributes. An undeclared key
// is a validation error, never a warning and never a silently dropped field:
// an open schema is an escape hatch the extractor will eventually use.
//
// Two purposes, because the same attribute set is read two ways:
//   - `write`: every declared attribute, deprecated ones included, so values
//     already stored round-trip. `null` means "clear this key". A key may be
//     omitted (unchanged / not set); a `required` attribute may not be null.
//   - `extract`: only extractable, non-deprecated attributes — exactly the set
//     `buildPropsJsonSchema` hands the model. `null` means "not stated"; a
//     `required` attribute must be stated.
// =============================================================================

import { z } from 'zod';

import { MAX_LIST_ITEMS, MAX_TEXT_LENGTH, MAX_URL_LENGTH } from './constants.js';
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

export type ValidatePropsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: PropsIssue[] };

/**
 * The attributes a props object for `typeKey` may carry, or undefined when the
 * type is not in this effective schema.
 */
export function propsAttributes(
  schema: EffectiveSchema,
  typeKey: string,
  opts: { relation?: boolean } = {},
): readonly EffectiveAttribute[] | undefined {
  if (opts.relation) return schema.relationType(typeKey)?.props;
  return schema.entityType(typeKey)?.attributes;
}

/** Whether an attribute is asked of the model: extractable and not deprecated. */
export function isExtractAttribute(attr: EffectiveAttribute): boolean {
  return attr.extractable && !attr.deprecated;
}

function choiceValues(attr: EffectiveAttribute): [string, ...string[]] {
  const values = (attr.options?.choices ?? []).map((c) => c.value);
  // Guaranteed non-empty by define.ts / the user-attribute check.
  return values as [string, ...string[]];
}

function scalarSchema(attr: EffectiveAttribute): z.ZodType {
  switch (attr.kind) {
    case 'text':
      return z.string().trim().min(1, 'must not be empty').max(MAX_TEXT_LENGTH);
    case 'number':
      return z.number();
    case 'date':
      return z.iso.date();
    case 'boolean':
      return z.boolean();
    case 'select':
      return z.enum(choiceValues(attr));
    case 'multi_select':
      return z
        .array(z.enum(choiceValues(attr)))
        .max(MAX_LIST_ITEMS)
        .refine((values) => new Set(values).size === values.length, { message: 'values must be unique' });
    case 'url':
      return z.url({ protocol: /^https?$/, message: 'must be an http(s) URL' }).max(MAX_URL_LENGTH);
    case 'entity_ref':
      return z.uuid();
  }
}

function attributeSchema(attr: EffectiveAttribute, purpose: PropsPurpose): z.ZodType {
  const value = attr.list ? z.array(scalarSchema(attr)).max(MAX_LIST_ITEMS) : scalarSchema(attr);
  if (attr.required) return purpose === 'extract' ? value : value.optional();
  return value.nullable().optional();
}

const cache = new WeakMap<EffectiveSchema, Map<string, z.ZodType<Record<string, unknown>>>>();

/**
 * A closed (strict) Zod object for one type's props, for the given purpose.
 * Throws when `typeKey` is not a type of this effective schema.
 */
export function buildPropsSchema(
  schema: EffectiveSchema,
  typeKey: string,
  opts: BuildPropsSchemaOptions,
): z.ZodType<Record<string, unknown>> {
  const cacheKey = `${opts.relation ? 'relation' : 'entity'}:${opts.purpose}:${typeKey}`;
  let perSchema = cache.get(schema);
  const hit = perSchema?.get(cacheKey);
  if (hit !== undefined) return hit;

  const attributes = propsAttributes(schema, typeKey, opts);
  if (attributes === undefined) {
    throw new Error(`Unknown ${opts.relation ? 'relation' : 'entity'} type '${typeKey}' in this effective schema`);
  }
  const shape: Record<string, z.ZodType> = {};
  for (const attr of attributes) {
    if (opts.purpose === 'extract' && !isExtractAttribute(attr)) continue;
    shape[attr.key] = attributeSchema(attr, opts.purpose);
  }
  const built = z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;

  if (perSchema === undefined) {
    perSchema = new Map();
    cache.set(schema, perSchema);
  }
  perSchema.set(cacheKey, built);
  return built;
}

function toIssues(error: z.ZodError): PropsIssue[] {
  const issues: PropsIssue[] = [];
  for (const issue of error.issues) {
    const base = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      // One issue per undeclared key, at that key's own path.
      for (const key of issue.keys) {
        issues.push({ path: [...base, key].join('.'), message: `'${key}' is not a declared attribute of this type` });
      }
      continue;
    }
    issues.push({ path: base.join('.'), message: issue.message });
  }
  return issues;
}

/**
 * Validate a props object for WRITE (the closed schema, deprecated attributes
 * accepted). Returns the parsed value (text trimmed) or path-specific issues.
 */
export function validateProps(
  schema: EffectiveSchema,
  typeKey: string,
  props: unknown,
  opts: { relation?: boolean } = {},
): ValidatePropsResult {
  if (propsAttributes(schema, typeKey, opts) === undefined) {
    return {
      ok: false,
      issues: [{ path: '', message: `Unknown ${opts.relation ? 'relation' : 'entity'} type '${typeKey}'` }],
    };
  }
  const parsed = buildPropsSchema(schema, typeKey, { purpose: 'write', relation: opts.relation }).safeParse(props);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: toIssues(parsed.error) };
}
