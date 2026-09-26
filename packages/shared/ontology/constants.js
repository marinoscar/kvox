"use strict";
// =============================================================================
// Ontology constants (issue #350, epic #344, docs/specs/ontology.md §5, §17)
// =============================================================================
//
// Every closed list the ontology is built from. Declared `as const` so each
// one is simultaneously a runtime array (a Zod enum, a form's options) and the
// source of a TypeScript union (`types.ts`) -- one declaration, never two.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROPS_LIMITS = exports.USER_ATTRIBUTE_KEY_PATTERN = exports.USER_ATTRIBUTE_KEY_PREFIX = exports.PSEUDO_TYPES = exports.DEFAULT_ENABLED_DOMAINS = exports.DOMAIN_KEYS = exports.ITEM_KINDS = exports.VALID_PRECISIONS = exports.SENSITIVITIES = exports.ATTRIBUTE_KINDS = void 0;
/** The fixed list an attribute's `kind` is drawn from (§17.3). */
exports.ATTRIBUTE_KINDS = [
    'text',
    'number',
    'date',
    'boolean',
    'select',
    'multi_select',
    'url',
    'entity_ref',
];
/** §5.6. `sensitive` never enters any prompt enrichment, under any setting. */
exports.SENSITIVITIES = ['business', 'personal', 'sensitive'];
/** §5.4: how exact a `valid` range's source actually was. */
exports.VALID_PRECISIONS = ['day', 'month', 'year', 'unknown'];
/** The four kinds of `kg_items` row; each is claimed by exactly one item type. */
exports.ITEM_KINDS = ['commitment', 'decision', 'claim', 'person_fact'];
/**
 * Every domain key the ontology knows about (§17.2). `personal` is declared
 * so settings can name it, but no module ships for it yet (#383).
 */
exports.DOMAIN_KEYS = ['core', 'work', 'personal'];
/** The domains a user who never touched the settings card has enabled. */
exports.DEFAULT_ENABLED_DOMAINS = ['core', 'work'];
/**
 * Relation endpoints that are NOT `kg_entities` rows: a transcript's
 * diarized speaker, and the two content rows evidence points at. They may
 * appear only in `speaker_link`, `mention` and `evidence` relations.
 */
exports.PSEUDO_TYPES = ['Speaker', 'Note', 'Transcript'];
/**
 * Every user-defined attribute key starts with this prefix (§17.3), and no
 * built-in attribute key may -- so the two namespaces can never collide.
 */
exports.USER_ATTRIBUTE_KEY_PREFIX = 'u_';
/** The full shape of a user attribute key: the prefix plus ten `[a-z0-9]`. */
exports.USER_ATTRIBUTE_KEY_PATTERN = /^u_[a-z0-9]{10}$/;
/** Upper bounds the props validators enforce (and the JSON Schema cannot). */
exports.PROPS_LIMITS = {
    textMaxLength: 2000,
    urlMaxLength: 2048,
    listMaxItems: 50,
};
