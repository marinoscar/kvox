# User Data Deletion

> The "Danger Zone": an authenticated user asking this deployment to forget
> some or all of the data it holds for them, in bulk, with no administrator in
> the loop on either side (issue #80). Since issue #480 (epic #478) the routes,
> the `user.data.purge` job and the page are the **platform user-data slice's**
> (`@marinoscar/platform-api/user-data`, `@marinoscar/platform-web/user-data/ui`).
> This application only **registers** what it owns: categories, scopes and
> one hint per owner model. The slice's own design (the planner, the registries,
> the security notes, the conformance suite) is the platform's spec,
> `docs/specs/user-data-reset.md` in the EnterpriseAppBase repository (the
> platform's source; written without a URL because the identity guard bans the
> owner slug in a link), and the package README under
> `node_modules/@marinoscar/platform-api/`.
> This document is what is specific to this application: its registrations,
> the delegates, the one job type it adds, and the places its behaviour differs
> from what it did before the swap. The wire contract is the `### User Data`
> section of [`docs/API.md`](../API.md).

Implemented in `apps/api/src/platform/user-data/` (`user-data.manifest.ts`,
`user-data.config.ts`, `user-data-host.module.ts`),
`apps/api/src/kvox-objects/files-purge-unmanaged.handler.ts`, the owner-level
payload of `transcripts/handlers/transcript-purge.handler.ts` and
`notes/handlers/note-purge.handler.ts` (shared parser: `common/owner-purge.ts`),
and, on the web side, the `Danger Zone` group of
`apps/web/src/config/userSettingsSections.tsx`. Proven end to end against a real
database by `apps/api/test/user-data/user-data-purge.db.spec.ts`.

## 1. Two layers, not one switch

The page is the platform's, and it keeps the design this application chose for
it: **two visually separated layers**. Layer 1, "Delete specific data", is the
three targeted scopes (recordings, notes, files), each beside its live count.
Layer 2, "Danger zone", is the two composites. A single scope picker was
rejected: it makes five actions look interchangeable, hides each one's blast
radius behind a control, and puts the narrowest scope and the widest one
keystroke apart. A scope's `layer` (`specific` or `danger`) is what puts it on
one side or the other, and the card sits alone in the **last** group of
`USER_SETTINGS_SECTIONS` (`dangerZoneLastViolations` pins it).

Neither layer deletes the account. The `users` row, roles, memberships and the
session survive every scope; the page says so in words.

## 2. The scope matrix

Registered in `user-data.manifest.ts`. Ids and confirmation phrases are
**permanent API** (a queued job carries the scope id; clients compare the
phrase): the phrase is the scope id uppercased.

| Scope | Layer | Phrase | Categories |
|---|---|---|---|
| `transcripts` | specific | `TRANSCRIPTS` | `transcripts` |
| `notes` | specific | `NOTES` | `notes` |
| `files` | specific | `FILES` | `files` |
| `content` | danger | `CONTENT` | `transcripts`, `notes`, `noteTemplates`, `files`, `graph`, `ask` |
| `everything` | danger | `EVERYTHING` | **all** categories |

Both composites re-register the platform's built-in scope of the same id with
`overrideBuiltIn: true` (the built-ins' phrases are `DELETE MY CONTENT` and
`DELETE MY DATA`; the former is refused by this application with a 400).

- **`content` is an explicit list, not `'content'`.** The platform's built-in
  `notifications` and `ai` categories are `content: true`, so a scope defined as
  `'content'` would also delete the user's inbox, AI run history and AI keys,
  which `content` never did. The list is `CONTENT_CATEGORIES`.
- **Note templates ride with `content` and `everything` only.** The narrow
  `notes` scope does not reach them: a template is reusable configuration, not
  note content. The knowledge graph and Ask conversations are likewise
  `content`/`everything` only; no narrow scope reaches them.
- **Categories** (listing order): `transcripts`, `notes`, `files`,
  `noteTemplates`, `graph`, `ask`, then the platform's `notifications`, `ai`,
  `credentials` and `settings`. `files` is re-registered here (same id) so the
  platform's description is skipped: "Files you uploaded yourself. Audio and
  documents that belong to a transcript or note are deleted with them."

### 2.1 `everything` is wider than it was (user-visible change)

Before #480, `everything` was `content` plus AI provider keys, personal access
tokens and the `onboarding` settings namespace. It is now the platform's `all`,
a superset. In addition it deletes:

- the user's **notifications** (inbox, delivery record, Web Push subscriptions);
- the **AI run and usage history** (the keys were already included);
- pending **device codes** and any stored user **credentials**;
- the whole **`user_settings` row** (theme, navigation, data tables and the rest;
  `onboarding` was already cleared, and now goes with it), and it **clears the
  display name and profile image** on the user row.

Personal access tokens are now **deleted**, not revoked (the platform's
`credentials` category); their audit trail survives. All of it is the user's own,
none of it is content, and the account, roles, memberships and session still
survive. The confirmation phrase is unchanged. If product review rejects the
wider scope, list the categories instead of `'all'`
(`[...CONTENT_CATEGORIES, 'ai', 'credentials', 'settings']`, dropping
`notifications`) in the one place it is declared.

## 3. Model hints and the delegates

One hint per owner model (`registerUserDataModels`). A model with a
`delegate` is not deleted inline: after the platform's own rows commit, the purge
enqueues the delegate's job (subject `user:<userId>`, `orgId: null`); the queue's
active dedup makes every hint that names one job type a single job.

| Owner model(s) | Category | What a deletion does |
|---|---|---|
| `Transcript` | `transcripts` | delegate `transcript.purge { mode: 'owner', userId }` |
| `Note` | `notes` | delegate `note.purge { mode: 'owner', userId }` |
| `NoteTemplate` | `noteTemplates` | inline, `keepWhenReferenced` |
| `UserHiddenNoteTemplate` | `noteTemplates` | inline |
| `AskConversation` | `ask` | inline (messages cascade) |
| the 13 `Kg*` owner models and `KgEntityView` | `graph` | one shared delegate `kg.purge { scope: 'all', userId }` |
| `StorageObject` | `files` | delegate `files.purge_unmanaged { userId }`, **not** `storageObjects: true` |
| `SearchIndexState` | none | kept: the transcript and note purges forget it |

Models with only an *actor* column (`TranscriptVersion`,
`TranscriptExport`, `TranscriptNameCheck`, `NoteVersion`, `NoteExport`, ...) are
not owner models and need no hint: they go with their transcript or note when the
per-item purge deletes it, and another user's history on a transcript keeps its
rows.

**Registration order is load-bearing.** The manifest registers this
application's entries first and calls `registerPlatformUserData()` last; the
platform skips an id that is already registered. If the platform's
`StorageObject` hint (`storageObjects: true`) won, its media step would delete
every object the user owns, managed ones included.
`assertKvoxUserDataRegistrations()` runs at import and fails the boot when
`storageObjectModelHint()` is defined or the hint lost its delegate; the
registrations spec pins it.

## 4. Owner-level purge and the foreign keys

`transcript.purge` and `note.purge` gain an additive payload, `{ mode: 'owner',
userId }` (the per-item `{ transcriptId }` / `{ noteId }` is unchanged, and so
are the type strings and profiles). The handler soft-deletes every live row the
user owns, in pages, and queues the per-item purge for each; the per-item purge
deletes the bytes and the row. Both **clear the `Restrict` foreign keys first**
and never catch a foreign-key violation to force a delete through:

- `notes.source_transcript_id` is cleared on **every** note citing one of the
  user's transcripts, **another user's included**. A transcript can be shared; a
  note somebody else generated from it is *their* content, and it keeps its full
  text and loses only the provenance link.
- `notes.source_note_id` is cleared on every note derived from one of the user's
  notes, the same way.

The per-item 409 guards (`NotesService.remove` while a note is generating or has a
derived note; the transcript delete while a note cites it) are deliberately **not**
applied to a bulk deletion: the user was shown an inventory and typed the scope's
name, and the blocking note is itself in the set being deleted.

Each owner-level run is re-entrant (it asks the database for the live rows that
remain), forgets the owner's documents in the semantic index
(`SearchIndexService.forgetOwnerDocuments`), and writes the
`user_data:transcripts_deleted` / `user_data:notes_deleted` audit row.

## 5. `files.purge_unmanaged`

A new, permanent job type (`apps/api/src/kvox-objects/files-purge-unmanaged.handler.ts`).
In this application many storage objects are owned by a module (a transcript's
audio and exports, a note's source document, graph imports and exports), recorded
in the side table `kvox_object_ownership`. The platform's generic `files` step
would delete every object the user owns and break a `Restrict` key or delete bytes
before the row delete fails. So `StorageObject`'s hint delegates to this job, which
selects the user's `storage_objects` **with no ownership row** (`kvoxOwnership:
null` is in the query), pages by id, and deletes each through
`ObjectsService.delete` (bytes, then the row). **A `files` deletion never touches
an object in `kvox_object_ownership`**, nor the transcript or note that owns it
(`user-data-purge.db.spec.ts` pins it against a real database). The handler is
server-only, `profile: { maxRuntimeMs: 30 min, maxAttempts: 3 }`, re-entrant, counts
provider failures and keeps those rows without throwing; asking again retries them.
`orgId` is the job's, else the default organization.

## 6. Server-only, and retries

`user.data.purge` and its four delegates are server-only for good: they write rows
across several tables as they go, and each holds the authority to destroy a user's
data, which no job-scoped credential can narrow. The platform's `user.data.purge`
is `maxRuntimeMs: 15 min`, `maxAttempts: 3` (it was `maxAttempts: 1` here): every
step is re-entrant and the counts accumulate on the job payload across attempts, so
a retry finishes the remainder rather than repeating a destruction. Asking for the
deletion again is still the explicit retry path. `kg.purge` stays `maxAttempts: 1`.

A `user.data.purge` row queued by the previous build carries `{ userId, scope,
requestId }`; the platform's payload schema accepts it (the extra key is
stripped), so a deploy mid-deletion loses nothing.

## 7. Differences from before the swap

Recorded so a support question has an answer. Everything not listed is unchanged:
the same categories go, the same objects survive, the same per-module purge jobs
run, and a `files` deletion never touches a managed object.

- **`everything` is wider** (§2.1).
- **A second request while one is in flight returns that job (202)** instead of a
  409 naming the scope; the platform page follows the job it started.
- **Wire shapes** (see API.md): the summary is `{ categories, scopes, kept }`
  (the scope list, phrases and layers now come from the API); the 202 body is
  `{ jobId, status }`; there is a new `GET /api/user-data/deletions/{jobId}`; a
  wrong phrase is a 400 `CONFIRMATION_MISMATCH` and an unknown scope a 400
  `UNKNOWN_SCOPE`.
- **The routes require `user_settings:write`** (every role holds it) instead of
  `@Auth()` alone. The card still declares no permission.
- **A note template a note still uses is kept active, not archived.** The
  inline template step runs before the notes are hard-deleted, so
  `keepWhenReferenced` keeps it as it is (it used to be archived). It becomes
  deletable once its notes are gone, by a later `content`/`everything` run or by
  hand in Note templates.
- **"Files" counts every object the user uploaded**, managed ones included, and shows
  no byte total: the platform counts the storage-object model as a whole. The
  `files` scope still deletes only the unmanaged ones.
- **The audit trail** is the platform's: one `PURGE_COMPLETED` event per run, plus the
  `user_data:*` rows the owner-level jobs and `files.purge_unmanaged` write. The
  per-key `ai_key:delete` events of the old credentials step are gone (the key rows
  are deleted by the `ai` category directly).
- **The job label** in the admin job list is the platform's, "User data deletion"
  (it was "Account data deletion").
- The platform also mounts the **factory reset** and **organization offboarding**
  routes (`system:factory_reset`, `orgs:offboard`; Admin only). The factory reset has
  a page since #562: the `Factory reset` card in the pinned-last admin `Danger Zone`
  group, routed at `/admin/settings/factory-reset` behind `system:factory_reset`.
  Organization offboarding has no page yet. Both routes are refused in deployments
  the platform gates them out of (`saas` mode; offboarding needs multi-organization
  tenancy).

## 8. Admin factory reset on KVox

The platform's `admin.factory_reset` job (`system:factory_reset`, Admin only; page
`/admin/settings/factory-reset`) wipes inline owner models, every `org` model and every user
but the actor, then every storage object outside the surviving prefixes. It assumes content
in inline models and one `storageObjects: true` model. KVox has neither, so the bare reset is
wrong here in five ways: the content is delegated and the reset never enqueues a delegate;
the `storage_objects` table is not swept, or fails on a `Restrict` key; the actor is never
cascaded; the search index has no foreign key; and the built-in note templates are deleted.
`apps/api/src/platform/user-data/factory-reset.steps.ts` carries the full reasoning in its
header. This app closes the gaps with three registered steps, the `StorageObject` hint
`factoryReset: 'keep'` (`user-data.manifest.ts`) and one config line (`user-data.config.ts`).

| Step | Phase | What it does |
|---|---|---|
| `kvox.content` | `before-users` | Deletes, for every user and the actor included, the transcripts, notes, custom note templates, search index rows and the knowledge graph, in foreign-key order |
| `kvox.storage-objects` | `deployment` | Deletes every storage object outside the surviving prefixes: the bytes, then the row (`kvox-objects/factory-reset-storage.step.ts`) |
| `kvox.note-templates` | `deployment` | Re-seeds the built-in note templates that the platform's owner-less sweep deleted (fixed ids, idempotent) |

### What is kept

- The acting administrator's account, and the roles.
- Configuration, including the built-in note templates.
- Database backups: the runs, their archives (the surviving key prefix) and their jobs
  (`factoryReset.keepJobsReferencedBy` on `DatabaseBackupRun.jobId`).
- The audit log.

### Result keys

The job result namespaces each step's counts as `step.<id>.<key>`.

| Key | Meaning |
|---|---|
| `step.kvox.content.providerCopiesRemaining` | Transcripts whose copy still sits at the transcription provider. The reset does not delete vendor copies; the administrator removes them at the provider |
| `step.kvox.storage-objects.storageObjectsFailed` | Bucket deletions the provider refused. The row stays so a re-run retries it; the step never throws on one |

The other counts are `transcripts`, `notes`, `noteTemplates`, `graphEntities`,
`graphRelations`, `graphItems`, `graphExports`, `searchChunks`, `searchIndexState`,
`storageObjectsDeleted`, `builtInTemplatesRestored` and `builtInTemplatesPresent`.

### Graph erasure

The graph rows are erased directly in one transaction, not through `GraphWriteService`: the
write rule governs producing and editing graph rows, and erasing them is a different act
(`kg.purge` and the `owner_id ... ON DELETE CASCADE` of every `kg_*` table already delete
directly). The deferred `kg_assert_has_evidence` trigger re-reads each subject's current row at
`COMMIT`, so the step deletes every entity, relation and item and then all evidence in the same
transaction and the trigger finds nothing to refuse.

### Not fixed: organization offboarding

`orgs:offboard` (multi-organization tenancy only; no page) deletes the organization's rows,
including `storage_objects`, which transcripts, note sources and exports, version snapshots and
graph exports reference with `onDelete: Restrict`. It has the same foreign-key defect and no KVox
step. Closing it needs a follow-up or a platform seam; until then, do not offboard an
organization that holds transcripts on this app.

Every step is a `deleteMany` by predicate or a page selected from what is still there, so a
retried job deletes what is left.

## 9. Testing

- `apps/api/test/user-data/user-data-registrations.spec.ts`: the five scopes, their
  phrases and layers, the categories each reaches, the delegates' type strings and
  payloads, the registration-order assertion.
- `apps/api/test/user-data/user-data-purge.db.spec.ts`: the real `UserPurgeRunner`
  over the real registries and schema, then the real delegate handlers, one user with
  every kind of data and a bystander; each scope's exact outcome, including
  `files` leaving every managed object, `kg.purge` enqueued once, and another user's
  derived note keeping its text.
- The `user-data` suite of `runPlatformConformance()` (`apps/api/test/conformance.spec.ts`):
  every owner model decided, hints and scopes name what exists, a delete order exists.
- The handler specs of `transcript.purge`, `note.purge` and `files.purge_unmanaged`
  pin the payload shapes.
- Web: `apps/web/src/__tests__/config/dangerZoneCard.test.ts` (the card is
  declared, ungated, and last).
- `apps/api/test/user-data/factory-reset-steps.spec.ts` (the three steps over mocks),
  `factory-reset.db.spec.ts` (the real handler over the real schema, including the evidence
  trigger forced with `SET CONSTRAINTS ALL IMMEDIATE`) and the factory reset RBAC specs
  (`factory-reset-rbac.integration.spec.ts`, `factory-reset-permissions.spec.ts`).
