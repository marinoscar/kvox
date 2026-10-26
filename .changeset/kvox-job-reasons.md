---
'@marinoscar/kvox-api': patch
---

Note imports enqueue their jobs with the platform's built-in reasons (`upload` for an import, `rerun` for a retry) instead of the unregistered `import` and `retry`, which the platform queue refused with "Unknown job reason" (a 500 on `POST /api/notes/import-batches/:id/files`; the single-file `POST /api/notes/import` lost its source extraction the same way, silently). `KvoxEnqueueInput.reason` is now typed `KvoxJobReason` (`'upload' | 'rerun' | 'backfill'`), so an unregistered reason no longer compiles.
