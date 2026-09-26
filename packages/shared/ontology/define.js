"use strict";
// =============================================================================
// The definition factories: `defineEntityType`, `defineRelationType`,
// `defineDomain` (docs/specs/ontology.md §17.1).
//
// Every check here runs when a domain module is LOADED, so a malformed
// declaration fails the first `require('@app/shared/ontology')` — in every API
// test, every web test and at API boot — rather than surfacing later as a
// strange extraction prompt. Cross-type checks (dangling endpoints, duplicate
// keys across modules, mixin targets) need every module at once and live in
// `registry.ts`.
//
// Each factory returns a deep-frozen COPY: a consumer mutating a spec it was
// handed can never change what another consumer reads.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.OntologyDefinitionError = void 0;
exports.checkAttributeOptions = checkAttributeOptions;
exports.defineEntityType = defineEntityType;
exports.defineRelationType = defineRelationType;
exports.defineDomain = defineDomain;
const constants_js_1 = require("./constants.js");
/** Thrown for any ontology declaration that breaks a definition rule. */
class OntologyDefinitionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OntologyDefinitionError';
    }
}
exports.OntologyDefinitionError = OntologyDefinitionError;
const REPRESENTATION_KINDS = ['edge', 'item_column', 'speaker_link', 'mention', 'evidence', 'supersedes'];
const ITEM_COLUMNS = ['subject_id', 'owner_person_id', 'counterparty_id', 'meeting_id'];
function fail(where, rule) {
    throw new OntologyDefinitionError(`${where}: ${rule}`);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function requireText(where, field, value) {
    if (!isNonEmptyString(value))
        fail(where, `${field} must be a non-empty string`);
}
function includes(list, value) {
    return typeof value === 'string' && list.includes(value);
}
/** Validates per-kind options; shared with user attribute defs. */
function checkAttributeOptions(where, kind, options) {
    if (kind === 'select' || kind === 'multi_select') {
        const choices = options?.choices;
        if (!Array.isArray(choices) || choices.length === 0) {
            fail(where, `a ${kind} attribute must declare at least one choice`);
        }
        const seen = new Set();
        for (const choice of choices) {
            if (!isNonEmptyString(choice?.value))
                fail(where, 'every choice needs a non-empty value');
            if (!isNonEmptyString(choice?.label))
                fail(where, `choice '${choice.value}' needs a non-empty label`);
            if (seen.has(choice.value))
                fail(where, `choice value '${choice.value}' is declared twice`);
            seen.add(choice.value);
        }
    }
    else if (options?.choices !== undefined) {
        fail(where, `choices are only valid on select/multi_select, not ${kind}`);
    }
    if (options?.targetTypes !== undefined) {
        if (kind !== 'entity_ref')
            fail(where, `targetTypes are only valid on entity_ref, not ${kind}`);
        if (!Array.isArray(options.targetTypes) || options.targetTypes.length === 0) {
            fail(where, 'targetTypes, when given, must be a non-empty list');
        }
        for (const t of options.targetTypes) {
            if (!constants_js_1.ENTITY_TYPE_KEY_PATTERN.test(t))
                fail(where, `target type '${t}' is not a type key`);
        }
    }
}
function checkAttributes(owner, attributes, field) {
    if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
        fail(owner, `${field} must be an object (use {} for none)`);
    }
    for (const [key, spec] of Object.entries(attributes)) {
        const where = `${owner}.${key}`;
        if (key.startsWith(constants_js_1.USER_ATTRIBUTE_KEY_PREFIX)) {
            fail(where, `attribute keys may not start with '${constants_js_1.USER_ATTRIBUTE_KEY_PREFIX}' (reserved for user attributes)`);
        }
        if (!constants_js_1.ATTRIBUTE_KEY_PATTERN.test(key))
            fail(where, `attribute key must match ${constants_js_1.ATTRIBUTE_KEY_PATTERN}`);
        if (spec === null || typeof spec !== 'object')
            fail(where, 'attribute spec must be an object');
        if (!includes(constants_js_1.ATTRIBUTE_KINDS, spec.kind)) {
            fail(where, `kind must be one of ${constants_js_1.ATTRIBUTE_KINDS.join(', ')} (got ${String(spec.kind)})`);
        }
        requireText(where, 'label', spec.label);
        requireText(where, 'description', spec.description);
        if (spec.sensitivity !== undefined && !includes(constants_js_1.SENSITIVITIES, spec.sensitivity)) {
            fail(where, `sensitivity must be one of ${constants_js_1.SENSITIVITIES.join(', ')}`);
        }
        if (spec.kind === 'multi_select' && spec.list) {
            fail(where, 'multi_select is already a list; do not also set list: true');
        }
        checkAttributeOptions(where, spec.kind, spec.options);
        if (spec.deprecated !== undefined)
            checkDeprecation(where, spec.deprecated);
    }
}
function checkDeprecation(where, deprecated) {
    requireText(where, 'deprecated.since', deprecated?.since);
    requireText(where, 'deprecated.reason', deprecated?.reason);
}
function checkDomain(where, domain) {
    if (!includes(constants_js_1.DOMAIN_KEYS, domain))
        fail(where, `domain must be one of ${constants_js_1.DOMAIN_KEYS.join(', ')}`);
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value))
            deepFreeze(child);
    }
    return value;
}
/** A structural deep copy of plain declaration data (no functions, no dates). */
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function defineEntityType(spec) {
    const key = spec?.key;
    const where = `entity type ${String(key)}`;
    if (typeof key !== 'string' || !constants_js_1.ENTITY_TYPE_KEY_PATTERN.test(key)) {
        fail(where, `key must match ${constants_js_1.ENTITY_TYPE_KEY_PATTERN}`);
    }
    checkDomain(where, spec.domain);
    requireText(where, 'label', spec.label);
    requireText(where, 'pluralLabel', spec.pluralLabel);
    requireText(where, 'description', spec.description);
    if (!Array.isArray(spec.disambiguation) || spec.disambiguation.length === 0) {
        fail(where, 'at least one disambiguation rule is required');
    }
    spec.disambiguation.forEach((rule, i) => requireText(where, `disambiguation[${i}]`, rule));
    if (!includes(constants_js_1.SENSITIVITIES, spec.sensitivityDefault)) {
        fail(where, `sensitivityDefault must be one of ${constants_js_1.SENSITIVITIES.join(', ')}`);
    }
    checkAttributes(where, spec.attributes, 'attributes');
    if (spec.itemKind !== undefined) {
        if (!includes(constants_js_1.ITEM_KINDS, spec.itemKind))
            fail(where, `itemKind must be one of ${constants_js_1.ITEM_KINDS.join(', ')}`);
        if (!Array.isArray(spec.statuses) || spec.statuses.length === 0) {
            fail(where, 'an item type must declare at least one status');
        }
        if (new Set(spec.statuses).size !== spec.statuses.length)
            fail(where, 'statuses must be unique');
        spec.statuses.forEach((s, i) => requireText(where, `statuses[${i}]`, s));
        if (!Array.isArray(spec.subjectTypes) || spec.subjectTypes.length === 0) {
            fail(where, 'an item type must declare at least one subject type');
        }
        for (const t of spec.subjectTypes) {
            if (!constants_js_1.ENTITY_TYPE_KEY_PATTERN.test(t))
                fail(where, `subject type '${t}' is not a type key`);
        }
    }
    else if (spec.statuses !== undefined || spec.subjectTypes !== undefined || spec.subjectRequired !== undefined) {
        fail(where, 'statuses/subjectTypes/subjectRequired are only valid on item types (set itemKind)');
    }
    if (spec.deprecated !== undefined)
        checkDeprecation(where, spec.deprecated);
    return deepFreeze(clone(spec));
}
function defineRelationType(spec) {
    const key = spec?.key;
    const where = `relation type ${String(key)}`;
    if (typeof key !== 'string' || !constants_js_1.RELATION_TYPE_KEY_PATTERN.test(key)) {
        fail(where, `key must match ${constants_js_1.RELATION_TYPE_KEY_PATTERN}`);
    }
    checkDomain(where, spec.domain);
    requireText(where, 'label', spec.label);
    requireText(where, 'description', spec.description);
    for (const side of ['from', 'to']) {
        const list = spec[side];
        if (!Array.isArray(list) || list.length === 0)
            fail(where, `${side} must list at least one endpoint type`);
        for (const t of list) {
            if (!constants_js_1.ENTITY_TYPE_KEY_PATTERN.test(t))
                fail(where, `${side} endpoint '${t}' is not a type key`);
        }
        if (new Set(list).size !== list.length)
            fail(where, `${side} lists an endpoint twice`);
    }
    if (spec.allowedPairs !== undefined) {
        if (!Array.isArray(spec.allowedPairs) || spec.allowedPairs.length === 0) {
            fail(where, 'allowedPairs, when given, must be a non-empty list');
        }
        for (const pair of spec.allowedPairs) {
            if (!Array.isArray(pair) || pair.length !== 2)
                fail(where, 'every allowed pair is a [from, to] tuple');
            if (!spec.from.includes(pair[0]) || !spec.to.includes(pair[1])) {
                fail(where, `allowed pair [${pair.join(', ')}] is not within from × to`);
            }
        }
    }
    if (typeof spec.temporal !== 'boolean')
        fail(where, 'temporal must be a boolean');
    if (spec.exclusive !== 'soft' && spec.exclusive !== 'none')
        fail(where, "exclusive must be 'soft' or 'none'");
    if (spec.exclusive === 'soft' && !spec.temporal)
        fail(where, "exclusive: 'soft' requires temporal: true");
    if (spec.exclusiveScope !== undefined && spec.exclusiveScope !== 'from' && spec.exclusiveScope !== 'from_to') {
        fail(where, "exclusiveScope must be 'from' or 'from_to'");
    }
    if (spec.exclusiveScope !== undefined && spec.exclusive !== 'soft') {
        fail(where, "exclusiveScope only applies to exclusive: 'soft'");
    }
    const rep = spec.representation;
    if (rep === null || typeof rep !== 'object' || !REPRESENTATION_KINDS.includes(rep.kind)) {
        fail(where, `representation.kind must be one of ${REPRESENTATION_KINDS.join(', ')}`);
    }
    if (rep.kind === 'item_column' && !ITEM_COLUMNS.includes(rep.column)) {
        fail(where, `representation.column must be one of ${ITEM_COLUMNS.join(', ')}`);
    }
    if (spec.temporal && rep.kind !== 'edge')
        fail(where, "a temporal relation must be represented as an 'edge'");
    if (typeof spec.extractable !== 'boolean')
        fail(where, 'extractable must be a boolean');
    if (spec.extractable && rep.kind !== 'edge')
        fail(where, "only an 'edge' relation can be extractable");
    checkAttributes(where, spec.props, 'props');
    if (spec.deprecated !== undefined)
        checkDeprecation(where, spec.deprecated);
    return deepFreeze(clone(spec));
}
function defineDomain(mod) {
    const where = `domain ${String(mod?.key)}`;
    checkDomain(where, mod?.key);
    requireText(where, 'label', mod.label);
    if (typeof mod.alwaysOn !== 'boolean' || typeof mod.defaultEnabled !== 'boolean') {
        fail(where, 'alwaysOn and defaultEnabled must be booleans');
    }
    if (mod.alwaysOn && !mod.defaultEnabled)
        fail(where, 'an always-on domain must also be enabled by default');
    if (!Array.isArray(mod.entityTypes) || !Array.isArray(mod.relationTypes) || !Array.isArray(mod.mixins)) {
        fail(where, 'entityTypes, relationTypes and mixins must be arrays');
    }
    // Re-run the factories: a module may be handed raw specs, and this is
    // idempotent for already-defined ones.
    const entityTypes = mod.entityTypes.map((t) => defineEntityType(t));
    const relationTypes = mod.relationTypes.map((r) => defineRelationType(r));
    for (const t of entityTypes) {
        if (t.domain !== mod.key)
            fail(`entity type ${t.key}`, `declared in domain '${mod.key}' but names '${t.domain}'`);
    }
    for (const r of relationTypes) {
        if (r.domain !== mod.key)
            fail(`relation type ${r.key}`, `declared in domain '${mod.key}' but names '${r.domain}'`);
    }
    for (const mixin of mod.mixins) {
        if (typeof mixin?.entityType !== 'string' || !constants_js_1.ENTITY_TYPE_KEY_PATTERN.test(mixin.entityType)) {
            fail(where, `mixin target '${String(mixin?.entityType)}' is not a type key`);
        }
        checkAttributes(`${where} mixin on ${mixin.entityType}`, mixin.attributes, 'attributes');
    }
    return deepFreeze({ ...clone(mod), entityTypes, relationTypes });
}
