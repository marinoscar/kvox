// =============================================================================
// Where the graph's files live in object storage (issue #386, #387; moved by #496)
// =============================================================================
//
// An upload of `kg.import` is stored under `graph/<owner>/imports/`, beside the owner's
// exports (`graph/<owner>/exports/`). The prefix lives in the core graph slice because the
// purge sweeps it; the key of one file is built where the formats are known
// (`graph-rdf/import/graph-import.constants.ts`).
// =============================================================================

/**
 * The prefix every import file of `ownerId` lives under (the purge's sweep).
 *
 * @param ownerId - the owner.
 * @returns the storage-key prefix.
 * @stability experimental
 */
export function graphImportStoragePrefix(ownerId: string): string {
  return `graph/${ownerId}/imports/`;
}
