"use strict";
// =============================================================================
// `@app/shared/ontology` -- the ontology definition (issue #350, epic #344)
// =============================================================================
//
// The single TypeScript + Zod declaration of the knowledge-graph ontology
// that `apps/api` validates and extracts against and `apps/web` renders forms
// from (docs/specs/ontology.md §17). Sources live in
// `packages/shared/src/ontology/`; the committed CommonJS + .d.ts under
// `packages/shared/ontology/` is what consumers load. After editing a source,
// run `npm run build:ontology --workspace=@app/shared` and commit the output
// in the same commit -- CI fails otherwise. See packages/shared/README.md.
//
// Web code imports TYPES and small constants from here; its forms render from
// the `GET /api/graph/ontology` payload, never from `ONTOLOGY` directly,
// because a user's effective schema includes their own attribute definitions.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractableRelationTypes = exports.extractableEntityTypes = exports.buildPropsJsonSchema = exports.validateProps = exports.buildPropsSchema = exports.toEffectiveSchemaPayload = exports.computeEffectiveSchema = exports.buildOntologyRegistry = exports.ONTOLOGY = exports.defineRelationType = exports.defineEntityType = exports.defineDomain = exports.OntologyDefinitionError = exports.SHIPPED_KEYS = exports.ONTOLOGY_VERSION = exports.CHANGELOG = exports.VALID_PRECISIONS = exports.USER_ATTRIBUTE_KEY_PREFIX = exports.SENSITIVITIES = exports.PSEUDO_TYPES = exports.ITEM_KINDS = exports.DOMAIN_KEYS = exports.DEFAULT_ENABLED_DOMAINS = exports.ATTRIBUTE_KINDS = void 0;
var constants_js_1 = require("./constants.js");
Object.defineProperty(exports, "ATTRIBUTE_KINDS", { enumerable: true, get: function () { return constants_js_1.ATTRIBUTE_KINDS; } });
Object.defineProperty(exports, "DEFAULT_ENABLED_DOMAINS", { enumerable: true, get: function () { return constants_js_1.DEFAULT_ENABLED_DOMAINS; } });
Object.defineProperty(exports, "DOMAIN_KEYS", { enumerable: true, get: function () { return constants_js_1.DOMAIN_KEYS; } });
Object.defineProperty(exports, "ITEM_KINDS", { enumerable: true, get: function () { return constants_js_1.ITEM_KINDS; } });
Object.defineProperty(exports, "PSEUDO_TYPES", { enumerable: true, get: function () { return constants_js_1.PSEUDO_TYPES; } });
Object.defineProperty(exports, "SENSITIVITIES", { enumerable: true, get: function () { return constants_js_1.SENSITIVITIES; } });
Object.defineProperty(exports, "USER_ATTRIBUTE_KEY_PREFIX", { enumerable: true, get: function () { return constants_js_1.USER_ATTRIBUTE_KEY_PREFIX; } });
Object.defineProperty(exports, "VALID_PRECISIONS", { enumerable: true, get: function () { return constants_js_1.VALID_PRECISIONS; } });
var version_js_1 = require("./version.js");
Object.defineProperty(exports, "CHANGELOG", { enumerable: true, get: function () { return version_js_1.CHANGELOG; } });
Object.defineProperty(exports, "ONTOLOGY_VERSION", { enumerable: true, get: function () { return version_js_1.ONTOLOGY_VERSION; } });
var shipped_keys_js_1 = require("./shipped-keys.js");
Object.defineProperty(exports, "SHIPPED_KEYS", { enumerable: true, get: function () { return shipped_keys_js_1.SHIPPED_KEYS; } });
var define_js_1 = require("./define.js");
Object.defineProperty(exports, "OntologyDefinitionError", { enumerable: true, get: function () { return define_js_1.OntologyDefinitionError; } });
Object.defineProperty(exports, "defineDomain", { enumerable: true, get: function () { return define_js_1.defineDomain; } });
Object.defineProperty(exports, "defineEntityType", { enumerable: true, get: function () { return define_js_1.defineEntityType; } });
Object.defineProperty(exports, "defineRelationType", { enumerable: true, get: function () { return define_js_1.defineRelationType; } });
var registry_js_1 = require("./registry.js");
Object.defineProperty(exports, "ONTOLOGY", { enumerable: true, get: function () { return registry_js_1.ONTOLOGY; } });
Object.defineProperty(exports, "buildOntologyRegistry", { enumerable: true, get: function () { return registry_js_1.buildOntologyRegistry; } });
var effective_schema_js_1 = require("./effective-schema.js");
Object.defineProperty(exports, "computeEffectiveSchema", { enumerable: true, get: function () { return effective_schema_js_1.computeEffectiveSchema; } });
Object.defineProperty(exports, "toEffectiveSchemaPayload", { enumerable: true, get: function () { return effective_schema_js_1.toEffectiveSchemaPayload; } });
var props_schema_js_1 = require("./props-schema.js");
Object.defineProperty(exports, "buildPropsSchema", { enumerable: true, get: function () { return props_schema_js_1.buildPropsSchema; } });
Object.defineProperty(exports, "validateProps", { enumerable: true, get: function () { return props_schema_js_1.validateProps; } });
var json_schema_js_1 = require("./json-schema.js");
Object.defineProperty(exports, "buildPropsJsonSchema", { enumerable: true, get: function () { return json_schema_js_1.buildPropsJsonSchema; } });
Object.defineProperty(exports, "extractableEntityTypes", { enumerable: true, get: function () { return json_schema_js_1.extractableEntityTypes; } });
Object.defineProperty(exports, "extractableRelationTypes", { enumerable: true, get: function () { return json_schema_js_1.extractableRelationTypes; } });
