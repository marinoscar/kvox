---
'@marinoscar/kvox-db': minor
---

Note context attachments schema (issue #810): `note_context_attachments` (documents and images attached to a note as generation context; Cascade on the note, Restrict on the storage object, unique `(note_id, object_id)`, a `kind` CHECK) and `note_generations.context_attachments` (a JSON snapshot of what was sent), with the migration `20261106120000_add_note_context_attachments` and back-relations on `Note` and `StorageObject`.
