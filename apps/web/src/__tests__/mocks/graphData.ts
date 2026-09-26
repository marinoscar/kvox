/**
 * Connected-knowledge fixtures for the web tests (#369).
 *
 * The ontology payload is COMPUTED by the real shared package rather than
 * hand-written, so a fixture can never describe a schema the API would not
 * send — `computeEffectiveSchema` is the same function `GET /api/graph/ontology`
 * runs.
 */

import {
  computeEffectiveSchema,
  toEffectiveSchemaPayload,
  type DomainKey,
  type UserAttributeDef,
} from '@app/shared/ontology';

import type { AttributeDef, GraphOntology } from '../../services/graph';

export function mockGraphOntology(
  enabledDomains: DomainKey[] = ['core', 'work'],
  userAttributes: UserAttributeDef[] = [],
): GraphOntology {
  return toEffectiveSchemaPayload(computeEffectiveSchema({ enabledDomains, userAttributes }));
}

export function mockAttributeDef(overrides: Partial<AttributeDef> = {}): AttributeDef {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    entityType: 'Person',
    key: 'u_nickname01',
    label: 'Nickname',
    kind: 'text',
    options: null,
    extractable: true,
    extractionHint: 'How teammates address them informally',
    sensitivity: null,
    sortOrder: 0,
    deprecatedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}
