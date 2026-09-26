// =============================================================================
// Strict JSON Schema building blocks for extraction (#363)
// =============================================================================
//
// `buildPropsJsonSchema()` emits the `props` object schema for one type, in
// the strict structured-output subset (#358's `assertStrictJsonSchema()`
// enforces the same rules):
//
//   - the root is `type: 'object'`; every object has
//     `additionalProperties: false` and a `required` listing EVERY property;
//   - an absent value is expressed as nullable -- `type: [T, 'null']` for a
//     scalar, `anyOf: [X, { type: 'null' }]` for an enum, array or object;
//   - only `type`, `properties`, `required`, `additionalProperties`, `items`,
//     `enum`, `anyOf` and `description` are used -- never `format`,
//     `pattern`, `minLength`, `minimum`, `const`, `$ref` or `default`. Those
//     constraints are enforced by the Zod schema (`buildPropsSchema(...,
//     { purpose: 'extract' })`) after parsing;
//   - nesting depth stays <= 5 from the props root (the deepest shape here, a
//     nullable list of enums, is 3).
//
// Only extractable, non-deprecated attributes appear. A required attribute is
// not nullable; everything else is.
// =============================================================================

import { effectiveAttributesOf, lookupEffectiveType } from './effective-schema.js';
import { attributesForPurpose } from './props-schema.js';
import type { EffectiveAttribute, EffectiveSchema } from './types.js';

type JsonSchema = Record<string, unknown>;

const NULL_SCHEMA: JsonSchema = { type: 'null' };

const KIND_HINTS: Record<string, string> = {
  date: 'A calendar date in YYYY-MM-DD form.',
  url: 'An absolute http:// or https:// URL.',
  entity_ref: 'The id (uuid) of an existing entity.',
};

function describe(attr: EffectiveAttribute): string {
  const hint = KIND_HINTS[attr.kind];
  const base = hint ? `${attr.description} ${hint}` : attr.description;
  return attr.required ? base : `${base} Null when the source does not state it.`;
}

function scalarType(kind: EffectiveAttribute['kind']): 'string' | 'number' | 'boolean' {
  if (kind === 'number') return 'number';
  if (kind === 'boolean') return 'boolean';
  return 'string';
}

/** One value of the attribute's kind, non-nullable. */
function itemSchema(attr: EffectiveAttribute): JsonSchema {
  const values = (attr.options?.choices ?? []).map((c) => c.value);
  switch (attr.kind) {
    case 'select':
      return { type: 'string', enum: values };
    case 'multi_select':
      return { type: 'array', items: { type: 'string', enum: values } };
    default:
      return { type: scalarType(attr.kind) };
  }
}

function attributeSchema(attr: EffectiveAttribute): JsonSchema {
  let value = itemSchema(attr);
  if (attr.list) value = { type: 'array', items: value };
  const description = describe(attr);
  if (attr.required) return { ...value, description };

  const isScalar = typeof value.type === 'string' && value.type !== 'array' && value.enum === undefined;
  if (isScalar) return { type: [value.type, 'null'], description };
  return { anyOf: [value, NULL_SCHEMA], description };
}

function resolve(schema: EffectiveSchema, typeKey: string, relation: boolean) {
  const type = lookupEffectiveType(schema, typeKey, relation);
  if (!type) throw new Error(`Unknown ${relation ? 'relation' : 'entity'} type '${typeKey}' in this effective schema`);
  return type;
}

/** The strict-mode `props` JSON Schema for one entity or relation type. */
export function buildPropsJsonSchema(
  schema: EffectiveSchema,
  typeKey: string,
  opts?: { relation?: boolean },
): Record<string, unknown> {
  const type = resolve(schema, typeKey, opts?.relation === true);
  const properties: Record<string, JsonSchema> = {};
  for (const attr of attributesForPurpose(effectiveAttributesOf(type), 'extract')) {
    properties[attr.key] = attributeSchema(attr);
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** Entity and item types the model may propose (Meeting and deprecated types excluded). */
export function extractableEntityTypes(schema: EffectiveSchema): string[] {
  return schema.entityTypes.filter((t) => t.extractable && !t.deprecated).map((t) => t.key);
}

/** Relation types the model may propose: extractable, non-deprecated edges. */
export function extractableRelationTypes(schema: EffectiveSchema): string[] {
  return schema.relationTypes
    .filter((r) => r.representation.kind === 'edge' && r.extractable && !r.deprecated)
    .map((r) => r.key);
}
