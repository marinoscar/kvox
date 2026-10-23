---
'@marinoscar/kvox-api': patch
'@marinoscar/kvox-web': patch
---

Close import batches that never got an item. New `POST /api/notes/import-batches/:id/close` (cancels an empty batch, settles a finished one, leaves an importing one running); `GET /import-batches/:id` also reads an empty batch older than 30 minutes as cancelled. The library sync and the ad-hoc import now call `closeImportBatch` for every batch they opened, after the uploads, on a cancelled confirm and on abort.
