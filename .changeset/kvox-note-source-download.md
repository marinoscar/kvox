---
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-contract": minor
---

Download the source document of an imported note (#732). `GET /api/notes/{id}/source` (`notes:read`, owner only, 404 never 403) returns `{ url, filename, mimeType, expiresAt }`: a 15 minute signed URL serving the original file under its sanitized upload name as an attachment; optional `?version=<n>` must name an existing version. `@marinoscar/kvox-contract/notes` adds `noteSourceDownloadSchema`, `noteSourceDownloadQuerySchema` and their types; `@marinoscar/kvox-api` adds `NoteSourceDownloadService` and `noteSourceFilename`.
