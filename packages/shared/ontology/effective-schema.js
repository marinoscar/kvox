"use strict";
// =============================================================================
// The effective schema (docs/specs/ontology.md §17.2–§17.4): what ONE user's
// graph actually consists of.
//
//   core ∪ {their enabled domains}
//     + the mixins those domains add onto other domains' types
//     + their own `kg_attribute_defs` rows (passed in as plain data)
//     with every relation endpoint and item subject pruned to types present.
//
// It is computed, never hand-assembled per caller, and it is the ONLY input to
// the props validators and JSON Schema builders: a user who disabled `work`
// can never have a `work` type validated or sent to the model for them.
//
// `toEffectiveSchemaPayload` is exactly what `GET /api/graph/ontology` returns
// and what every web form renders from.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeEffectiveSchemaFor = computeEffectiveSchemaFor;
exports.toEffectiveSchemaPayload = toEffectiveSchemaPayload;
const constants_js_1 = require("./constants.js");
const define_js_1 = require("./define.js");
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value))
            deepFreeze(child);
    }
    return value;
}
function copyOptions(options) {
    if (options === null || options === undefined)
        return null;
    const out = {};
    if (options.choices !== undefined)
        out.choices = options.choices.map((c) => ({ value: c.value, label: c.label }));
    if (options.targetTypes !== undefined)
        out.targetTypes = [...options.targetTypes];
    return out;
}
function builtinAttributes(attributes, source, domain, sensitivityDefault, startAt) {
    return Object.entries(attributes).map(([key, spec], i) => ({
        key,
        label: spec.label,
        kind: spec.kind,
        required: spec.required ?? false,
        list: spec.list ?? false,
        options: copyOptions(spec.options),
        extractable: spec.extractable ?? false,
        description: spec.description,
        sensitivity: spec.sensitivity ?? sensitivityDefault,
        source,
        domain,
        attributeDefId: null,
        deprecated: spec.deprecated !== undefined,
        sortOrder: startAt + i,
    }));
}
function userAttribute(def, sensitivityDefault) {
    const hint = typeof def.extractionHint === 'string' ? def.extractionHint.trim() : '';
    return {
        key: def.key,
        label: def.label,
        kind: def.kind,
        required: false,
        list: false,
        options: copyOptions(def.options),
        extractable: def.extractable,
        description: hint.length > 0 ? hint : def.label,
        sensitivity: def.sensitivity ?? sensitivityDefault,
        source: 'user',
        domain: null,
        attributeDefId: def.id,
        deprecated: def.deprecatedAt !== null && def.deprecatedAt !== undefined,
        sortOrder: def.sortOrder,
    };
}
function checkUserAttribute(def) {
    const where = `user attribute ${String(def?.id)}`;
    const fail = (rule) => {
        throw new define_js_1.OntologyDefinitionError(`${where}: ${rule}`);
    };
    if (typeof def.id !== 'string' || def.id.length === 0)
        fail('id must be a non-empty string');
    if (typeof def.key !== 'string' || !constants_js_1.USER_ATTRIBUTE_KEY_PATTERN.test(def.key)) {
        fail(`key '${String(def.key)}' must match ${constants_js_1.USER_ATTRIBUTE_KEY_PATTERN}`);
    }
    if (typeof def.label !== 'string' || def.label.trim().length === 0)
        fail('label must be a non-empty string');
    if (!constants_js_1.ATTRIBUTE_KINDS.includes(def.kind))
        fail(`unknown kind '${String(def.kind)}'`);
    if (def.sensitivity !== null && !constants_js_1.SENSITIVITIES.includes(def.sensitivity)) {
        fail(`unknown sensitivity '${String(def.sensitivity)}'`);
    }
    if (typeof def.sortOrder !== 'number' || !Number.isFinite(def.sortOrder))
        fail('sortOrder must be a finite number');
    (0, define_js_1.checkAttributeOptions)(where, def.kind, def.options);
}
/**
 * Resolve one user's effective schema. Throws `OntologyDefinitionError` on a
 * malformed user attribute def (bad key, kind, options, or a duplicate key on
 * one type). A def whose entity type is not present — its domain is disabled,
 * or the type is unknown — is left out, not an error: disabling a domain must
 * never break the endpoint.
 */
function computeEffectiveSchemaFor(registry, input) {
    const requested = new Set(input.enabledDomains);
    const domainsInEffect = registry
        .domains()
        .filter((d) => d.alwaysOn || d.key === 'core' || requested.has(d.key));
    const enabled = new Set(domainsInEffect.map((d) => d.key));
    const presentTypes = new Set(registry
        .entityTypes()
        .filter((t) => enabled.has(t.domain))
        .map((t) => t.key));
    const endpointPresent = (key) => presentTypes.has(key) || constants_js_1.PSEUDO_TYPES.includes(key);
    const userByType = new Map();
    for (const def of input.userAttributes) {
        checkUserAttribute(def);
        if (!presentTypes.has(def.entityType))
            continue;
        const list = userByType.get(def.entityType) ?? [];
        if (list.some((d) => d.key === def.key)) {
            throw new define_js_1.OntologyDefinitionError(`user attribute ${def.id}: key '${def.key}' is declared twice on ${def.entityType}`);
        }
        list.push(def);
        userByType.set(def.entityType, list);
    }
    const entityTypes = registry
        .entityTypes()
        .filter((t) => presentTypes.has(t.key))
        .map((t) => {
        const attributes = builtinAttributes(t.attributes, 'builtin', t.domain, t.sensitivityDefault, 0);
        for (const d of domainsInEffect) {
            for (const mixin of d.mixins) {
                if (mixin.entityType !== t.key)
                    continue;
                attributes.push(...builtinAttributes(mixin.attributes, 'mixin', d.key, t.sensitivityDefault, attributes.length));
            }
        }
        const users = [...(userByType.get(t.key) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
        attributes.push(...users.map((def) => userAttribute(def, t.sensitivityDefault)));
        const isItem = t.itemKind !== undefined;
        return {
            key: t.key,
            domain: t.domain,
            label: t.label,
            pluralLabel: t.pluralLabel,
            description: t.description,
            disambiguation: [...t.disambiguation],
            storage: isItem ? 'item' : 'entity',
            itemKind: t.itemKind ?? null,
            statuses: t.statuses ? [...t.statuses] : null,
            subjectTypes: isItem ? (t.subjectTypes ?? []).filter((s) => presentTypes.has(s)) : null,
            subjectRequired: t.subjectRequired ?? false,
            sensitivityDefault: t.sensitivityDefault,
            alignment: t.alignment ?? null,
            extractable: t.extractable !== false,
            deprecated: t.deprecated !== undefined,
            attributes,
        };
    });
    const relationTypes = [];
    for (const r of registry.relationTypes()) {
        if (!enabled.has(r.domain))
            continue;
        let from = r.from.filter(endpointPresent);
        let to = r.to.filter(endpointPresent);
        let allowedPairs = null;
        if (r.allowedPairs !== undefined) {
            allowedPairs = r.allowedPairs
                .filter(([a, b]) => from.includes(a) && to.includes(b))
                .map(([a, b]) => [a, b]);
            // Narrow the endpoint lists to what some surviving pair still uses.
            from = from.filter((f) => allowedPairs.some(([a]) => a === f));
            to = to.filter((t) => allowedPairs.some(([, b]) => b === t));
            if (allowedPairs.length === 0)
                continue;
        }
        if (from.length === 0 || to.length === 0)
            continue;
        relationTypes.push({
            key: r.key,
            domain: r.domain,
            label: r.label,
            description: r.description,
            from,
            to,
            allowedPairs,
            temporal: r.temporal,
            exclusive: r.exclusive,
            exclusiveScope: r.exclusiveScope ?? 'from',
            representation: JSON.parse(JSON.stringify(r.representation)),
            extractable: r.extractable,
            alignment: r.alignment ?? null,
            deprecated: r.deprecated !== undefined,
            props: builtinAttributes(r.props, 'builtin', r.domain, 'business', 0),
        });
    }
    const domains = registry.domains().map((d) => ({
        key: d.key,
        label: d.label,
        enabled: enabled.has(d.key),
        alwaysOn: d.alwaysOn,
    }));
    deepFreeze(entityTypes);
    deepFreeze(relationTypes);
    deepFreeze(domains);
    const entityByKey = new Map(entityTypes.map((t) => [t.key, t]));
    const relationByKey = new Map(relationTypes.map((r) => [r.key, r]));
    const schema = {
        version: registry.version,
        enabledDomains: Object.freeze(domainsInEffect.map((d) => d.key)),
        domains,
        entityTypes,
        relationTypes,
        entityType: (key) => entityByKey.get(key),
        relationType: (key) => relationByKey.get(key),
    };
    return Object.freeze(schema);
}
/**
 * The JSON-safe payload `GET /api/graph/ontology` returns: a fresh, mutable,
 * plain-data copy (`JSON.parse(JSON.stringify(p))` deep-equals it).
 */
function toEffectiveSchemaPayload(schema) {
    return JSON.parse(JSON.stringify({
        version: schema.version,
        domains: schema.domains,
        entityTypes: schema.entityTypes,
        relationTypes: schema.relationTypes,
    }));
}
