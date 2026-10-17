# ask

The Ask UI of `@marinoscar/kvox-web`: questions answered by the read-only agent over the viewer's own knowledge graph, with streamed answers, tool steps and citation chips, as a page of its own and as a panel on the entity page.

## Purpose and scope

Everything a person does with Ask in the browser: start a conversation and ask a question (`/ask`, `/ask/:conversationId`), watch the answer stream in with the lookups the agent made and its citations as chips (a source quote, an entity, a transcript moment, a note), reload mid-answer and pick the answer back up, rename or delete a saved conversation (deleting one mid-turn shows the "no longer available" state), pick a different model for a conversation, and ask about one entity from its page ("Ask about Joe", a drawer scoped to that entity whose conversations also appear on `/ask`).

The headless half holds the API client (`/api/ask/conversations/**`, each call taking the host first), the answer stream (`GET /api/ask/messages/:id/stream` over `host.sse`: `delta`, `step`, `done` and `error` frames, with the content offset as the frame id so a reconnect resumes with `Last-Event-ID`), the narrow read of `/api/ai-tasks/config`, the hooks over them (`useAskConversations`, `useAskConversation`, `useAskStream`, `useAskAiConfig`) and the pure helpers (the error and caption copy, the citation-marker parser `remarkAskCitations` with its counters, the model choices, the entity suggestions). The ui half holds `AskPage`, `AskThread`, `AskComposer`, `ConversationList`, `EntityAskPanel` and `EntityAskButton`, the two slot components for the graph entity page, and the route as data.

The slice imports `core`, `transcripts` (one timestamp formatter), `notes` (`MarkdownView`, `ModelSelect`) and `graph` (`EvidenceChip`, `EntityTypeIcon`, the entity hooks). The graph slice imports nothing from this one: the Ask action and panel of its entity page come in through `GraphEntityPageSlots`, and `AskEntityButtonSlot` and `AskEntityPanelSlot` fill them. The wire types are `@marinoscar/kvox-contract/ask`.

Status: filled (Epic 7, issue 7.6).

## Entry point

- `@marinoscar/kvox-web/ask/headless`: the client functions (`listAskConversations`, `getAskConversation`, `createAskConversation`, `renameAskConversation`, `deleteAskConversation`, `postAskMessage`), the stream (`connectAskStream` and its frame parsers), the hooks, `askErrorClassCopy`, `askSendErrorCopy`, `askFinishReasonCopy`, `entityAskSuggestions`, `askModelOptions`, `askDefaultModel` and the wire types. No component, no `@mui/*`, no router.
- `@marinoscar/kvox-web/ask/ui`: `AskPage`, `AskThread`, `AskComposer`, `ConversationList`, `EntityAskPanel`, `EntityAskButton`, `AskEntityPanelSlot`, `AskEntityButtonSlot` and `kvoxAskRoutes`.

The app renders `kvoxAskRoutes` where its literal `/ask` route used to be, and passes the two slot components as `GraphEntityPageSlots.AskPanel` and `AskButton`. There is no destination: the graph slice's `knowledge` destination already owns the `/ask` prefix, and four non-pinned tabs is the ceiling.

## Peer dependencies

`@marinoscar/kvox-contract`, `react` and `react-dom` for the headless entry. `ui` adds `@mui/material`, `@mui/icons-material` and `react-router-dom`, and `react-markdown` (an optional peer of the package; the answer is rendered through the notes slice's `MarkdownView`). `remarkAskCitations` imports only a type and walks the tree by hand, so it adds no peer.

Keep ONE copy of `react-markdown` (and so of `unified`) in the host: the citation plugin walks the tree that `react-markdown` builds, and a second copy can change node shapes silently. `node scripts/kvox-packages/check-single-instance.mjs --guard react-markdown` checks it. The sigma and graphology peers are the graph slice's and are loaded lazily by its pages, not by this one.

## Configuration

The hooks and pages read their host (`useKvoxHost`); there is no other configuration object. Host members that matter to this slice:

- `host.http`: `/api/ask/conversations/**` and `GET /api/ai-tasks/config` (the tool-capable models, the `graph.agent` default, `keyConfigured`, `graphEnabled`; `notes:read`, seeded to every role).
- `host.sse.connect`: the answer stream. The first attempt names the offset the page already holds (`?lastEventId=`), later attempts send the last frame's id as `Last-Event-ID`; the stream is SELF-CLOSING on a terminal frame and is closed on unmount, which never cancels the turn (`ask.respond` finishes whether or not anybody watches).
- `host.features().graphEnabled`: connected knowledge is on. Both slot components return nothing unless it is exactly `true`; the page shows an info state, with no composer, only when the configuration says `false` (an older server that says nothing reads as unknown, not off).
- `host.viewer()`: `graph:read` gates the route and both slots. It is the exact string every `/api/ask/**` route enforces; there is no `ask:*` pair.
- `host.links`: `conversation(id)` for a conversation row and "Open in Ask", `entity(id)` for the scope chip and entity citations, `transcript(id)` and `note(id)` for document citations (a transcript citation opens at the cited moment, `?t=<ms>`). The route `/ask` itself and `/settings/ai` (the fix for a missing key) are written as paths.

The 404-never-403 rule holds: a conversation that is not the caller's is the same "This conversation doesn't exist" as one that was deleted. Rendered answers never contain raw HTML: a marker the API flagged `valid: false`, or one it never issued, is removed from the text and counted in the "couldn't be verified" caption, never rendered as a link. The stream reader gives up with `timeout` and reason `stream_duration_cap`; the conversation hook then re-reads the stored message and re-attaches if the turn is still running. A `gone` error frame (the conversation was deleted mid-turn) re-reads the row, which answers 404. Pixels, markup and accessible names are unchanged by the move.

Data: none. The only browser storage is the model chosen per conversation, in `sessionStorage` (never `localStorage`: nothing about a conversation outlives the tab), read and written inside try/catch.

## Extension-point catalog

- `AskEntityButtonSlot` and `AskEntityPanelSlot` (`ui`, `@extensionPoint slot`): fill `GraphEntityPageSlots.AskButton` and `AskPanel`. Each draws nothing unless the viewer holds `graph:read` and connected knowledge is on, so a host wires them unconditionally; the panel reads the viewer's AI configuration itself (`useAskAiConfig`). The graph page owns the `?ask=` parameter (open state and conversation).
- `kvoxAskRoutes` (`ui`, `@extensionPoint route`): `/ask/:conversationId?` on `graph:read` (a viewer without it is sent home), one route with an optional segment so `/ask` to `/ask/:id` after the first question keeps the page mounted. The page is lazy.
- `AskPage`, `AskThread`, `AskComposer`, `ConversationList`, `EntityAskPanel` and `EntityAskButton` (`ui`): the pieces a host can lay out differently. `AskThread` and `AskComposer` take props and callbacks only, so the panel and the page share them. `EntityAskPanel` takes the AI configuration as a prop (`config`), which the slot supplies from `useAskAiConfig`.
- `remarkAskCitations` (`headless`): the `react-markdown` plugin that turns `[^ev7]`-style markers into citation nodes.
- Working example: the web edition wires the slice in `apps/web/src/kvox/GraphEntityPageWithSlots.tsx` (the slots) and `apps/web/src/App.tsx` (`renderKvoxRoutes(kvoxAskRoutes)`).

Security notes: the model's text is never markup (`MarkdownView` has no raw-HTML path, and the citation nodes are built from the validated `citations` array). The send error copy shows the API's own message only for a 4xx. Testing: the slice is tested against `createFakeKvoxWebHost` from `@marinoscar/kvox-web/core/testing`; `test/ask/ask-error-copy.test.ts` fails when the contract gains an error class, conflict reason or finish reason that has no copy.

### Desktop

Desktop passes the two slot components to the graph entity page and renders `kvoxAskRoutes`; the model picker lists only what the host's `/api/ai-tasks/config` reports as tool-capable, and without a provider key the composer shows the "add your key" notice. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#offline-constraints-feature-by-feature).
