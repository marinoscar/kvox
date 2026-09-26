"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPropsJsonSchema = buildPropsJsonSchema;
exports.extractableEntityTypes = extractableEntityTypes;
exports.extractableRelationTypes = extractableRelationTypes;
const props_schema_js_1 = require("./props-schema.js");
const FORMAT_HINTS = {
    date: 'Format: YYYY-MM-DD.',
    url: 'An absolute http:// or https:// URL.',
    entity_ref: 'The UUID of the referenced entity.',
};
function describe(attr) {
    const hint = FORMAT_HINTS[attr.kind];
    return hint === undefined ? attr.description : `${attr.description} (${hint})`;
}
function scalarType(attr) {
    if (attr.kind === 'number')
        return 'number';
    if (attr.kind === 'boolean')
        return 'boolean';
    return 'string';
}
function choiceValues(attr) {
    return (attr.options?.choices ?? []).map((c) => c.value);
}
/** The non-null schema of ONE item (for a list or multi_select) or of the value. */
function itemSchema(attr) {
    if (attr.kind === 'select' || attr.kind === 'multi_select')
        return { type: 'string', enum: choiceValues(attr) };
    return { type: scalarType(attr) };
}
function propertySchema(attr) {
    const description = describe(attr);
    const nullable = !attr.required;
    const isArray = attr.list || attr.kind === 'multi_select';
    if (isArray) {
        const array = { type: 'array', items: itemSchema(attr) };
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
function buildPropsJsonSchema(schema, typeKey, opts = {}) {
    const attributes = (0, props_schema_js_1.propsAttributes)(schema, typeKey, opts);
    if (attributes === undefined) {
        throw new Error(`Unknown ${opts.relation ? 'relation' : 'entity'} type '${typeKey}' in this effective schema`);
    }
    const properties = {};
    for (const attr of attributes) {
        if ((0, props_schema_js_1.isExtractAttribute)(attr))
            properties[attr.key] = propertySchema(attr);
    }
    return {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
    };
}
/** Entity and item types the extractor may propose (`extractable !== false`, not deprecated). */
function extractableEntityTypes(schema) {
    return schema.entityTypes.filter((t) => t.extractable && !t.deprecated).map((t) => t.key);
}
/** Relation types the extractor may propose: edges, extractable, not deprecated. */
function extractableRelationTypes(schema) {
    return schema.relationTypes
        .filter((r) => r.representation.kind === 'edge' && r.extractable && !r.deprecated)
        .map((r) => r.key);
}
