"use strict";
// =============================================================================
// Ontology version and CHANGELOG (docs/specs/ontology.md §17.4)
// =============================================================================
//
// Every graph row records the `ontology_version` it was written against.
//
//   MAJOR  a type's MEANING changed (an old row can no longer be assumed to
//          satisfy the new definition).
//   MINOR  a type, relation or attribute was ADDED (or deprecated).
//   PATCH  only descriptions, disambiguation or extraction hints changed --
//          text a model reads, never structure a stored row depends on.
//
// Append a CHANGELOG entry for every bump; the last entry's `version` IS
// `ONTOLOGY_VERSION` (the parity test enforces it, and that versions strictly
// increase). Never edit or delete an old entry.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.ONTOLOGY_VERSION = exports.CHANGELOG = void 0;
exports.CHANGELOG = Object.freeze([
    Object.freeze({
        version: '1.0.0',
        date: '2026-09-26',
        changes: Object.freeze([
            'Initial core + work: Person, Organization, Meeting, Claim, PersonFact (core); Project, Commitment, Decision and the Person.title mixin (work); 15 relation types.',
        ]),
    }),
]);
exports.ONTOLOGY_VERSION = exports.CHANGELOG[exports.CHANGELOG.length - 1].version;
