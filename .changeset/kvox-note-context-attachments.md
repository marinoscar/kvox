---
'@marinoscar/kvox-contract': minor
'@marinoscar/kvox-ai': minor
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-web': minor
---

Attach files as note context (issue #810). A note can carry up to 10 files besides the text box when it is created or regenerated: documents (txt, md, pdf, docx, pptx) go through the existing extraction job and their text is rendered in the prompt's Context block under an `Attached file: <name>` fence; images (png, jpeg, webp, gif) are sent as vision input and need a vision-capable model (409 `ai_model_no_vision`). Additive: new routes `POST/GET /api/notes/context/attachments`, optional `contextAttachmentIds` on create and regenerate, `contextAttachments` on the note and `attachments` on the generation context, four new error codes, an optional `images` on `KVOX_AI.generateText` and an optional `supportsVision`, and `ContextAttachmentsField`, `ContextAttachmentList`, `useContextAttachments`, `uploadNoteContextAttachment` and `getNoteContextAttachmentStatus` in the web package. A host that ignores `images` drops them silently, so KVox Desktop must implement them or refuse.
