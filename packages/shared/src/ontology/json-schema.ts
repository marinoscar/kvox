// =============================================================================
// Strict-mode JSON Schema building blocks for extraction (docs/specs/ontology.md
// §6, §17.1). `kg.extract` composes its structured-output schema from these.
//
// The rules (the OpenAI strict subset — #358's assertStrictJsonSchema enforces
// the same ones):
//   - every object has `additionalProperties: false` and `required` lists EVERY
//     property key;
//   - an absent value is nullable: `type: [T, 'null']`, or
//     `anyOf: [X, { type: 'null' }]` for arrays;
//   - only these keywords: type, properties, required, additionalProperties,
//     items, enum, anyOf, description. Never format, pattern, minLength,
//     minimum, const, $ref or default: those constraints are enforced by the
//     Zod schema (`buildPropsSchema(..., { purpose: 'extract' })`) after
//     parsing, and the format is stated in the description instead.
//
// Built by hand rather than with `z.toJSONSchema`, so no other keyword can ever
// appear. Only extractable, non-deprecated attributes are included.
// =============================================================================

import type { EffectiveAttribute, EffectiveSchema } from './effective-schema.js';
import { isExtractAttribute, propsAttributes } from './props-schema.js';

type JsonSchema = Record<string, unknown>;

const FORMAT_HINTS: Partial<Record<EffectiveAttribute['kind'], string>> = {
  date: 'Format: YYYY-MM-DD.',
  url: 'An absolute http:// or https:// URL.',
  entity_ref: 'The UUID of the referenced entity.',
};

function describe(attr: EffectiveAttribute): string {
  const hint = FORMAT_HINTS[attr.kind];
  return hint === undefined ? attr.description : `${attr.description} (${hint})`;
}

function scalarType(attr: EffectiveAttribute): 'string' | 'number' | 'boolean' {
  if (attr.kind === 'number') return 'number';
  if (attr.kind === 'boolean') return 'boolean';
  return 'string';
}

function choiceValues(attr: EffectiveAttribute): string[] {
  return (attr.options?.choices ?? []).map((c) => c.value);
}

/** The non-null schema of ONE item (for a list or multi_select) or of the value. */
function itemSchema(attr: EffectiveAttribute): JsonSchema {
  if (attr.kind === 'select' || attr.kind === 'multi_select') return { type: 'string', enum: choiceValues(attr) };
  return { type: scalarType(attr) };
}

function propertySchema(attr: EffectiveAttribute): JsonSchema {
  const description = describe(attr);
  const nullable = !attr.required;
  const isArray = attr.list || attr.kind === 'multi_select';
  if (isArray) {
    const array: JsonSchema = { type: 'array', items: itemSchema(attr) };
    return nullable ? { anyOf: [array, { type: 'null' }], description } : { ...array, description };
  }
  if (attr.kind === 'select') {
    return nullable
      ? { type: ['string', 'null'], enum: [...choiceValues(attr), null], description }
      : { type: 'string', enum: choiceValues(attr), description };
  }
  const type = scalarType(attr);
  return { type: nullable ? [type, 'null'] : type, description };
}

/**
 * The strict JSON Schema of one type's extractable props (an object whose
 * `required` is every key). Throws when `typeKey` is not in this schema.
 */
export function buildPropsJsonSchema(
  schema: EffectiveSchema,
  typeKey: string,
  opts: { relation?: boolean } = {},
): Record<string, unknown> {
  const attributes = propsAttributes(schema, typeKey, opts);
  if (attributes === undefined) {
    throw new Error(`Unknown ${opts.relation ? 'relation' : 'entity'} type '${typeKey}' in this effective schema`);
  }
  const properties: Record<string, JsonSchema> = {};
  for (const attr of attributes) {
    if (isExtractAttribute(attr)) properties[attr.key] = propertySchema(attr);
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** Entity and item types the extractor may propose (`extractable !== false`, not deprecated). */
export function extractableEntityTypes(schema: EffectiveSchema): string[] {
  return schema.entityTypes.filter((t) => t.extractable && !t.deprecated).map((t) => t.key);
}

/** Relation types the extractor may propose: edges, extractable, not deprecated. */
export function extractableRelationTypes(schema: EffectiveSchema): string[] {
  return schema.relationTypes
    .filter((r) => r.representation.kind === 'edge' && r.extractable && !r.deprecated)
    .map((r) => r.key);
}
