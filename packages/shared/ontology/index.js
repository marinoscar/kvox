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
exports.ONTOLOGY = exports.buildOntologyRegistry = exports.SHIPPED_KEYS = exports.ONTOLOGY_VERSION = exports.CHANGELOG = exports.OntologyDefinitionError = exports.defineRelationType = exports.defineEntityType = exports.defineDomain = exports.VALID_PRECISIONS = exports.USER_ATTRIBUTE_KEY_PREFIX = exports.SENSITIVITIES = exports.PSEUDO_TYPES = exports.ITEM_KINDS = exports.DOMAIN_KEYS = exports.DEFAULT_ENABLED_DOMAINS = exports.ATTRIBUTE_KINDS = void 0;
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
// -----------------------------------------------------------------------------
// The domain modules, listed EXPLICITLY — never self-registered by import side
// effect (registration order under Vite pre-bundling vs Jest `require` is not
// something to depend on). Adding a domain is one import and one entry here.
// -----------------------------------------------------------------------------
const core_js_1 = require("./domains/core.js");
const work_js_1 = require("./domains/work.js");
const registry_js_2 = require("./registry.js");
const version_js_2 = require("./version.js");
exports.ONTOLOGY = (0, registry_js_2.buildOntologyRegistry)([core_js_1.coreDomain, work_js_1.workDomain], version_js_2.ONTOLOGY_VERSION);
