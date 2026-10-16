// =============================================================================
// The streaming contract, as data (issue #52, epic #45, docs/specs/notes.md §5)
// =============================================================================
//
// MOVED to `@marinoscar/kvox-api/core` (issue #490, epic #486), where the Ask stream
// imports it too without importing the notes slice. The cursor, the frame builders and
// `resolveStreamOffset` are unchanged; only the names that said "note" became "Kvox".
// This file re-exports them under their original names so the existing importers keep
// compiling, and the original spec (`note-stream.spec.ts`) still runs against them.
// =============================================================================

export {
  KVOX_STREAM_DELTA_EVENT as NOTE_STREAM_DELTA_EVENT,
  KVOX_STREAM_DONE_EVENT as NOTE_STREAM_DONE_EVENT,
  KVOX_STREAM_ERROR_EVENT as NOTE_STREAM_ERROR_EVENT,
  KvoxStreamCursor as NoteStreamCursor,
  parseLastEventId,
  resolveStreamOffset,
  toDeltaFrame,
  toDoneFrame,
  toErrorFrame,
} from '@marinoscar/kvox-api/core';
export type {
  KvoxStreamDeltaData as NoteStreamDeltaData,
  KvoxStreamDoneData as NoteStreamDoneData,
  KvoxStreamErrorClass as NoteStreamErrorClass,
  KvoxStreamErrorData as NoteStreamErrorData,
  KvoxStreamMessage as NoteStreamMessage,
} from '@marinoscar/kvox-api/core';
