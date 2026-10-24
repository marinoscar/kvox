// The host-neutral half of the `core` slice: the host port, the transports, the
// viewer and permission hooks, the upload engine and the domain-neutral helpers
// every slice uses. No component, no `@mui/*`, no router.

export {
  KvoxHostMissingError,
  KvoxWebHostProvider,
  isKvoxTranscriptionEnabled,
  useHasPermission,
  useKvoxHost,
  useKvoxLatestEventId,
  useKvoxPermissionCheck,
  useKvoxTranscriptionEnabled,
  useKvoxViewer,
} from './host.js';
export type {
  KvoxBlobResponse,
  KvoxFeatures,
  KvoxHttpMethod,
  KvoxHttpPort,
  KvoxLinks,
  KvoxPartResult,
  KvoxResponseHeaders,
  KvoxRequestInit,
  KvoxResponseWithMeta,
  KvoxSseConnectOptions,
  KvoxSseEvent,
  KvoxSsePort,
  KvoxSsePostOptions,
  KvoxUploadPort,
  KvoxViewer,
  KvoxWebHost,
} from './host.js';

export { KvoxApiError, isKvoxApiError, toKvoxApiError, unwrapEnvelope } from './errors.js';

export {
  buildKvoxUrl,
  kvoxDelete,
  kvoxGet,
  kvoxGetBlob,
  kvoxGetWithMeta,
  kvoxPatch,
  kvoxPost,
  kvoxPostFormData,
  kvoxPut,
  kvoxRequest,
  kvoxRequestBlob,
} from './http.js';
export type { KvoxCallOptions } from './http.js';

export { SseParser } from './sse-parser.js';
export type { SseFrame } from './sse-parser.js';
export { connectKvoxSse, connectSse, createFetchSseConnect } from './sse.js';
export type {
  FetchSseConnectOptions,
  KvoxSseOptions,
  SseConnection,
  SseOptions,
  SseState,
} from './sse.js';

export * from './upload/index.js';

export * from './files/index.js';

export { useVisiblePolling } from './polling.js';

export { useCopyToClipboard } from './hooks/useCopyToClipboard.js';
export type {
  CopyState,
  RichClipboardContent,
  UseCopyToClipboardResult,
} from './hooks/useCopyToClipboard.js';
export { useIsMounted } from './hooks/useIsMounted.js';
export { isWakeLockSupported, useScreenWakeLock } from './hooks/useScreenWakeLock.js';
export type {
  UseScreenWakeLockOptions,
  UseScreenWakeLockResult,
} from './hooks/useScreenWakeLock.js';
export { useScrollRestoration } from './hooks/useScrollRestoration.js';
export { useUnsavedChangesWarning } from './hooks/useUnsavedChangesWarning.js';

export { clearFeedCache, feedCacheKey, readFeedCache, useCachedFeedState, writeFeedCache } from './utils/feedCache.js';
export { feedCountLabel, feedDateBucket, groupFeedByDate } from './utils/feedDateGroups.js';
export type { DatedFeedRow, FeedDateBucket, FeedDateGroup } from './utils/feedDateGroups.js';
export { compareFeedRows, reconcileFeed } from './utils/feedReconcile.js';
export type { FeedPage, FeedRow, FeedState } from './utils/feedReconcile.js';
export { formatUtc } from './utils/formatUtc.js';
export { isInternalLink } from './utils/internalLink.js';
export { formatRelativeTime, formatShortDate } from './utils/relativeTime.js';
