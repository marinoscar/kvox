---
'@marinoscar/kvox-api': patch
---

`note.library.import` now logs a warning naming which condition made an item fail with `source_missing` (no source object id, object not found, bytes unreadable, or an unaccepted stored mime type), without any file content.
