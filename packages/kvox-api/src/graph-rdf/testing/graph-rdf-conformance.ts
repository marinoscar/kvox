import * as jsonld from 'jsonld';
import { Parser } from 'n3';
import { ONTOLOGY } from '@marinoscar/kvox-contract/ontology';

import type { KvoxJobHandler } from '../../ports/index.js';
import { KG_EXPORT_JOB_TYPE, KG_IMPORT_JOB_TYPE } from '../../graph/index.js';
import { GRAPH_IMPORT_MAX_TRIPLES } from '../import/graph-import.constants.js';
import { parseTurtleText } from '../import/rdf-parse.js';
import { buildImportVocabulary } from '../import/import-vocabulary.js';
import { mapImportToProposal } from '../import/rdf-to-proposal.js';
import { generateShacl } from '../rdf/shacl-generator.js';
import { FIXTURE_TIER_DEF, renderFixtureExport } from './export-fixture.js';
import { FIXTURE_NS as NS, validateShacl } from './rdf-fixtures.js';

// =============================================================================
// The graph-rdf conformance suite (issue #496, epic #491)
// =============================================================================
//
// `describeGraphRdfConformance` states, once, the invariants of the RDF export and import that a
// host's binding must not break and a fork that changes the slice must keep:
//
//   • the job types and their execution posture: `kg.export` (ten minutes, three attempts) and
//     `kg.import` (thirty minutes, ONE attempt: a half-applied import is not safe to repeat) are
//     server-only and spend no AI key;
//   • an export validates against the SHACL shapes the slice generates from the same ontology, in
//     Turtle and in JSON-LD;
//   • what an export writes, an import reads back: the exported file maps onto proposal rows
//     (`origin: user`, flagged `imported` by the handler) and nothing in it is skipped as sensitive.
//
// The posture group reads the handlers the host's binding registered; the rest run the real
// pipeline over the shared fixture graph, so they hold for any host. The database round trip
// (a draft proposal row) is the host's own integration spec.
// =============================================================================

/**
 * The test runner's functions, so the suite runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface GraphRdfConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any, timeoutMs?: number): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * What the suite needs from a host's binding.
 *
 * @stability experimental
 */
export interface GraphRdfConformanceTarget {
  /** Every job handler the binding registered (the RDF types are picked out by name). */
  handlers: readonly KvoxJobHandler[];
}

const PINNED_TYPES = [
  { type: KG_EXPORT_JOB_TYPE, maxRuntimeMs: 10 * 60_000, maxAttempts: 3 },
  { type: KG_IMPORT_JOB_TYPE, maxRuntimeMs: 30 * 60_000, maxAttempts: 1 },
] as const;

/**
 * Registers the graph-rdf conformance suite.
 *
 * @param label - names the binding under test in the report.
 * @param setup - resolves the host's binding (the registered handlers).
 * @param harness - the runner's `describe`, `it` and `expect`.
 * @stability experimental
 */
export function describeGraphRdfConformance(
  label: string,
  setup: () => Promise<GraphRdfConformanceTarget> | GraphRdfConformanceTarget,
  harness: GraphRdfConformanceHarness,
): void {
  const { describe, it, expect } = harness;

  describe(`graph-rdf conformance: ${label}`, () => {
    describe('job types', () => {
      let handlers: readonly KvoxJobHandler[] = [];

      it('resolves the binding', async () => {
        handlers = (await setup()).handlers;
      });

      for (const pinned of PINNED_TYPES) {
        it(`${pinned.type} is registered, server-only, spends no AI key, with its pinned profile`, () => {
          const handler = handlers.find((candidate) => candidate.type === pinned.type);

          expect(handler).toBeDefined();
          expect(handler?.usesAi).not.toBe(true);
          expect(handler?.nodeResultSchema).toBeUndefined();
          expect(handler?.persistNodeResult).toBeUndefined();
          expect(handler?.profile).toEqual({ maxRuntimeMs: pinned.maxRuntimeMs, maxAttempts: pinned.maxAttempts });
        });
      }
    });

    describe('an export', () => {

      for (const format of ['turtle', 'jsonld'] as const) {
        it(`validates against the generated SHACL shapes (${format})`, async () => {
          const text = await renderFixtureExport(format);
          const shapes = generateShacl(ONTOLOGY, [FIXTURE_TIER_DEF], NS);
          const data = format === 'turtle' ? text : await jsonLdQuads(text);
          const report = await validateShacl(shapes, data);

          expect(report.results.map((result) => [result.focusNode, result.path, result.message])).toEqual([]);
          expect(report.conforms).toBe(true);
        }, 120_000);
      }

      it('is byte-identical across runs', async () => {
        expect(await renderFixtureExport('turtle')).toBe(await renderFixtureExport('turtle'));
      });
    });

    describe('a round trip', () => {
      it('maps the exported file onto proposal rows, skipping nothing as sensitive', async () => {
        const quads = parseTurtleText(await renderFixtureExport('turtle'));

        expect(quads.length).toBeGreaterThan(20);
        expect(quads.length).toBeLessThan(GRAPH_IMPORT_MAX_TRIPLES);

        const mapped = mapImportToProposal({
          quads,
          ns: NS,
          registry: ONTOLOGY,
          vocabulary: buildImportVocabulary(ONTOLOGY, [FIXTURE_TIER_DEF], NS),
          userAttributes: [FIXTURE_TIER_DEF],
          filename: 'export.ttl',
          sensitivity: new Map(),
        });

        expect(mapped.counts.entities).toBeGreaterThanOrEqual(3);
        expect(mapped.counts.skippedSensitive).toBe(0);
        expect(mapped.rows.length).toBeGreaterThan(0);
        expect(mapped.rows.every((row) => row.evidence.quote.length > 0)).toBe(true);
      });
    });
  });
}

/** JSON-LD text as quads, through the `jsonld` peer. */
async function jsonLdQuads(text: string): Promise<never> {
  const nquads = (await jsonld.toRDF(JSON.parse(text), { format: 'application/n-quads' })) as unknown as string;

  return new Parser({ format: 'N-Quads' }).parse(nquads) as never;
}
