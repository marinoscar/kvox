---
"@marinoscar/kvox-web": minor
---

Folder access for note libraries (#719, epic #708). `@marinoscar/kvox-web/core/headless` gains the `KvoxFileAccessPort` host capability (opaque `KvoxFolderRef`s, folder-relative `KvoxFileEntry` paths, `pickFolder`, `listFolders`, `forgetFolder`, `enumerate`, `hash`, `read`, an optional `watch`, and the per-device `getLibraryFolder`/`setLibraryFolder` binding), the optional `KvoxWebHost.files` that KVox Desktop implements, `useKvoxFileAccess()` (the host's port or a shared browser one), `createBrowserFileAccess()` (File System Access with handles kept in IndexedDB, or an `<input webkitdirectory>` fallback held in memory; hidden entries and `node_modules` skipped; paths normalised with `normalizeLibraryPath`; SHA-256 through WebCrypto on the main thread because the CSP allows no `blob:` worker), `scanFolder()` with progress, `filesFromDirectoryInput`, `sha256Hex` and `KvoxFileAccessError`.
