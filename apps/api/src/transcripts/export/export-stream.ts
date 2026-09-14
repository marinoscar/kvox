// =============================================================================
// Re-export shim: the stream helpers are generic now (issue #54, epic #45)
// =============================================================================
//
// See `./export-options.ts`'s header — same extraction, same reason for the
// shim. New code should import from `../../export/export-stream`.
// =============================================================================

export * from '../../export/export-stream';
