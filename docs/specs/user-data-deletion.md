# User Data Deletion

> Issue #80: the "Danger Zone" — an authenticated user asking this deployment
> to forget some or all of the data it holds for them, in bulk, with no
> administrator in the loop on either side. Implemented in
> `apps/api/src/user-data/job-types.ts`,
> `apps/api/src/user-data/user-data.controller.ts`,
> `apps/api/src/user-data/user-data.service.ts`,
> `apps/api/src/user-data/dto/user-data.dto.ts`,
> `apps/api/src/user-data/handlers/user-data-purge.handler.ts` and
> `apps/api/src/user-data/user-data.module.ts` on the API side;
> `apps/web/src/pages/UserDangerZonePage.tsx`,
> `apps/web/src/components/settings/UserDataDeleteDialog.tsx`,
> `apps/web/src/hooks/useUserData.ts` and `apps/web/src/services/userData.ts`
> on the web side, plus a `Danger Zone` group in
> `apps/web/src/config/userSettingsSections.tsx`. The wire contract is
> `docs/API.md`'s `### User Data` section; CLAUDE.md's own `### User Data`
> endpoint group and `### Deleting Your Own Data` subsection point here
> rather than restating it. Neither document repeats what the implementation
> files' own header comments already argue in full — this document is the
> one place that argument is assembled end to end.

## 1. Two layers, not one switch

The obvious shape for "let a user delete their stuff" is one scope picker —
a `Select` or a row of radio buttons — feeding one button. It was rejected.
`UserDangerZonePage.tsx` is deliberately **two visually separated layers**,
and the gap between them is the entire design:

- **Layer 1, "Delete specific data."** Three targeted actions — recordings,
  notes, files — each rendered with its own live count and byte total. This
  is the layer someone actually reaches for ("I uploaded forty hours of
  meetings I should not have kept"), and showing the count next to the
  button is what turns an abstract, frightening action into a decision a
  person can check against what they believe they have. A row whose count is
  zero has nothing to delete, so its button is disabled rather than offering
  an action whose only possible outcome is a no-op.
- **Layer 2, "Danger zone."** The two composite scopes, below a divider and
  an error-coloured heading. They are not "the same thing but bigger": the
  wider of the two, `everything`, reaches outside the page's apparent
  subject and revokes the personal access tokens a user's scripts
  authenticate with — a consequence most likely to be discovered by a cron
  job failing at 3 a.m., not by reading a settings page.

A single picker makes all five actions look interchangeable, hides each
one's blast radius behind a control the user has to open to compare, and
puts the narrowest scope (`files`) and the widest (`everything`) one
keystroke apart under a button whose label never changes to say which is
selected. Two layers make the blast radius visible without a click, and put
one deliberate visual barrier — a divider, a colour, a group of its own in
`userSettingsSections.tsx` rather than a fourth card under `Account` or a
second one under `Security` — between "delete some things" and "delete
everything, keys included."

The same one-thing-two-decisions logic holds inside layer 2 itself: `content`
and `everything` are exposed as two buttons, not one button plus a checkbox,
because "delete my content" and "delete my content and revoke my keys" are
two decisions a person makes separately, at different moments, for different
reasons.

## 2. The scope matrix

Five scopes, defined once — `USER_DATA_SCOPES` and `scopeIncludes` in
`apps/api/src/user-data/job-types.ts` — and read by both the request
validator (which only checks the string is a member) and the purge handler
(which decides every destructive step from it). There is no second,
independently written `scope === 'content' || scope === 'everything'`
anywhere else in the module; the two are separated by a queue and by
minutes, and nothing would report a disagreement between two copies of the
same rule if one existed.

| Scope | Transcripts | Notes | Note Templates | Files | Graph | Ask conversations | Credentials |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `transcripts` | ✓ | | | | | | |
| `notes` | | ✓ | | | | | |
| `files` | | | | ✓ | | | |
| `content` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `everything` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

The rule the table encodes: **every narrow scope maps to exactly one
category; only the two composites fan out.** `content` is everything the
user *made*; `everything` is `content` plus the user's *credentials*, which
is the only line the two composites differ on and deliberately the only one.

Note templates are the case this symmetry had to be argued for rather than
assumed, because the intuitive reading of "delete my notes" drags the
recipes along with the meals made from them. It is wrong here, on purpose:

- A template is not note **content**; it is reusable **configuration**. It
  has its own settings destination (`/settings/note-templates`), is authored
  deliberately and independently of any one note, and exists specifically to
  be used by notes that do not exist yet — "the notes are gone, therefore
  the recipe is meaningless" has the causality backwards.
- The user-facing consequence is the real argument. A person who clicked
  "Delete notes" on a row reading "40 notes · 184 KB" was told they were
  deleting notes. Silently emptying a different settings page they did not
  open — one holding hand-authored text with no provider, no bucket and no
  source recording to rebuild it from — is exactly the kind of surprise a
  Danger Zone can least afford.

The composites still take templates, and that is consistent rather than a
special case: `content` means "everything you made," and a template is
something the user made.

The same "configuration, not content" argument settles what happens to
`user_hidden_note_templates` (issue #310) under each scope. A `content`
(or `everything`) purge only **archives** a caller's own custom templates
when notes still reference them (§4 below) — it does not delete the row —
so a hidden-preference row naming one of the caller's own templates that
survives as archived also survives untouched; the same row on a template
that a later sweep does hard-delete cascades away with it, by the FK's own
`ON DELETE CASCADE`, with nothing here to do about it. A hidden-preference
row naming a **built-in** is never touched by any scope: `content`/
`everything` never delete or archive a built-in (`owner_id IS NULL` rows
are immutable through this API under every role, §7.2), so "I don't want to
see the seeded Meeting Notes template" is a preference about the caller,
not about their content, and a content purge has no more business clearing
it than it has clearing the caller's UI theme. Only **account deletion**
(a raw cascading user delete, not `user.data.purge` — no scope here touches
`users`) removes every `user_hidden_note_templates` row naming that caller,
via the same `user_id` `Cascade` every other per-user preference in this
schema already gets.

The knowledge graph (`kg_*` tables, issue #357, epic #344) sits on the same
line as note templates rather than beside credentials: it is `content`/
`everything` only, and for the same "everything you made" reasoning — a graph
is derived content, built by reviewing and committing extraction proposals,
not operational state like an onboarding flag or an access token. No narrow
scope reaches it: deleting `transcripts` does not silently empty a graph the
user curated by hand, and a graph row whose cited transcript or note is gone
keeps its `quote` (every `kg_evidence` anchor foreign key is `SetNull`, by
design — see `docs/specs/ontology.md` §5.3). Unlike every other category in
this table, the graph is not deleted inline: the handler enqueues `kg.purge
{ scope: 'all' }` and lets that job's own handler own the plan, the same
fan-out-to-existing-handlers pattern already used for `transcript.purge` and
`note.purge` below — a second, independent implementation of "delete the
graph" here is exactly how the two would come to disagree about what the
graph is. It also runs **first**, before any other step, so that graph rows
citing a transcript or note this same request is about to delete go away
alongside them (though correctness never depends on that order, since every
evidence anchor is `SetNull` rather than `Restrict`).

Saved **Ask conversations** (`ask_conversations`/`ask_messages`, issue #376,
epic #348) sit on the graph's line for the same reason: a conversation is
content the user made — their own questions and the answers they asked for —
so it is `content`/`everything` only, and no narrow scope touches it. Like
`graph` and `noteTemplates`, `ask` is a **category** of `scopeIncludes`, not a
new scope string: `USER_DATA_SCOPES` is unchanged. Unlike the graph it **is**
deleted inline — one owner-scoped `DELETE` on `ask_conversations`, every
message following through the `conversation_id` cascade (a turn still
streaming included) — because a conversation has no storage object, no
provider-side state and no other table pointing at it, so there is no plan
for a job of its own to own. It runs **first**, before the graph's `kg.purge`
enqueue; nothing depends on that order (a conversation's only link into
`kg_*` is its `SetNull` scope). The summary reports it as
`askConversations: { count }`. Deleting the **account** removes the same rows
by the `ask_conversations.owner_id` cascade instead.

Credentials sit at the opposite end of the same argument: they are
`everything`-only because revoking a user's API tokens is not implied by
"delete my recordings," and a `content` scope that silently signed a user's
CLI out of a running job would be a surprise with no way back.

⚠ **These five strings are permanent once a job carries one.** A
`user.data.purge` row's JSONB payload records the scope it was queued for as
plain text, and a handler running days later against a renamed member would
silently widen or narrow what it destroys — the one kind of drift this
feature cannot tolerate. Nothing enforces that beyond convention; it is
recorded here and in the file's own header for exactly that reason.

## 3. Force semantics: which per-item guards are overridden, and what the user is told first

`NotesService.remove` refuses with a 409 while a note is `generating` or
while another note is derived from it (`sourceNoteId`).
`TranscriptsService.remove` refuses while a note cites the transcript
(`sourceTranscriptId`). Both refusals are correct for a single delete: they
exist so that one click on one row does not silently break something the
user was not looking at.

A bulk deletion is the opposite situation, and the purge handler honours
**neither** guard. The user has already been shown a whole-category
inventory and typed the scope's name; "delete my notes, except four of them,
because of relationships between notes you were never shown" is not a
result anyone asked for, and it is unfixable from the UI — the blocking note
is itself inside the set being deleted, so there is no row left to edit
around it.

What is overridden, precisely:

- A note `generating` when its batch is soft-deleted is **not** excluded.
  The generation finishes or fails against a row that `note.purge` then
  removes; `note.generate` is `maxAttempts: 1`, so there is no retry left to
  outlive the purge, and `notes.housekeeping` re-queues anything stranded in
  `deleting` with no live purge job.
- A note that is the `sourceNoteId` of another note does not block that
  other note's purge — the pointer is cleared first (§4).
- A transcript that is the `sourceTranscriptId` of a note, including a note
  owned by **someone else** the transcript was shared with, does not block
  the transcript's purge — that pointer is cleared first too, and the other
  user's note keeps its full text and loses only the link explaining where
  it came from.

What the user is told, and where, before any of this happens: the API
description on `POST /user-data/deletions` states "this scope ignores the
per-item refusals" and names both guards explicitly (`docs/API.md`'s
`### User Data`). On the web side, `UserDangerZonePage.tsx`'s body copy
states in words — not only in a tooltip — that the account survives and
that `everything` also revokes access tokens, and `UserDataDeleteDialog`
repeats the force-semantics wording **for every scope**, not only the two
composites, because a `notes` deletion can already sever another user's
provenance link the moment it removes a shared transcript's dependent note
pointer.

## 4. FK-clearing order, and why it is mandatory rather than stylistic

The handler does not force anything by catching foreign-key violations, and
it does not disable a constraint. Every blocking column involved is
`Restrict`, so the handler clears the reference **first**, and the delete
that follows is then an ordinary one the database was always going to allow.
The order the five steps run in is a direct consequence of which columns
point at which tables, not a preference. Ask conversations and the knowledge
graph (both `content`/`everything` only) are not among the five: Ask
conversations are deleted inline before everything else, and the graph
participates in no `Restrict` foreign key from this handler's own tables, so
its `kg.purge` enqueue is not ordered against them by necessity either — it
simply runs next, before all five, so that graph rows citing a transcript or
note about to be deleted below go with them.

1. **Credentials** (`everything` only) — `user_ai_credentials` and
   `personal_access_tokens` both cascade from `users` and from nothing else,
   so this step participates in no foreign key with any step below it. It
   runs first anyway, by choice rather than necessity: revoking a key is
   fast and definitive, and a user who asked for their keys to be gone
   should not have them still working while several minutes of fan-out run.
2. **Notes** — `notes.source_note_id` is cleared across the whole batch
   before any note in it is soft-deleted.
3. **Transcripts** — `notes.source_transcript_id` is cleared (on every
   note that cites a transcript in the batch, any owner) before the
   transcript is soft-deleted. This step must run **after** notes: a note's
   `source_transcript_id` is `Restrict`, so deleting transcripts while the
   user's own notes still cite them would leave the transcript purge blocked
   by a reference step 2 had not yet cleared.
4. **Note templates** (`content`/`everything` only) —
   `NoteTemplatesService.remove` archives, rather than deletes, a template
   while any note still references it. Because every scope that reaches
   this step has already run step 2, the notes referencing a caller's own
   template are — at minimum — soft-deleted and queued for purge by the
   time this step runs, which is what makes an eventual real delete
   possible at all (see the gap in §6).
5. **Unmanaged storage objects** — last, because it is the only step whose
   rows nothing else in this list can point at.

Skipping the clear-first step and instead catching the resulting FK
violation was not merely a style preference to reject: `Restrict` means the
database refuses the statement outright, so "catch and continue" would mean
catching an error on **every** blocked row and silently leaving it
undeleted with no record of why — the opposite of the visible, named
`failed` job §5 is built to produce. Clearing first keeps every failure this
handler can still throw a real one.

## 5. `maxAttempts: 1`, and why `POST /api/user-data/deletions` is the retry path

The handler is re-entrant in the narrow sense that a second run is safe: every
step re-derives its remaining work from the rows still live in the database
rather than from a cursor or count carried over from a previous attempt, so a
run that finds nothing left to do simply succeeds having done nothing. That
safety is **not** why automatic retries are disabled.

A destructive fan-out that fails part-way through has already deleted some
of a user's data and not the rest, and the only honest response to that is
to **show it**: a `failed` job, with `lastError` naming the step, that a
person looks at. An automatic retry would quietly re-run the remaining
destruction minutes later and, if it then succeeded, leave no trace that
anything had gone wrong with a deletion the user is entitled to know the
outcome of.

This is the identical relationship `note.generate` has with
`POST /api/notes/{id}/regenerate` (`docs/specs/notes.md`, CLAUDE.md's own
notes on that module): the retry of an irreversible, user-visible action
belongs to the user, as an explicit second request with its own fresh
one-attempt budget, never to the queue's own retry loop. `POST
/api/user-data/deletions` is that button here — pressing it again after a
`failed` job (once the 409 no longer applies, because the failed job is no
longer `pending`/`running`) queues a brand-new `user.data.purge` job that
picks up exactly the remainder the re-entrant handler can see.

`maxRuntimeMs` is left generous (30 minutes) rather than tight, and
deliberately not treated as part of this same argument: this job's own work
is batched database writes and enqueues, not the slow part. The slow part —
deleting bytes from object storage — happens inside the per-item
`transcript.purge`/`note.purge` jobs this job fans out to, each carrying its
own timeout and its own row in the admin job list.

## 6. Server-only, permanently

CLAUDE.md's job-queue rule 2 makes node-eligibility the default posture for
a new job type, so `user.data.purge` opting out permanently owes an
argument, and it has two, either one sufficient on its own:

1. **The work has no computable result to hand back.** Node-eligibility
   means a remote worker computes something and posts a validated result the
   server persists. This job reads and writes across `transcripts`, `notes`,
   `note_templates`, `storage_objects`, `personal_access_tokens` and
   `user_ai_credentials` **mid-computation** — each batch's contents decide
   the next query, and clearing a foreign key is what makes the delete after
   it possible. There is no "already-computed result" shape a
   `nodeResultSchema` could describe.
2. **It holds authority no remote machine should be handed.** This is job-
   queue rule 2's "needs a privilege a remote machine must never hold," in
   its strongest form: the database restore is the canonical example because
   it can replace the live database, and this job is the identical shape
   pointed at one account's entire dataset. A `nodeSecretBroker` cannot help
   here the way it does for `db.backup.run`'s scoped PostgreSQL role: there
   is no credential narrow enough to mean "may delete exactly this user's
   rows across six tables and nothing else," so brokering one would mean
   handing a worker node write access to all six.

## 7. Honest gaps

Two consequences of the design above are real, known, and left as they are
rather than engineered away, because each one is the least bad of the
choices actually available:

- **A note template that still has live-but-soft-deleted notes pointing at
  it finishes a run archived, not deleted.** Step 4 runs after step 2, but
  "after" means "the notes have been soft-deleted and their purge jobs
  queued," not "the notes are gone" — `note.purge` still has to run. So
  `NoteTemplatesService.remove` sees a template still referenced and
  archives it (invisible in the normal catalogue, still the caller's row,
  not deleted) rather than deleting it. The template becomes properly
  deletable once every note that named it is actually purged, and this
  handler being re-entrant is what closes the gap: a **later** run —
  triggered by the user pressing "Delete all content" a second time, or by
  a future scheduled sweep, neither of which exists yet — finds the notes
  genuinely gone and deletes the template for real. Deleting it regardless
  of the archive rule was rejected (§ Rejected alternatives): it would give
  this file a second, contradictory answer to "may this template go?",
  when the one in `note-templates.service.ts` exists precisely so a note
  never loses the record of what produced it.
- **`notes.source_transcript_id` is cleared on other users' notes**, not
  only the caller's own. A transcript can be shared; a note somebody else
  generated from it is *their* content, and it survives a deletion the
  transcript's owner requested — keeping its full text and losing only the
  provenance pointer explaining where it came from. This is a deliberate
  trade rather than an oversight: the owner's right to delete their own
  recording outranks a stranger's pointer to it, and the two remaining
  alternatives — refusing the owner's deletion, or deleting the stranger's
  note along with it — are both worse. It is documented here rather than
  discovered in an incident, because "why did my note lose its source
  link" is a support question this design accepts in exchange for never
  becoming "why was my note deleted by someone else."

## Rejected alternatives

**Deleting inline, inside the request.** The obvious shortcut for "delete my
stuff" is to just do it in the `POST` handler. It violates CLAUDE.md's
"Every Long-Running Activity Is a Queue Job" rule directly — this fan-out
spans several tables and object storage and comfortably outlives one HTTP
request — and it would mean a slow deployment's confirmation click either
times out or blocks a connection for minutes with no progress visible
anywhere. A queued job with its own row in the admin job list is both the
required shape and the more honest one.

**Reimplementing byte deletion inside the bulk handler.** Deleting a
transcript's five kinds of storage object, cancelling it with the
transcription provider where still possible, and deleting a note's export
and source-document objects are already fully solved by
`transcript.purge`/`note.purge`, and exercised by every single-item delete
in the application. A second implementation living here — even one that
starts out correct — is a second thing to keep correct, and it would diverge
silently the first time either module grows a new artifact kind. The handler
fans out to the existing per-item jobs instead and deletes no bytes itself.

**Honouring the per-item 409 guards in bulk.** It reads as the more careful
choice and produces a worse, unfixable result: "delete my notes, except the
ones other notes depend on" leaves the user with a residue they cannot
explain or remove from the UI, because the blocking relationship is inside
the very set they asked to delete. §3 covers the actual behaviour and what
the user is told about it beforehand.

**A single `DELETE`-style confirmation token for every scope.** It is the
simpler implementation and the more dangerous interface: a token typed into
the "delete my files" dialog would then also authorise whatever scope a
second, unrelated request happened to carry, including `everything`.
Deriving the token from the scope itself (`confirmationFor` — the scope,
uppercased) makes a mismatched pair refused rather than silently honoured,
at the cost of one function nobody has to keep in step with
`USER_DATA_SCOPES` by hand.

**Deleting the account as part of `everything`.** "Delete everything" reads,
to a user, as "and my account" — which is exactly why the page states the
opposite in words, more than once. This feature answers a different
question ("stop holding my content") from account deletion ("close my
account"), and conflating them would mean a user clearing their media
library discovered afterward that they had also signed themselves out of a
system they may still need — to see the confirmation that their data is
actually gone, if nothing else. No scope here touches `users`,
`user_roles`, `refresh_tokens`, or the caller's session.

The one `user_settings` exception is `everything`, which clears the
`onboarding` namespace (epic #271) and nothing else in that row. A wipe that
left `welcomeSeenAt` and `dismissedAt` behind produced a genuinely confusing
state: the derived checklist regresses correctly — no transcripts, no AI key,
so both required steps are outstanding again — and then neither the banner nor
the welcome dialog will surface it, because both gate on the surviving
timestamps. "Delete everything" should mean start over. Every other namespace
— `theme`, `profile`, `navigation`, `notifications`, `dataTables` — survives
every scope, because deleting your data is not resetting your preferences.
Account deletion, if this application ever adds it, is a separate feature
with its own confirmation flow, not a sixth scope on this one.
