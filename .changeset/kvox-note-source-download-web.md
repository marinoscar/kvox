---
"@marinoscar/kvox-web": minor
---

Download the original file of a document-sourced note (#732). `getNoteSourceDownload(host, noteId, version?)` reads `GET /api/notes/{id}/source` and parses it with the contract's `noteSourceDownloadSchema`; `NoteProvenance` turns the file name of a document source into a "Download <file name>" button that opens the short-lived signed URL the same way a note export's download is opened, and says inline when the original file is no longer available.
