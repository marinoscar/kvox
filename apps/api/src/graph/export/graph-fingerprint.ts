// =============================================================================
// The content address of a graph export (issue #386)
// =============================================================================
//
//   graph_fingerprint = sha256(canonical JSON of {
//     ontologyVersion, format, namespace,
//     tables: { <table>: { count, lastChangedAt } } for the owner's
//             kg_entities, kg_entity_aliases, kg_relations, kg_items,
//             kg_evidence, kg_attribute_defs
//   })
//
// `POST /api/graph/exports` reuses an unexpired, non-failed export whose
// fingerprint matches, so asking twice for an unchanged graph renders once.
// Any committed change moves at least one input: an insert or delete moves a
// count, an edit moves `max(updated_at)` (every graph write sets it, including
// the raw-SQL `valid` updates), and aliases/evidence — which have no
// `updated_at` — move their count and `max(created_at)`.
//
// A cheap SIGNATURE, not a hash of the content: the export's bytes also carry
// the titles of the transcripts/notes cited (labels read live), which this
// deliberately does not cover — a renamed source does not re-render a graph.
//
// ⚠ PURE. The query that gathers `tables` lives in `graph-export.source.ts`.
// =============================================================================

import { createHash } from 'node:crypto';

export const FINGERPRINT_TABLES = [
  'kg_attribute_defs',
  'kg_entities',
  'kg_entity_aliases',
  'kg_evidence',
  'kg_items',
  'kg_relations',
] as const;

export type FingerprintTable = (typeof FINGERPRINT_TABLES)[number];

export interface TableSignature {
  count: number;
  /** ISO-8601, or null for an empty table. */
  lastChangedAt: string | null;
}

export interface GraphFingerprintInput {
  ontologyVersion: string;
  format: string;
  namespace: string;
  tables: Readonly<Record<FingerprintTable, TableSignature>>;
}

/** A lowercase hex SHA-256 over the canonical form of `input`. */
export function graphFingerprint(input: GraphFingerprintInput): string {
  const canonical = {
    format: input.format,
    namespace: input.namespace,
    ontologyVersion: input.ontologyVersion,
    tables: FINGERPRINT_TABLES.map((table) => {
      const sig = input.tables[table];
      return [table, sig.count, sig.lastChangedAt];
    }),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
