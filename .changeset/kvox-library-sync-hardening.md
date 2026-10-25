---
"@marinoscar/kvox-web": minor
---

Library sync hardening (#725). `@marinoscar/kvox-web/notes/headless` gains a per-library sync lock: `createLibrarySyncCoordinator`, the shared `getLibrarySyncCoordinator()` and `syncLibrary()` (a request joins the run in flight or queues exactly one rerun, `whenRunning`; one library at a time by default, `maxConcurrent`; `cancel`, `subscribe`, `getStates`, `idle`), and `isLibrarySyncCancelled`. `useLibrarySyncRunner` syncs through it (joining a sync a host's watcher started, and "Stop" cancels it) and takes an optional `coordinator`. `LibrarySyncProgress` carries `batchId` as soon as a scan opens a batch (and in `importFilesAdHoc`). `importFilesAdHoc` gives files with the same path distinct ones (`notes (2).md`) through the new `uniqueNoteImportPaths`. `runLibrarySync` no longer waits on an unanswered `confirm` once its signal aborts.
