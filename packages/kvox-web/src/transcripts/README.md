# transcripts

The transcripts UI of `@marinoscar/kvox-web`: the library, the upload flow, the transcript viewer and editor, the version history, and the clients, hooks and upload manager under them.

## Purpose and scope

Everything a person does with a transcript in the browser: list and search the library (Mine and Shared with me), upload or record a source with progress that survives navigating away, watch a transcript process, read it with synced playback, edit it (rename speakers, edit, split and merge lines, find and replace, recorded-at), fix names with the AI name check, export it, share it, and browse and restore earlier versions.

The headless half holds the six API clients (`/api/transcripts/**`: reads with a conditional `If-None-Match`, edits, versions, exports, name checks and the browser's resumable upload sessions), the hooks over them (`useTranscripts`, `useTranscript`, `useTranscriptOperations`, `useTranscriptVersions`, `useTranscriptWords`, `useTranscriptSearch`, `useNameCheck`, `usePlaybackEngine`, `useSourceAudio`, `useLibraryAudioPreview`), the upload manager (`KvoxUploadManagerProvider`, `useUploadManager`, `useLiveUploadTranscriptIds`) and the pure helpers (status descriptors, playback intervals, version sessions, the new-transcript form rules, the library's deep-link parsers). The ui half holds `TranscriptsPage`, `TranscriptPage`, `TranscriptHistoryPage`, `NewTranscriptPage`, `TranscriptsLibraryView`, `TranscriptStatusChip`, the slot contracts, and the destination and the routes as data.

The slice imports only `core`, `transcription` and `search`. It imports nothing from the notes, graph or ask slices: what those add to the transcript page comes in through slots. Everything else it needs from the host (who is signed in, the AI key state, how a share is managed) it reads from `KvoxWebHost` or takes as a prop.

Status: filled (Epic 7, issue 7.2).

## Entry point

- `@marinoscar/kvox-web/transcripts/headless`: the clients (`getTranscripts`, `getTranscript`, `getTranscriptSegments`, `getTranscriptWords`, `getTranscriptAudio`, `getTranscriptSummary`, `updateTranscript`, `deleteTranscript`, `retryTranscript`, `cancelTranscript`, the editing, version and name-check calls, the upload-session helpers, and the JSON import (`importTranscript`, `transcriptImportErrorMessage`, `checkTranscriptImportFile`, `isImportedTranscript`); each takes the host first; the export client is used by the export dialog and not exported), the hooks above, `KvoxUploadManagerProvider`, the pure helpers (`formatDuration`, `formatTimestamp`, `formatBytes`, `transcriptStatusDescriptor`, `failureMessage`, `processingStageLabel`, `isUploadInterrupted`, `SPEAKER_PALETTES`, `TRANSCRIPT_STATUS_FILTERS`, `searchFromQuery`, `transcriptScopeFromQuery`, `transcriptStatusFromQuery`) and the wire types.
- `@marinoscar/kvox-web/transcripts/ui`: the pages, `TranscriptsLibraryView`, `TranscriptStatusChip`, `ImportTranscriptButton` (the "Import transcript (JSON)" action, in the library header and on `/transcripts/new`), `SlotBoundary`, the slot types (`TranscriptPageSlots`, `TranscriptsLibrarySlots`, `TranscriptSelectionActionsProps`, `TranscriptSpeakerPeople`, `TranscriptSharingAdapter`, `TranscriptShareDialogProps`, `TranscriptAiAccess`, `TranscriptAiState`), `kvoxTranscriptsDestinations`, `kvoxTranscriptsDestinationRoutes` and `kvoxTranscriptsRoutes`.

The slice depends on `core`, `transcription` and `search`. Mount `KvoxUploadManagerProvider` ONCE, at the app root, inside the host provider: it owns the in-flight uploads, so a provider mounted inside a page loses them on navigation. The app spreads `kvoxTranscriptsDestinations` into its destination table directly after Home, `kvoxTranscriptsDestinationRoutes` into its ownership table, and renders `kvoxTranscriptsRoutes` where its literal routes used to be.

## Peer dependencies

`@marinoscar/kvox-contract`, `react` and `react-dom` for the headless entry. `ui` adds `@mui/material`, `@mui/icons-material`, `react-router-dom` and `@tanstack/react-virtual` (the segment list is virtualized), all optional peers of the package.

The browser APIs the engine and the upload manager use are each guarded, so a webview without them degrades instead of throwing: `HTMLAudioElement`, the Media Session API, the Screen Wake Lock API (the keep-awake toggle simply does nothing), IndexedDB (the resumable-upload session store reports "storage unavailable" and uploads run without resume) and `XMLHttpRequest` (used for part uploads only when the host has no `upload.putPart`).

## Configuration

The hooks and pages read their host (`useKvoxHost`); there is no other configuration object. Three host members matter to this slice:

- `host.upload` (optional): the part-upload port. Without it the upload manager uses `XMLHttpRequest` against the signed part URLs the API returns. Part URLs are short-lived: the manager re-signs through the API when one expires and never stores one.
- `host.useLatestEventId(prefix)` (optional): a hook returning the id of the newest notification whose event key starts with `prefix`. The library and the viewer pass `transcripts.` so a list re-reads itself the moment a processing event arrives; without it they poll alone.
- `host.links.transcript(id)` and `host.viewer()`: where a row opens, and which `transcripts:*` and `notes:*` permissions gate the controls.

The pages take props for what the slice must not import: `slots` (below), `sharing` (`TranscriptSharingAdapter`: the share dialog and "leave"; without it the row menu and the page offer neither) and `ai` (`TranscriptAiAccess`: the viewer's AI availability and the "add your key" state; without it the page offers no name check).

## Extension-point catalog

- `TranscriptPageSlots` (prop `slots` of `TranscriptPage`), every member optional, default renders nothing, every component slot contained by `SlotBoundary` (a slot that throws renders nothing and logs):
  - `NotesSection`: `ComponentType<{ transcriptId }>`, the notes made from this transcript. Rendered for a viewer holding `notes:read` once the transcript content has arrived.
  - `useSpeakerPeople`: a hook `(transcriptId, enabled) => { entityIds, open } | null` telling which speakers are a known person; the speaker chips draw an "Open the person's page" button for each. It is a hook and runs on every render, so it must follow the rules of hooks; `enabled` is false until the transcript is ready.
  - `SelectionActions`: `ComponentType<TranscriptSelectionActionsProps>`, an action over a text selection inside one line (`containerRef`, `segments`, `enabled`). Rendered once the transcript is ready.
  - `HeaderActions`: `ComponentType<{ transcriptId }>`, extra actions after the page's own.
- `TranscriptsLibrarySlots.SearchPrefix` (prop `slots` of `TranscriptsPage` and `TranscriptsLibraryView`): `ComponentType<{ query }>`, rendered above the ranked results while the search box holds a query.
- `TranscriptSharingAdapter` and `TranscriptAiAccess` (props `sharing` and `ai`).
- `kvoxTranscriptsDestinations`: one destination, `transcripts` ("Transcripts" for both labels, the waveform icon, `/transcripts`, `transcripts:read`, not pinned). `kvoxTranscriptsDestinationRoutes`: its single ownership prefix `/transcripts`.
- `kvoxTranscriptsRoutes`: `/transcripts` and `/transcripts/:id` and `/transcripts/:id/history` gated on `transcripts:read` (a viewer without it is sent home), and `/transcripts/new` on `transcripts:write` (sent back to the list, through the route's `redirectTo`). The pages are lazy. The list and the viewer take slots, so an app that fills them replaces those two `Component`s with a wrapper that passes the props.
- Working example: the web edition wires every slot in `apps/web/src/kvox/` (`transcriptSlots.tsx`: the notes section, person links and "Add to graph" over the graph UI and the graph hits above the search results; `transcriptSharing.tsx`; `transcriptAiAccess.tsx`; `transcriptsRoutes.ts`; the two `*WithSlots` wrappers).
