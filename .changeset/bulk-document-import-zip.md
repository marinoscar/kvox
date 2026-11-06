---
'@marinoscar/kvox-web': minor
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-contract': minor
---

Bulk document import (#811). The notes import accepts ZIP archives, expanded in the browser (`expandZipArchive`, `prepareNoteImport`), and shows a pre-flight dialog before any upload. With `BatchUploadProvider` mounted, the batch page opens at once while files upload in the background (pause, resume, cancel, retry). The batch page is a virtualized table with search, sort, throughput and ETA, and a CSV export of failures. `GET /notes/import-batches/:id/items` takes `q` and `updatedSince` and pages up to 500 items (`noteImportBatchItemsQuerySchema`).
