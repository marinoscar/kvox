"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.propsAttributes = propsAttributes;
exports.isExtractAttribute = isExtractAttribute;
exports.buildPropsSchema = buildPropsSchema;
exports.validateProps = validateProps;
const zod_1 = require("zod");
const constants_js_1 = require("./constants.js");
/**
 * The attributes a props object for `typeKey` may carry, or undefined when the
 * type is not in this effective schema.
 */
function propsAttributes(schema, typeKey, opts = {}) {
    if (opts.relation)
        return schema.relationType(typeKey)?.props;
    return schema.entityType(typeKey)?.attributes;
}
/** Whether an attribute is asked of the model: extractable and not deprecated. */
function isExtractAttribute(attr) {
    return attr.extractable && !attr.deprecated;
}
function choiceValues(attr) {
    const values = (attr.options?.choices ?? []).map((c) => c.value);
    // Guaranteed non-empty by define.ts / the user-attribute check.
    return values;
}
function scalarSchema(attr) {
    switch (attr.kind) {
        case 'text':
            return zod_1.z.string().trim().min(1, 'must not be empty').max(constants_js_1.MAX_TEXT_LENGTH);
        case 'number':
            return zod_1.z.number();
        case 'date':
            return zod_1.z.iso.date();
        case 'boolean':
            return zod_1.z.boolean();
        case 'select':
            return zod_1.z.enum(choiceValues(attr));
        case 'multi_select':
            return zod_1.z
                .array(zod_1.z.enum(choiceValues(attr)))
                .max(constants_js_1.MAX_LIST_ITEMS)
                .refine((values) => new Set(values).size === values.length, { message: 'values must be unique' });
        case 'url':
            return zod_1.z.url({ protocol: /^https?$/, message: 'must be an http(s) URL' }).max(constants_js_1.MAX_URL_LENGTH);
        case 'entity_ref':
            return zod_1.z.uuid();
    }
}
function attributeSchema(attr, purpose) {
    const value = attr.list ? zod_1.z.array(scalarSchema(attr)).max(constants_js_1.MAX_LIST_ITEMS) : scalarSchema(attr);
    if (attr.required)
        return purpose === 'extract' ? value : value.optional();
    return value.nullable().optional();
}
const cache = new WeakMap();
/**
 * A closed (strict) Zod object for one type's props, for the given purpose.
 * Throws when `typeKey` is not a type of this effective schema.
 */
function buildPropsSchema(schema, typeKey, opts) {
    const cacheKey = `${opts.relation ? 'relation' : 'entity'}:${opts.purpose}:${typeKey}`;
    let perSchema = cache.get(schema);
    const hit = perSchema?.get(cacheKey);
    if (hit !== undefined)
        return hit;
    const attributes = propsAttributes(schema, typeKey, opts);
    if (attributes === undefined) {
        throw new Error(`Unknown ${opts.relation ? 'relation' : 'entity'} type '${typeKey}' in this effective schema`);
    }
    const shape = {};
    for (const attr of attributes) {
        if (opts.purpose === 'extract' && !isExtractAttribute(attr))
            continue;
        shape[attr.key] = attributeSchema(attr, opts.purpose);
    }
    const built = zod_1.z.strictObject(shape);
    if (perSchema === undefined) {
        perSchema = new Map();
        cache.set(schema, perSchema);
    }
    perSchema.set(cacheKey, built);
    return built;
}
function toIssues(error) {
    const issues = [];
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
function validateProps(schema, typeKey, props, opts = {}) {
    if (propsAttributes(schema, typeKey, opts) === undefined) {
        return {
            ok: false,
            issues: [{ path: '', message: `Unknown ${opts.relation ? 'relation' : 'entity'} type '${typeKey}'` }],
        };
    }
    const parsed = buildPropsSchema(schema, typeKey, { purpose: 'write', relation: opts.relation }).safeParse(props);
    if (parsed.success)
        return { ok: true, value: parsed.data };
    return { ok: false, issues: toIssues(parsed.error) };
}
