// The host-neutral half of the transcripts slice: the API clients, the hooks over
// them, the upload manager and the pure helpers other screens share. No
// component, no `@mui/*`, no router.

// The API clients. Each call takes the `KvoxWebHost` first.
export * from './clients/transcripts.js';
export * from './clients/transcriptEditing.js';
export * from './clients/transcriptNameChecks.js';
export {
  TRANSCRIPT_IMPORT_ACCEPT,
  TRANSCRIPT_IMPORT_MAX_BYTES,
  TRANSCRIPT_IMPORT_PROVIDER,
  checkTranscriptImportFile,
  importTranscript,
  transcriptImportErrorDetails,
  transcriptImportErrorMessage,
} from './clients/transcriptImports.js';
export type {
  TranscriptImportErrorDetails,
  TranscriptImportFailureReason,
} from './clients/transcriptImports.js';
export {
  UploadSessionGoneError,
  UploadSessionMismatchError,
  matchUploadSession,
} from './clients/uploadSessions.js';
export type { UploadSessionRecord } from './clients/uploadSessions.js';

// The hooks.
export { useLibraryAudioPreview } from './hooks/useLibraryAudioPreview.js';
export type {
  AudioPreviewFailure,
  AudioPreviewState,
  LibraryAudioPreview,
  LibraryAudioPreviewOptions,
} from './hooks/useLibraryAudioPreview.js';
export { liveUploadTranscriptIds, useLiveUploadTranscriptIds } from './hooks/useLiveUploadTranscriptIds.js';
export { useNameCheck } from './hooks/useNameCheck.js';
export type { UseNameCheckOptions, UseNameCheckResult } from './hooks/useNameCheck.js';
export { PLAYBACK_RATES, usePlaybackEngine } from './hooks/usePlaybackEngine.js';
export type {
  PlaybackEngine,
  PlaybackEngineOptions,
  PlaybackEngineStatus,
  PlaybackRate,
} from './hooks/usePlaybackEngine.js';
export { useSourceAudio } from './hooks/useSourceAudio.js';
export type { SourceAudio, SourceAudioOptions, SourceAudioStatus } from './hooks/useSourceAudio.js';
export { useTranscriptOperations } from './hooks/useTranscriptOperations.js';
export type {
  EditConflict,
  SaveState,
  UseTranscriptOperationsOptions,
  UseTranscriptOperationsResult,
} from './hooks/useTranscriptOperations.js';
export { useTranscriptSearch } from './hooks/useTranscriptSearch.js';
export type { FindQuery, UseTranscriptSearchResult } from './hooks/useTranscriptSearch.js';
export { useTranscriptVersions } from './hooks/useTranscriptVersions.js';
export type { UseTranscriptVersionsResult } from './hooks/useTranscriptVersions.js';
export { useTranscriptWords } from './hooks/useTranscriptWords.js';
export type { UseTranscriptWordsResult } from './hooks/useTranscriptWords.js';
export {
  useTranscript,
  useTranscriptSegments,
  useTranscriptSummary,
  useTranscripts,
} from './hooks/useTranscripts.js';
export type {
  UseTranscriptResult,
  UseTranscriptSegmentsResult,
  UseTranscriptsOptions,
  UseTranscriptsResult,
  UseTranscriptSummaryResult,
} from './hooks/useTranscripts.js';
export { useUploadManager } from './hooks/useUploadManager.js';

// The upload manager. Mount `KvoxUploadManagerProvider` ONCE, at the app root.
export { KvoxUploadManagerProvider } from './upload/UploadManagerContext.js';
export type {
  ManagedUpload,
  StartUploadInput,
  UploadManagerContextValue,
} from './upload/UploadManagerContext.js';

// Pure helpers other screens use.
export { formatDuration, formatTimestamp } from './utils/playbackIntervals.js';
export type { PlaybackInterval } from './utils/playbackIntervals.js';
export {
  SPEAKER_PALETTES,
  UPLOAD_INTERRUPTED_LABEL,
  failureMessage,
  formatBytes,
  isUploadInterrupted,
  processingStageLabel,
  transcriptStatusDescriptor,
} from './utils/transcriptDisplay.js';
export type { StatusDescriptor } from './utils/transcriptDisplay.js';
export {
  TRANSCRIPT_STATUS_FILTERS,
  searchFromQuery,
  transcriptScopeFromQuery,
  transcriptStatusFromQuery,
} from './utils/transcriptsLibraryFilters.js';
export type {
  TranscriptScopeFilter,
  TranscriptStatusFilterOption,
} from './utils/transcriptsLibraryFilters.js';
