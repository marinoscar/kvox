# Data export ("Download your data")

> A signed-in user asking this deployment for a copy of what it stores about them (issue #532, Part B of #479). The routes, the `export.run` and `export.purge` jobs, the writers and the `user-data` and `org-data` sources are the **platform exports slice's** (`@marinoscar/platform-api/exports`, `@marinoscar/platform-web/exports/ui`). This application decides **what is in the file**: the policy below, and one source of its own. Wire contract: the `### Exports` section of [`docs/API.md`](../API.md).

Implemented in `apps/api/src/platform/exports/` (`exports.config.ts`, `exports-host.module.ts`, `exports-notifier.adapter.ts`, `kvox-content.source.ts`), `apps/api/src/app-registrations/user-owned-models.ts` (the policy), `apps/api/src/notifications-registry/exports.notifications.ts` and the `Your data` group of `apps/web/src/config/userSettingsSections.tsx` (page `/settings/data-export`). Pinned by `apps/api/test/exports/` and the `exports` suite of `apps/api/test/conformance.spec.ts`.

## 1. How a file is made

1. `POST /api/exports` validates the source, the format and the caller's permission (`user_settings:read` for both user sources), refuses a fourth in-flight export (429) and enqueues `export.run` (server-only).
2. The handler streams the source's datasets through the chosen writer into object storage under `exports/users/<userId>/<exportId>.<ext>`; rows are paged by id and read through the **bypass client** with an explicit owner filter on every query. A half-written file is destroyed, never uploaded.
3. `export.ready` (or, after the last attempt, `export.failed`) reaches the bell and Web Push, linking to `/settings/data-export`. The signed download is minted on each `GET /api/exports/:id`.
4. `export.purge` (a daily cron that only enqueues) deletes files older than 7 days.

Default redaction applies to every source and cannot be switched off: a column named `secret`, `password`, `hint`, `tokenHash` or ending in `Secret`, `Hash`, `Ciphertext` or `Salt`, and any `Bytes` column, is never written. The user's AI provider keys are the platform's `user_ai_keys`, classified by the platform, not here.

## 2. Two sources

| Source | Owner | Contents |
|---|---|---|
| `user-data` | platform | The account row, then one dataset per model the user-owned registry marks `export: 'include'` (table 3), rows where the owner column is the user. |
| `kvox-content` | this application | Datasets that need a **parent-keyed** filter (table 4). |

`org-data` (an organization's rows and member list, for `org_members:read`) stays on as the platform's default. No model of this app is org-kind, so it carries none of the content in this document.

`kvox-content` is registered **after** `ExportsModule.forRoot` so `user-data` stays the first source in the dialog. Unlike `user-data`, it **lists** its formats (`json`, `csv`, `xlsx`): the built-in writers attach only to the platform's own source ids, and the slice silently drops a source that offers no format.

## 3. The policy of the user-owned registry

`include` means the platform writes the model; `exclude` means it does not (and the conformance suite proves none of its columns reaches a file). The rationale of each entry is in `user-owned-models.ts`.

| Model | Export | Why |
|---|---|---|
| `Transcript`, `Note`, `NoteTemplate`, `AskConversation` | include | The user's own content, owner-keyed. |
| `UserHiddenNoteTemplate` | include | Small user-authored preference. |
| `KgEntity` | include, omit `props`, `embeddingModel`, `embeddingHash` | The user's map of people, places and topics. `props` can hold an attribute value whose definition is `sensitive`, and a column cannot be filtered per key. The embedding vector is `Unsupported` (absent from the datamodel). |
| `KgEntityAlias` | include | Names of an exported entity. |
| `KgRelation` | include, omit `props` | An edge between exported entities; a relation prop defaults to its type's sensitivity. |
| `KgItem`, `KgEvidence` | **exclude** | **A `sensitive` PersonFact never leaves the deployment**, for any purpose or setting (root `AGENTS.md`). The platform source cannot filter by sensitivity, so the whole model and its quotes stay out. |
| `TranscriptSegment`, `NoteVersion` | exclude, exported by `kvox-content` | Actor-only models (`editedById`, `authorId`): the platform source would export the segments the user merely edited in **someone else's** shared transcript and miss the segments of their own transcript that others edited. |
| `KgAttributeDef` | exclude, exported by `kvox-content` | Exported with every definition classed `sensitive` left out, as the ontology and RDF artefacts do. |
| `TranscriptVersion`, `TranscriptExport`, `TranscriptNameCheck`, `TranscriptNameSuggestion`, `NoteExport`, `SearchIndexState`, `KgMention`, `KgProposal`, `KgMerge`, `KgDistinctPair`, `KgEntityDigest`, `KgExport`, `KgGraphLayout`, `KgEntityView` | exclude | Derived, bulky, transient or bookkeeping; a proposal can carry a sensitive PersonFact before it is decided. |

## 4. The `kvox-content` datasets

| Dataset | Where (always through the parent) | Left out |
|---|---|---|
| `transcript_speaker` | `transcript.ownerId = user` | |
| `transcript_segment` | `transcript.ownerId = user` | `words`, `wordsAlignment` (per-word timings: the largest data in the schema, derived from the text) |
| `note_version` | `note.ownerId = user` | |
| `ask_message` | `conversation.ownerId = user` | `toolCalls` (the agent's execution trace) |
| `kg_attribute_def` | `ownerId = user` and not `sensitivity = sensitive` | |

A transcript shared **to** the user is not exported (only the owner's rows are), and nothing is keyed by an actor column.

## 5. Not exported, by design

File bytes (the audio, renditions and rendered exports): the `storage_object` dataset is a manifest. Transcripts and notes shared with the user by others. Another user's anything: there is no `read_any` for transcripts, notes or the graph.

## 6. Changing the policy

Add a model: classify it in `user-owned-models.ts` (the `user-owned-data` conformance suite fails otherwise). To export a model whose rows cannot be selected by its own owner column, add a dataset to the dataset list in `kvox-content.source.ts` with a parent-keyed `where`, mark the model `exclude`, and extend the export policy spec in `apps/api/test/exports/`. Never export `KgItem` or `KgEvidence` without a sensitivity filter that the spec proves.

Follow-up worth doing: a sensitivity-aware entity dataset that exports `props` per key (the attribute definitions already say which are sensitive).
