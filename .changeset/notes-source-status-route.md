---
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-web": patch
---

The notes slice serves `GET /api/notes/sources/documents/{objectId}`, the extraction status of an uploaded source document (`notes:read`, owner-scoped, 404 for any id the caller does not own), with the new `noteSourceDocumentStatusResponseSchema` in `@marinoscar/kvox-contract/notes`. The notes UI polls it instead of `GET /api/storage/objects/{id}`, so a host no longer serves a storage object read for notes (#596).
