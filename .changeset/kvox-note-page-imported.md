---
'@marinoscar/kvox-web': patch
---

Note page (#758): an imported note (a document kept as the note, no template) no longer shows "How this note was generated" — it was never generated. The provenance line still names the file, offers it back and dates the import, and an AI formatting pass is named from the version history ("Formatted with AI · version 2, …"). New `isImportedNote`, `useNoteAiRevision` and `pickNoteAiRevision` in `@marinoscar/kvox-web/notes/headless`. The header now gives the title its own row, so it wraps like prose at tablet and phone widths, with the status chip and the actions (including a host's `HeaderActions`) on a wrapping row beneath it instead of over it.
