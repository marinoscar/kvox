# core

The host port and the shared building blocks of `@marinoscar/kvox-web`.

## Purpose and scope

What every packaged page needs from the app that mounts it, and what several slices share: the `KvoxWebHost` port and its provider; the HTTP, event-stream and upload transports over it; the viewer and permission hooks; `KvoxApiError`; the resumable upload engine; polling and the domain-neutral hooks and helpers (relative time, the feed cache and reconciler, scroll restoration, the clipboard, the wake lock); the library chrome; and the test kit. The app provides the host once; the pages read it through hooks. This slice imports no platform package.

Status: filled (Epic 7, issue 7.1). The slices that follow add nothing to it unless a port is missing.

## Entry point

Three entries, none depending on another slice:

- `@marinoscar/kvox-web/core/headless`: no component, no `@mui/*`, no router. Host types and provider (`KvoxWebHost`, `KvoxWebHostProvider`, `useKvoxHost`, `useKvoxViewer`, `useHasPermission`, `useKvoxPermissionCheck`, `KvoxHostMissingError`); transports (`kvoxGet`, `kvoxPost`, `kvoxPut`, `kvoxPatch`, `kvoxDelete`, `kvoxRequest`, `kvoxPostFormData`, `kvoxRequestBlob`, `kvoxGetBlob`, `kvoxGetWithMeta`, `buildKvoxUrl`); errors (`KvoxApiError`, `toKvoxApiError`, `unwrapEnvelope`); event streams (`connectKvoxSse`, `createFetchSseConnect`, `SseParser`, and the URL-based `connectSse`); the upload engine (`createResumableUpload`, `startUpload`, `resumeUpload`, `createTranscriptUpload`, `completeUpload` and the rest); `useVisiblePolling`, `useIsMounted`, `useCopyToClipboard`, `useScrollRestoration`, `useUnsavedChangesWarning`, `useScreenWakeLock`; the utilities `formatRelativeTime`, `formatShortDate`, `formatUtc`, `isInternalLink`, the feed cache (`useCachedFeedState`, `readFeedCache`, `writeFeedCache`, `clearFeedCache`), `reconcileFeed`, `compareFeedRows`, `groupFeedByDate`, `feedDateBucket`, `feedCountLabel`.
- `@marinoscar/kvox-web/core/ui`: `LibraryPageFrame`, `FeedCountLine`, `FeedDateSeparator`, `ActiveStatusFilterChip`, `KvoxLoadingSpinner` and the types `KvoxSettingsCard`, `KvoxDestination`, `KvoxDestinationRoutes`, `KvoxRouteDef`.
- `@marinoscar/kvox-web/core/testing`: `createFakeKvoxWebHost`, `fakeApiError`, `renderWithKvoxHost`, `installMatchMedia` and `setViewportWidth`, `createFakeXhrFactory`, `describeKvoxWebConformance`.

## Peer dependencies

`core/headless`: `@marinoscar/kvox-contract`, `react` and `react-dom`, all required. `core/ui` adds `@mui/material`, `@mui/icons-material` and `react-router-dom`; `core/testing` adds `@mui/material`, `react-router-dom` and `@testing-library/react`. All of those are optional peers of the package.

## Configuration

None. The behaviour is the host's.

## Extension-point catalog

- `KvoxWebHost`: the port a host implements. `http` resolves with the payload with the `{ data }` envelope already removed and rejects with an error that has a numeric `status` (the core helpers wrap it as `KvoxApiError`, which keeps `status`, `code`, `details`, `details.reason` as `reason` and the contract code as `kvoxCode`). `sse.connect` is ONE attempt (`connectKvoxSse` loops, with backoff and `Last-Event-ID` resume; a 401 or 403 rejection ends the loop); `sse.post` is a POST that answers with an event stream. `upload` is optional: without it the engine sends parts with `XMLHttpRequest`.
- `KvoxHttpPort`, `KvoxSsePort`, `KvoxUploadPort`: the three transports.
- `KvoxSettingsCard<F>`: a settings card as data, structurally the app's `SettingsCardDef`. `F` is the union of settings-feature keys the card may name; it defaults to `never`, so a card without a feature spreads into the app's registry without a cast.
- `KvoxDestination<K, F>` and `KvoxDestinationRoutes<K>`: a navigation destination and the prefixes it owns, structurally the shell's `ShellDestination`.
- `KvoxRouteDef`: a route as data (`path`, optional `permission`, lazy `Component`); the app renders it inside its own guard (`apps/web/src/platform-kvox/renderKvoxRoutes.tsx`).
