# Trusted Transcript → AI Notes

> Epic #45 (issues #46–#60): the AI provider framework and per-user API keys,
> the `notes`/`note_templates`/`note_generations`/`note_versions`/
> `note_exports` data model, note generation and its resumable stream,
> document sources, note export, and the web surfaces that reach all of it.
> This document **is** issue #46 — the architecture spec the epic requires
> before any of the fourteen issues it blocks starts, per CLAUDE.md's
> Issue-Driven Development rule and the precedent `docs/specs/transcription.md`
> set for issue #20. Nothing described below is merged yet. Every file path
> named in this document is where the implementing issue commits to putting
> the code, not a file that exists today.
>
> Planned locations: `apps/api/src/ai/` (#47 — the `AiProvider` interface and
> registry, the OpenAI provider, the error taxonomy, per-user credentials, the
> `ai` system-settings policy reader), the `user_ai_credentials` table (#47)
> and the five note tables — `notes`, `note_versions`, `note_templates`,
> `note_generations`, `note_exports` (#48) — both in `apps/api/prisma/
> schema.prisma`, the `notes:*`/`note_templates:*` permission pair and the
> built-in template seed rows in `apps/api/src/common/constants/
> roles.constants.ts` and `apps/api/prisma/seed-data.ts` (#48), the one-line
> delete guard the new `Restrict` foreign keys require in `apps/api/src/
> transcripts/transcripts.service.ts` (#48, landing in the same window as the
> migration — see §4), `apps/api/src/notes/` for everything else on the API
> side: `prompt/` (prompt assembly and the token budget, #49),
> `handlers/note-generate.handler.ts` (#49), `handlers/
> note-source-extract.handler.ts` and `apps/cli/src/node/executors/
> note-source-extract.ts` (#51), `templates/` (the Note Templates CRUD
> controller and service, #50), `generation/` (the resumable SSE stream, #52),
> the rest of `handlers/`, `access/note-access.service.ts`, `tasks/
> notes-housekeeping.task.ts`, `notes.controller.ts` and `notes.service.ts`
> (#53), and `export/` alongside the new generic `apps/api/src/export/
> exporter-registry.ts` that #54 extracts from `apps/api/src/transcripts/
> export/transcript-exporter.registry.ts` (a behaviour-preserving refactor,
> #54). On the web side: `apps/web/src/pages/AiKeySettingsPage.tsx` and
> `apps/web/src/pages/Admin/AiPolicyPage.tsx` plus the matching
> `config/userSettingsSections.tsx` / `config/adminSections.tsx` cards (#55);
> `apps/web/src/pages/NoteTemplatesPage.tsx` (#56); the `config/
> destinations.ts` rename to `library`, `apps/web/src/pages/
> NotesLibraryPage.tsx`, `LibraryTabs.tsx`, `NewNotePage.tsx` and the
> streaming generation view (#57); `apps/web/src/pages/NotePage.tsx`,
> `NoteHistoryPage.tsx` and `apps/web/src/components/notes/` (#58); and the
> extension to the existing `apps/web/src/pages/TranscriptPage.tsx` (#59).
> Documentation lands last: `docs/API.md`'s `### Notes` group, CLAUDE.md's own
> Notes section, a runbook, and the changelog entry (#60).
>
> **Suggested build order** (from the epic): #46 (this document) →
> (#47 provider framework + keys, #48 data model + RBAC + built-ins, both
> depending only on this document) → (#49 generation pipeline, #51 document
> sources) → (#50 templates API, #52 SSE stream, #53 notes API) → #55 (web:
> key setup, admin policy) → (#56 web: templates manager, #57 web: library +
> new-note flow) → #54 (export, gated on #28 merging in epic #19) →
> (#58 web: note detail/editor, #59 web: transcript-page entry point) →
> #60 (docs).

## Why this shape, and not the obvious one

VISION.md's "AI as a Transformation Layer" section states the whole feature as
one equation — `Transcript + Optional Context + Optional Skill = AI-Generated
Artifact` — and "Notes as Knowledge" adds the constraint that makes this spec
necessary: *"A note should remain connected to the information that produced
it."* Epic #19 built the trust half of this product's thesis for transcripts.
This epic is the first place the thesis has to survive **AI actually writing
the primary content**, not merely transcribing it, and four decisions carry
almost the whole weight of that:

1. **The stream is a durable-state projection, never a push channel.** Epic
   #345's rule 1 (CLAUDE.md, "Every Long-Running Activity Is a Queue Job")
   already settled that `note.generate` must be a queue job, not a detached
   promise held open for the length of a completion. What is new here is that
   a **client** also needs to watch that job's progress live, and the obvious
   tool for that — an in-process `EventEmitter` a controller subscribes to —
   is wrong for the same reason a single long-lived polling job was wrong for
   transcription (`docs/specs/transcription.md` §1.5.2–4's rejected
   alternative): it assumes one process is both running the work and serving
   the watcher, which this application's horizontally-scaled API tier does
   not guarantee for a single request, let alone for the following one after a
   reconnect. §5 makes the full argument; the summary is that treating
   `note_generations` as the one place tokens are ever written, and the SSE
   endpoint as a thin, resumable reader over it, buys "two replicas," "closed
   tab," and "reconnect resumes" all at once, for the cost of a short poll
   loop this codebase already uses elsewhere (`docs/specs/transcription.md`
   §5's weak-ETag polling).
2. **`note.generate` is server-only for a different reason than every
   provider-calling job type in `docs/specs/transcription.md`.**
   Transcription's three provider jobs are server-only because the API key is
   **account-level** and long-lived (transcription.md §1.5.2–4). Here the key
   belongs to **the individual calling user**, and there is no OpenAI API for
   minting a job-scoped sub-key the way `db.backup.run`'s broker mints a
   PostgreSQL role (`docs/specs/database-backup.md` §16) — so CLAUDE.md rule 3
   (`nodeSecretBroker`) has nothing to broker, for a reason distinct from rule
   3's other server-only cases in this codebase: it is not that the secret is
   too powerful to hand to a node, it is that **no mechanism to narrow it
   exists at all**, at any vendor, for any user. `note.source.extract`, which
   needs no credential, is node-eligible from day one, following rule 2's
   default posture exactly as `media.audio.transcode` does.
3. **`profile: { maxAttempts: 1 }`, and the reason is not "be conservative."**
   Every other job type in this codebase that calls an external provider
   (`transcription.submit`, `.poll`, `.ingest`; `db.backup.run`) is right to
   auto-retry an ordinary failure, because retrying re-asks a **deterministic**
   question funded by **this deployment's** account — a second attempt costs
   the same operator the same modest amount and produces the same answer.
   Neither is true here: the money is **the user's own**, and the output is
   **non-deterministic** — a second attempt after a partial stream has already
   been shown produces *different* text, not a retry of the same one. An
   automatic retry would therefore silently spend a second charge on the
   user's account to show them something other than what they were just
   watching. §2 states the full error taxonomy this forces; the short version
   is that `maxAttempts: 1` does not merely shrink the retry budget the way a
   stricter number would elsewhere in this codebase — it turns "retry" off,
   because regenerating has to remain the thing only a person decides to do.
4. **Per-user API keys get a table of their own, not a row in `credentials`.**
   `credentials` is `(purpose, name)`-keyed with no foreign key to `users`
   (`apps/api/src/common/crypto/secret-cipher.ts`'s own consumer,
   `CredentialsService`) precisely because it holds **infrastructure**
   secrets — an SMTP password, this deployment's own AssemblyAI key — that
   must outlive whichever admin last typed them in. A personal OpenAI key is
   the opposite kind of fact: it belongs to exactly one user and has to leave
   when they do. `user_ai_credentials` (§4) cascades on user delete and
   reuses `encryptSecret`/`decryptSecret` from `secret-cipher.ts` completely
   unchanged — a new table and a new foreign key, zero new cryptography.

Two further postures run through every section below, worth stating once:

- **Privacy is precise here in a way it could only be institutional
  elsewhere.** `docs/specs/transcription.md` §10 can say "your audio goes to
  AssemblyAI" because every user's audio goes to the *same* AssemblyAI
  account under the *same* retention policy. With a per-user key, "your
  content goes to OpenAI, under **your own** account's data-usage settings"
  is the honest statement, and it is a *stronger* privacy guarantee, not a
  weaker one — it puts the user's own provider relationship in the loop
  instead of a deployment-wide one they never agreed to. §9 states exactly
  what that does and does not let an administrator see.
- **Nothing here is a new mechanism.** The provider registry (§2) copies
  `TranscriptionProviderRegistry`'s shape (`docs/specs/transcription.md` §2.1)
  down to the same required-no-op-`deleteRemote`-style discipline; prompt
  assembly (§3) is pure, living beside `apps/api/src/transcripts/editing/`'s
  reducers in spirit; the five tables (§4) reuse the exact versioning and
  FK-direction discipline `transcripts` established; the export registry (§8)
  is *literally* extracted and reused, not re-implemented; and the built-in
  template convention (§7) reuses the same null-owner seeding
  `docs/specs/settings-ui.md` and CLAUDE.md's allowlist section already
  establish for "exists for everyone, owned by nobody." An epic that
  introduces a genuinely new capability (AI generation, a live stream) still
  owes this codebase the discipline of reusing every pattern that already
  fits.

## 1. State machines

Notes have **two** state machines, for the same reason transcripts have three
(`docs/specs/transcription.md` §1.4): a list view needs one cheap column to
sort and filter on, and the fine-grained detail of "what is this specific
generation doing right now" belongs on a different row that a list query
never has to touch. `notes.status` is the coarse, list-visible field;
`note_generations.status` is the detail a single open generation's stream
reads from.

### 1.1 `notes.status`

```
draft → generating → ready ⇄ generating
                        ↘        ↘
                        failed → generating
              ready, failed → deleting
```

| Status | Meaning | Set by |
|---|---|---|
| `draft` | The note row exists — source and template chosen, the first `note.generate` job enqueued — but that job has not yet started running | `POST /api/notes` |
| `generating` | A `note.generate` job (create **or** regenerate) is actively streaming tokens for this note | The job, on claim, before the first provider call |
| `ready` | At least one `note_versions` row exists and its content is current | The job, in the same transaction that commits the new version (§1.4) |
| `failed` | The most recent generation ended in a failure the note has to show | The job, on any failure class in §2 (see the note below on which ones) |
| `deleting` | The owner asked to delete it; `note.purge` is removing its storage and rows | `DELETE /api/notes/:id` |

Two transitions are worth naming explicitly because they are not obvious from
the diagram:

- **`ready → generating` and `failed → generating` both come only from
  `POST /api/notes/:id/regenerate`, and neither the API request itself nor
  the note ever passes back through `draft`.** `draft` means specifically
  "never generated even once"; a note that has already produced content (or
  already failed to) is regenerating, not starting over, and the UI treats
  the two states differently (a `ready` note shows its last good content
  behind a "regenerating…" banner while the new stream runs; a `failed` note
  shows nothing to fall back to). The status flip itself still happens **only
  when the job starts**, exactly like the initial `draft → generating`
  transition — the regenerate endpoint enqueues a fresh `note.generate` job
  (a new job row, a fresh one-attempt budget, per §1.3's decision 3) and
  returns immediately; the note keeps showing its prior status until that job
  is actually claimed and begins running, which is ordinarily milliseconds
  later but is not guaranteed to be.
- **`DELETE /api/notes/:id` is refused with 409 while `notes.status =
  'generating'`.** A user may delete a `draft`, a `ready`, or a `failed` note,
  but not one an in-flight job is actively writing to — the alternative would
  make `note.purge` either race the still-running `note.generate` job for the
  same rows, or have to know how to interrupt it, neither of which this
  design accepts. The UI disables the delete action while generating and
  re-enables it the moment the stream reports `succeeded` or `failed`.

### 1.2 `note_generations.status`

```
pending → streaming → succeeded
                    ↘
                     failed
```

| Status | Meaning | Set by |
|---|---|---|
| `pending` | The row exists (create, regenerate, or a template preview); `note.generate` has been enqueued but has not yet been claimed | Enqueue (`POST /api/notes`, `POST /api/notes/:id/regenerate`, or `POST /api/note-templates/:id/preview`) |
| `streaming` | The job is running: prompt assembly and the token-budget check (§3) have passed, and the provider's stream is being read and appended to `content` as it arrives | The job, immediately before requesting the provider's first chunk |
| `succeeded` | The provider's stream ended cleanly and (for a non-preview generation) the content has been committed as a `note_versions` row | The job, at the end of `process()` |
| `failed` | A domain failure or the job's one attempt being exhausted (§2) | The job |

**Reachability, stated the way transcription.md §1's own table does it:**
every transition on this machine is set by the **job**, never by an API
request — the API only ever creates a row in `pending` (by enqueuing) and
reads it back. This is the whole point of §5's durable-buffer design: there
is exactly one writer of a `note_generations` row for its entire life, so a
client watching it is never racing anything but that one job's own appends.

### 1.3 How the two machines relate, and why generation does not chain

`notes.status` tracks the **note's** overall condition across however many
generations it has had; `note_generations.status` tracks **one attempt**.
A `ready` note may have had two `failed` generations before its one
`succeeded` one — the note's history preserves all three rows (§4), and
`notes.status` reflects only the most recent one's outcome once it settles.
`notes.currentGenerationId` (§4) is the pointer that lets the note detail
page and the SSE resume endpoint find "the generation to watch" without a
query across `note_generations` — it is updated to the new row's id the
moment a create or regenerate request enqueues it, and never cleared, so a
`ready` note's `currentGenerationId` always names the generation that
produced its current content.

**`note.generate` does not chain the way `transcription.poll` does
(`docs/specs/transcription.md` §1.5.2–4).** `transcription.poll` re-enqueues
itself with `skipDedup: true` because the actual work (an AssemblyAI job) runs
on the **provider's** infrastructure for potentially hours, and holding one
worker slot for that entire span would fight the lease/timeout machinery —
transcription.md §11 documents this as a rejected alternative in its own
right. `note.generate` is different in exactly the way that makes holding a
slot the *correct* choice: the provider's response **is** the open streaming
HTTP connection the job is reading from, so the job's `process()` call is
necessarily alive for the entire generation — there is no "check back later"
phase to chain across, because there is nothing else running the work in the
meantime. A completion typically takes seconds to a few minutes, which is
what `profile.maxRuntimeMs` (§2) is sized against; this is holding a slot for
the length of the *actual* computation, not for an external wait, so it is
not the anti-pattern §11 exists to name.

## 2. The AI provider contract

### 2.1 `AiProvider`

`apps/api/src/ai/providers/ai-provider.interface.ts`, the same shape
`TranscriptionProvider` already establishes (`docs/specs/transcription.md`
§2.1) — one small interface, one settings schema, a registry, and every
vendor-specific call confined behind `apps/api/src/ai/providers/`:

```ts
interface AiModelDescriptor {
  id: string;              // the provider's own model id, e.g. "gpt-4o"
  label: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

interface AiProviderCapabilities {
  models: AiModelDescriptor[];
  streaming: true;          // every registered provider must stream; there is no non-streaming path
}
```

and implements:

| Method | Returns | Notes |
|---|---|---|
| `testConnection(ctx)` | `{ ok, latencyMs, detail }` | `ctx.apiKey` may be a **saved, decrypted** key or one the user is currently typing and has not saved — never persists anything, never queues a job, following `TranscriptionProvider.testConnection`'s own contract exactly |
| `countTokens(text, model)` | `number` | Synchronous. Used both by §3's budget check and to report `promptTokens` on the generation row once known |
| `generate(ctx, { model, systemPrompt, userContent, maxOutputTokens })` | `AsyncIterable<AiGenerateEvent>` | `ctx.apiKey` is the calling user's own decrypted key, resolved just before this call and never written anywhere but into this one outbound HTTPS request (§9) |

```ts
type AiGenerateEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; finishReason: 'stop' | 'length' | 'content_filter'; usage: { promptTokens: number; completionTokens: number } };
```

There is no `submit`/`getStatus`/`fetchResult` split the way
`TranscriptionProvider` has one: transcription's split exists because
AssemblyAI's job runs asynchronously on the provider's own infrastructure and
has to be polled; a chat completion is one request whose response **is** the
work, streamed back over the same connection. `generate` is therefore the
provider contract's only content-producing method, and it is required to
stream — a provider implementation that can only return a complete response
in one shot is not eligible for registration, because there would be nothing
for §5's durable buffer to append incrementally.

### 2.2 Error taxonomy

`apps/api/src/ai/providers/errors.ts`. Three named classes, plus a default,
following the identical "positively identify, otherwise assume ordinary"
posture `classifyRateLimit` takes for the queue generally
(`docs/specs/job-queue.md` §5.2, restated for transcription in
`docs/specs/transcription.md` §2.3):

| Class | Examples | `notes.status` | Job attempt spent? |
|---|---|---|---|
| `AiAuthError` | The key is invalid, revoked, or lacks the needed scope; the provider returns `401`/`403` | `failed` | **No** — the job returns normally, having correctly diagnosed a permanent condition, the identical posture `docs/specs/transcription.md` §1.6 gives `ProviderAuthError` |
| `AiRefusalError` | The provider declines the request itself — a content-policy refusal, a model that rejects the input outright, an over-budget input the job's own re-check (§3) catches at run time despite the request-time check passing | `failed` | **No** — same reasoning; retrying an identical refused request gets the identical refusal |
| `RateLimitError` (429) | The provider's own rate limit, reused verbatim from `apps/api/src/jobs/rate-limit.error.ts` — the same class `docs/specs/transcription.md` §1.6 shares across its three provider-calling handlers | `notes.status` **unchanged** — invisible backoff, not a failure | **No** — deferred through the throttle key in §2.4, exactly as `docs/specs/job-queue.md` §5.3 describes for the queue generally |
| Everything else (default) | A network error, an unexpected exception mid-stream, a `5xx`, a database write failing partway through a flush | `failed` | **Yes** — and because `profile.maxAttempts: 1` (§1.3, decision 3), this is the note's **only** attempt: there is no second automatic try the way an ordinary retryable failure gets elsewhere in this codebase |

**Why the fourth row is the one that matters most, and why it is not merely a
smaller retry budget.** Everywhere else this queue auto-retries the default
class, correctly — `transcription.submit`'s network hiccup should simply be
tried again, because trying again is free of side effects the user can see or
pay for twice. Here, retrying the default class would call the **same
provider, with the user's own key, a second time**, and because a completion
is non-deterministic, the retry would show the user *different* text than
whatever partial stream they had already watched fail. `maxAttempts: 1`
collapses the domain/ordinary distinction back to one practical consequence
— nothing about this job type auto-retries, ever — while the taxonomy above
is still kept precise, because it drives **what message the user sees** and
**whether the failure is invisible** (rate limit) or **terminal** (everything
else): a `failed` note always offers **Regenerate**, which is `POST
/api/notes/:id/regenerate` enqueuing a brand-new job with its own fresh
one-attempt budget — regeneration is the queue's manual retry, deliberately
placed one explicit user action away from ever happening automatically.

**The dialog behind that button is a form, not a confirmation** (issue #109,
epic #105). It is prefilled with the note's current template, context text
and model, and it sends a **diff**: an untouched form posts `{}` — byte for
byte what the confirmation-only dialog always sent — a cleared context box
posts `contextText: null`, and a moved template or model posts only that
field. The endpoint's own fallback rule ("every omitted field is what the
note already records") is what makes a diff safe; sending the whole form
would rewrite rows the user never touched.

Two branches the dialog must handle rather than assume away: a template that
no longer exists blocks confirmation until one is chosen, and a server `409
template_required` is rendered **inside the still-open dialog**, because it
is a question the user can answer without losing the rest of their form. The
model list is `GET /api/ai/config`'s, the same probe every other AI surface
gates on; a model the deployment no longer permits is named in helper text
and replaced, never silently dropped. See
[`docs/specs/ux-refresh.md`](ux-refresh.md) §4.

### 2.3 The rate-limit throttle key is per user, not per deployment

`ProviderThrottleService.registerProviderKey(type, `ai-provider:${userId}`)`
— the exact inverse of transcription's single shared
`'transcription-provider'` key (`docs/specs/transcription.md` §1.5.2–4). There,
every user's transcription shares **one** AssemblyAI account and its **one**
rate-limit bucket, so one throttle key correctly protects it. Here, every user
brings **their own** OpenAI account with their **own** rate limit, so a 429
against user A's key must defer only user A's queued generations — deferring
everyone's on one shared key would make a single busy user's account throttle
every other user's notes, which is not how the accounts actually relate to
each other at all.

### 2.4 OpenAI as the reference implementation

`apps/api/src/ai/providers/openai.provider.ts`, on Node's built-in `fetch`
(injected, mockable in tests), matching every other outbound HTTP client in
this codebase (`docs/specs/transcription.md` §2.7 makes the identical choice
for AssemblyAI). Chat Completions with `stream: true`, read as
server-sent-event chunks; `401` → `AiAuthError`; a `content_filter`
`finish_reason` or a `400` naming a policy violation → `AiRefusalError`;
`429` → `RateLimitError`, honouring `Retry-After` when present through the
same `parseRetryAfterMs` helper `docs/specs/job-queue.md` §5.2 already uses;
anything else defaults to the fourth row of §2.2's table.

**⚠ Exactly like `docs/specs/transcription.md` §2.7's own AssemblyAI caveat:**
the specific endpoint shape, streaming event format, and error-body fields
documented here are OpenAI's Chat Completions API as of this document's
writing (2026-09) and MUST be re-checked against OpenAI's current
documentation before this epic is declared final — the exact same posture,
for the exact same reason (a vendor API's shape is precisely the kind of fact
that drifts between a spec being written and the code that implements it
shipping).

### 2.5 The active-provider axis, live model discovery, and the widened `allowedModels` entry (#78; the five-rank resolution chain and derived defaults are #97)

Three changes shipped together because they answer one question — *"how does
a deployment adopt a model this application does not already know about,
without waiting for a release?"* — from three different angles.

**`ai.provider: AiProviderId | null`.** Before #78, every consumer of the AI
provider framework resolved the single registered provider by a hardcoded
`'openai'` literal, because there was exactly one and nobody had to ask.
That is now a persisted, nullable field on the `ai` namespace, resolved
through `AiProviderRegistry`, and **every hardcoded `'openai'` consumer
literal is gone** — `AiConfigService`, `AiSettingsService`,
`AiModelDiscoveryService` and the generation path all call
`this.registry.get(policy.provider)`. Adding a second OpenAI-API-compatible
vendor now costs one id in `AI_PROVIDER_IDS`, one block in
`aiProvidersSchema`, and one provider class — no consumer edit, in the same
"one registry entry" shape CLAUDE.md's "Adding a Job Type" and "Adding a
Notification" recipes already establish elsewhere in this codebase.

It is **nullable, not optional**, field for field with
`ai-settings.schema.ts`'s own reasoning and `systemTranscriptionSchema
.provider`'s precedent: "nobody has chosen a vendor" is a *persisted fact*
the settings page renders, not an absent key three different situations
(unset, dropped by a partial merge, or a schema a rollback no longer models)
would otherwise all collapse into. It defaults to `'openai'` rather than
`null`, unlike transcription's own provider field — the divergence is
deliberate: `enabled: false` plus an empty `allowedModels` already make a
fresh deployment inert twice over, so a `null` default would buy no extra
safety and would cost an administrator a second decision ("which vendor?")
to turn on a feature this build ships exactly one implementation of.
Transcription defaults to `null` because choosing AssemblyAI commits a
deployment to a specific named company; choosing "the OpenAI-compatible
provider" here commits it to nothing until a model is permitted and a user
pastes their own key. It is still a separate axis from `enabled`: an
operator can switch AI off for an incident without losing the vendor choice,
and switch vendors without touching the master switch.

**`listModels` and `capabilities.modelDiscovery` on `AiProvider`.** A new
optional method, present exactly when `capabilities.modelDiscovery` is
`true` — "presence is the declaration," the identical rule
`JobHandler.nodeResultSchema`/`persistNodeResult` already follows in this
codebase, except that here one of the two halves is a boolean a caller reads
*before* spending a request, so `AiProviderRegistry.register` enforces the
agreement at **boot** rather than leaving it to the type system alone — the
same one-line check `TranscriptionProviderRegistry` makes for
`capabilities.cancel`, and the same argument: an advertised capability with
no method is a `TypeError` in the path *least likely to have been
exercised* (an administrator pressing "load models from the provider" on a
page opened once a quarter), and a boot failure naming the provider is a far
better place to meet that bug than a 500 an admin reaches once a quarter.
`OpenAiProvider.listModels` implements it against `GET {baseUrl}/models` —
the same route `testConnection` already probes, read here for its *content*
instead of its status code — filtered to plausible chat models by a short,
literal substring list (`NON_CHAT_MODEL_MARKERS`) that is a convenience over
an unstructured vendor list and *never* a gate: the filter can only hide a
row from the discovery dropdown, and `aiAllowedModelSchema` accepts any
model id typed by hand regardless of whether discovery would have shown it.

`listModels` throws on refusal, unlike `testConnection`, because a model
list has no partial form — the caller decides whether a refusal is a 200
diagnosis or a real failure, not the provider.
`AiModelDiscoveryService.discoverModels` is that caller, and is a
**service of its own**, not a method on `AiSettingsService` — a real
circular dependency, not a stylistic preference:
`UserAiCredentialsService` already injects `AiSettingsService` to read the
policy, so a `discoverModels` method needing the *caller's* credential would
close the loop and force a `forwardRef` on both sides. `AiConfigService` is
the standing precedent for solving this the same way: a leaf composing the
policy, the registry and the credential service without any of them knowing
about it.

**Why discovery spends the *calling administrator's own* key, and not a
deployment key.** There is no deployment key to spend — §9's strict
bring-your-own-key decision means this application stores no AI credential
of any kind, for any purpose, ever. Adding one *just for discovery* was
considered and rejected: it would be the exact deployment-wide fallback
credential §9 exists to rule out, introduced through a side door reachable
only by an administrator, which does not make the privacy answer any less
institutional than doing it through the main door would. So discovery
authenticates as the administrator making the request, exactly as `POST
/api/ai-credentials/test` does — with the stated consequence that an
administrator with no key of their own gets a `409` (`ai_key_missing`), not
an empty list, because "you have not set up a key" and "the provider offers
nothing" are different sentences with different fixes; and that the model
list returned is the one **that key** can reach (project-scoped, on
OpenAI), so two administrators can legitimately see different lists — the
policy saved from either list is checked against **neither** at generation
time, only against each user's own key, which is the only authority that
ever actually matters. Gated on `system_settings:write`, not `:read`, for
the same reason `POST /api/ai-settings/test` is: it is side-effecting (it
spends a real, billable vendor call), and looking at settings is not
probing a third party.

**Why `allowedModels` widened from `string[]` to an array of
`{ id, label?, contextWindowTokens?, maxOutputTokens? }`, instead of a bare
id plus a sibling metadata map.** Before #78, every entry was resolved
against this build's own four-model `MODELS` catalogue to find the context
window §3.3's budget needs — which made the deployment's model policy a
**subset** of an array compiled into the application: a model the vendor
shipped last week could be typed into `allowedModels` and saved, but never
budgeted and therefore never offered to anyone, and adopting it required a
release of this application. It also made discovery nearly pointless: there
is no use listing the sixty models a key can reach if fifty-six of them can
never be permitted. A **sibling map** keyed by model id (`{ "gpt-4o": {
contextWindowTokens: … } }`, alongside the existing `allowedModels: string[]`)
was the other shape considered and rejected: it is two structures that can
name a different set of models — an id present in one array and absent from
the other, or present in both with a stale entry nobody removed when the
model was un-permitted — with no schema-level way to say that is wrong. A
single array where each entry *is* both a permission and (optionally) its
own budget numbers cannot disagree with itself about which models exist.

**Two smaller consequences of #97 worth stating explicitly.** First, the
chat-model filter `GET /api/ai-settings/models` applies
(`NON_CHAT_MODEL_MARKERS`, a short literal substring list) can now be
skipped with `?includeAll=true`: before #97 the filter only hid a row from
the discovery dropdown, since an administrator could always type a filtered
id by hand and the save path never consulted it — but "type it by hand" was
exactly the "you must already know the answer to ask the question" state
#97 removes everywhere else, so the escape hatch had to exist too. Second,
`aiProvidersSchema`'s `allowedModels` cap rose from 50 to 200
(`ai-settings.schema.ts`): it bounds the settings blob stored in the
`global` row's JSONB, never how many models may be permitted, and 50 was an
unreachable ceiling back when permitting an unrecognised id meant
hand-typing two numbers per entry. Now that one click does it, a vendor
list of a hundred-odd dated snapshots is an ordinary thing to select most
of; 200 stays a bound on a mistake (a script writing the same id in a
loop), which is the only thing the cap was ever for.

**Resolution precedence, in one function.** `ai-model-resolution.ts`'s
`resolveAllowedModel(entry, knowledge)` is the *only* place that answers
"what does this deployment actually know about the model named by this
`allowedModels` entry," because — since #97 — **three** callers ask for
different reasons and must never be allowed to disagree: `AiSettingsService`
to **refuse** a save it cannot honour, `AiConfigService` to **publish** a
model to a picker, and — new in #97 — `OpenAiProvider.listModels` itself, so
the numbers shown in the "load models from the provider" dialog are the
exact numbers the save path will later compute for the same id. A second
implementation anywhere in that set could answer differently with no error
anywhere to say so, the same argument `materialize()` makes about replaying
transcript versions through the live reducers (`docs/specs/transcription.md`
§4.4).

The precedence is applied **per number**, not per model, so an entry
supplying only `maxOutputTokens` takes its context window from whichever
rank below can answer next:

1. **The entry's own numbers win (`explicit`)**, including over a build
   descriptor for the same id, so a deployment can correct a stale catalogue
   number without a release. Nothing #97 adds outranks this.
2. **An exact hit in the build catalogue (`catalogue`)** — `MODELS` in the
   provider, verified numbers for the models this application ships knowing
   about.
3. **The provider's own family derivation (`derived`, #97)** —
   `AiProvider.deriveModelDescriptor(id)` places an unrecognised id in a
   *known family*: `gpt-5.4-mini-2026-03-17` is a dated snapshot of
   `gpt-5.4-mini` and takes that model's whole window, never a reduced one.
   Real vendor lists are mostly dated snapshots of models this build already
   knows, so this rank is what makes most of a discovered catalogue
   permittable with one click instead of two hand-typed numbers per entry.
4. **The provider's conservative floor (`default`, #97)** —
   `AiProviderCapabilities.defaultModelLimits`, the smallest context window
   and output ceiling a chat model from this vendor is known to have. See
   below for why a floor is allowed to exist at all.
5. **`null`**, only when none of the above can answer — since #97 this means
   the policy names a provider this build does not implement (or a rollback
   across the addition of one), or a provider that has deliberately declined
   to declare a floor. It is *not* "this build has never heard of the
   model" any more; that case now resolves at rank 3 or 4.

Every resolution reports the **weakest** rank either number came from
(`AiResolvedModel.source`) plus `derivedFrom` (non-null exactly when the
weakest rank is `derived`), so a client can say "this build verified these
numbers" apart from "we assumed the `gpt-5.4-mini` family" apart from "we
used this vendor's conservative floor" — under-claiming what this
deployment knows costs an administrator nothing, and over-claiming it costs
them the chance to type the real number. `GET /api/ai/config` and
`GET /api/ai-settings/models` both publish `source`/`derivedFrom` on every
model for exactly this reason.

The same function is also called from the request-time budget check
(`NoteGenerationRequestService.assertPromptFits`) and from `note.generate`
itself, closing a gap #78 introduced and a same-epic fix patched
immediately: `assertPromptFits` originally looked a model up in the *build*
catalogue directly and returned silently (i.e., un-budgeted, not refused)
when the id was absent — which, once an entry can carry its own numbers, is
precisely the model an administrator just adopted from the discovery list.
Falling through meant an over-long prompt was not refused at request time
with numbers in a `400`, but minutes later as a `failed` note with nothing
to look at. All call sites now agree by construction.

`deriveModelDescriptor` **must be pure and synchronous**, the identical
requirement `AiProvider.countTokens` already carries and for the identical
reason: resolution runs inside the §3.3 budget check in `POST /api/notes`'s
own request handler and inside the `note.generate` job, so a network call or
a read of mutable state there would put a round trip in front of every note
creation and let the request-time and job-time answers disagree for reasons
that have nothing to do with the model. And it belongs on the **provider**,
never on `AiConfigService`/`AiSettingsService`: which id shapes are dated
snapshots and which families exist is *vendor knowledge*, and a service that
learned OpenAI's snapshot-suffix conventions would have to learn a different
vendor's all over again for the next provider registered.

**Why an unknown model's context window used to be asked for, never
guessed — and why #97 supersedes that, without contradicting it.** Before
#97, §3.3's rule against guessing a context window — "guessing high submits
a prompt the vendor rejects after billing the user, and guessing low
refuses work that would have fit" — was read as forbidding **both**
directions equally, and `resolveAllowedModel` returned `null` for any id
absent from the build catalogue with no numbers of its own. #97's argument
is that the two directions are **not symmetric**, and that this is not a
new observation but the thing the old sentence already said, read
correctly: a window *below* the truth refuses a prompt that would have
fit — **visible and correctable**, because the `400` names the model and an
administrator can type a per-entry override that outranks every rank in the
chain above. A window *above* the truth submits a prompt the vendor rejects
**after billing the user** — invisible until the vendor's own error arrives,
and by then unrecoverable. Only the high side is the mistake §3.3's
"guessing" warning was actually written to prevent. That asymmetry is why
rank 4's conservative floor is allowed to exist, and why it must stay
exactly that — conservative, re-verified with the numbers in `MODELS`, never
a plausible-looking estimate of a real model's size (see
`OPENAI_DEFAULT_MODEL_LIMITS`'s own comment for the verification
obligation).

The refusal path is **kept**, not deleted — `missingModelNumbers` still
names the fields a `400` should call out on save, and `GET /api/ai/config`
still quietly omits a model nothing can budget for — but since #97 it fires
only for the genuinely unanswerable case (rank 5 above), not for every model
shipped since this build was cut. This is still the same "refuse with a
number, never silently degrade" discipline §3.3 applies to an over-budget
prompt; what changed is how often an id needs a human-typed number to clear
it at all.

**Why the legacy bare-string form must keep parsing, forever.** Every
deployment that had already saved an AI policy before #78 has
`["gpt-4o", "gpt-4o-mini"]` sitting in the `global` row's JSONB. §7.10-style
schema evolution in this codebase is additive by convention, but the reason
this particular case is load-bearing rather than merely tidy is
`SystemSettingsService.readKnownSettings`'s degrade-to-defaults behaviour: a
namespace that fails to parse is not a migration failure or a `500`, it is
a **silent** substitution of `DEFAULT_SYSTEM_SETTINGS` — no log line an
administrator would find, no error, just `allowedModels: []` and
`enabled: false` from then on. A schema that rejected the string form would
not announce itself; it would quietly reset every existing deployment's
model policy on the next read, and the first anyone would know is users
reporting that AI generation had stopped working with no explanation
anywhere. So `aiAllowedModelEntrySchema` is a union with a normalising
transform (`typeof entry === 'string' ? { id: entry } : entry`), not a
widened object type with a one-time migration — there is no migration, and
the old shape is accepted for as long as this namespace exists. Normalising
at the schema boundary, rather than leaving every downstream reader to
branch on `typeof entry === 'string'`, is the same "one implementation, not
one per call site" argument the rest of this section makes about
`resolveAllowedModel`: a union type callers must narrow is a `typeof` check
that one of them, eventually, gets wrong.

**The no-secret compile-time proof now covers three levels, not two.**
`ai-settings.schema.ts`'s `CarriesNoSecret` check — the same technique
`transcription-settings.schema.ts` uses to prove no field named `apiKey` (or
its aliases) exists on the namespace — now also checks
`AiAllowedModel`, the per-entry object type #78 introduced. This is not a
formality: once an `allowedModels` entry became an object with its own
optional fields, "this one model lives on a different account, so give it
its own key" became a plausible-sounding one-line change for someone to
make, and it would be exactly the deployment-wide fallback credential §9
rejects, hidden two levels deeper in a settings blob every
`system_settings:read` holder can already read wholesale.

## 3. Prompt assembly and the token budget

### 3.1 Assembly order, and why it is fixed

`apps/api/src/notes/prompt/prompt-assembly.ts`. **Pure**, like
`apps/api/src/transcripts/editing/`'s reducers — no `PrismaService`, no
network call, no clock read inside it — because §3.3 depends on calling the
identical function twice (once to validate at request time, once to build
the real prompt at job time) and getting identical answers from identical
inputs both times.

```ts
function assemblePrompt(input: {
  templateInstructions: string;
  templateOutputFormat: string;
  templateStructure: string[];
  templateTone: string | null;
  templateLength: string | null;
  contextText: string | null;
  sourceText: string;
}): { systemPrompt: string; userContent: string };
```

The system role carries the template's instructions **and its structured
fields** — `output_format`, `structure`, `tone`, `length` (§4.3) — composed
into one coherent instruction block by `assemblePrompt` itself, here, at read
time; the user role carries the optional context, then the source text, **in
that fixed order**:

1. **Template instructions and structured fields, in the system role.**
   `assemblePrompt` is where `instructions` and the guided sub-fields
   actually become one prompt — composition happens on every call, not once
   at save time, which is exactly what lets §4.3's editor read the sub-fields
   straight back out of the stored row instead of trying to parse them back
   out of flattened prose. Composed or not, this block is least likely to be
   overridden or diluted by whatever the source text turns out to contain —
   this is "the job," and it needs to stay stable regardless of how large or
   strange the transcript that follows is.
2. **Context, immediately after, still ahead of the source.** Short,
   user-authored, and orienting — a participant list, a project name, a term
   the transcript uses without defining — deliberately placed close to the
   instructions rather than appended after a potentially enormous source
   block, where a model's attention to it degrades the way attention to
   anything placed far from the point of generation degrades.
3. **Source text, last and largest.** It is the primary content being
   transformed, and putting it last keeps the instructions and the context
   closest to the point the model actually starts generating from.

### 3.2 Where the source text comes from, per source kind

`assemblePrompt` never reads a database; whatever calls it resolves
`sourceText` first, per the three source kinds §4 supports:

- **`transcript`**: `materialize(transcriptId, currentVersion)`
  (`docs/specs/transcription.md` §4.4) is rendered to plain reading text by
  reusing the transcript module's own Markdown projection
  (`apps/api/src/transcripts/export/markdown.exporter.ts` and
  `export-document.ts`) rather than writing a third transcript-to-text
  serializer that could disagree with the other two about what the transcript
  *says* — the identical "one document shape, several renderers" discipline
  `docs/specs/transcription.md` §8.1 already states for the exporters
  themselves.
- **`note`**: the source note's `notes.body` — by §4.1's invariant always
  identical to its `note_versions` row at `current_version`, so this reads the
  denormalized live copy directly rather than joining to the version table —
  already plain markdown, no conversion needed.
- **`document`**: the extracted plain text `note.source.extract` produced
  (§4's storage discussion) — never the raw uploaded bytes; `note.generate`
  has no PDF parser of its own and is not meant to grow one.

### 3.3 The token budget, and refusing early with a number

`apps/api/src/notes/prompt/token-budget.ts`. The input budget for a given
model is `model.contextWindowTokens - requestedMaxOutputTokens - safetyMarginTokens`
(a fixed 500-token margin, covering the few tokens OpenAI's own message
framing adds beyond the literal text). `countTokens` (§2.1) measures the
assembled `systemPrompt + userContent`. `model` here is `resolveAllowedModel`'s
output (§2.5), not a direct build-catalogue lookup — since #78 a permitted
model may carry its own `contextWindowTokens`/`maxOutputTokens` on its
`allowedModels` entry, and every caller of this budget (the request-time
check below, the job's re-check, and the config probe) resolves through the
same function so none of them can disagree about a given model's window.

**On a reasoning model, `requestedMaxOutputTokens` bounds thinking and the
answer together, never the answer alone (#87).** `ai.reasoningEffort`
(§2.5's sibling field in `ai-settings.schema.ts`) tells OpenAI how many
tokens to spend deliberating before it writes anything the user sees — drawn
from the *same* `maxOutputTokens` ceiling this budget already subtracts
above for input purposes, never a separate allowance. At `'high'` or
`'xhigh'` against the shipping `maxOutputTokens` of 16,384, a generation can
spend most of that ceiling thinking and return a short or truncated note.
This is not a case the "refuse early with a number" discipline below can
catch: the provider reports no intended reasoning-token spend in advance, so
there is nothing to check before the request is sent — the failure surfaces
only after the fact, as an ordinary `length` finish reason indistinguishable
from any other truncation. The fix is an administrator lowering
`reasoningEffort` or raising `maxOutputTokens` deliberately — the schema
field's own comment on `reasoningEffort` is explicit that raising the effort
must never do this automatically — not a request-time refusal, because there
is no number here to refuse with.

**If the assembled prompt exceeds the budget, the request is refused before
anything is created — no note, no draft row, no job.** `POST /api/notes` and
`POST /api/notes/:id/regenerate` call `assemblePrompt` and the budget check
**synchronously**, in the request handler, using the exact same pure function
`note.generate` calls later — never a second implementation that could drift
from it, the same "one function, two callers" discipline
`docs/specs/job-queue.md` §5.2's `classifyRateLimit` and
`docs/specs/transcription.md` §4.4's `materialize` both already establish. The
`400` response names the actual numbers: *"This source is approximately
14,200 tokens; gpt-4o allows 11,500 for input with this template and output
length. Choose a shorter source, a shorter template, or a model with a larger
context window."* — a number the user can act on, not a generic "too large."

**Rejected: silent truncation.** Cutting the source down to whatever fits and
generating anyway was the obvious alternative, and it is the one this section
exists specifically to forbid: a note confidently summarising the first third
of a meeting, with no indication anything was cut, is a worse failure than
refusing outright — it is exactly the kind of unearned confidence VISION.md's
"AI proposes. The user controls the truth" thesis (echoed by "Trust and
Provenance," §9) exists to prevent. A user who sees "too large, by this many
tokens" can act on it (a shorter template, a bigger-context model); a user who
receives a confidently wrong note about half a meeting may never know the
other half was silently dropped.

**The re-check inside the job is not redundant.** `note.generate` re-runs
`assemblePrompt` and the same budget check against **current** source state
when it actually claims the job (payload carries only `{ generationId }` —
see §4's "one function, two callers" note extended to job payload
minimalism, matching `media.audio.transcode`'s `payload: { transcriptId }`
precedent, `docs/specs/transcription.md` §1.5.1). A transcript can grow
between the request that created the draft and the moment the job runs — a
correction batch landing in between, say — so the rare case where a
now-larger source pushes the prompt back over budget is caught as an
`AiRefusalError`-classified domain failure (§2.2) rather than silently
generating from stale, no-longer-accurate content or silently truncating the
new state.

### 3.4 Naming the note: three ranks, and a title a person chose is never touched

*(Issue #182, epic #163.)* Until this section existed a note was called
whatever its **template** was called, so four notes generated from "Meeting
notes" were four rows called "Meeting notes" and the list gave a user no way to
tell them apart. Naming happens **once**, in `NoteGenerationService.commit`,
the moment the body, the version row and `status: 'ready'` are durable — three
ranks, each a fallback for the one above it:

| Rank | Source | Reached when |
|---|---|---|
| 1 | A dedicated titling completion against the committed body | Normally |
| 2 | The body's first Markdown heading, else its first sentence | Rank 1 produced nothing usable, **or threw anything at all** |
| 3 | The title the note already has | Rank 2 found nothing usable either |

Rank 1 is a **second, tiny request** rather than a line appended to the
generation prompt: a note whose first line is its own title is a note the user
then has to delete a line from. It sends the first ~2,000 characters of the
body — a document says what it is about at the top, and sending the whole note
would bill the user a second full pass over it for information the opening
already carried — caps the answer at 32 tokens, and asks for
`reasoningEffort: 'none'` regardless of policy, because reasoning tokens are
drawn from that same 32-token output ceiling (§2.1) and a thinking model would
spend the whole budget thinking and emit no title. Its timeout is the smaller
of 30 s and `ai.requestTimeoutMs`: this request is not a note, and it is
spending runtime that belongs to a `note.generate` job whose real work is
already finished.

**Rank 2 is pure, and that is the point of it being a separate module**
(`generation/title-derivation.ts`): no provider, no key, no network, no clock.
It is reached precisely because one of those has just failed, so a fallback
that needed any of them would be a second copy of the thing that broke.

**`titleSource: 'user'` is sticky.** The note is re-read inside the titling
pass — minutes of streaming may have passed since the caller's copy was taken —
and a `user` title returns immediately, writing nothing. The final write is an
`updateMany` guarded on `titleSource: { not: 'user' }` as well, so a rename that
lands between the read and the write still wins: the guard is in the `WHERE`
clause, where a race cannot get between the two. A title written by rank 1 or
rank 2 is recorded as `titleSource: 'ai'`.

**The throttle key is the per-user one** (§2.3), never a shared deployment
bucket — `aiProviderThrottleKey(ownerId)`, the same key the generation it
follows registered, for the same reason: every user brings their own vendor
account, so a 429 against one user's key is evidence about that user alone.

**⚠ `titleNote` never throws, and nothing it does can fail the note.** By the
time it runs the note is committed and durable; a title is a garnish on work
that has already succeeded. An auth failure, a refusal, a **rate limit**, a
timeout, a provider this build does not have, a key erased since the
generation, or `ai.enabled` switched off mid-flight all fall through to rank 2
and then rank 3, each logged with its reason. A `RateLimitError` is caught here
and **not** rethrown — the one place in this codebase that swallows one —
because deferring the job would re-run nothing useful and would leave the user
looking at a finished note reported as still working. An exception escaping
this path would turn a successful generation into a failed job, and the user
would lose the note they had just watched being written, for the sake of
naming it.

A **preview** is never titled: it has no note to name, is never listed, and is
hard-deleted at its ten-minute TTL (§4.4). Titling runs **before**
`notes.note_ready` is raised, because that notification carries the title —
raising it first would name a title the note stopped having a second later.

#### 3.4.1 Retitling a library that already exists

*(Issue #184, epic #163.)* §3.4 names a note the moment its body commits,
which fixes every note made from then on and leaves every note already in the
library called after its template. `note.retitle` is the retroactive half: one
job per note, running the **same** three ranks through the same
`NoteTitleService` — there is no second implementation of the ranks anywhere.

**A job, and deliberately not a migration.** The obvious shape for "fix every
existing row" is a data migration, and it is the wrong one here: rank 1 spends
the note owner's own vendor key on their own account (§9), and `migrate
deploy` must never bill a user's account on their behalf — least of all as an
invisible side effect of an operator shipping a release. CLAUDE.md's standing
rule settles it independently: a pass over a whole library outlives the
request that asked for it. Being a job is also what makes the sweep operable —
each note is one row in `GET /api/admin/jobs`, independently retryable, and a
sweep is stopped by not asking for the next page.

The type declares `profile: { maxRuntimeMs: 2 min, maxAttempts: 1 }` and is
**server-only permanently** (no `nodeResultSchema`, no `persistNodeResult`),
both for §2.2's and the generation handler's reasons unchanged: a retry
re-bills a non-deterministic call, and the credential is the owner's own
long-lived account key, which no worker node may hold. Its success means
**"this note was considered"**, not "this note got an AI title" — `titleNote`
never throws, so rank 2 and rank 3 are successful outcomes of a pass that ran,
and a user with no key saved gets a heading-derived title and a green job.

**Two entry points, and they differ on exactly one thing.**

| | `POST /notes/{id}/retitle` | `POST /notes/retitle` |
|---|---|---|
| Scope | one note | a capped page (100) of the caller's own |
| Renames a `titleSource: user` note | **yes** (`force: true`) | **never** |
| Selection | this note, unless `generating` (409) | own, `ready`, not deleted, `titleSource: template`, oldest `updatedAt` first |
| Queue dedup | `skipDedup: true` | the default active-dedup key |
| Priority | column default (`0`) | `HOUSEKEEPING_PRIORITY` (100) |

**⚠ The `force` asymmetry is the point, and it is not an inconsistency to
tidy up.** A bulk sweep renames notes **nobody is looking at**, so quietly
replacing fifty names a person chose would be indistinguishable from data
loss, and there is no undo — a title is metadata about the note, not versioned
content of it, so nothing keeps the old one. A person pressing "Suggest a
title" on **one note in front of them** has asked, explicitly and about that
note, for exactly this; refusing them on the strength of a column they never
saw would be the application overruling the user to protect them from a choice
they have just made. `force` relaxes both halves of §3.4's sticky guard — the
early return and the `updateMany` `WHERE` clause — in lockstep, because
relaxing only the first would spend the user's tokens and then write nothing.

**⚠ The sweep selects `titleSource: 'template'`, which is narrower than "not
`user`", and the narrowing is what makes it terminate.** `ai` is a note this
exact pass has already named from its own content; re-including it would spend
the owner's money to re-derive an answer they have, and — worse — would put
every note the sweep had just finished with straight back into the selection,
so `remaining` could never reach zero and a caller following the resumption
protocol would loop forever, billing themselves each lap. A success writes
`titleSource: 'ai'` and the note leaves the selection. That is the whole
convergence argument, and `titleSource: 'template'` is also, word for word,
the problem the issue describes: a note called whatever its template was
called.

**Oldest `updatedAt` first**, for a reason in the same register: a rename
touches the row, so `@updatedAt` moves a titled note to the *back* of the
ordering and the next call's page is the next hundred that still need it —
no cursor for the caller to carry and no page to lose. Newest-first would hand
back the same hundred every time. The honest residue: a note whose proposed
title equals the one it has is not written, keeps its `updatedAt` and its
`template` source, and will be reconsidered by a later call. It is rare, it is
cheap, and the alternative — writing a row to record that nothing changed —
would be worse.

`queued` and `remaining` together **are** the resumption protocol: `queued` is
what this call started, `remaining` is what still matches (counted at request
time, so it does not yet reflect the jobs just queued). A response carrying
only `queued` would leave a client unable to tell "the library is named" from
"there are eight hundred still to go".

## 4. Data model

Five tables (issue #48), all `snake_case`-mapped Prisma models, following the
exact versioning discipline `docs/specs/transcription.md` §3–§4 already
established for transcripts.

### 4.1 `notes`

| Group | Columns |
|---|---|
| Identity | `id`, `owner_id` (FK `users`, **Cascade**), `title` |
| Content | `body` (`@db.Text`, markdown) — the note's live working copy; see below |
| State | `status` (`NoteStatus`, §1.1), `current_version` (int, default 0), `current_generation_id` (FK `note_generations`, `SetNull`, nullable) |
| Source | `source_type` (`'transcript' \| 'note' \| 'document'`), `source_transcript_id?` (FK `transcripts`, **Restrict**), `source_note_id?` (FK `notes`, self-relation, **Restrict**), `source_object_id?` (FK `storage_objects`, **Restrict**) — exactly one of the three is set, matching `source_type` |
| Template | `template_id?` (FK `note_templates`, **`SetNull`**) |
| Provenance | `provider?`, `model?` — which `AiProvider` and which model produced the current `body` |
| Context | `context_text?` (the optional free-text Context, §3.1) |
| Failure | `failure_reason?` |
| Timestamps | `deleted_at?`, `created_at`, `updated_at` |
| Indexes | `(owner_id, updated_at desc)`, `(status)` |

**`body` is a denormalized live copy, and by invariant it always equals the
`note_versions` row named by `current_version` — the version rows (§4.5) are
the immutable history; `notes.body` is the one column a reader touches to see
the note as it stands today.** Reading through to `note_versions` on every
request was the obvious alternative, and it loses on the two paths that
matter most: `GET /api/notes` renders a title and a body snippet for a whole
page of results, so a join (or a second query) to find each row's current
version would run on every single list render, not on some rare detail view;
and §5.1's streaming handler's entire job, at the moment a generation
finishes, is to persist exactly one thing — the read-through design would
still need the version row *and* would then need a second write for
`current_version`/`updated_at` anyway, so denormalizing `body` costs nothing
extra at write time while saving a join on every read. The invariant this
duplication rests on is cheap to hold precisely because it has only two kinds
of writer for a note's entire life, both of which already write a
`note_versions` row in the same transaction they touch `body` in: `note
.generate`'s completion transaction (§5.1), and an explicit `PATCH
/api/notes/:id` edit (§6). There is no third path that could ever update one
column without the other, which is what makes "these two must agree" a
statement the schema can afford to leave unenforced by a trigger rather than
a promise that needs one.

**`provider?`/`model?` record which provider and model produced the *current*
body**, set in the same transaction as `body` itself and left untouched by a
manual `edit` version (§4.5, §6) — an edit changes prose, not provenance.
Without these two columns, the note detail page's "Generated with OpenAI
(gpt-4o)" line would have to join back to whichever `note_generations` row
produced `current_version` — and that row has no permanence guarantee on the
note's behalf: a `kind: 'preview'` row is hard-deleted outright (§4.4), and
even an ordinary `create`/`regenerate` row is exactly the kind of thing
`notes.housekeeping` (§8.6) is free to sweep well after the note itself is
still being read. Denormalizing `provider`/`model` onto `notes` means the one
fact the detail page states about its own content cannot go missing because
some unrelated row aged out.

**Why the three source columns `Restrict` while `owner_id` `Cascade`s — the
same sideways-pointer reasoning `docs/specs/transcription.md` §3.1 already
established for `Transcript.sourceObjectId`, applied here with one real
difference worth being honest about.**

`owner_id` cascades for the identical reason `transcripts.owner_id` does: a
note has no meaning and no permission path to read it once its owner is
gone — there is no `notes:read_any` (§6) — so there is nothing left for the
row to mean once the cascade fires.

The three source foreign keys are `Restrict` for the reason VISION.md's
"Trust and Provenance" section states as a product principle, not merely a
database convenience: *"Important knowledge should remain connected to its
evidence."* But the *consequence* of `Restrict` differs by which source it
is, and that difference is worth stating rather than glossing over:

- **`source_object_id` → `storage_objects`** is `Restrict` for the same
  reason `transcripts.source_object_id` is (transcription.md §3.1): the
  uploaded document is `managed_by: 'notes'`, so the generic storage
  `DELETE` already 409s on it (§9.3 of transcription.md's pattern, reused
  unchanged) — nothing outside `note.purge` can even attempt to delete it.
  `Restrict` here is belt-and-suspenders on a path that is already closed.
- **`source_transcript_id` → `transcripts` and `source_note_id` → `notes`**
  are `Restrict` against a resource that **is** independently, legitimately
  deletable by its own owner through its own existing endpoint —
  `DELETE /api/transcripts/:id` and `DELETE /api/notes/:id` neither know nor
  care whether a note was ever derived from them. Making these `Restrict`
  therefore has a real, user-visible consequence: **a transcript or note that
  has produced a note cannot be deleted while that note still exists.**
  `DELETE /api/transcripts/:id` gains a pre-check (`apps/api/src/transcripts/
  transcripts.service.ts`, landing with the same migration that adds this
  foreign key, #48) that 409s naming the blocking note ids — the identical
  shape `speaker_id: Restrict` already gives `segment.delete` in
  transcription.md §3.3 ("a speaker cannot be deleted while segments still
  reference it"), and the identical shape `managed_by` gives a managed
  storage object's generic `DELETE`. This is a deliberate reading of "the
  user controls the truth": the user who wants to delete evidence a note
  still cites is asked to delete (or wait to delete) the derivative first,
  rather than the evidence silently vanishing out from under a note that
  still names it as its source.

**`template_id` is `SetNull`, not `Restrict`, and that asymmetry is
deliberate.** A template is a reusable recipe, not evidence — VISION.md's
Trust-and-Provenance sentence is about a note's connection to the
*information* it transformed, never about which *instructions* did the
transforming. Making `template_id` `Restrict` would mean a user could never
delete an old custom template once it had produced even one note, which is a
real, ordinary thing a user wants to do (§7 covers templates fully); `SetNull`
loses only "which recipe produced this," never "what happened," and every
generation's own row (§4.4) keeps a `template_name_snapshot` so that fact
survives the template's deletion anyway.

### 4.2 `user_ai_credentials`

| Column | Notes |
|---|---|
| `id`, `user_id` (FK `users`, **Cascade**) | The one FK `credentials` structurally cannot have (§ "Why this shape" decision 4) |
| `provider_id` | Which registered `AiProvider` this key is for |
| `secret` (`@db.Text`) | `encryptSecret(rawKey, 'ai-key')`'s output — `secret-cipher.ts` unchanged, a new `purpose` string |
| `hint?` | Last 4 characters, for the settings UI, mirroring `Credential.hint` |
| `last_tested_at?`, `last_test_ok?` | The result of the most recent `testConnection` probe, so the settings page can show "last verified 2 hours ago" without re-probing on every page load |
| `created_at`, `updated_at` | |
| `@@unique([user_id, provider_id])` | One key per user per provider |

Never returned over the wire in any form (`GET /api/user-ai-credentials`
returns `hint`, `lastTestedAt`, `lastTestOk` — never `secret`), following
`CredentialsService.describe()`'s exact no-plaintext-egress discipline
(`secret-cipher.ts`'s own header: "THIS MODULE MUST NOT LOG" — the same
invariant extends to every consumer of it).

### 4.3 `note_templates`

| Column | Notes |
|---|---|
| `id`, `owner_id?` (FK `users`, **Cascade**) | `NULL` = built-in (§7) — the same "null means something specific and permanent" convention `transcript_speakers.label` uses (`docs/specs/transcription.md` §3.2), applied to ownership instead of provider labelling |
| `name`, `description` | |
| `instructions` (`@db.Text`) | The free-text prompt body — what the user actually writes, in their own words, distinct from the structured fields below |
| `output_format` | Meeting notes / summary / email / bullet list / custom — a fixed set the editor renders as a picker |
| `structure` (`Json @db.JsonB`) | The ordered list of sections/headings the form edits as a reorderable list — the one shape a JSON array captures directly and a single prose field cannot preserve order or identity for |
| `tone?`, `length?` | |
| `model?` | An optional per-template override of which model to generate with. Bounded by deployment policy **at selection time**, against `GET /api/ai/config`'s permitted list (§6.4) — not by this column, which just remembers the user's choice; a model the deployment later withdraws is caught the same way an unavailable model is caught anywhere else this epic reads that list, not by a constraint on this table |
| `is_archived` | Hides a template from the default list/picker view without deleting the row. This is a genuinely different action from `DELETE`, not a softer version of it: `template_id` `SetNull`s rather than `Restrict`s (§4.1), so deleting a template a user no longer wants is already possible even after it has produced notes — but deleting forfeits the definition permanently, with no `duplicated_from_id` (§7.3) to recover it from. Archiving keeps the row — still duplicable, still inspectable, reversible by un-archiving — while taking it out of the everyday list, for a user who wants "not right now" rather than "gone" |
| `created_at`, `updated_at` | |
| `@@unique([owner_id, name])` | Postgres's NULLS-DISTINCT behaviour — the same free property `docs/specs/transcription.md` §4's Database Tables entry notes for `transcript_versions.clientBatchId` — means this constrains only **owned** rows against each other. Any number of `owner_id IS NULL` built-ins may share a `name` as far as this index is concerned, so "no two of *your* templates can be called the same thing" is enforced with no second, narrower partial index needed to carve the built-ins back out |

**`user_hidden_note_templates`** (issue #310, epic #306) is a separate join
table, not a column here: `(user_id, template_id)` primary key, both FKs
**Cascade** (a hiding preference has no meaning once either the user or the
template it names is gone), indexed on `template_id` for the reverse lookup a
template deletion sweep needs. It records a per-**user** LISTING preference,
never access control — see §7.4 for the full rationale, including why it is a
join table and not a `user_settings` namespace or a reuse of `is_archived`.

No `is_built_in` boolean: it would be a second, independently-settable
statement of a fact `owner_id IS NULL` already states, which is the identical
"presence is the declaration, never a flag that can disagree with it"
argument `apps/api/src/jobs/job-handler.interface.ts` makes for node
eligibility.

**Why the template is `instructions` plus five structured columns, and not
one prose field the editor composes client-side before saving — and why an
earlier version of this section argued exactly the opposite.** That earlier
argument said a form presenting tone/length/structure as guided sub-fields
could compose them into `instructions` as a single string at save time,
keeping the server's stored contract to one field because `assemblePrompt`
treats the whole thing as one block regardless. The argument is wrong, and
wrong in a way worth stating rather than quietly reversing: composing
structured input into prose at save time is a **one-way** function. Once
"formal tone, three sections, action items, 200 words" has been flattened
into a sentence inside `instructions`, there is no path back to the fields
that produced it — the user who reopens their template a week later to
change just the tone finds a wall of prose instead of the picker they filled
in, and has to either reverse-engineer what they meant from the flattened
text or abandon it and start over. Issue #56's own description of the editor
states the requirement directly: it is "fields over #48's columns, each a
real control," and its acceptance criteria require the model picker and the
structure list to render from **saved** state on reopen — not parsed back out
of `instructions`. A save path a form's own load path cannot undo is not a
convenience layered over one field; it is a broken editor wearing a
convenience's clothing.

`assemblePrompt` (§3.1) reads every one of these columns, not `instructions`
alone — `output_format`, `structure`, `tone` and `length` compose into the
system prompt at generation time, inside the same pure function, so the "one
coherent instruction block" the earlier argument was protecting still exists
exactly as before. What moves is *when* the composition happens: at **read**
time, inside a pure function already required to run twice per identical
inputs (§3.1, §3.3), rather than at **write** time, irreversibly, inside the
save endpoint. Nothing about keeping `prompt-assembly.ts` in step with the
stored schema gets harder — the schema simply stops discarding information
the prompt still needs to reconstruct.

### 4.4 `note_generations`

The durable buffer §5's stream reads from, and — because a preview has no
note — deliberately **self-sufficient**: every field `assemblePrompt` needs
is denormalized onto this row at creation time rather than requiring a join
back to `notes` for a generation that might have no note to join to.

| Group | Columns |
|---|---|
| Identity | `id`, `note_id?` (FK `notes`, **Cascade**, `NULL` for a preview), `kind` (`'create' \| 'regenerate' \| 'preview'`), `job_id?` (`@unique`, `SetNull`) |
| State | `status` (`GenerationStatus`, §1.2), `error_class?` (`'auth' \| 'refusal' \| 'rate_limit' \| 'other'`), `error_detail?` |
| Inputs (denormalized) | `template_id?` (FK `note_templates`, `SetNull`), `template_name_snapshot`, `context_text?`, `source_type`, `source_transcript_id?`, `source_note_id?`, `source_object_id?`, `provider_id`, `model` |
| The stream | `content` (`@db.Text`, append-only), `last_event_id` (int, default 0, §5's SSE `id:`) |
| Usage | `prompt_tokens?`, `completion_tokens?` |
| Lifecycle | `expires_at?` (only set for `kind: 'preview'` — §7's TTL sweep), `started_at?`, `completed_at?`, `created_at`, `updated_at` |

`kind: 'preview'` rows are **hard-deleted**, not soft-expired, by
`notes.housekeeping` past `expires_at` — there is no `note_exports`-style
`expired` status here, because nothing else in this schema ever references a
preview generation (it has no `note_id`), so there is nothing a soft-expiry
status would need to be visible *to*.

**`job_id?` is nullable and `SetNull`, the identical shape `note_exports
.job_id` gets in §4.6 and the exact precedent `DatabaseBackupRun.jobId` and
`TranscriptExport.jobId` already set: this row's own lifetime is independent
of `job.history.purge`'s retention schedule for the underlying `jobs` row.**
A generation is read back for as long as its note (or, for a preview, its
`expires_at` TTL) says it should be — §5's stream, and the detail page's
provenance line (§4.1) — and neither span is obliged to match how long the
queue keeps a settled job's history around. Were `note_generations` to
instead hold no
column of its own and rely on `jobs.subject_id` pointing the other way (as
§3.3's job payload does, carrying `{ generationId }` so the running job knows
*which row to write to*), a generation older than the purge window would lose
every trace of which job ever produced it the moment that job row aged out —
an ordinary background sweep silently amputating a fact the note detail page
still needs. `SetNull` means the reverse: the job can go, and the generation
simply loses a link to a job that no longer matters, exactly as `note_exports
.job_id` already does for exports.

**Four more columns, added by issue #307, snapshot what was actually sent to
the AI provider**: `system_prompt?`, `user_content?` (the two halves of
`assemblePrompt`'s output), `source_version?` (the transcript/source-note
`current_version` actually materialized — `NULL` for a document source) and
`context_captured_at?`. All four are written **before** the provider call, so
a generation that fails still records what it asked; all four are `NULL`
together on a row that predates issue #307, and deliberately never
backfilled — re-materializing the source today would fabricate history, since
the source may have been corrected and the template edited since. See
`NoteGenerationContextService` and `GET /notes/{id}/context` in `docs/API.md`.

### 4.5 `note_versions`

Mirrors `transcript_versions` (`docs/specs/transcription.md` §3, §4.4–4.5)
exactly in spirit, with one deliberate structural difference:

| Column | Notes |
|---|---|
| `id`, `note_id` (**Cascade**), `version` (int) | |
| `kind` (`'ai_generated' \| 'edit' \| 'restore'`) | |
| `body` (`@db.Text`) | **The full markdown**, not an operation log — see below |
| `summary?` | A short, one-line description of what this version changed — *"Regenerated with a shorter, more formal tone"*; *"Restored to version 1"*; *"Fixed the action items list"* — read by the version history list so it can render one line per row without loading `body` for every version listed, the same "a list renders a snippet, not the whole document" reasoning §4.1 makes for denormalizing `notes.body` itself, applied here to history rather than to the current row |
| `author_id?` (FK `users`, `SetNull`) | `NULL` means "the AI," the identical convention `transcript_versions.author_id` uses |
| `generation_id?` (FK `note_generations`, `SetNull`) | Which generation produced this version, for `kind: 'ai_generated'`; `NULL` for `edit`/`restore` |
| `restored_from_version?` | For `kind: 'restore'`, mirroring `transcripts.restored_from_version` |
| `client_batch_id?` | Idempotency for the save endpoint, same purpose as `transcript_versions.clientBatchId` |
| `created_at` | |
| `@@unique([note_id, version])`, `@@unique([note_id, client_batch_id])` | Second index NULLS-DISTINCT, the same free property `docs/specs/transcription.md` §4's Database Tables entry notes for `transcript_versions` |

**Why a full body per version, and not an operation log the way transcripts
uses one — this is the decision issue #46 flags explicitly, and it is a
genuinely different answer for a genuinely different-shaped document.**
`docs/specs/transcription.md` §11's rejected-alternatives list gives the
arithmetic that ruled a full snapshot out for transcripts: roughly 7 MB per
save for a 10-hour, 90,000-word recording, which would make a
`transcript_versions`-style table grow into the gigabytes for a routinely
edited transcript. A note is a page or two of AI-generated or user-edited
prose — a few kilobytes, not megabytes — so that arithmetic simply does not
apply, and the machinery an op log requires to pay for itself (pure reducers,
a `materialize()` replay function, gap-based ordinals, LCS-based word
realignment) has nothing to buy here: a note has no segments, no speakers, no
per-entity concurrency to reconcile (§5's stream is the only writer while
generating; §6 covers the single-owner edit case), and "what changed between
two versions of prose" is a question a client-side text diff answers directly
from two full bodies, with no reducer replay needed to reconstruct either
one. Storing the whole markdown string per save is not a shortcut taken
because building the op-log machinery was too much work — it is the design
an operation log would be **over-engineering for a document this small**,
stated as its own entry in Rejected alternatives.

### 4.6 `note_exports`

Mirrors `transcript_exports` exactly: `id`, `note_id` (**Cascade**),
`version` (int), `format`, `options_hash`, `job_id?` (`@unique`, `SetNull`),
`status`, `storage_object_id?`, `expires_at?`, `created_at`.
`@@unique([note_id, version, format, options_hash])` — the identical
content-addressed reuse index `docs/specs/transcription.md` §8.5 declares,
applied to notes (§8 covers the export path in full).

### 4.7 Document sources: no sixth table

`note.source.extract` (#51) needs to persist the plain text it pulls out of
an uploaded PDF/TXT/MD **without** a sixth table. It reuses machinery
`storage_objects` already has: the raw upload (`storage_objects`, `managed_by:
'notes'`, the object a `notes.source_object_id` eventually points at) and a
**second**, node-eligible-written `storage_objects` row holding the extracted
plain text — the same "one write, two paths" shape
`media.audio.transcode`'s `recordRendition()` uses
(`docs/specs/transcription.md` §1.5.1) — whose id is recorded in the
**first** object's own `metadata` (`PATCH /api/storage/objects/:id/metadata`,
already a generic capability) as `{ extractedObjectId }`. `note.generate`'s
`sourceType: 'document'` branch (§3.2) reads `sourceObject.metadata
.extractedObjectId`, downloads that object, and uses its contents as the
source text — never the raw PDF bytes, which it has no parser for and is not
meant to grow one. `deriveOutputKey(job)` for `note.source.extract` returns
`notes/sources/<sourceObjectId>/extracted-<jobId>.txt`, idempotent per job
exactly as `job-handler.interface.ts` requires, following
`media.audio.transcode`'s rendition-key precedent for the same reason: the
extracted text is a durable, externally-referenced artifact, not scratch
output nothing outside the job will ever name again.

## 5. The streaming contract

### 5.1 The durable buffer

`note_generations.content` (§4.4) is the **only** place a token is ever
written. `note.generate` appends each delta the provider streams, flushing to
the row on a short interval — `notes.streamFlushIntervalMs`, default **250**
— rather than on every individual token, so a fast model does not turn into a
write-per-token hammering on Postgres; the flush also bumps `last_event_id`
by one for whatever text accumulated since the previous flush. Both the
append and the `last_event_id` increment happen in the same `UPDATE`, so the
id sequence is gapless and stable by construction — there is no separate
counter that could disagree with what actually landed in `content`.

**Rejected: a separate `note_generation_chunks` table, one row per delta.**
Resume (§5.3) only ever needs a **suffix** of one string — "give me
everything after position N" — which a single `content` column answers with
a substring slice. A chunks table would need an `ORDER BY` range query on
every poll and grows without bound for the length of one generation, for no
capability the single column lacks; it also would not double, the way
`content` does, as the literal input to both writes completion makes in one
transaction — the new `note_versions.body` row, and `notes.body` itself, kept
equal to it by §4.1's invariant.

### 5.2 The SSE endpoint

`GET /api/note-generations/:id/stream`
(`apps/api/src/notes/generation/note-generation-stream.controller.ts`, #52).
Reachable by the generation's owner (the note's owner, for `create`/
`regenerate`; the caller who requested it, for `preview`) — same access
discipline as §6, same 404-not-403 posture.

**Frame shape**, standard Server-Sent Events, two event types:

```
event: chunk
id: 42
data: {"delta":"the text appended since the previous frame"}

event: done
id: 43
data: {"status":"succeeded","errorClass":null,"errorDetail":null}

```

- **`id:` semantics.** The id on a frame is the exact `last_event_id` value
  the row carried the instant that content was flushed — not a wall-clock
  timestamp, not a client-side counter. It is therefore stable and directly
  resumable: a client that has seen frames up to id 42 asks to resume **from
  43**, and the server's answer is unambiguous because the id space is the
  row's own, monotonic, write-order sequence.
- **The `Last-Event-ID` resume rule.** A browser's native `EventSource`
  automatically resends whatever id it last received as the `Last-Event-ID`
  request header on reconnect; a client opening a **fresh** connection after
  a full page reload (where no `EventSource` object survived to remember an
  id) instead passes `?lastEventId=` explicitly, read from `note_generations
  .lastEventId` on the note it already fetched. Either way, the endpoint's
  read loop is one function: load the row, and if the requested id is behind
  `content`'s current length, emit **one** immediate `chunk` frame carrying
  the substring from that point plus the row's current `last_event_id`,
  before continuing to tail live. A caller already caught up (requesting an
  id at or past the current one) skips replay and starts tailing
  immediately.
- **A generation that is already terminal answers the same way.** There is
  no special case for "you reconnected after it finished" — the endpoint
  replays whatever content the caller's id was missing, then immediately
  emits `done` and closes. This is what lets the client run **one** code
  path for every entry into the streaming view: open the stream, and either
  you catch a live tail or you get a fast replay-then-done, with no branch
  needed at the call site to ask "is this actually still running."

**Termination conditions, all of them:**

1. **`done`, server-initiated.** `note_generations.status` reaches
   `succeeded` or `failed`; the endpoint emits `done` with that outcome and
   closes the response.
2. **Client-initiated disconnect** (tab closed, navigation, network drop).
   The server's read loop for that one HTTP response simply ends when the
   socket closes; **nothing about the underlying `note.generate` job is
   affected** — it keeps running, keeps flushing to `content`, entirely
   independent of whether anyone is currently reading it. This is the literal
   mechanism behind "closing the tab loses nothing."
3. **Read-idle timeout.** If the stream has been open longer than
   `note.generate`'s own `profile.maxRuntimeMs` (§2) and the generation is
   still not terminal — the job is presumably stuck or was reaped — the
   endpoint emits a `done`-shaped frame with `status: 'failed'`,
   `errorClass: 'timeout'` and closes, so a client is never left holding an
   open connection indefinitely. This is a client-facing safety net layered
   **on top of** the reaper's own recovery (`docs/specs/job-queue.md` §7),
   never a substitute for it — the reaper still owns actually reclaiming the
   job row.
4. **The generation row is gone.** A preview's TTL sweep (§4.4) removes it
   mid-connection, or the parent note was deleted. The endpoint's next poll
   finds no row, emits `{"status":"failed","errorClass":"gone"}`, and closes.
5. **The read mechanism itself is a poll loop, not a database subscription.**
   The endpoint re-reads `note_generations` by primary key on a short
   interval (~150–300 ms) for the life of one open connection, rather than a
   Postgres `LISTEN/NOTIFY` subscription. A poll against one indexed row,
   for a generation that typically finishes in seconds to a couple of
   minutes, is negligible load, and it is the **same mechanism** whether the
   reader is the tab that started the generation, a reconnecting one, or a
   second tab opened on the same note — there is exactly one code path for
   "catch me up" and "keep me updated," because both are simply "poll from
   event id N." This is the identical shape `docs/specs/transcription.md`
   §5's weak-ETag polling already uses for `GET /:id`, at a shorter interval
   because a token stream has to feel live in a way a settings row does not.

### 5.3 Arguing against the in-process `EventEmitter`, explicitly

This is the alternative anyone reaches for first, and it is wrong on the same
three counts VISION.md and the epic's own architecture notes name directly:

1. **It breaks the moment there are two API replicas.** An `EventEmitter`
   lives in one process's memory. `note.generate` is server-only (§1's
   "Why this shape" decision 2) but that only means it never runs on a
   worker *node* — it can still be claimed and executed by **any** of this
   deployment's API replicas running the worker, with no guarantee the same
   replica is also the one serving a given browser's SSE connection behind a
   load balancer with no sticky sessions. An emitter on replica A is
   invisible to a listener attached on replica B: the stream would simply
   hang, silently, with nothing wrong in the logs of the replica actually
   doing the work.
2. **A closed tab loses work.** An `EventEmitter` has no memory of anything
   emitted before a listener attaches — it is a broadcast primitive, not a
   log. A user who closes the tab mid-generation and reopens the note a
   minute later would get a listener that only hears **future** emissions,
   missing everything already produced. The only fix would be to *also*
   maintain a durable copy for replay — at which point the durable copy is
   the real source of truth and the emitter is a redundant, unreliable
   second one layered on top of it for no benefit.
3. **A reconnect cannot resume.** There is no `Last-Event-ID` equivalent for
   an emitter, because there is nothing persisted to resume **from** — every
   reconnect would restart the client's view from empty, directly
   contradicting the epic's own success criterion: *"Reconnecting
   mid-generation resumes mid-stream rather than restarting or dropping the
   tokens already produced."*

Making the stream a **projection** of durable state buys all three for free,
at the cost of a poll interval instead of a push — a trade this codebase has
already made once, for the identical reasons, in transcripts' own `GET /:id`
polling. There is no new mechanism in §5; there is only a shorter interval
than either existing precedent, because a token stream needs to read as live
in a way neither of those does.

## 6. The access model

### 6.1 Owner-only, and 404 never 403

`apps/api/src/notes/access/note-access.service.ts` — `NoteAccessService
.require(userId, noteId, level)` with `level ∈ 'view' | 'edit' | 'own'`,
deliberately the same three-level shape `TranscriptAccessService` already
has (`docs/specs/transcription.md` §6.1), even though in this epic every
level collapses to a single ownership check: **there is no `note_shares`
table in v1**, so only the owner ever satisfies any level, and everyone else
gets a uniform 404. Keeping the three-level interface now — rather than a
bare `requireOwner(userId, noteId)` — means the day note sharing is built, it
slots into `NoteAccessService` exactly the way `transcript_shares` slots into
`TranscriptAccessService`, with **zero** call-site changes anywhere that
already asks for `'view'`, `'edit'`, or `'own'`.

**No access is a 404, never a 403** — carried across, not restated loosely,
from `docs/specs/transcription.md` §6.1: a 403 confirms a resource exists and
merely refuses the caller; a 404 reveals nothing about whether note `abc123`
exists at all, which matters for the identical reason it matters for a
transcript — a note is derived from somebody's private conversation, and the
existence of a specific id is itself information a stranger has no business
learning.

### 6.2 Why note sharing waits, and what it will reuse when it lands

The epic states this as an explicit scope line, and the reasoning is worth
carrying forward precisely rather than restating loosely: note sharing is
**out of scope for epic #45 entirely**, deferred to a later, not-yet-filed
epic, so that when it is built it can be modelled directly on
`transcript_shares`' already-proven shape (`docs/specs/transcription.md`
§6.3) — the narrow exact-email lookup, the generic "no user with that
email" 404, the per-caller rate-limited lookup throttle, `viewer`/`editor`
roles, revocation taking effect on the next request with nothing cached to
invalidate — rather than inventing a second sharing model that could disagree
with the first about any of those details. Building note sharing inside this
epic, before that pattern could be reused deliberately rather than
approximated under time pressure, was rejected for the same reason issue #46
itself exists: the expensive mistakes in this codebase are the cross-feature
disagreements, and two independently-designed sharing models is exactly that
kind of mistake.

### 6.3 What `notes:*` and `note_templates:*` gate

`notes:read`/`notes:write` and `note_templates:read`/`note_templates:write`
are seeded to **all three roles** — Admin, Contributor, and **Viewer**
(`apps/api/prisma/seed-data.ts` `ROLE_PERMISSIONS`) — mirroring
`transcripts:read`/`write` exactly (CLAUDE.md's "Key Permissions" section),
because producing a note is the core action this epic exists to enable and a
fresh account's default role is Viewer. There is deliberately **no
`notes:read_any`**, for the identical reason there is no
`transcripts:read_any` (`docs/specs/transcription.md` §6.2): a note is
derived from somebody's private conversation, and no permission string for
reading another user's note content exists anywhere in this design, for any
role, ever.

`note_templates:write` gates creating, editing, and deleting a user's **own**
custom templates only — it does not gate built-ins, which are immutable
through the API regardless of any permission any role holds (§7).

**`POST /api/note-templates/:id/preview` is gated on `notes:write`, not
`note_templates:write`.** A preview reads a template (any template the caller
can already see — `note_templates:read` covers that) but its action is
**generating real content through the user's own AI key**, the same
mechanism `note.generate` runs — so it is gated by the permission that
governs generating, exactly the way `transcript.export`'s reuse endpoint is
gated on `transcripts:read` (view access to the transcript), not on any
permission belonging to the exporter registry itself.

### 6.4 Why the admin AI policy card reuses `system_settings:*`

The `ai` system-settings namespace (enabled providers, permitted models,
token ceilings, request timeout) is gated on `system_settings:read`/`write`,
**not** a new `ai:*` permission pair — the same SMTP-password-precedent
reasoning `docs/specs/transcription.md` §6.4 applies to the AssemblyAI
settings card, checked against the same four-way test CLAUDE.md's "Key
Permissions" section states for why `push:*`/`nodes:*`/`broadcasts:*`/
`db_backup:*` earned their own permissions: rotating a *policy* value here
disrupts nothing already in flight (unlike `push:*`), names no
fleet-versus-queue distinction (unlike `nodes:*`), sends nothing to anyone
(unlike `broadcasts:*`), and touches no data more consequential than an
ordinary settings edit (unlike `db_backup:restore`). What this namespace
actually configures is deployment **policy about what is permitted** — never
a credential; the per-user key itself lives in `user_ai_credentials` (§4.2)
and is gated by ordinary self-service ownership, the same split
`docs/specs/transcription.md` §6.4 draws between "configuring the pipe" and
"holding the key."

`GET /api/ai/config` is the one non-admin endpoint in this group, gated on
`notes:read` following `GET /api/transcription/config`'s exact precedent
(§6.4 of transcription.md, and CLAUDE.md's Browser Notifications section
before it): a regular user needs to know which providers/models this
deployment permits, and which provider their content would go to, without
needing `system_settings:read` to ask.

**`GET /api/ai-settings/models` (#78) is gated on `system_settings:write`,
not `:read`, even though it is a `GET`.** Every other read in this group is
`:read`; this one is side-effecting — it spends a real, billable vendor call
— which is the identical "looking is not probing" reasoning `POST
/api/ai-settings/test` and `POST /api/transcription-settings/test` already
establish for their own probes. It is gated no differently for the fact that
it spends the *calling administrator's own* key rather than a deployment
one: whose credential is charged changes who bears the cost, not whether the
action is a read or a write.

## 7. Templates and built-ins

### 7.1 The null-owner convention

`note_templates.owner_id IS NULL` means built-in — readable by **every**
user regardless of any permission beyond `note_templates:read`, editable by
**nobody** through the API, seeded via `apps/api/prisma/seed-data.ts` (#48),
extending the exact same seeding mechanism this repository already uses for
role-permission rows and the allowlist's initial admin entry. `GET
/api/note-templates` returns the union of `owner_id IS NULL` and `owner_id =
callerId`, so a brand-new account with zero templates of its own still sees
a full, usable catalogue on day one.

The seeded set is the six VISION.md names in its "Skills" section as worked
examples of what a Skill/template should be able to produce: **concise
meeting notes, detailed meeting notes, an executive summary, action items, a
decision log, and a follow-up email.**

### 7.2 Immutability is a stated policy, not a privacy boundary — and answers
differently from §6's 404

`PATCH`/`DELETE /api/note-templates/:id` against a built-in template answers
**403**, not the 404 §6.1 gives an unowned *note*. This is a deliberate
divergence, not an inconsistency: §6's 404 exists because a **note's**
existence is private information a stranger has no business confirming or
denying. A built-in template's existence is not private — it is visible to
**every** user by design, listed in every account's own template catalogue.
Confirming "yes, this template exists, and no, it cannot be edited" leaks
nothing that was not already public, so the honest answer — a named,
actionable 403 — is the right one, and the 404 posture that governs every
other cross-user access check in this epic does not apply to a row nobody
owns.

### 7.3 Duplicate-to-mine

`POST /api/note-templates/:id/duplicate` works against any template the
caller can read — a built-in, or another one of their own, for a
"start from a variant" flow — and creates a new row with `owner_id:
callerId`, copying `name` (suffixed, e.g. `"Concise Meeting Notes (copy)"`),
`description`, `instructions`, `output_format`, `structure`, `tone`, `length`
and `model` verbatim (`is_archived` resets to `false` — a duplicate of an
archived template is a fresh, active starting point, not an archived one).
Copying every column, not merely `instructions`, is §4.3's round-trip
argument applied one step earlier than editing: a "start from a variant" flow
that dropped the source template's structure/tone/length on the way in would
hand the user a form they still have to refill from scratch, the exact
failure §4.3 rejects composing those fields away in the first place. This is
what lets a first-run account produce a usable note without authoring
anything, and what lets any account customise a built-in without losing the
original.

**No `duplicated_from_id` is tracked.** Unlike a note's source (§4.1's
`Restrict` trio — genuine evidence a note must stay connected to per
VISION.md's Trust-and-Provenance thesis), a template is a recipe, not
evidence: once duplicated, it is simply the user's own template, free to
diverge with no product need to trace which built-in it started from. Adding
lineage tracking here would be applying §4.1's provenance discipline to
something the product's own thesis does not ask it to apply to.

### 7.4 Hidden templates (issue #310, epic #306)

`PUT`/`DELETE /api/note-templates/:id/hidden` let a caller remove one
template — theirs or a built-in — from their **own**
`GET /api/note-templates` list without touching the shared row at all.

**Hiding is a LISTING preference, never access control, and that distinction
is load-bearing throughout.** `POST /api/notes` (create), `POST
/api/notes/:id/regenerate`, and `POST /api/note-templates/preview` all keep
accepting a hidden template by id exactly as before it was hidden — hiding
changes what a picker *shows*, not what an id *resolves to*. A hidden
template a note already references keeps producing that note's history
unaffected; hiding it after the fact does not retroactively hide the note
or its provenance line.

**Why hiding a built-in is allowed, and deliberately not the §7.2 403
path.** §7.2's built-in immutability check exists because `PATCH`/`DELETE`
would mutate the **shared** row every other account also reads. Hiding
writes a row in `user_hidden_note_templates` keyed on the caller and touches
nothing on `note_templates` itself, so there is nothing here for the
immutability rule to protect — the access check the controller performs is
`'read'`, the same check `GET /:id` already performs, not the write-and-own
check `PATCH`/`DELETE` perform. Hiding is exactly the operation a built-in's
public, shared existence should support: an account that has no use for the
"Meeting Notes" seed template can remove it from its own picker without
that seed disappearing, or even changing, for anyone else. Another user's
**custom** template, by contrast, is still a 404 on either route — hiding
does not create a second way to probe for a row you cannot read.

**Idempotent both ways.** `PUT` on an already-hidden template, and `DELETE`
on one that was never hidden, both answer `204` — the caller asked for a
state, not for an edge to fire, mirroring the idempotency posture
`docs/specs/transcription.md` and this file's own §5.2 resumable-stream
contract already establish elsewhere in this codebase.

**Audited, not versioned.** `note_template:hide` / `note_template:unhide`
audit events record `{ templateId, builtIn }` (`NoteTemplatesService.hide`
/ `.unhide`) — a preference change is worth an audit trail entry for "who
tidied their own picker and when," but it is not content, so it gets no
`note_templates` version-style history of its own.

**`GET /api/note-templates` excludes hidden templates by default** and
includes them under `?includeHidden=true`; every returned item — hidden or
not, built-in or the caller's own — carries `hidden` for **the caller**,
computed from a `hiddenBy` relation filtered to `userId` so that another
account hiding a built-in can never make it read as hidden for anyone else.
A freshly **duplicated** copy of a hidden template (§7.3) is visible: the
duplicate is a new row with no `user_hidden_note_templates` entry of its
own, hiding the source never propagates to a copy.

**Orthogonal to `is_archived`.** Archiving is a property of the template
row itself (§4.3) — visible to nobody, because the row's own
`DELETE`-with-references fallback set it — while hiding is a property of
the `(user, template)` pair. A caller may archive their own template and
separately hide a built-in; the two states compose with no shared code path
and no shared column.

**Why a join table, and not the two obvious alternatives:**

- **Not a `user_settings` namespace.** A namespace would need to enumerate
  an unbounded, growing list of template ids inside one JSONB blob with no
  foreign key to `note_templates` in either direction — nothing catches a
  hidden id that outlives the template it named, filtering "is this template
  hidden" becomes a JSONB containment check instead of an indexed join, and
  the six-file settings-parity discipline this codebase's `CLAUDE.md`
  documents for a `system_settings` namespace (and its five-file counterpart
  for `user_settings`) buys nothing here that a plain table with two foreign
  keys does not already get for free. A join table gives real FK integrity
  in both directions, an ordinary indexed `WHERE user_id = ...` / `WHERE
  template_id = ...` query, no cap on how many templates one caller may
  hide, and zero settings-parity cost.
- **Not `note_templates.is_archived`.** `is_archived` is a column on the
  **shared** row (§4.3) — true or false for every viewer at once, which is
  exactly wrong for hiding: a built-in must stay archived-`false` and fully
  visible to everyone else while one account hides it from their own list.
  Reusing `is_archived` would mean the first user to hide a built-in
  archives it for the entire deployment.

## 8. Export

### 8.1 The registry is extracted, not re-implemented

`apps/api/src/export/exporter-registry.ts` (#54) is a **generic** extraction
of `TranscriptExporterRegistry`'s exact shape
(`apps/api/src/transcripts/export/transcript-exporter.registry.ts`,
`docs/specs/transcription.md` §8.1) — a generic `Exporter<TDoc>` interface
(`format`, `label`, `mimeType`, `extension`, `options`, `optionsSchema`, and
`render(doc: TDoc, options, out: Writable): Promise<void>` under the exact
same **streams, never returns a buffer** contract §8.1 states) and a generic
`ExporterRegistry<TDoc>` class carrying `register`/`get`/`all`/`formats`
unchanged. This is the **first** step of #54, landed as its own
behaviour-preserving refactor commit: `apps/api/src/transcripts/export/
transcript-exporter.registry.ts` becomes a thin instantiation —
`class TranscriptExporterRegistry extends ExporterRegistry<ExportDocument>`
— with its existing test suite
(`transcript-exporter.registry.spec.ts`) passing unmodified against the
identical public API, which is what proves the extraction changed nothing
about transcript export before anything note-shaped is added on top of it.

`apps/api/src/notes/export/` then gets its own `NoteExporterRegistry extends
ExporterRegistry<NoteExportDocument>` and three self-registering exporter
classes — `markdown.exporter.ts`, `pdf.exporter.ts`, `word.exporter.ts` —
following the identical "adding a format costs one class" discipline
`docs/specs/transcription.md` §8.1 states for transcripts, restated as its
own rule for the second document type it now applies to.

### 8.2 `NoteExportDocument`

`apps/api/src/notes/export/note-export-document.ts`, built once by a pure
`buildNoteExportDocument()` from the version being exported — the note's
counterpart to `buildExportDocument()` — with none of `ExportDocument`'s
speaker/segment/talk-time shape, because a note has none of those:

```ts
interface NoteExportDocument {
  noteId: string;
  title: string;
  body: string;              // the version's markdown, as stored
  version: number;
  createdAt: Date;           // when this version was saved
  exportedAt: Date;
  author: { displayName: string; email: string } | null; // null for an AI version
  provider: { id: string; model: string } | null;         // which AI generated it, if any
  templateName: string | null;
  source: { type: 'transcript' | 'note' | 'document'; title: string; id: string };
}
```

### 8.3 What a note-shaped export needs that a transcript-shaped one does not

Three real differences, not merely a smaller document:

1. **A provenance line naming the source, rendered into every format** — a
   header such as *"Generated from: Weekly Sync — Sep 12 (transcript)"*.
   VISION.md's Trust-and-Provenance thesis matters most acutely for an
   artifact that **leaves the application entirely**: inside KVox a note
   always carries its source as a live link the reader can click through;
   a PDF emailed to a client cannot. The provenance line is the export's only
   carried memory of where the content came from once it is outside this
   application. A transcript export has no equivalent line, because a
   transcript **is** the primary source, not a derivative of one.
2. **Markdown-to-X rendering, not segment-to-X rendering.** A note's body is
   already markdown — its native storage format (§4.5, and VISION.md's
   explicit "A note is markdown" scope line) — so `markdown.exporter.ts`'s
   render is close to a literal passthrough (front matter plus the
   provenance line); `pdf.exporter.ts` and `word.exporter.ts` need an actual
   markdown parser (`apps/api/src/notes/export/markdown-ast.ts`, wrapping a
   small, audited parsing library — headings, lists, emphasis, code) to lay
   out, a capability `apps/api/src/transcripts/export/` has never needed,
   because its PDF and Markdown renderers build their own layout directly
   from segments and speakers and never interpret markdown syntax written by
   anyone else.
3. **Word (`.docx`) export.** `docx` export was explicitly deferred out of
   epic #19's scope (`docs/specs/transcription.md` §8's own scope line,
   restated in CLAUDE.md) and has never been built anywhere in this
   codebase. #54 is where the **first** `docx` exporter actually lands, built
   for notes rather than retrofitted onto transcripts, because VISION.md's
   "Information Should Be Portable" section names Word explicitly and a page
   or two of prose is a far more natural `.docx` document than a
   multi-thousand-segment transcript would be. Whether this exporter is
   later generalised for transcript export as well is out of scope for #54.

**What notes' PDF export *does* reuse wholesale**: the bundled Noto fonts
(`apps/api/assets/fonts`, `docs/specs/transcription.md` §8.4) rather than a
second font set, and the streaming `render(doc, options, out: Writable)`
contract itself — the two pieces of infrastructure genuinely shared between
transcript and note PDFs.

### 8.4 Queue job, reuse, expiry — identical posture to transcripts

`note.export` (§8.5 below) is the **only** path to a note export — no inline
synchronous rendering below some size threshold, for the identical rule-1
reasoning `docs/specs/transcription.md` §8.5 states in full. `POST
/api/notes/:id/exports` hashes `{ format, version, options }` and checks
`note_exports` (§4.6) for a matching, unexpired row before enqueueing — 200
on a hit, 202 `{ exportId }` on a miss — the same content-addressed reuse
`docs/specs/transcription.md` §8.5 describes, cited by section rather than
restated. Exports expire after 7 days, swept by `notes.housekeeping` (§8.6).

### 8.5 Job types

Six job types, all under `apps/api/src/notes/handlers/` except
`note.source.extract`'s node executor counterpart
(`apps/cli/src/node/executors/note-source-extract.ts`):

| Job type | Profile | Node-eligible? | Reasoning |
|---|---|---|---|
| `note.generate` | `{ maxRuntimeMs: 10m, maxAttempts: 1 }` | **No** | CLAUDE.md rule 3, per-user reason (§ "Why this shape" decision 2); `maxAttempts: 1` per decision 3 |
| `note.source.extract` | `{ maxRuntimeMs: 5m, maxAttempts: 3 }` | **Yes** | Rule 2's default posture — CPU-bound, secret-free, exactly `media.audio.transcode`'s shape |
| `note.export` | `{ maxRuntimeMs: 5m, maxAttempts: 2 }`, priority **−10** | No, in v1 | The identical "renderers live in the API" reasoning `docs/specs/transcription.md` §1.5.6 states for `transcript.export`, cited by number rather than re-argued; priority −10 for the same "someone is watching a spinner" reason |
| `note.purge` | Deployment default | No | Rule 2's "deletes rows/objects across several tables as it goes," mirroring `transcript.purge` (transcription.md §1.5.7) |
| `notes.housekeeping` | Deployment default | No | Rule 2's "reads/writes across several tables in one sweep," mirroring `transcripts.housekeeping` (transcription.md §1.5.8); enqueued by a ten-minute `@Cron` through the shared `enqueueHousekeepingJob` helper (`docs/specs/job-queue.md` §7.10), which is what keeps `apps/api/test/jobs/cron-enqueue-only.spec.ts` passing once this cron exists |
| `note.retitle` | `{ maxRuntimeMs: 2m, maxAttempts: 1 }`, sweep priority **100** | **No** | §3.4.1. Same per-user credential reason as `note.generate`, and the same `maxAttempts: 1`; `maxRuntimeMs` is two minutes because `NoteTitleService` already caps its own provider call at ≤30 s and the rest is two indexed row reads — and the lease derives from that number, so a dead worker's job is reclaimable in two minutes rather than ten. The bulk sweep enqueues at `HOUSEKEEPING_PRIORITY`; the single-note route takes the column default, because somebody pressed a button |

`note.purge`, unlike `transcript.purge`, calls **no provider-side delete** —
there is no remote copy of anything to clean up (§9.4 explains why a chat
completion leaves nothing behind the way an in-flight transcription job
does); it only removes this note's own managed storage objects (a document
source and its extraction, if any) and export files, then the SQL rows via
cascade.

## 9. Privacy — what leaves this deployment, to whose account

VISION.md requires that users *"understand when their information is being
sent to an external AI provider."* Per-user keys make the answer to that
question **precise** rather than institutional, and this section states it
in concrete terms, following `docs/specs/transcription.md` §10's own
discipline of stating facts rather than gesturing at a policy.

**What is transmitted.** The fully assembled prompt (§3) — the template's
instructions, the user's optional context text, and the **complete** source
text (the whole transcript's reading rendering, the whole source note's
body, or the whole extracted document text — never a truncated version, per
§3.3) — is sent over HTTPS directly from the API server to the configured
provider's completion endpoint. Nothing about that request passes through
any other system this deployment operates.

**Under whose account.** The API key used is the **calling user's own
saved key**, decrypted server-side for the duration of that one outbound
request only — never written to disk beyond its encrypted column in
`user_ai_credentials`, never logged, following `secret-cipher.ts`'s own
"THIS MODULE MUST NOT LOG" invariant. This means the content that reaches
the provider is subject to **that individual user's own** account-level data
and retention settings with that provider — not a blanket policy this
deployment's operator negotiated, and not the same policy for every user.
This is the one respect in which notes' privacy answer is more precise than
transcription's: `docs/specs/transcription.md` §10 can state one uniform
retention fact because every user's audio goes through one shared
AssemblyAI account; here the honest answer is "your own provider account's
own settings govern your own content," which the UI states rather than
asserting a specific retention window the application does not control on
any individual user's behalf.

**What an administrator can see.** Which providers and models this
deployment **permits** (the `ai` policy, §6.4) — a setting, not a content
fact. Aggregate operational facts through the ordinary job admin surface
(`GET /api/admin/jobs`) — that `note.generate` jobs exist, their subject ids,
counts and failure rates — the same shape every other job type already
exposes there, **never** a job's payload or a generation's `content`.

**What an administrator cannot see.** The plaintext of any user's saved AI
key — write-only over the wire, never returned by any endpoint, the same
guarantee `CredentialsService`/`secret-cipher.ts` already give every other
secret this application stores. The content of any note, or the prompt that
produced it. Which specific transcript, note, or document a given note was
generated from, through any path this RBAC model grants — there is no
`notes:read_any` (§6.2), so an administrator configuring **policy** has
exactly the same no-path-to-content posture `docs/specs/transcription.md`
§10 already states for transcription: *"configuring the pipe is not the same
authority as reading what flows through it."* Any usage or billing on the
user's own OpenAI account — that lives entirely on the provider's side, tied
to a key this application never displays back to anyone, including its own
administrators.

**The provider's own retention, stated as honestly as
`docs/specs/transcription.md` §2.7 states AssemblyAI's API shape: as of this
document's writing, OpenAI's published API data-usage policy does not use
API-submitted content for model training and does not retain it beyond a
short abuse-monitoring window — but this is the **vendor's stated policy**,
not something this application enforces, verifies, or can act on if it
changes. It must be re-checked before this epic is declared final, for the
identical reason §2.4's AssemblyAI-style caveat exists.

**Why `note.purge` calls no `deleteRemote`.** `transcript.purge` calls
`provider.deleteRemote` (`docs/specs/transcription.md` §1.5.7, §10) because
AssemblyAI holds a **persistent remote copy** of the audio and the transcript
between submission and ingest that this application is responsible for
asking it to delete. A chat completion has no such persistent object on the
provider's side that this application created and must clean up — the
request and its streamed response are the entire transaction, over as soon
as the stream ends. Deleting a note therefore only ever has to remove
**this application's own** rows and storage objects, which is why §8.5's
`note.purge` is a lighter job than `transcript.purge` in this one specific
respect.

**A generation now durably stores a copy of the source text it sent, for the
note's lifetime (issue #307).** `note_generations.user_content` (§4.4) holds
the complete source material that reached the provider, not just a pointer to
it — so `GET /notes/{id}/context` can show it back later even after the
source transcript is edited, unshared, or deleted. That copy is deleted with
the note: `note_generations.note_id` cascades, and `note.purge`/
`user.data.purge` deleting the note row takes every one of its generations,
snapshot included, with it — there is no separate retention window for this
column. If `ai.maxInputTokens` grows enough to make storing full prompt text
in the database costly, offloading `system_prompt`/`user_content` to object
storage (mirroring how source documents already work) is a future option;
nothing about §307's design requires it today.

**The user is told before every generation which provider and model their
content is being sent to.** `GET /api/ai/config` (§6.4) exposes the
deployment's permitted providers and models, and the note-creation flow
shows — before Generate is pressed — *"This will be sent to OpenAI (gpt-4o)
using your saved API key."* the same transparency posture
`GET /api/transcription/config` already gives transcription
(`docs/specs/transcription.md` §10).

## Notifying somebody about a note

Three events, added to `NOTIFICATION_EVENTS`
(`apps/api/src/notifications/notification-events.ts`) via the exact
three-step recipe CLAUDE.md's "Adding a Notification" section documents —
mirroring the three transcript events `docs/specs/transcription.md`'s own
"Notifying somebody about a transcript" section states, with the same
addressed-to-a-user posture (none of these is a job-queue operational event
addressed to a permission, the way `jobs.job_failed` is):

- **`notes.note_ready`** — raised by `note.generate` after its version
  commits, to the owner. Default-enabled.
- **`notes.note_failed`** — raised on any terminal `failed` (§2.2), to the
  owner, carrying the error class and a link straight to the Regenerate
  action.
- **`notes.preview_failed`** — raised **only** for a template preview
  (`kind: 'preview'`) that fails, to the user who requested it, since a
  preview has no note detail page to surface the failure on otherwise — a
  successful preview needs no notification at all, because the user is
  already watching it stream live in the templates manager (#56).

None of the three is `mandatory: true` — unlike `security.role_changed`,
being told a note finished or failed is a courtesy about the user's own
requested work, not a security-relevant change to their account.

## Rejected alternatives

- **An in-process `EventEmitter` for the generation stream.** Rejected on
  all three counts §5.3 states in full: it breaks across API replicas, a
  closed tab loses everything already produced, and a reconnect has nothing
  to resume from. This is the alternative the epic's own architecture notes
  name explicitly as the one anyone would reach for first.
- **A deployment-wide or fallback API key.** Rejected per the epic's own
  scope line: this product's thesis is that every user brings their own
  account, and a shared fallback key would reintroduce exactly the
  institutional, imprecise privacy answer §9 exists to avoid — "sent to
  OpenAI under this deployment's own account" instead of "under yours."
  It would also make `ai-provider:<userId>` throttle keys (§2.3) meaningless,
  since every user's generations would share one account's rate limit again.
- **A deployment key held just for model discovery (#78)**, so an
  administrator without a personal key could still browse the catalogue.
  Rejected for the identical reason as the entry above: it is the same
  fallback credential §9 rules out, reintroduced through a side door that
  makes the privacy answer no less institutional than adding it through the
  front door would. See §2.5.
- **A sibling metadata map for model context windows (#78)**, keyed by model
  id alongside a still-`string[]` `allowedModels`. Rejected because it is two
  structures that can disagree about which models exist — an id present in
  one and absent from the other, or present in both with a stale entry
  nobody removed when the model was un-permitted — with no way for a schema
  to say that is wrong. See §2.5.
- **Rejecting the legacy bare-string `allowedModels` entry once the object
  form existed (#78).** Rejected because `SystemSettingsService
  .readKnownSettings` silently degrades a namespace that fails to parse to
  `DEFAULT_SYSTEM_SETTINGS` — a schema that rejected the old shape would not
  fail loudly, it would quietly reset every existing deployment's model
  policy to empty on the next read. See §2.5.
- **Leaving rank 4 (the provider's conservative floor) out and letting an
  unknown id stay unresolvable forever (#97).** This is what #78 shipped,
  and it read §3.3's rule against guessing a context window as forbidding
  both directions of error equally. It does not: a window below the truth
  refuses a prompt that would have fit, which is visible and correctable
  with a per-model override that outranks the floor; a window above it
  submits a prompt the vendor rejects **after** billing the user, which is
  neither. Only the second is the mistake §3.3 was written to prevent. See
  §2.5's "superseded" paragraph for the argument in full.
- **Deriving family placement in `AiConfigService`/`AiSettingsService`
  instead of on the provider (#97).** Rejected because which id shapes are
  dated snapshots and which families exist is vendor knowledge, not policy
  logic — a service that learned OpenAI's snapshot-suffix conventions would
  have to learn a different vendor's all over again for the next provider,
  and the two services would risk deriving differently for the same id with
  nothing to catch the drift. See §2.5.
- **An operation log for note bodies**, mirroring `transcript_versions`'
  design. Rejected per §4.5: the arithmetic that justifies an op log for a
  90,000-word transcript (roughly 7 MB per full snapshot) does not apply to
  a page or two of prose, and the machinery an op log needs to pay for
  itself — pure reducers, `materialize()`, per-entity concurrency, ordinal
  gaps — has no equivalent structure in a note to operate over. A full body
  per version is simpler, smaller, and sufficient.
- **A fifth top-level navigation destination for Notes.** Rejected *at the
  time*, per `apps/web/src/config/destinations.ts`'s own header, restated by
  the epic itself: *"the bottom bar's ceiling is exactly four … a fifth
  destination is not an addition, it is a redesign."* Notes therefore joined
  the existing `transcripts` destination, renamed `library`, owning both
  `/transcripts` and `/notes` — the same **destination-vs-tab** reasoning
  `docs/specs/settings-ui.md` §2 already states for Users/Allowlist, and the
  exact judgement the transcripts library page's own existing
  Mine/Shared-with-me tabs already made: two answers to "what do I have," not
  a hierarchy.

  ⚠ **SUPERSEDED BY EPIC #105.** Transcripts and Notes are now two sibling
  destinations, and the tab strip between them is gone. Nothing above was
  wrong when it was written: the constraint was the bottom bar's four-tab
  ceiling, and #106 made room by moving `Console` off that bar entirely
  (it is `pinned`, so it renders at the navigation rail's foot and in the
  avatar menu instead). The rule this reasoning rests on never said tabs
  were *required* for parallel content, only that they were permitted — see
  [`docs/specs/ux-refresh.md`](ux-refresh.md) §1.
- **A single `/library` route rendering both lists from client-side state.**
  Rejected: Notes needs the same real, deep-linkable sub-routes Transcripts
  already has (`/notes/new`, `/notes/:id`, `/notes/:id/history`), the same
  way `/transcripts/new` and `/transcripts/:id` exist as real routes today,
  not modal or client-only views. `/transcripts` and `/notes` stay two
  separate routes, and that half of this decision still stands.

  ⚠ **The rest is superseded by epic #105.** The two routes were owned by one
  `library` destination and shared a Transcripts | Notes switcher; since #106
  each route is its own destination and there is no switcher. What survives
  unchanged is the reason for rejecting client-side state: both halves still
  need real, deep-linkable sub-routes. The two pages now share
  `LibraryPageFrame.tsx` — a title, a create action, and the breakpoint-aware
  placement of that action — rather than a tab strip.
- **Synchronous generation inside the request.** Rejected per CLAUDE.md
  rule 1: a chat completion can legitimately take from several seconds to a
  few minutes, well past what an HTTP request should hold open, and it needs
  every property §5 gives a queue job for free — durability if the
  connection drops, resumability, and a lease/timeout the reaper already
  knows how to recover. The obvious argument for inlining it ("it's just one
  HTTP call to OpenAI, why queue it") is exactly the reasoning rule 1 exists
  to override: duration, not call count, is what makes something long-running.
- **Storing per-user AI keys in the existing `credentials` table.** Rejected
  per § "Why this shape" decision 4: `credentials` is `(purpose, name)`-keyed
  with no foreign key to `users`, because it holds infrastructure secrets
  that must outlive whichever administrator last configured them. A personal
  API key needs the opposite lifetime — it must be deleted when its owner
  is — which `credentials`' schema cannot express without adding a
  user-scoped column to a table every other consumer of it does not need,
  and without complicating the one guarantee that table exists to hold
  (no plaintext egress, `secret-cipher.ts`'s own invariant) with a second,
  narrower cascade rule that applies to only one row shape among many.
- **A `nodeSecretBroker` for `note.generate`, minting a scoped OpenAI
  key.** Rejected as structurally impossible, not merely undesirable: unlike
  `db.backup.run`'s PostgreSQL role (`docs/specs/database-backup.md` §16),
  OpenAI has no API for minting a short-lived, narrowly-scoped sub-key from a
  user's own API key. There is nothing for a broker to broker.
- **A single `NOTES_READ`-style permission per note action**, folding
  `note_templates:*` into `notes:*`. Rejected: templates and notes are
  governed by two different controllers with two different write surfaces
  (editing a recipe versus generating content), the same "a permission split
  at the API is never re-merged in the registry" discipline
  `docs/specs/settings-ui.md` §3 states for `nodes:read` staying apart from
  `jobs:read` — collapsing them here would make a deployment unable to grant
  one without the other for no structural reason.
- **A sixth `note_source_documents` table for extracted text.** Rejected per
  §4.7: `storage_objects`'s existing `managed_by` convention and generic
  metadata column already express "a derived artifact, referenced by id,"
  the identical shape `media.audio.transcode`'s rendition already uses — a
  new table would duplicate that mechanism for no new capability.

## Verification

What this document's decisions imply for testing, before any of it is
implemented, given here so a later reviewer can check the built code against
the list this spec was designed against — the same purpose
`docs/specs/transcription.md`'s own Verification table serves.

| Claim | Will be covered by |
|---|---|
| `note.generate` declares `profile: { maxAttempts: 1 }` and carries no `nodeResultSchema`/`persistNodeResult`; `note.source.extract` declares both | Unit assertions over each handler's declared members, mirroring `job-handler.registry.spec.ts`'s own pattern |
| `notes.housekeeping`'s `@Cron` only enqueues | `apps/api/test/jobs/cron-enqueue-only.spec.ts`, extended — the existing test this document's job additions must not break |
| The error taxonomy: `AiAuthError`/`AiRefusalError` set `failed` without spending the job's attempt; the default class spends it; `RateLimitError` defers without changing `notes.status` | `apps/api/src/notes/handlers/note-generate.handler.spec.ts`, against a fake `AiProvider` |
| The rate-limit throttle key is `ai-provider:<userId>`, distinct per user | A test asserting `registerProviderKey` is called with a key that varies by the generation's `userId`, unlike transcription's single shared key |
| `assemblePrompt` and the token budget check are the same function called at request time and at job time, and produce identical results for identical inputs | `apps/api/src/notes/prompt/prompt-assembly.spec.ts` and `token-budget.spec.ts`, including a property test over the two call sites |
| An over-budget `POST /api/notes` is refused with a 400 naming both the estimated and the allowed token counts, and creates no note, no generation row, and enqueues no job | `apps/api/test/notes/notes-create.e2e.spec.ts` |
| `notes.status` and `note_generations.status` follow exactly the transitions §1's tables state, including `deleting` being refused with 409 while `status = 'generating'` | `apps/api/src/notes/notes.service.spec.ts` and an e2e state-machine walk |
| `notes.body`/`provider`/`model` are updated only by `note.generate`'s completion transaction or an explicit `PATCH`, and always equal `note_versions.body` at `current_version` after either | `apps/api/src/notes/notes.service.spec.ts`, asserting the invariant after a generate, a regenerate, and a manual edit |
| The SSE endpoint's frame shape, `id:` sequencing, `Last-Event-ID` resume (including a request-time reload with no `EventSource` to remember an id), and every termination condition in §5.2 | `apps/api/src/notes/generation/note-generation-stream.controller.spec.ts`, against an injected clock and a fake provider stream |
| A client disconnect never affects the underlying job's execution | An integration test that closes the SSE connection mid-generation and asserts the job still commits a version |
| No access to a note or a generation is ever a 403; a built-in template's edit attempt is a 403, not a 404 | An RBAC matrix e2e distinguishing the two cases explicitly, per §6.1 and §7.2 |
| `notes:read`/`write` and `note_templates:read`/`write` are seeded for Admin, Contributor and Viewer; no `notes:read_any` exists anywhere | `apps/api/test/prisma/seed-data.spec.ts`, extended |
| `POST /api/note-templates/:id/preview` is gated on `notes:write`, not `note_templates:write` | An RBAC e2e asserting a caller with only `note_templates:read` gets 403 from preview |
| `@@unique([owner_id, name])` on `note_templates` rejects two of one owner's templates sharing a name, but two `owner_id IS NULL` built-ins may share a name | `apps/api/test/prisma/note-templates.constraints.spec.ts` |
| A saved template's `output_format`/`structure`/`tone`/`length`/`model` round-trip through save and reload unchanged — the editor never has to parse them back out of `instructions` | `apps/web/src/__tests__/pages/NoteTemplatesPage.test.tsx`, per issue #56's own acceptance criteria |
| `note_generations.job_id` survives `job.history.purge` deleting the underlying `jobs` row (`SetNull`, not cascade) | `apps/api/test/jobs/job-history-purge.task.spec.ts`, extended to assert a `note_generations` row with a purged `job_id` |
| `note_versions.summary` is set on save and read by the version history list without a `body` fetch | `apps/api/src/notes/notes.service.spec.ts` and `apps/web/src/__tests__/pages/NoteHistoryPage.test.tsx` |
| `DELETE /api/transcripts/:id` 409s naming the blocking note id(s) when a note still references it as its source | `apps/api/test/transcripts/transcripts-delete.e2e.spec.ts`, extended |
| The `user_ai_credentials` row cascades on user delete; the stored key never appears in a response body, a log line, or an audit `meta` | A dedicated assertion sweeping every response and captured log line, following `email-settings.service.spec.ts`'s existing technique |
| `TranscriptExporterRegistry`'s existing test suite passes unmodified after the generic `ExporterRegistry<TDoc>` extraction | `transcript-exporter.registry.spec.ts`, run as-is against the refactored class |
| A note export carries the provenance line, renders markdown syntax correctly in PDF and Word, and reuses an identical prior export by `options_hash` | `apps/api/src/notes/export/markdown.exporter.spec.ts`, `pdf.exporter.spec.ts`, `word.exporter.spec.ts`, and `note-export.service.spec.ts` |
| `note.source.extract` is node-eligible and its extracted-text object is written and referenced exactly as §4.7 describes | `apps/api/src/notes/handlers/note-source-extract.handler.spec.ts`, plus a node-executor integration test mirroring `media-audio-transcode.ffmpeg.spec.ts`'s real-tool-output discipline |
| `config/destinations.ts`'s `library` entry owns both `/transcripts` and `/notes`, and the bottom bar still shows exactly four destinations | `apps/web/src/__tests__/config/destinations.test.ts`, extended |
