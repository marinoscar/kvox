---
'@marinoscar/kvox-web': patch
---

Notes import: an upload refused because object storage is not set up (503, `storage_not_configured` or `storage_bucket_unknown`) now says "File storage is not set up on this server yet. An administrator can set it up in Settings → Storage." instead of the generic per-file sentence, an unknown refusal reason keeps the server's own message, and the `source_missing` failure reason has its own sentence.
