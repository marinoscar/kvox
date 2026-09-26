"use strict";
// =============================================================================
// The ontology registry (docs/specs/ontology.md §17.2)
// =============================================================================
//
// `buildOntologyRegistry()` assembles domain modules into one lookup and
// runs every check that needs all modules at once: duplicate domain or type
// keys, endpoints naming a type no module declares, mixins onto a type that
// does not exist or colliding with an attribute already there, subject and
// target types that do not resolve.
//
// WHY THE DOMAIN LIST IS EXPLICIT (and not self-registration by import side
// effect, as spec §17.2 first sketched): this is a CommonJS package that
// Vite pre-bundles for the web app and Jest `require`s for the API. Whether a
// module's side effect has run before the registry is read would then depend
// on which bundler loaded it and in what order. One line per domain in the
// `ONTOLOGY` call below keeps adding a domain a one-line change, with an
// order every consumer sees identically.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.ONTOLOGY = void 0;
exports.buildOntologyRegistry = buildOntologyRegistry;
const constants_js_1 = require("./constants.js");
const define_js_1 = require("./define.js");
const core_js_1 = require("./domains/core.js");
const work_js_1 = require("./domains/work.js");
const version_js_1 = require("./version.js");
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function fail(message) {
    throw new define_js_1.OntologyDefinitionError(message);
}
function assertTargetTypes(owner, attributes, entityKeys) {
    for (const [key, spec] of Object.entries(attributes)) {
        for (const target of spec.options?.targetTypes ?? []) {
            if (!entityKeys.has(target))
                fail(`${owner}.${key}: entity_ref target type '${target}' is not a registered entity type`);
        }
    }
}
/**
 * Builds a registry from domain modules. Throws `OntologyDefinitionError` on
 * a duplicate key, an unknown domain, or a dangling endpoint. Tests use it to
 * build deliberately broken registries; production code reads `ONTOLOGY`.
 */
function buildOntologyRegistry(mods, version) {
    if (!SEMVER_PATTERN.test(version))
        fail(`Ontology version '${version}' is not semver (MAJOR.MINOR.PATCH)`);
    const domainKeys = new Set();
    const entities = new Map();
    const relations = new Map();
    for (const mod of mods) {
        if (domainKeys.has(mod.key))
            fail(`Duplicate domain module '${mod.key}'`);
        domainKeys.add(mod.key);
        for (const type of mod.entityTypes) {
            if (type.domain !== mod.key)
                fail(`${type.key}: listed in domain '${mod.key}' but declares domain '${type.domain}'`);
            if (entities.has(type.key))
                fail(`Duplicate entity type key '${type.key}'`);
            entities.set(type.key, type);
        }
        for (const rel of mod.relationTypes) {
            if (rel.domain !== mod.key)
                fail(`${rel.key}: listed in domain '${mod.key}' but declares domain '${rel.domain}'`);
            if (relations.has(rel.key))
                fail(`Duplicate relation type key '${rel.key}'`);
            relations.set(rel.key, rel);
        }
    }
    const entityKeys = new Set(entities.keys());
    const pseudo = new Set(constants_js_1.PSEUDO_TYPES);
    for (const key of entityKeys) {
        if (pseudo.has(key))
            fail(`${key}: entity type key collides with a pseudo-type`);
    }
    for (const type of entities.values()) {
        for (const subject of type.subjectTypes ?? []) {
            if (!entityKeys.has(subject))
                fail(`${type.key}: subject type '${subject}' is not a registered entity type`);
        }
        assertTargetTypes(type.key, type.attributes, entityKeys);
    }
    for (const rel of relations.values()) {
        const pseudoAllowed = ['speaker_link', 'mention', 'evidence'].includes(rel.representation.kind);
        for (const endpoint of [...rel.from, ...rel.to]) {
            if (entityKeys.has(endpoint))
                continue;
            if (pseudo.has(endpoint)) {
                if (!pseudoAllowed) {
                    fail(`${rel.key}: pseudo-type '${endpoint}' may only be an endpoint of a speaker_link, mention or evidence relation`);
                }
                continue;
            }
            fail(`${rel.key}: endpoint '${endpoint}' is neither a registered entity type nor a pseudo-type (dangling endpoint)`);
        }
        assertTargetTypes(rel.key, rel.props, entityKeys);
    }
    // Mixins: onto an existing type, never shadowing a base or another mixin's key.
    const attributeOwners = new Map();
    for (const type of entities.values()) {
        for (const key of Object.keys(type.attributes))
            attributeOwners.set(`${type.key}.${key}`, `base ${type.key}`);
    }
    for (const mod of mods) {
        for (const mixin of mod.mixins) {
            if (!entityKeys.has(mixin.entityType))
                fail(`Mixin from '${mod.key}' targets unknown entity type '${mixin.entityType}'`);
            for (const key of Object.keys(mixin.attributes)) {
                const name = `${mixin.entityType}.${key}`;
                const existing = attributeOwners.get(name);
                if (existing !== undefined)
                    fail(`${name}: mixin from '${mod.key}' collides with an attribute declared by ${existing}`);
                attributeOwners.set(name, `the '${mod.key}' mixin`);
            }
            assertTargetTypes(mixin.entityType, mixin.attributes, entityKeys);
        }
    }
    const domainList = (0, define_js_1.deepFreeze)([...mods]);
    const entityList = Object.freeze([...entities.values()]);
    const relationList = Object.freeze([...relations.values()]);
    return Object.freeze({
        version,
        domains: () => domainList,
        entityType: (key) => entities.get(key),
        relationType: (key) => relations.get(key),
        entityTypes: () => entityList,
        relationTypes: () => relationList,
    });
}
/** The shipped ontology: `core` + `work`. `personal` (#383) is one more line here. */
exports.ONTOLOGY = buildOntologyRegistry([core_js_1.coreDomain, work_js_1.workDomain], version_js_1.ONTOLOGY_VERSION);
