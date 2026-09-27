// =============================================================================
// Graph import constants and pure helpers (#387, docs/specs/ontology.md §18.3)
// =============================================================================
//
// Shared by the upload route (`graph-import.service.ts`), the job
// (`kg-import.handler.ts`) and the attribute-offer routes. No Nest, no I/O.
// =============================================================================

import type { GraphImportFailureReason, GraphImportFormat } from './dto/graph-import.dto';

/** The largest file one import accepts (20 MiB). */
export const GRAPH_IMPORT_MAX_BYTES = 20 * 1024 * 1024;

/** The most triples one import holds. */
export const GRAPH_IMPORT_MAX_TRIPLES = 200_000;

/**
 * `kg_proposals.stats` key holding the values of every OFFERED unknown
 * property, per proposal row, until the offer is accepted (values move into
 * `props`) or rejected (dropped). Internal bookkeeping: never serialized to a
 * client (`proposal-view.mapper.ts`'s `INTERNAL_STATS_KEYS`).
 */
export const IMPORT_PENDING_STATS_KEY = 'importPending';

/** One stored value: lexical form or IRI, its datatype, and the row it names (an IRI of another imported node). */
export interface ImportPendingValue {
  v: string;
  d?: string;
  item?: string;
}

/** offerId → the rows carrying it and their values. */
export type ImportPendingStats = Record<string, Array<{ itemId: string; values: ImportPendingValue[] }>>;

/** The sentence the import page shows for each failure. Never quotes the file. */
export function failureMessage(reason: GraphImportFailureReason): string {
  switch (reason) {
    case 'parse_error':
      return 'The file could not be read as RDF.';
    case 'too_large':
      return 'The file is larger than one import can hold.';
    case 'ontology_version_newer':
      return 'The file was written by a newer ontology version than this deployment runs. Upgrade this deployment first.';
    case 'migration_pending':
      return 'Your graph is being updated to the current ontology version. Try the import again once that finishes.';
    case 'shacl_violations':
      return 'The file does not match your ontology, so nothing was imported.';
    case 'empty':
      return 'The file contains nothing this graph can hold — no node is typed with one of its classes.';
  }
}

/** The format of an upload, from its extension first and its declared type second; null when neither says. */
export function detectImportFormat(filename: string, mimeType: string | undefined): GraphImportFormat | null {
  const name = (filename ?? '').toLowerCase();
  if (name.endsWith('.ttl')) return 'turtle';
  if (name.endsWith('.jsonld') || name.endsWith('.json')) return 'jsonld';
  if (name.endsWith('.nq')) return 'nquads';
  const type = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (type === 'text/turtle') return 'turtle';
  if (type === 'application/ld+json') return 'jsonld';
  if (type === 'application/n-quads') return 'nquads';
  return null;
}

export const GRAPH_IMPORT_FORMAT_INFO: Readonly<Record<GraphImportFormat, { extension: string; mimeType: string }>> = {
  turtle: { extension: 'ttl', mimeType: 'text/turtle' },
  jsonld: { extension: 'jsonld', mimeType: 'application/ld+json' },
  nquads: { extension: 'nq', mimeType: 'application/n-quads' },
};

/** Where an import's file is stored — beside the owner's exports, under `imports/`. */
export function graphImportStorageKey(ownerId: string, id: string, format: GraphImportFormat): string {
  return `graph/${ownerId}/imports/${id}.${GRAPH_IMPORT_FORMAT_INFO[format].extension}`;
}

/** The prefix every import file of `ownerId` lives under (the purge's sweep). */
export function graphImportStoragePrefix(ownerId: string): string {
  return `graph/${ownerId}/imports/`;
}
