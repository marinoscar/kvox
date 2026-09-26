"use strict";
// =============================================================================
// Ontology types (issue #350, docs/specs/ontology.md §17)
// =============================================================================
//
// The shapes a domain module declares (`*Spec`), the shapes a caller's
// effective schema resolves to (`Effective*`), and the JSON-safe payload
// `GET /api/graph/ontology` returns (`*Payload`). Web forms render from the
// payload, never from the registry, because a user's effective schema also
// carries that user's own attribute definitions.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
