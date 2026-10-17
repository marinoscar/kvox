import { ONTOLOGY } from '@marinoscar/kvox-contract/ontology';

import { GraphRdfDatasetBuilder, type RdfSubjectBlock } from '../export/rdf-dataset-builder.js';
import type { GraphExportFormat } from '../export/graph-export-formats.js';
import { serializeGraph } from '../export/serializers.js';
import { FIXTURE_NS as NS, userDef } from './rdf-fixtures.js';

// =============================================================================
// A small fixture graph written through the real export pipeline (issue #496, epic #491)
// =============================================================================
//
// Three entities, a work relation, a commitment and five evidence anchors, built by the real
// dataset builder and written by the real serializer. The serializer spec, the export-conformance
// suite and a host's round-trip spec share it, so they all prove the same bytes.
// =============================================================================

/** The id of the n-th fixture row. */
export const fixtureId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The user attribute definition the fixture graph carries. */
export const FIXTURE_TIER_DEF = userDef({
  id: '11111111-1111-4111-8111-111111111111',
  entityType: 'Organization',
  key: 'u_tier000001',
  label: 'Tier',
  kind: 'select',
  options: { choices: [{ value: 'gold', label: 'Gold' }] },
});

const id = fixtureId;
const TIER = FIXTURE_TIER_DEF;

/** The fixture graph's subject blocks, batch by batch. */
export function fixtureBatches(): RdfSubjectBlock[][] {
  const b = new GraphRdfDatasetBuilder({
    ns: NS,
    registry: ONTOLOGY,
    attributeDefs: [TIER],
    exportId: id(99),
    generatedAt: new Date('2026-09-01T00:00:00Z'),
    ontologyVersion: ONTOLOGY.version,
  });
  const works = {
    id: id(20),
    type: 'WORKS_FOR',
    fromId: id(1),
    fromType: 'Person',
    toId: id(2),
    toType: 'Organization',
    props: {},
    validFrom: new Date('2019-01-01T00:00:00Z'),
    validTo: new Date('2024-01-01T00:00:00Z'),
    validPrecision: 'year',
    reviewStatus: 'accepted',
    confidence: 0.8,
    ontologyVersion: '1.0.0',
  };
  const entity = (n: number, type: string, label: string, extra: object = {}) => ({
    id: id(n),
    type,
    label,
    props: {},
    reviewStatus: 'accepted',
    occurredAt: null,
    ontologyVersion: '1.0.0',
    aliases: [label],
    evidenceIds: [id(50 + n)],
    refTypes: new Map<string, string>(),
    outgoing: [],
    ...extra,
  });
  const blocks = (xs: Array<RdfSubjectBlock | null>) => xs.filter((x): x is RdfSubjectBlock => x !== null);
  return [
    [b.ontologyHeader(), ...b.attributeDefinitions()],
    blocks([
      b.entity(entity(1, 'Person', 'Sarah "SC" Chen', { aliases: ['Sarah'], outgoing: [works] })),
      b.entity(entity(2, 'Organization', 'Acme', { props: { website: 'https://acme.example', u_tier000001: 'gold' } })),
      b.entity(entity(3, 'Meeting', 'Pilot sync', { occurredAt: new Date('2026-04-02T15:00:00Z') })),
    ]),
    blocks(
      [51, 52, 53, 54, 55].map((n) =>
        b.evidence({
          id: id(n),
          subjectKind: n === 54 ? 'relation' : n === 55 ? 'item' : 'entity',
          subjectSensitivity: null,
          quote: `quote ${n}\nwith a newline and ünïcode`,
          segmentId: id(60),
          startMs: 1500,
          endMs: 4000,
          noteId: null,
          noteVersion: null,
          charStart: 0,
          charEnd: 5,
        }),
      ),
    ),
    [b.exportHeader()],
    blocks([
      b.item({
        id: id(30),
        kind: 'commitment',
        title: 'Send the proposal',
        statement: 'Sarah will send the proposal.',
        status: 'open',
        props: {},
        occurredAt: null,
        dueAt: new Date('2026-04-10T17:00:00Z'),
        validFrom: null,
        validTo: null,
        validPrecision: null,
        reviewStatus: 'accepted',
        confidence: null,
        sensitivity: null,
        ontologyVersion: '1.0.0',
        subject: { id: id(2), type: 'Organization' },
        meeting: { id: id(3), type: 'Meeting' },
        ownerPerson: { id: id(1), type: 'Person' },
        counterparty: null,
        supersedes: [],
        evidenceIds: [id(55)],
        refTypes: new Map(),
      }),
    ]),
    blocks([b.relation({ ...works, evidenceIds: [id(54)] })]),
    [b.segmentLabel(id(60), 'Weekly sync')],
  ];
}

/** An array as an async generator. */
export async function* asAsync<T>(xs: T[]): AsyncGenerator<T> {
  for (const x of xs) yield x;
}

/**
 * Renders the fixture graph in one export format.
 *
 * @param format - the export format.
 * @returns the file's text.
 */
export async function renderFixtureExport(format: GraphExportFormat): Promise<string> {
  let out = '';
  for await (const chunk of serializeGraph(format, NS, asAsync(fixtureBatches()))) out += chunk;
  return out;
}

