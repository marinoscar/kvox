// =============================================================================
// Layout constants that must be importable WITHOUT the graph libraries (issue #496)
// =============================================================================
//
// `compute-layout.ts` imports `graphology` and its plug-ins, optional peers of the graph
// slice. The overview service needs one constant from it, and the service is loaded with the
// module, so the constant lives here and `compute-layout.ts` re-exports it.
// =============================================================================

/**
 * Cluster id every singleton community pools into.
 *
 * @stability experimental
 */
export const UNCONNECTED_CLUSTER_ID = -1;
