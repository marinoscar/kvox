"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.attributesForPurpose = attributesForPurpose;
exports.buildPropsSchema = buildPropsSchema;
exports.validateProps = validateProps;
const zod_1 = require("zod");
const constants_js_1 = require("./constants.js");
const effective_schema_js_1 = require("./effective-schema.js");
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#]+[^\s]*$/i;
/** An `error` map that says "required" for a missing/null value, else `fallback`. */
function kindError(fallback) {
    return (issue) => issue.input === undefined ? 'is required' : issue.input === null ? 'is required and may not be null' : fallback;
}
function choiceValues(attr) {
    return (attr.options?.choices ?? []).map((c) => c.value);
}
function enumOf(values) {
    if (values.length === 0) {
        return zod_1.z.never({ error: 'has no choices defined, so no value is accepted' });
    }
    return zod_1.z.enum(values, { error: kindError(`must be one of: ${values.join(', ')}`) });
}
/** The Zod schema for ONE value of `attr.kind` (before `list` wrapping / nullability). */
function kindSchema(attr) {
    switch (attr.kind) {
        case 'text':
            return zod_1.z
                .string({ error: kindError('must be text') })
                .trim()
                .min(1, { error: 'must not be empty' })
                .max(constants_js_1.PROPS_LIMITS.textMaxLength, { error: `must be at most ${constants_js_1.PROPS_LIMITS.textMaxLength} characters` });
        case 'number':
            return zod_1.z.number({ error: kindError('must be a finite number') });
        case 'date':
            return zod_1.z.iso.date({ error: kindError('must be a date in YYYY-MM-DD form') });
        case 'boolean':
            return zod_1.z.boolean({ error: kindError('must be true or false') });
        case 'select':
            return enumOf(choiceValues(attr));
        case 'multi_select': {
            const values = choiceValues(attr);
            return zod_1.z
                .array(enumOf(values), { error: kindError('must be a list of choice values') })
                .max(constants_js_1.PROPS_LIMITS.listMaxItems, { error: `must have at most ${constants_js_1.PROPS_LIMITS.listMaxItems} values` })
                .refine((arr) => new Set(arr).size === arr.length, { error: 'must not repeat a value' });
        }
        case 'url':
            return zod_1.z
                .string({ error: kindError('must be an http(s) URL') })
                .max(constants_js_1.PROPS_LIMITS.urlMaxLength, { error: `must be at most ${constants_js_1.PROPS_LIMITS.urlMaxLength} characters` })
                .regex(HTTP_URL_PATTERN, { error: 'must be an http:// or https:// URL' });
        case 'entity_ref':
            return zod_1.z.uuid({ error: kindError('must be an entity id (uuid)') });
    }
}
function valueSchema(attr, required) {
    let schema = kindSchema(attr);
    if (attr.list) {
        schema = zod_1.z
            .array(schema, { error: kindError('must be a list') })
            .max(constants_js_1.PROPS_LIMITS.listMaxItems, { error: `must have at most ${constants_js_1.PROPS_LIMITS.listMaxItems} items` });
    }
    return required ? schema : schema.nullable().optional();
}
/** The attributes a purpose admits, in effective-schema order. */
function attributesForPurpose(attributes, purpose) {
    return purpose === 'write' ? [...attributes] : attributes.filter((a) => a.extractable && !a.deprecated);
}
/**
 * The closed Zod schema for one type's `props`. Throws when `typeKey` is not
 * in the effective schema (a caller bug, not user input).
 */
function buildPropsSchema(schema, typeKey, opts) {
    const relation = opts.relation === true;
    const type = (0, effective_schema_js_1.lookupEffectiveType)(schema, typeKey, relation);
    if (!type) {
        throw new Error(`Unknown ${relation ? 'relation' : 'entity'} type '${typeKey}' in this effective schema`);
    }
    const shape = {};
    for (const attr of attributesForPurpose((0, effective_schema_js_1.effectiveAttributesOf)(type), opts.purpose)) {
        shape[attr.key] = valueSchema(attr, attr.required && !attr.deprecated);
    }
    return zod_1.z.strictObject(shape, {
        error: (issue) => issue.code === 'unrecognized_keys'
            ? `undeclared attribute on ${typeKey} (props are closed)`
            : `props for ${typeKey} must be an object`,
    });
}
function toIssues(typeKey, error) {
    const issues = [];
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
function validateProps(schema, typeKey, props, opts) {
    const relation = opts?.relation === true;
    if (!(0, effective_schema_js_1.lookupEffectiveType)(schema, typeKey, relation)) {
        return {
            ok: false,
            issues: [{ path: '', message: `Unknown ${relation ? 'relation' : 'entity'} type '${typeKey}' in this effective schema` }],
        };
    }
    const result = buildPropsSchema(schema, typeKey, { purpose: 'write', relation }).safeParse(props);
    if (result.success)
        return { ok: true, value: result.data };
    return { ok: false, issues: toIssues(typeKey, result.error) };
}
