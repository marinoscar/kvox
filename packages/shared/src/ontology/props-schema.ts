// =============================================================================
// Closed `props` validation (docs/specs/ontology.md §17.1, §17.3)
// =============================================================================
//
// A `props` object may carry ONLY keys declared by the type itself, a mixin
// from an enabled domain, or the caller's own attribute definitions. An
// undeclared key is an error -- not a warning, not a silently dropped field.
// That is what keeps an extractor from inventing structure.
//
// Semantics, per key:
//   - absent            -> not set (allowed unless the attribute is required)
//   - null              -> "clear this key" on write, "not stated" on extract;
//                          never allowed for a required attribute
//   - a value           -> validated against the attribute's kind (below)
//
// Validate the WHOLE resulting props object (after merging a patch), so a
// required attribute is checked for presence as well as for null.
//
// Purposes:
//   - 'write'   every attribute, INCLUDING deprecated ones, so a value stored
//               before a deprecation round-trips. A deprecated attribute is
//               never required.
//   - 'extract' only extractable, non-deprecated attributes -- exactly the set
//               `buildPropsJsonSchema()` hands the model.
//
// Kinds: text 1..2000 chars (trimmed) · number finite · date YYYY-MM-DD ·
// boolean · select one choice value · multi_select unique choice values, <= 50
// · url http(s)://, <= 2048 · entity_ref uuid. `list: true` wraps the kind in
// an array of <= 50.
// =============================================================================

import { z } from 'zod';

import { PROPS_LIMITS } from './constants.js';
import { effectiveAttributesOf, lookupEffectiveType } from './effective-schema.js';
import type { EffectiveAttribute, EffectiveSchema, PropsIssue, ValidatePropsResult } from './types.js';

export interface BuildPropsSchemaOptions {
  purpose: 'write' | 'extract';
  /** true: `typeKey` names a relation type and its `props` are validated. */
  relation?: boolean;
}

const HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

type ZodAny = z.ZodType<unknown>;

/** An `error` map that says "required" for a missing/null value, else `fallback`. */
function kindError(fallback: string) {
  return (issue: { input?: unknown }) =>
    issue.input === undefined ? 'is required' : issue.input === null ? 'is required and may not be null' : fallback;
}

function choiceValues(attr: EffectiveAttribute): string[] {
  return (attr.options?.choices ?? []).map((c) => c.value);
}

function enumOf(values: string[]): ZodAny {
  if (values.length === 0) {
    return z.never({ error: 'has no choices defined, so no value is accepted' });
  }
  return z.enum(values as [string, ...string[]], { error: kindError(`must be one of: ${values.join(', ')}`) });
}

/** The Zod schema for ONE value of `attr.kind` (before `list` wrapping / nullability). */
function kindSchema(attr: EffectiveAttribute): ZodAny {
  switch (attr.kind) {
    case 'text':
      return z
        .string({ error: kindError('must be text') })
        .trim()
        .min(1, { error: 'must not be empty' })
        .max(PROPS_LIMITS.textMaxLength, { error: `must be at most ${PROPS_LIMITS.textMaxLength} characters` });
    case 'number':
      return z.number({ error: kindError('must be a finite number') });
    case 'date':
      return z.iso.date({ error: kindError('must be a date in YYYY-MM-DD form') });
    case 'boolean':
      return z.boolean({ error: kindError('must be true or false') });
    case 'select':
      return enumOf(choiceValues(attr));
    case 'multi_select': {
      const values = choiceValues(attr);
      return z
        .array(enumOf(values), { error: kindError('must be a list of choice values') })
        .max(PROPS_LIMITS.listMaxItems, { error: `must have at most ${PROPS_LIMITS.listMaxItems} values` })
        .refine((arr) => new Set(arr).size === arr.length, { error: 'must not repeat a value' });
    }
    case 'url':
      return z
        .string({ error: kindError('must be an http(s) URL') })
        .max(PROPS_LIMITS.urlMaxLength, { error: `must be at most ${PROPS_LIMITS.urlMaxLength} characters` })
        .regex(HTTP_URL_PATTERN, { error: 'must be an http:// or https:// URL' });
    case 'entity_ref':
      return z.uuid({ error: kindError('must be an entity id (uuid)') });
  }
}

function valueSchema(attr: EffectiveAttribute, required: boolean): ZodAny {
  let schema = kindSchema(attr);
  if (attr.list) {
    schema = z
      .array(schema, { error: kindError('must be a list') })
      .max(PROPS_LIMITS.listMaxItems, { error: `must have at most ${PROPS_LIMITS.listMaxItems} items` });
  }
  return required ? schema : schema.nullable().optional();
}

/** The attributes a purpose admits, in effective-schema order. */
export function attributesForPurpose(
  attributes: readonly EffectiveAttribute[],
  purpose: 'write' | 'extract',
): EffectiveAttribute[] {
  return purpose === 'write' ? [...attributes] : attributes.filter((a) => a.extractable && !a.deprecated);
}

/**
 * The closed Zod schema for one type's `props`. Throws when `typeKey` is not
 * in the effective schema (a caller bug, not user input).
 */
export function buildPropsSchema(
  schema: EffectiveSchema,
  typeKey: string,
  opts: BuildPropsSchemaOptions,
): z.ZodType<Record<string, unknown>> {
  const relation = opts.relation === true;
  const type = lookupEffectiveType(schema, typeKey, relation);
  if (!type) {
    throw new Error(`Unknown ${relation ? 'relation' : 'entity'} type '${typeKey}' in this effective schema`);
  }
  const shape: Record<string, ZodAny> = {};
  for (const attr of attributesForPurpose(effectiveAttributesOf(type), opts.purpose)) {
    shape[attr.key] = valueSchema(attr, attr.required && !attr.deprecated);
  }
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `undeclared attribute on ${typeKey} (props are closed)`
        : `props for ${typeKey} must be an object`,
  }) as unknown as z.ZodType<Record<string, unknown>>;
}

function toIssues(typeKey: string, error: z.ZodError): PropsIssue[] {
  const issues: PropsIssue[] = [];
  for (const issue of error.issues) {
    const base = issue.path.map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const path = base ? `${base}.${key}` : key;
        issues.push({ path, message: `${typeKey}.${path}: undeclared attribute (props are closed)` });
      }
      continue;
    }
    issues.push({ path: base, message: base ? `${typeKey}.${base}: ${issue.message}` : `${typeKey}: ${issue.message}` });
  }
  return issues;
}

/**
 * Validates a whole `props` object for a write (create, or the merged result
 * of a patch). Never throws: an unknown type is reported as an issue at the
 * root path.
 */
export function validateProps(
  schema: EffectiveSchema,
  typeKey: string,
  props: unknown,
  opts?: { relation?: boolean },
): ValidatePropsResult {
  const relation = opts?.relation === true;
  if (!lookupEffectiveType(schema, typeKey, relation)) {
    return {
      ok: false,
      issues: [{ path: '', message: `Unknown ${relation ? 'relation' : 'entity'} type '${typeKey}' in this effective schema` }],
    };
  }
  const result = buildPropsSchema(schema, typeKey, { purpose: 'write', relation }).safeParse(props);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: toIssues(typeKey, result.error) };
}
