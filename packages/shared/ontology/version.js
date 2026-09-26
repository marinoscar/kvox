"use strict";
// =============================================================================
// Ontology version and CHANGELOG (docs/specs/ontology.md §17.4).
//
// Semver on the definition: MAJOR when a type's meaning changes, MINOR when a
// type, relation or attribute is added, PATCH when only descriptions or
// extraction hints change. Every graph row records the version it was written
// against. Append a CHANGELOG entry with every bump; the last entry's version
// must equal ONTOLOGY_VERSION (the parity test pins it).
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.ONTOLOGY_VERSION = exports.CHANGELOG = void 0;
exports.CHANGELOG = Object.freeze([
    Object.freeze({
        version: '1.0.0',
        date: '2026-09-26',
        changes: Object.freeze(['initial core + work']),
    }),
]);
exports.ONTOLOGY_VERSION = '1.0.0';
