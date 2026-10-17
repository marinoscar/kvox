# notes

The notes UI of `@marinoscar/kvox-web`: the library, the new-note flow, the note page with its streaming generation view and editor, the version history, export, and the user's note templates.

## Purpose and scope

Everything a person does with a note in the browser: list and search the library, make a note from a transcript, another note or an uploaded document with a template, watch it being written, read it, edit it (a visual editor, a markdown textarea and a preview; a plain-text note has only a textarea), rename it or ask for a suggested title, regenerate it with another template or model, see exactly what the AI was sent, browse and restore earlier versions, export it as a file, and manage their own note templates with a live sample.

The headless half holds the four API clients (`/api/notes/**`, `/api/note-templates/**`, the exports of a note, and the generation stream), the hooks over them (`useNotes`, `useNote`, `useNoteSummary`, `useNoteTemplates`, `useNoteTemplateDetail`, `useNoteGenerationContext`, `useTemplatePreview`) and the pure helpers (the source reference of a note). The ui half holds `NotesPage`, `NotePage`, `NoteHistoryPage`, `NewNotePage`, `UserNoteTemplatesPage`, `NotesLibraryView`, the pieces other screens embed (`TranscriptNotesSection`, `MarkdownView`, `NoteStatusChip`, `SourceLine`), the slot contracts, and the destination, the routes and the Note Templates card as data.

The slice imports only `core`, `transcripts` and `search`. It imports nothing from the graph or ask slices: the knowledge-graph features of the note page (the review sheet, "Add to graph" on a selection, the extract dialog) and the entity hits above library search come in through slots. What it needs from the host that no port covers (the viewer's AI key and model list) it takes as the `ai` prop.

Status: filled (Epic 7, issue 7.4).

## Entry point

- `@marinoscar/kvox-web/notes/headless`: the clients (`getNotes`, `getNote`, `getNoteSummary`, `createNote`, `updateNote`, `regenerateNote`, `retitleNote`, the version, context and document calls (`getNoteDocumentExtraction` polls `GET /api/notes/sources/documents/{objectId}`, not the storage object), the note-template calls, the export calls; each takes the host first), `connectNoteStream` and `connectNoteGenerationStream` (the generation stream over `host.sse`), the hooks above, `noteConflictReason` and the wire types. No component, no `@mui/*`, no router, and none of the optional editor peers.
- `@marinoscar/kvox-web/notes/ui`: the pages, `NotesLibraryView`, `SourceLine`, `TranscriptNotesSection`, `MarkdownView`, `NoteStatusChip`, `NotesSlotBoundary`, the slot and AI types (`NotePageSlots`, `NotesLibrarySlots`, `NotesAiAccess`), `kvoxNotesDestinations`, `kvoxNotesDestinationRoutes`, `kvoxNotesUserSettingsSections` and `kvoxNotesRoutes`.

The slice depends on `core`, `transcripts` and `search`. The app spreads `kvoxNotesDestinations` into its destination table directly after Transcripts, `kvoxNotesDestinationRoutes` into its ownership table, `kvoxNotesUserSettingsSections.account` into its `Account` group directly after `AI Provider`, and renders `kvoxNotesRoutes` (the four `/notes` routes and `/settings/note-templates`) where its literal routes used to be.

## Peer dependencies

`@marinoscar/kvox-contract`, `react` and `react-dom` for the headless entry. `ui` adds `@mui/material`, `@mui/icons-material` and `react-router-dom`, and the editor and renderer libraries, all optional peers of the package and needed by this entry only: `react-markdown` and `remark-gfm` (every rendered note body) and `@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-table`, `@tiptap/markdown` and `@tiptap/pm` (the visual editor).

The visual editor is loaded with `React.lazy` the first time somebody edits a note, so `@tiptap/*` is a separate chunk that a reader never downloads. Keep ONE copy of `@tiptap/pm` (ProseMirror) in the host: two copies fail at run time with "Duplicate use of selection JSON ID". `node scripts/kvox-packages/check-single-instance.mjs --guard '@tiptap/*'` checks it.

## Configuration

The hooks and pages read their host (`useKvoxHost`); there is no other configuration object. Host members that matter to this slice:

- `host.sse.connect`: the generation stream (`GET /api/notes/:id/stream`, `GET /api/note-generations/:id/stream`). The slice reconnects with backoff and sends the last frame id as `Last-Event-ID`; every delta is written AT its offset, so a host (or a server) that replays from the start duplicates nothing.
- `host.useLatestEventId(prefix)` (optional): the library and the note page pass `notes.` so a list re-reads itself the moment a note event arrives.
- `host.viewer()`: which of `notes:read`, `notes:write` gate the controls.

The pages that need AI take `ai` (`NotesAiAccess`): a hook returning `{ isLoading, loadError, keyConfigured, available, models, defaultModel }` and the "add your AI key" state. Without it the page behaves as for a viewer with no AI.

## Extension-point catalog

- `NotePageSlots` (prop `slots` of `NotePage`), every member optional, default renders nothing, every leaf slot contained by `NotesSlotBoundary` (a slot that throws renders nothing and logs):
  - `Provider`: `ComponentType<{ noteId, children }>`, wraps the whole page (loading and error states included) so the other slots can share state. It must render `children` and add no element.
  - `useAsideWidth`: a hook returning the pixel width of a panel the page makes room for at `lg` and up, or `0`.
  - `HeaderActions`: `ComponentType<{ noteId }>`, extra actions in the header after History.
  - `ProposalActions`: `ComponentType<{ noteId, version, bodyRef, originTranscriptId }>`, a panel over the note's connected-knowledge proposal.
  - `SelectionActions`: `ComponentType<{ noteId, version, markdown, containerRef, enabled, onReload }>`, an action over a text selection in the rendered body.
- `NotesLibrarySlots.SearchPrefix` (prop `slots` of `NotesPage` and `NotesLibraryView`): `ComponentType<{ query }>`, rendered above the ranked results while the search box holds a query.
- `NotesAiAccess` (prop `ai` of `NotePage`, `NewNotePage` and `UserNoteTemplatesPage`).
- `NotesPage`'s `secondaryAction` (#585): a node rendered beside "New note" in the header at every width (KVox Desktop's "Import…"); it gates itself.
- `NewNotePage` query parameters: `?transcriptId=` and `?templateId=` pre-select a source transcript and a template; `?objectId=` (#585) pre-selects a document the host already uploaded (with `?documentName=` as its display name) and polls its extraction, which is how KVox Desktop offers "Create note" after an import.
- `importNoteMarkdown(host, file)` (#585): `POST /api/notes/import`, a Markdown note export (or any Markdown or text file) into a new note.
- `TranscriptNotesSection`: the component the transcript page draws through its `NotesSection` slot.
- `kvoxNotesDestinations`: one destination, `notes` ("Notes" for both labels, the page icon, `/notes`, `notes:read`, not pinned). `kvoxNotesDestinationRoutes`: its single ownership prefix `/notes`.
- `kvoxNotesUserSettingsSections.account`: the Note Templates card, with NO `permission` (the API's `note_templates:*` permissions are seeded to every role, and the page's real gate is the key).
- `kvoxNotesRoutes`: `/notes`, `/notes/:id` and `/notes/:id/history` gated on `notes:read` (a viewer without it is sent home), `/notes/new` on `notes:write` (sent back to the list through `redirectTo`) and `/settings/note-templates` ungated. The pages are lazy. The pages that take slots or `ai` need a wrapper, so an app that fills them replaces those `Component`s.
- Working example: the web edition wires every slot in `apps/web/src/kvox/` (`noteSlots.tsx`: the review sheet and extract dialog, the header button, "Add to graph" and the `?review=1` link over the graph UI; `noteAiAccess.tsx`; `NotePageWithSlots.tsx`; `NotesLibraryWithSlots.tsx`; `notesRoutes.ts`).

Security notes: `MarkdownView` ignores embedded HTML and never renders it. There is no `rehype-raw` and no `rehypePlugins` passthrough, because AI-generated text is untrusted; a caller can add remark (markdown-tree) plugins only. A 409 `ai_key_missing` or `ai_not_configured` from creating or regenerating a note is a branch the pages handle with their own copy, not an error message.
