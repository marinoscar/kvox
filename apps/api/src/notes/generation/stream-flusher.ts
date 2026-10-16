// =============================================================================
// The flush cadence (issue #49, epic #45, docs/specs/notes.md §5.1)
// =============================================================================
//
// MOVED to `@marinoscar/kvox-api/core` (issue #490, epic #486), where the Ask stream
// imports it too without importing the notes slice. This file only re-exports it so the
// existing importers keep compiling; the code and its comments are unchanged.
// =============================================================================

export {
  DEFAULT_FLUSH_CHARS,
  DEFAULT_FLUSH_INTERVAL_MS,
  StreamFlusher,
} from '@marinoscar/kvox-api/core';
export type { FlushClock, StreamFlusherOptions } from '@marinoscar/kvox-api/core';
