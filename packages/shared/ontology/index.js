"use strict";
// =============================================================================
// `@app/shared/ontology` — the ontology definition (docs/specs/ontology.md §17).
//
// Sources: packages/shared/src/ontology/**/*.ts. Compiled, committed output:
// packages/shared/ontology/. Rebuild with
// `npm run build:ontology --workspace=@app/shared` after any source edit; CI
// fails when the committed output is stale.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.ONTOLOGY = exports.extractableRelationTypes = exports.extractableEntityTypes = exports.buildPropsJsonSchema = exports.validateProps = exports.buildPropsSchema = exports.toEffectiveSchemaPayload = exports.buildOntologyRegistry = exports.SHIPPED_KEYS = exports.ONTOLOGY_VERSION = exports.CHANGELOG = exports.OntologyDefinitionError = exports.defineRelationType = exports.defineEntityType = exports.defineDomain = exports.VALID_PRECISIONS = exports.USER_ATTRIBUTE_KEY_PREFIX = exports.SENSITIVITIES = exports.PSEUDO_TYPES = exports.ITEM_KINDS = exports.DOMAIN_KEYS = exports.DEFAULT_ENABLED_DOMAINS = exports.ATTRIBUTE_KINDS = void 0;
exports.computeEffectiveSchema = computeEffectiveSchema;
var constants_js_1 = require("./constants.js");
Object.defineProperty(exports, "ATTRIBUTE_KINDS", { enumerable: true, get: function () { return constants_js_1.ATTRIBUTE_KINDS; } });
Object.defineProperty(exports, "DEFAULT_ENABLED_DOMAINS", { enumerable: true, get: function () { return constants_js_1.DEFAULT_ENABLED_DOMAINS; } });
Object.defineProperty(exports, "DOMAIN_KEYS", { enumerable: true, get: function () { return constants_js_1.DOMAIN_KEYS; } });
Object.defineProperty(exports, "ITEM_KINDS", { enumerable: true, get: function () { return constants_js_1.ITEM_KINDS; } });
Object.defineProperty(exports, "PSEUDO_TYPES", { enumerable: true, get: function () { return constants_js_1.PSEUDO_TYPES; } });
Object.defineProperty(exports, "SENSITIVITIES", { enumerable: true, get: function () { return constants_js_1.SENSITIVITIES; } });
Object.defineProperty(exports, "USER_ATTRIBUTE_KEY_PREFIX", { enumerable: true, get: function () { return constants_js_1.USER_ATTRIBUTE_KEY_PREFIX; } });
Object.defineProperty(exports, "VALID_PRECISIONS", { enumerable: true, get: function () { return constants_js_1.VALID_PRECISIONS; } });
var define_js_1 = require("./define.js");
Object.defineProperty(exports, "defineDomain", { enumerable: true, get: function () { return define_js_1.defineDomain; } });
Object.defineProperty(exports, "defineEntityType", { enumerable: true, get: function () { return define_js_1.defineEntityType; } });
Object.defineProperty(exports, "defineRelationType", { enumerable: true, get: function () { return define_js_1.defineRelationType; } });
Object.defineProperty(exports, "OntologyDefinitionError", { enumerable: true, get: function () { return define_js_1.OntologyDefinitionError; } });
var version_js_1 = require("./version.js");
Object.defineProperty(exports, "CHANGELOG", { enumerable: true, get: function () { return version_js_1.CHANGELOG; } });
Object.defineProperty(exports, "ONTOLOGY_VERSION", { enumerable: true, get: function () { return version_js_1.ONTOLOGY_VERSION; } });
var shipped_keys_js_1 = require("./shipped-keys.js");
Object.defineProperty(exports, "SHIPPED_KEYS", { enumerable: true, get: function () { return shipped_keys_js_1.SHIPPED_KEYS; } });
var registry_js_1 = require("./registry.js");
Object.defineProperty(exports, "buildOntologyRegistry", { enumerable: true, get: function () { return registry_js_1.buildOntologyRegistry; } });
var effective_schema_js_1 = require("./effective-schema.js");
Object.defineProperty(exports, "toEffectiveSchemaPayload", { enumerable: true, get: function () { return effective_schema_js_1.toEffectiveSchemaPayload; } });
var props_schema_js_1 = require("./props-schema.js");
Object.defineProperty(exports, "buildPropsSchema", { enumerable: true, get: function () { return props_schema_js_1.buildPropsSchema; } });
Object.defineProperty(exports, "validateProps", { enumerable: true, get: function () { return props_schema_js_1.validateProps; } });
var json_schema_js_1 = require("./json-schema.js");
Object.defineProperty(exports, "buildPropsJsonSchema", { enumerable: true, get: function () { return json_schema_js_1.buildPropsJsonSchema; } });
Object.defineProperty(exports, "extractableEntityTypes", { enumerable: true, get: function () { return json_schema_js_1.extractableEntityTypes; } });
Object.defineProperty(exports, "extractableRelationTypes", { enumerable: true, get: function () { return json_schema_js_1.extractableRelationTypes; } });
// -----------------------------------------------------------------------------
// The domain modules, listed EXPLICITLY — never self-registered by import side
// effect (registration order under Vite pre-bundling vs Jest `require` is not
// something to depend on). Adding a domain is one import and one entry here.
// -----------------------------------------------------------------------------
const core_js_1 = require("./domains/core.js");
const work_js_1 = require("./domains/work.js");
const registry_js_2 = require("./registry.js");
const version_js_2 = require("./version.js");
const effective_schema_js_2 = require("./effective-schema.js");
exports.ONTOLOGY = (0, registry_js_2.buildOntologyRegistry)([core_js_1.coreDomain, work_js_1.workDomain], version_js_2.ONTOLOGY_VERSION);
/**
 * One user's effective schema: `core` plus their enabled domains, mixins and
 * their own attribute defs. `registry` defaults to `ONTOLOGY`. (Defined here
 * rather than in effective-schema.ts so that file never imports this one.)
 */
function computeEffectiveSchema(input) {
    return (0, effective_schema_js_2.computeEffectiveSchemaFor)(input.registry ?? exports.ONTOLOGY, input);
}
