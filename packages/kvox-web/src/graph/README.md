# graph

The connected-knowledge UI of `@marinoscar/kvox-web`: the knowledge index, the entity page, the explorer, the whole-graph overview, RDF import, the proposal review sheet and the Knowledge graph settings page, plus ready-made slot components for the transcript and note pages and both libraries.

## Purpose and scope

Everything a person does with their knowledge graph in the browser: list and search entities (`/graph`), read everything about one (`/graph/entities/:id`: the brief, the neighbourhood, connections, the timeline, mentions with evidence chips), edit or forget it, set a Person's manager, employer or role by hand, explore the graph from seeds (`/graph/explore`), see the whole graph by cluster (`/graph/overview`), review and import an RDF file (`/graph/imports/:proposalId`), see every proposal waiting for review (`/graph/review`), review the proposal a note or transcript produced (the review sheet, the extract dialog, "Add to graph" on a text selection), and set their own extraction preferences, domains and attribute definitions (`/settings/knowledge-graph`).

The headless half holds the API client (`/api/graph/**`, plus the `/api/ai-tasks/config` read the extract dialog needs), the hooks over it (`useGraphEntity`, `useGraphEntities`, `useGraphBrief`, `useGraphTimeline`, `useGraphMentions`, `useGraphEvidence`, `useGraphOverview`, `useGraphProposal` (option `awaitUntil`; constants `PROPOSAL_POLL_MS`, `NOTE_EXTRACTION_FOLLOW_MS`), `useGraphReviewQueue`, `useEntityRelationEdits`, `useGraphOntology`, `useGraphEffectiveOntology`, `useGraphPreferences`, `useGraphAttributeDefs`, `useGraphExport`, `useGraphImport`, `useGraphExtractEstimate`, `useGraphTranscriptPeople`, `useGraphAiConfig`) and the pure helpers (display, spans, proposal grouping, explorer filters and hand-off, guidance, selection resolvers). The ui half holds the pages, the pieces other screens embed (`EvidenceChip`, `NeighborhoodWidget`, `EntityConnectionsList`, `EntityRelationDialog`, `SchemaForm`, `EntityTypeIcon`, `ProposalReviewSheet`), the explorer hook and models, the slot components, and the destination, routes and card as data.

The slice imports `core`, `transcripts`, `notes` and `search` and nothing from `ask`, which depends on it: the entity page's "Ask about this entity" action and panel come in as slots. The ontology is read from `@marinoscar/kvox-contract/ontology`.

Status: filled (Epic 7, issue 7.5).

## Entry point

- `@marinoscar/kvox-web/graph/headless`: the client (each call takes the host first), the hooks above, the preference types and defaults, the pure helpers and the wire types. No component, no `@mui/*`, no router, and none of the drawing libraries.
- `@marinoscar/kvox-web/graph/ui`: the seven pages (with `GraphReviewPage` and its `reviewTarget`), `EvidenceChip`, `NeighborhoodWidget`, `EntityConnectionsList`, `EntityRelationDialog` and `ENTITY_RELATION_EDITS`, `SchemaForm`, `EntityTypeIcon`, `entityPath`, `ProposalReviewSheet`, `useGraphExplorer`, the slot components and slot types, `kvoxGraphDestinations`, `kvoxGraphDestinationRoutes`, `kvoxGraphUserSettingsSections` and `kvoxGraphRoutes`.
- `@marinoscar/kvox-web/graph/testing`: `mockGraphCanvas`, the stand-in for the WebGL canvases. Test code only.

The app spreads `kvoxGraphDestinations` into its destination table directly after Notes, `kvoxGraphDestinationRoutes` into its ownership table, `kvoxGraphUserSettingsSections.knowledge` into a `Knowledge` group between `Account` and `Security`, and renders `kvoxGraphRoutes` where its literal graph routes used to be.

## Peer dependencies

`@marinoscar/kvox-contract`, `react` and `react-dom` for the headless entry. `ui` adds `@mui/material`, `@mui/icons-material` and `react-router-dom`, and the drawing libraries, all optional peers of the package and needed by this entry only: `sigma`, `@react-sigma/core`, `graphology` and `graphology-layout-forceatlas2`. `testing` needs only `react`.

Keep ONE copy of `graphology` in the host: sigma tests graphs with `instanceof`, so two copies draw nothing. `node scripts/kvox-packages/check-single-instance.mjs --guard graphology` checks it. The module-level hand-off between the overview and the explorer (`setExplorerHandoff`) is likewise per package copy, so a duplicated `@marinoscar/kvox-web` would lose it.

## Configuration

The hooks and pages read their host (`useKvoxHost`); there is no other configuration object. Host members that matter to this slice:

- `host.features().graphEnabled`: connected knowledge is on for this deployment. Every slot component returns nothing unless it is exactly `true`, and so does the Ask action of the entity page; `undefined` (not known yet) reads as off.
- `host.viewer()`: `graph:read` gates reading, `graph:write` the extract dialog, "Add to graph", import and the Knowledge graph page.
- `host.links.entity(id)`: where a speaker's person link goes.
- `host.http`: `/api/graph/**`, `/api/ai-tasks/config` (the models and the key notice of the extract dialog; `notes:read`) and `/api/user-settings` (the preferences of the Knowledge graph page: `GET`, and `PATCH` with `If-Match` carrying the document's version, retried once after a 409).

The 404-never-403 rule holds in the UI: an entity the API will not show answers "This page does not exist, or you no longer have access to it", never a permission message. `sensitive` person facts stay hidden unless the API returns them (`includeSensitive`); nothing is inferred client-side.

Permissions: `graph:read` opens every read route and the `knowledge` destination; `graph:write` gates the Knowledge graph page, import, the extract dialog, editing, forgetting and "Add to graph", and is checked again inside each control. The Knowledge graph card sets the user's `graph` settings namespace (`extraction`, `resolution`, `domains`) and their own attribute definitions; both are sparse, and a default is never written into the row.

UI: pages and components are MUI and need `react-router-dom`. The explorer, the overview and the entity page's neighbourhood widget draw with sigma, which is WebGL only: `GraphCanvas.tsx` is the one file that imports `sigma` and `@react-sigma/core`, and every screen reaches it through `React.lazy` (`canvasLoaders`), so a screen that never draws a graph never downloads either library, and the list view of the explorer and overview does not either. Without WebGL (`isWebGLAvailable`) the explorer and the overview force their list view and the widget hides itself. The destination's runtime-flag gate (`feature: 'graph'`) is the app shell's: the row is hidden while the switch is unknown. Pixels, markup and accessible names are unchanged by the move.

Data: the slice has no storage of its own. The module-level caches are per package copy and per page load: the effective ontology (`useGraphOntology`, dropped with `invalidateGraphOntology`), the evidence links (`useGraphEvidence`, dropped with `clearEvidenceCache`) and the explorer hand-off between the overview and the explorer. Every server fact is read through `host.http`.

## Extension-point catalog

- `GraphEntityPageSlots` (prop `slots` of `GraphEntityPage`): `AskButton` (`{ entityId, entityLabel, onClick }`, drawn in the entity header) and `AskPanel` (`{ entityId, entityLabel, entityType, open, onClose, conversationId, onConversationChange }`, the panel it opens). The page keeps the `?ask=` search parameter (open state and conversation), so a reload reopens the conversation and the back gesture closes the panel. Both render only while `graphEnabled` is `true`.
- `graphTranscriptPageSlots`: the `useSpeakerPeople` (`useGraphSpeakerPeople`: speakers that are a person in the graph get an "Open the person's page" link) and `SelectionActions` (`GraphTranscriptSelectionActions`: "Add to graph" from a selection within one line, `graph:write`) members of the transcript page's slots, to spread next to the host's `NotesSection`. `graphTranscriptsLibrarySlots`: `SearchPrefix`, entity hits above the ranked results.
- `graphNotePageSlots`: every member of the note page's slots. `GraphNotePageProvider` holds the proposal and the open state of the review sheet and the extract dialog once for the page, opens the sheet for `?review=1` and then drops the parameter (its `ready` prop, default `true`, lets a host whose switch loads asynchronously hold that until it has); when the note turns `ready` (or the page opens within `NOTE_EXTRACTION_FOLLOW_MS`, 30 s, of it) it keeps re-reading the proposal for that window, through `useGraphProposal`'s `awaitUntil` option, so an automatic extraction appears without a reload); `useGraphNoteAsideWidth` makes room for the sheet at `lg` and up; `GraphNoteHeaderActions` is the review button with its undecided count; `GraphNoteProposalActions` is the sheet and the extract dialog; `GraphNoteSelectionActions` is "Add to graph" on the rendered body. `graphNotesLibrarySlots`: `SearchPrefix` for the notes library; `GraphSearchPrefix` is the component behind both.
- Every slot component returns `null` when connected knowledge is off or the viewer lacks the permission, so a host wires them unconditionally.
- `kvoxGraphDestinations`: one destination, `knowledge` ("Knowledge" for both labels, the hub icon, `/graph`, `graph:read`, `feature: 'graph'`, not pinned). With the switch off or unknown the row is hidden, never shown and then removed. `kvoxGraphDestinationRoutes`: its ownership prefixes `/graph` and `/ask`; the ask slice adds routes under it, never a fifth bottom-bar destination (four non-pinned tabs is the ceiling).
- `kvoxGraphUserSettingsSections.knowledge`: the Knowledge graph card, with `permission: 'graph:write'`, the exact string the attribute-definition write routes enforce.
- `kvoxGraphRoutes`: `/graph`, `/graph/entities/:id`, `/graph/explore`, `/graph/overview`, `/graph/review` on `graph:read` (a viewer without it is sent home), `/graph/imports/:proposalId` on `graph:write` (sent to `/graph`) and `/settings/knowledge-graph` on `graph:write` (sent to `/settings`). The pages are lazy; the entity page takes slots, so an app that offers Ask replaces its `Component` (the web edition does, in `apps/web/src/kvox/graphRoutes.ts`).
- Working example: the web edition wires the slots in `apps/web/src/kvox/` (`noteSlots.tsx`: the AI provider in front of `GraphNotePageProvider`; `transcriptSlots.tsx`; `GraphEntityPageWithSlots.tsx`, which passes the ask slice's `AskEntityButtonSlot` and `AskEntityPanelSlot`; `graphRoutes.ts`).

### Manual relation edits (#586)

On the entity page of a Person, for a caller with `graph:write`, the Connections section (`EntityConnectionsList`, props `entityType`, `canEdit`, `onChanged`) offers three buttons, "Set manager" (`REPORTS_TO` → Person), "Set employer" (`WORKS_FOR` → Organization) and "Add role" (`HAS_ROLE` → Organization). Each opens `EntityRelationDialog`, titled with the action: a combobox over the caller's own graph named "Manager", "Employer" or "Organization" (`EntitySearchField`, filtered to the allowed type), for a role the text boxes "Title" (required) and "Business unit", an optional date box "Since" (empty means today), and "Cancel" / "Save". Each stored outgoing manager, employer or role row has a button named "Remove <group> <label>" (for example "Remove Reports to Mark Chen") that opens "Remove this connection?" with "Cancel" / "Remove". A save or removal shows "Saved." or "Removed." in a status alert and re-reads the list, the neighbourhood canvas and the brief. The server closes the earlier open edge of the same kind at the new date and cites the relation "Set by hand"; the evidence chip names such a citation "Set by hand". Headless: `setEntityRelation`, `removeEntityRelation` and `useEntityRelationEdits(entityId)` (`{ setRelation, removeRelation, isSaving, error, clearError }`).

### Review (`/graph/review`)

`GraphReviewPage` lists the caller's draft proposals (`useGraphReviewQueue`: `GET /api/graph/proposals?status=draft`, 20 at a time, "Load more"): a heading "Review", then one link per proposal named after its source with the rows still to decide and in total. A note extraction links to `host.links.note(noteId)` + `?review=1` (the note page opens its review sheet), an import to `/graph/imports/:id`; a `resolution` proposal has no review page and is not listed. Nothing waiting reads "Nothing to review". The index page links to it next to Explore and Overview.

Security notes: no HTML is injected: evidence quotes, labels and AI-written text render as React text. A forget request carries the typed confirmation (`FORGET_CONFIRMATION`) and the dialog makes the person type the person's name first. `sensitive` person facts are shown only when the API returns them, and never exported or bulk-accepted from here. A 404 from the API is shown as "not found", never as a permission error, so a foreign id leaks nothing. Testing: the slice is tested against `createFakeKvoxWebHost` from `@marinoscar/kvox-web/core/testing`, and `mockGraphCanvas` from `@marinoscar/kvox-web/graph/testing` stands in for the canvases.

### Desktop

Desktop spreads the same data and passes the slot components; without a provider key the extract dialog and the review sheet's model label still render, and "Ask about this entity" is simply not offered unless the host fills the slots. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#offline-constraints-feature-by-feature).
