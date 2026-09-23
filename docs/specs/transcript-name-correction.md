# AI Name Correction

> Epic #326 (issues #327–#330): feeding a transcript's known names to the
> transcription provider as a recognition hint, then a three-stage pipeline —
> deterministic phonetic retrieval, an optional thorough discovery pass, and
> LLM adjudication — that finds and proposes fixes for the names speech
> recognition still got wrong. Implemented in `apps/api/src/transcription/
> keyterms.ts` (#327), `apps/api/src/transcripts/name-check/` and
> `apps/api/src/transcripts/handlers/transcript-name-check.handler.ts` (#328),
> `apps/web/src/components/transcripts/` name-check review panel (#329), and
> the `thorough` mode plus its discovery pass on top of #328's pipeline
> (#330). Builds on `docs/specs/transcription.md` (the transcript pipeline
> and its `TranscriptionProvider` contract) and `docs/specs/notes.md` §2.5–3.3
> (the `AiProvider` interface, per-user credentials, and the token-budget
> refusal this feature reuses verbatim).

## 1. The problem, and the framing

A transcript's speech-recognition text is a best guess at what was said, and
names are where that guess fails hardest: a name has no grammar to lean on,
often has no common spelling, and the provider has never heard it before this
recording. A user who has already told this application a name — by renaming
speaker "A" to "Oscar", or by typing "Kubernetes" into an upload form — has
given it information the provider's acoustic model does not have. This
feature is the two ways that information is put to use:

1. **Feed it forward** (#327): send the names as a recognition *hint* to the
   provider before transcription happens, the same class of bias
   `speakersExpected` already is — it never forces an output, it never
   fails a submission, and it costs nothing when the active provider cannot
   use it.
2. **Check for it afterward** (#328, #330): after the transcript exists,
   search it for spans that are *probably* a mis-hearing of a name the user
   has since supplied — including one they only added after transcription
   finished, which the feed-forward hint could never have reached — and
   propose a correction.

Both paths keep the exact discipline `docs/specs/notes.md` states for AI
content and `docs/specs/transcription.md` §10 states for transcript privacy:
**"AI proposes. The user controls the truth."** A keyterm biases a vendor's
guess; it is never assumed correct. A name-check suggestion is a candidate
edit sitting in `transcript_name_suggestions`, `status: pending`, until a
person accepts or rejects it. Nothing this feature does writes
`transcript_segments.text` on its own — see §4.

## 2. Feed-forward keyterms (#327)

`apps/api/src/transcription/keyterms.ts` is the whole surface: pure
normalisation (`normalizeKeyterms` — trim, collapse whitespace, drop empties,
de-duplicate case-insensitively keeping the first spelling), a reader
(`readKeyterms`, defensive like `readSpeakersExpected` — a row written before
#327 has no `keyterms` key and reads as none), and a provider-capability
clamp (`clampKeytermsToCapability`).

**Two limits, and they are different things.** `POST /api/transcripts`
accepts up to `MAX_TRANSCRIPT_KEYTERMS` (200) terms of at most
`MAX_KEYTERM_WORDS` (6) words each, at upload time — deliberately tighter
than any vendor's own ceiling, because 200 terms is already far beyond what a
person types into a form and a small ceiling bounds what every transcript
row stores in `provider_options`. Separately, `TranscriptionProviderCapabilities
.keyterms` (`{ maxTerms, maxWordsPerTerm } | null`) is what the *active
provider* can actually be sent, applied by `clampKeytermsToCapability` at
**submit** time, not at upload time, because the active provider can change
between the two. The terms are stored whatever the provider of the moment
can do and only clamped at the edge — a deployment that switches to a
keyterm-capable provider then honours terms a user already typed, on a
retry, rather than having silently discarded them at upload.

**AssemblyAI** (`apps/api/src/transcription/providers/assemblyai.provider.ts`)
is the only provider that implements the capability today: `keyterms:
{ maxTerms: 1000, maxWordsPerTerm: 6 }`, sent as `keyterms_prompt` — **never**
the deprecated `word_boost`/`boost_param` pair (see §7's rejected
alternatives). It is omitted from the request body entirely when there are no
terms, so a submission without keyterms is byte-for-byte identical to one
made before #327. `keyterms_prompt` is documented by the vendor for
`universal-3-5-pro` and `universal-3-pro`; with this deployment's default
`speech_models` fallback list (`universal-3-5-pro, universal-2`) the vendor is
expected to apply the prompt to whichever model in the list supports it.
⚠ **Unverified**: whether a request whose `speech_models` list names *only*
`universal-2` (no keyterm-capable model at all) is refused outright or
silently has the prompt ignored — AssemblyAI's documentation does not say,
and this deployment has not forced that configuration to find out. The terms
are sent regardless; a deployment that pins itself to `universal-2` alone
gets the ordinary transcription with no keyterm effect, not an error.

`GET /api/transcription/config` (readable by any authenticated user, per
`docs/specs/transcription.md` §6.4) publishes `keytermsSupported` (whether the
active provider's `capabilities.keyterms` is non-null) and `maxKeyterms` (the
smaller of this API's 200 and the provider's `maxTerms`, or `0` when
unsupported) — so a client's upload form knows, before rendering the field at
all, whether typing a name will do anything.

## 3. The three-stage correction pipeline (#328, #330)

`apps/api/src/transcripts/name-check/` is entirely **pure** — no Prisma, no
`@Injectable`, no clock, no randomness — the identical discipline
`apps/api/src/transcripts/editing/` holds for the correction reducers
(`docs/specs/transcription.md` §4.4). Every function here is a deterministic
function of its arguments, which is what lets `estimate.ts` compute a request
cost *with the job's own prompt-building functions* rather than a formula
that has to be kept in sync with them by hand, and what lets a test pin exact
output.

### 3.1 Stage 1 — deterministic phonetic retrieval (`candidates.ts`)

Free, instant, and runs in every mode. For each transcript segment:

1. **Tokenize** into word tokens with UTF-16 offsets (`[\p{L}\p{N}\p{M}]+`
   plus internal apostrophes/hyphens, so `"O'Brien"` and `"Oscar's"` are one
   token each).
2. **Slide windows** of 1–3 consecutive tokens, never crossing a segment
   boundary.
3. **Drop a window that is already correct** — spelled exactly like any
   target name (case- and diacritic-insensitively), or that name's plural or
   possessive. A correctly spelled *other* name is never a candidate for
   *this* one, and a multi-token window containing an already-correct token
   is dropped (the misspelled neighbour is still reachable as its own
   window).
4. **Gate** on two independent signals, combined:
   - **Double Metaphone** (`phonetic.ts`) — a TypeScript port of Lawrence
     Philips' algorithm, checked against PostgreSQL's `dmetaphone()`/
     `dmetaphone_alt()` for every test vector. Two phonetic keys (primary,
     alternate) per spelling, at 8 symbols rather than the reference
     implementation's 4, so a long name keeps its tail. A window's keys must
     be equal, or within Levenshtein edit-distance 1 of a target's keys (with
     a length-3 floor before an edit-distance check is attempted at all).
     One-edit differences are further classified **`near`** (a substitution
     between phonetically confusable consonant classes — labials, dentals,
     sibilants, nasals — or dropping the key's leading vowel marker: "Oscar"
     `ASKR` / "Skar" `SKR`) or **`weak`** (any other single edit), and each
     strength carries its own minimum letter-similarity floor below.
   - **Jaro-Winkler** (`phonetic.ts`) letter-level similarity of the
     normalized forms, at least 0.85 on its own, or a looser floor when
     paired with a phonetic match (because Double Metaphone drops every
     vowel — "again" and "Joaquín" share a key — so a phonetic match alone
     is not evidence; it needs a minimum of surviving letter agreement too).
   - A window whose token count differs from the name's own ("Oh scar" for
     "Oscar") is held to a stricter bar: only an *exact* phonetic key match
     with strong letter agreement counts, or every short word pair would
     resemble some name.
   - The window's letter count must be within ±50% of the target's.
   - A run of pure function words ("that is", "so the") is never a window,
     via a small English/Spanish stoplist.
5. **Score and select** — a phonetic/letter-similarity base score, boosted
   when the aligned provider word confidence is low (the provider's own
   doubt is evidence for a mis-hearing) and penalised for a stopword window
   or a stopword at a multi-token window's edge. Non-overlapping windows are
   then kept greedily, best score first, per segment.

Every distinct single-token spelling is memoised (a two-hour transcript has
tens of thousands of tokens but far fewer distinct spellings, and whether a
spelling resembles a name does not depend on where it occurs), which is what
keeps this stage's cost proportional to vocabulary rather than to duration —
see §5.

### 3.2 Stage 1b — thorough discovery (`prompts.ts`, mode `thorough` only, #330)

Phonetic retrieval leans toward recall but is still fundamentally a spelling
comparison: it cannot find "Oscar" heard and transcribed as "the scar," where
the mis-hearing does not even preserve the name's token boundaries or sound
shape closely enough to clear Stage 1's gates. Thorough mode adds a second,
LLM-driven pass that reads transcript **text**, not spelling similarity.

The transcript is packed into chunks of about `DISCOVERY_CHUNK_TOKENS`
(6,000) tokens each, in reading order, **with one segment of overlap**
between consecutive chunks — so a mis-hearing whose surrounding context
straddles a chunk seam is still seen whole at least once; a finding reported
twice for the shared segment is de-duplicated by span when findings are
located. A single segment longer than the chunk budget is a chunk of its
own rather than being cut, because the model needs to quote from the whole
line exactly. Each chunk is rendered as `[<index>] <Speaker>: <text>` lines
and sent with the target list, asking the model for JSON findings
(`{"seg": <n>, "text": "...", "target": "..."}`); findings naming a segment
index outside the chunk it was answered for are dropped.

A finding is **located**, never trusted at face value: `locateDiscoveryFindings`
searches the named segment's text for the quoted `text` (exact match first,
then case-insensitive when that does not change string length), widens the
match to whole word boundaries, skips anything overlapping an already-placed
finding or a phonetic candidate, drops anything that cannot be found at all,
and drops anything that names an unrecognised target or already spells the
target correctly. A located finding becomes a `SourcedCandidate` tagged
`source: 'discovery'` at a fixed nominal score (`DISCOVERY_SCORE = 0.8`) —
below a confident phonetic match, above a marginal one, because the model
read the surrounding context and the phonetic pass did not.

`mergeCandidates` then combines the two candidate sets: a discovery
candidate overlapping any phonetic candidate is dropped (the phonetic span's
offsets were *computed*, not quoted back by a model, so it wins the
overlap), and so is one overlapping an earlier discovery candidate.

### 3.3 Stage 2 — LLM adjudication (`prompts.ts`, both modes)

**Every** candidate from either source, however it was found, is verified by
the model before it can become a suggestion — the discovery pass finds, it
never decides. Candidates are batched (`ADJUDICATION_BATCH_SIZE = 40` per
request) and each is shown with:

- the target name it proposes;
- the speaking segment's line, with the exact span marked with sentinel
  brackets (`⟦…⟧` — characters chosen because they never appear in ASR
  output) and clipped to `LINE_CONTEXT_CHARS` (240) around the span;
- the immediately preceding and following segment's speaker and text,
  clipped to `NEIGHBOUR_CONTEXT_CHARS` (200) — **±1 segment of context**, not
  the whole transcript, in standard mode (see §7 for why "whole transcript
  context" was rejected as the default).

The model answers per item: `verdict` (`replace`/`keep`), `replacement`,
`confidence` (0–1), `reason` (a few words). The request sets
`responseFormat: 'json'` on `AiGenerateRequest` (`apps/api/src/ai/providers/
ai-provider.interface.ts`) — a **hint**, not a guarantee, so the answer is
parsed defensively (`extractJsonObject` tolerates a Markdown fence, preamble
prose and trailing prose) and validated with Zod. A malformed answer earns
one retry with an explicit "return only valid JSON" instruction appended; a
batch that still fails is skipped and logged, never treated as a run failure
on its own — see §5.4.

**The over-correction guard**, the part of this design that makes it safe
to run unattended: `acceptResults` enforces that a `replace` verdict's
`replacement`, after stripping a trailing possessive or plural suffix, must
equal the proposed target — case- and diacritic-insensitively — or the
result is dropped, *however confident the model claims to be*. The model may
only ever choose **between** "the name the user told us about" and "leave it
alone." It cannot introduce a third spelling, cannot correct a name the user
never supplied, and cannot rewrite anything outside the marked span. A
result naming an id the batch did not send, a repeated id, or a replacement
identical to what is already there is also dropped.

## 4. Why this shape (the research this rests on)

- **arXiv 2506.10779**, *"Improving Speech Recognition of Named Entities in
  Speech-to-Text Systems using LLM-based Revision and Phonetic-Semantic
  Context"* — the core argument this pipeline follows: giving an LLM a
  *curated* set of phonetically-plausible candidate entities, retrieved by a
  cheap deterministic pass and shown with local context, outperforms giving
  it the *entire* transcript and asking it to find and fix errors itself.
  Full-document context measurably increases hallucinated "corrections" —
  the model, primed with the whole document, starts rewriting text that was
  already right — while narrow, retrieved candidate context keeps the
  model's job to a bounded verification decision. This is why standard mode
  never sends a full transcript to the model, why the adjudication prompt
  shows ±1 segment rather than the surrounding chapter, and why the
  over-correction guard exists at all: the retrieval step is the safety
  mechanism, not an optimisation.
- **Apple's retrieval-augmented named-entity correction** work — the same
  retrieve-then-verify shape applied to on-device ASR correction, cited here
  for validating that phonetic/fuzzy retrieval feeding a smaller verification
  step is a workable production pattern, not a research curiosity.
- **AssemblyAI's own `keyterms_prompt`** (§2) is metaphone-based keyterm
  boosting at the *acoustic* stage — bias the recognizer before it commits to
  a transcript. This feature's Stage 1 retrieval independently reaches for
  the same phonetic-encoding family (Double Metaphone rather than the
  vendor's own undocumented implementation, since Stage 1 runs against text
  the vendor has already produced and has no access to the vendor's
  internals) for the *correction* stage, after the fact — the two are
  complementary passes at the same underlying problem, not a
  reimplementation of one by the other.

Thorough mode's discovery pass is the deliberate exception to "never send the
whole document": it is offered as an explicit, priced, opt-in mode
specifically because the paper's finding is about *default* behaviour, not an
absolute prohibition — a user who wants the wider net and is willing to pay
for reading the whole transcript through the model, with its own risk of
false positives, can ask for it, and every one of its own findings is still
routed back through the same narrow, guarded adjudication step before
anything is proposed.

## 5. Cost, and why it scales the way it does

### 5.1 Standard mode: cost scales with candidates, not with duration

Stage 1 is free (no model call) and its cost is proportional to vocabulary
size via memoisation (§3.1), not transcript length. What reaches the model is
exactly the **candidate count** — the number of spans Stage 1 judged
plausible — batched at 40 per request with ±1 segment of context each.
A two-hour recording with few ambiguous names and a two-hour recording with
many will cost very differently, but neither costs proportionally to its
duration on its own; a ten-minute recording that happens to say a
hard-to-transcribe name forty times can cost more than a two-hour recording
that says easy names twice. `MAX_ADJUDICATED_CANDIDATES` (1,000) is a
deliberate ceiling on this, and it is stated as a **bill** bound, not a
**quality** one: past a thousand candidates the target list is almost
certainly too generic ("Al", "Mo") for a phonetic match to mean much, and the
right fix is narrowing the term list, not twenty-five more requests
adjudicating noise.

### 5.2 Measured: candidate retrieval on a 30,000-word transcript

Stage 1 retrieval (tokenize, window, gate, score, greedy-select) measured at
approximately **250ms** for a ~30,000-word transcript (roughly a two-hour
recording) in the test environment — the pure, synchronous pass that runs
before any model is ever called. `phonetic.ts`'s hot-path functions
(`jaroWinkler`, `levenshtein`) deliberately avoid `Math.*` calls and reuse
scratch buffers across calls specifically because they measured roughly
100x slower under Jest's `vm` sandbox than native — see the inline comments
in `phonetic.ts` for the measurement that drove it.

### 5.3 Thorough mode: a *lower bound*, and it says so

Thorough mode reads the transcript in ~6,000-token chunks through the model
for discovery, on top of adjudicating every phonetic candidate — several
times the tokens of standard mode, and `estimate.ts`'s own header is
explicit about the honest limit here: **the estimate is a lower bound**.
Discovery's own findings are themselves adjudicated, and how many there will
be is exactly what discovery exists to find out; the estimate counts the
discovery pass plus adjudicating the phonetic candidates, and it counts
**input tokens only** — output tokens are not counted at all. A user sees a
number before clicking "Check names," and that number is guaranteed to
under-state a thorough run's true cost, never over-state it.

### 5.4 Every model request is billed to the user's own account

Both modes run entirely on **the requesting user's own AI provider key**
(`user_ai_credentials`, never a deployment-wide credential — `docs/specs/
notes.md` §9's bring-your-own-key posture, reused verbatim). `assertWithinBudget`
/ `computeTokenBudget` (`apps/notes/generation/token-budget.ts`, shared with
note generation) refuse a request that would not fit the resolved model's
context window **before** any call is made — a batch too large to fit is
split in half rather than the whole run being refused, and only a *single*
candidate that still cannot fit fails the run, as a budget error carrying the
actual numbers (`docs/specs/notes.md`'s rule 4: never truncate silently).

## 6. Job-queue rules compliance

`transcript.name_check` (`TranscriptNameCheckHandler`) is a `JobHandler`
under CLAUDE.md's "Every Long-Running Activity Is a Queue Job" rule, enqueued
by `TranscriptNameCheckService.create` and never run inline — a two-hour
transcript's `thorough` run can need dozens of sequential model calls, each
taking seconds, which is squarely the "outlives the HTTP request" case that
rule exists for.

- **`profile: { maxRuntimeMs: 20 * 60_000, maxAttempts: 1 }`** — exactly the
  two numbers CLAUDE.md's rule 4 permits, and **deliberately one attempt**,
  for the identical reason `note.generate` carries `maxAttempts: 1`
  (`docs/specs/notes.md` rule 2): every request here is billed to the
  requesting user's *own* key, so an automatic retry would silently re-run
  discovery and adjudication from the top and charge them twice for one
  click — and because completions are non-deterministic, a retry could
  propose a *different* set of corrections than the run they may already be
  half-reviewing. The retry path is the person pressing "Check names"
  again, which queues a brand-new run with its own fresh one-attempt budget
  — the same relationship `POST /api/notes/{id}/regenerate` has with
  `note.generate`. Twenty minutes, not `note.generate`'s ten, because a
  thorough check of a two-hour recording is roughly 7 discovery chunks plus
  up to 25 adjudication batches, run sequentially. The lease and its
  renewal interval are *derived* from `maxRuntimeMs`, per rule 4.
- **Server-only, permanently** — neither `nodeResultSchema` nor
  `persistNodeResult` is declared, so `JobHandlerRegistry.serverOnlyTypes()`
  reports this type and no worker node can ever claim it, per rule 2. The
  credential in play is the user's own long-lived vendor API key; unlike
  `db.backup.run`'s PostgreSQL role, no AI vendor here offers a
  job-scoped, short-lived sub-key a `nodeSecretBroker` could mint and hand
  to a remote machine, and shipping a personal API key to hardware this
  deployment does not own is not a fallback anyone should want — the same
  argument `note.generate` makes for itself.
- **Per-user provider throttle key** — `aiProviderThrottleKey(userId)`
  (shared with `note.generate`, `docs/specs/notes.md` rule 3), registered
  immediately before each provider call so a 429 defers *this* user's own
  work and nobody else's. A shared, deployment-wide throttle key would be
  wrong here for the same reason it would be wrong for note generation:
  every user brings their own vendor account with their own independent
  rate limit, so a 429 against one user's key is evidence about that user
  only.
- **Failure classes, mirroring `note.generate`'s taxonomy exactly**:
  `RateLimitError` is rethrown so the queue defers the job against the
  user's bucket with the attempt uncharged and the run left `running` — the
  next claim restarts the run from the top with nothing persisted yet, so
  no partial state is left behind to disagree with a fresh start.
  `AiAuthError`/`AiBudgetError`/`AiRefusedError`/`AiInputError` mark the run
  `failed` with an `errorClass` and a user-facing message, and the job
  **returns normally** — it determined a permanent outcome, and rethrowing
  would spend the run's one attempt on nothing. Anything else marks the run
  `failed` **and** rethrows, so `Job.lastError` records what actually
  happened. A malformed answer for *one batch* is explicitly not a run
  failure (§3.3): only when every request in the run failed to produce a
  usable answer does the run fail, with class `refusal` — otherwise "zero
  suggestions" would misreport a partial success as nothing happening.

## 7. Apply semantics: an ordinary correction, never a second write path

`TranscriptNameCheckService.apply` does not, and structurally cannot, write
`transcript_segments.text` directly. Accepting suggestions turns them into
`segment.update_text` operations — **one per affected segment**, carrying
that segment's *current* `rev` — and sends them through the exact same
`TranscriptEditingService.applyOperations` path every other correction in
this application uses: the same transaction, the same version history, the
same 409-on-stale-rev handling, the same idempotency-key mechanics
(`docs/specs/transcription.md` §4). A suggestion table that could edit text
on its own would be a second write path the version log does not know about,
and `materialize()` — which replays the version log through the *same*
reducer functions the live edit path calls (`docs/specs/transcription.md`
§4.4) — could no longer be guaranteed to rebuild what the user actually sees.
This is exactly the shape rule 1 in CLAUDE.md's transcript-correction section
protects: nothing outside `apps/api/src/transcripts/editing/` may write a
segment's text.

**Deterministic chunking and `clientBatchId`.** An apply call is chunked at
`MAX_OPS_PER_BATCH` (200) segments per `applyOperations` call, and each
chunk's `clientBatchId` (`namecheck:<checkId>:<sha256 of the chunk's sorted
suggestion ids>`) is computed from the **suggestion ids alone** — fixed
*before* any span is resolved against current text. This has to be true for
the idempotency key to survive a crash mid-apply: by the time a retry
recomputes the same chunk, the segment text already carries the earlier
chunk's replacements, so resolving spans again could call suggestions
"stale" that were already applied. Because the key never depends on span
resolution, a retried apply after a crash is recognised by
`TranscriptEditingService`'s own idempotency check (looking up the recorded
version by `(transcriptId, clientBatchId)`) before any span is touched a
second time, and the suggestions the recorded version actually edited are
marked `accepted` from its own `ops`, never re-derived.

**Stale/relocation** (`name-check/spans.ts`, pure). A stored suggestion's
`start`/`end` were computed against `TranscriptSegment.text` at the
suggestion's own `segmentRev`. By the time it is reviewed, an unrelated edit
earlier in the same line may have shifted every later offset. `resolveSpan`
takes the narrowest correct path:

1. If the stored offsets still read `original` in the current text, use them
   unchanged.
2. Otherwise, if `original` occurs **exactly once** in the current text as a
   whole word (case-sensitive, Unicode-aware boundaries — the identical
   matcher find & replace uses, `docs/specs/transcription.md` §4.3), use that
   occurrence.
3. Otherwise, the suggestion is **stale**. Two occurrences are ambiguous and
   zero means the text the suggestion described no longer exists; guessing
   either way would be a silent wrong edit, so neither is attempted.

`GET /:id/name-checks/latest` reports each pending suggestion's `stale` flag
computed the same way, so a review UI can show it before a user tries to
accept it; `POST /:id/name-checks/:checkId/apply` marks it `status: stale`
(not `rejected`) and skips it rather than failing the whole batch, exactly
as `applySplices` (§7's `spans.ts`) skips — never merges — a splice
overlapping one already applied within the same call: two suggestions
claiming the same characters cannot both be right, and picking one silently
would be exactly the kind of guess step 3 above refuses to make.

**409 conflicts propagate unchanged.** A concurrent edit that invalidates a
chunk's `baseVersion` produces the identical 409 shape `POST
/:id/operations` returns (`details` naming every conflicting entity, per
`docs/specs/transcription.md` §5); earlier chunks already committed in this
apply call stay committed, and the chunk that hit the conflict — along with
every chunk after it — stays `pending` for the user to re-review, rather
than the whole apply call being unwound.

## 8. Data model

Two tables (full column-level reasoning is in the block comment above
`TranscriptNameCheck` in `apps/api/prisma/schema.prisma` — this is the
summary):

- **`transcript_name_checks`** — one row per **run**: `mode`
  (`standard`/`thorough`), `status` (`pending`/`running`/`ready`/`failed`),
  `basedOnVersion` (the `Transcript.currentVersion` this run read, matching
  `TranscriptExport.version`'s reasoning — a run started against one version
  must never be silently reinterpreted against a later one once edits land
  mid-run), `terms` (opaque JSONB — the resolved name/term list this run
  checked for), `providerId`/`model`, denormalized `candidateCount`/
  `suggestionCount` (matching `Transcript.speakerCount`'s "cheap to read
  often, recomputed by the one write path that changes the true count"
  shape), `inputTokens`/`outputTokens` cost accounting (the same pair
  `NoteGeneration` tracks), `errorClass`/`error`, and `jobId`
  (`@unique`/nullable/`SetNull`, mirroring `TranscriptExport.jobId` — a
  run's own lifetime, read by the review UI long after job history is
  purged, is independent of `job.history.purge`'s schedule).
  `requestedById` is `SetNull` on user deletion, not `Cascade` — unlike
  `TranscriptExport.requestedById`'s disposable artifact, a name-check run
  and the suggestions it produced are worth keeping as transcript history
  even after the requesting account is gone, the same posture
  `TranscriptVersion.authorId` already takes.
- **`transcript_name_suggestions`** — one row per **proposed edit**:
  `segmentId`/`segmentRev` (the segment and the `TranscriptSegment.rev`
  the offsets below were computed against — the same optimistic-concurrency
  shape `TranscriptVersion`'s `rev` split uses elsewhere in this schema),
  `start`/`end` (UTF-16 offsets into that segment's text at that rev),
  `original`/`replacement`, `confidence`/`reason`, `source`
  (`'phonetic'`/`'discovery'`, a plain string rather than an enum — which
  detection strategies exist is code, not schema, matching
  `Transcript.provider`'s open-registry reasoning), and `status`
  (`pending`/`accepted`/`rejected`/`stale`). `segmentId` is `Cascade`: a
  suggestion against a segment a later `segment.split`/`segment.join`/delete
  removed has nothing left to apply to.

## 9. Endpoints

Five routes on `TranscriptNameChecksController`, sharing `TranscriptsController`'s
prefix, permission pair and access posture exactly: `transcripts:read` + view
access for reads, `transcripts:write` + edit access for writes, and **no
access is a 404, never a 403** (`docs/specs/transcription.md` §6.1's
reasoning applies unchanged — a name-check run belongs to somebody's private
transcript). See `docs/API.md`'s `### Transcripts` group for full
request/response shapes.

| Route | What |
|---|---|
| `POST /api/transcripts/{id}/name-checks` | Queue a run. `mode` (`standard`/`thorough`, default `standard`), optional `terms`, optional `speakerIds` (default: every speaker). Names checked: selected speakers' display names (generic labels like "Speaker A" skipped) + `terms` + upload keyterms. **202**, body carries the queued run and its `estimate`. **400** when nothing to check; **409** `ai_not_configured` / `ai_key_missing` / `name_check_running` / `transcript_not_ready` |
| `GET /api/transcripts/{id}/name-checks/estimate` | What a run of the given `mode` would cost — input tokens, requests, candidate count — without creating anything. Needs no API key (counting is free); still 409 `ai_not_configured` |
| `GET /api/transcripts/{id}/name-checks/latest` | The most recent run (or `run: null`), its **pending** suggestions in reading order with relocated `start`/`end`/`preview`/`stale`, and counts by status. Poll while `run.status` is `pending`/`running` |
| `POST /api/transcripts/{id}/name-checks/{checkId}/apply` | Accept named suggestions — writes them as ordinary corrections (§7). Body carries the new segments/speakers state so a client can adopt it without a second fetch |
| `POST /api/transcripts/{id}/name-checks/{checkId}/reject` | Mark named pending suggestions `rejected`. Never touches the transcript |

`assertNoActiveRun` treats a `pending`/`running` run whose job is gone or
already settled — an administrator deleted it, or the process died between
the job settling and the run being marked — as **not** active, failing it on
the spot rather than letting a lost job block the "Check names" button
forever.

## 10. Privacy

- **Keyterms** (§2) go to the **transcription provider** as part of the
  submission request, exactly like every other piece of submission metadata
  (`speakersExpected`, the language hint) — no new data-sharing surface, the
  same vendor the audio itself already goes to.
- **Standard-mode name checks** send only the **candidate windows**: each
  adjudication request's payload is the marked span plus ±1 segment of
  surrounding context (§3.3), never the whole transcript. A two-hour
  recording with three candidate names sends three small windows to the
  model, not two hours of conversation.
- **Thorough-mode name checks** send the **whole transcript text**, in
  chunks, to the discovery model (§3.2) — on **the requesting user's own AI
  vendor account**, the identical privacy posture note generation already
  has for the source material it summarises (`docs/specs/notes.md`'s privacy
  statement): the vendor sees the content because the user's own key is
  paying for and authorising that vendor to see it, not because this
  deployment holds or forwards a copy anywhere else. Choosing `thorough`
  mode is an explicit, per-run decision, never a default.
- **Every request in both modes runs on the user's own credential**
  (§6) — this deployment never proxies or holds a shared key for this
  feature, mirroring `docs/specs/notes.md`'s strict bring-your-own-key
  stance end to end.

## 11. Known limitations

- **A rate-limit deferral restarts the whole run from the top.** Because
  `maxAttempts: 1` means there is exactly one job attempt, and a
  `RateLimitError` leaves the run `running` with nothing persisted (§6), a
  429 encountered deep into a long `thorough` run's adjudication phase costs
  every discovery and adjudication call already made — there is no
  resumption from where it left off. This is the direct cost of the
  single-attempt policy §6 argues for on billing-safety grounds; it was
  accepted as the smaller problem, not treated as a non-issue.
- **A replayed chunk's suggestions are marked from the recorded ops, not
  re-diffed against the intent.** When an apply retry recognises an already-
  committed chunk (§7), it marks the suggestions on any segment that
  version's `ops` touched as `accepted`en masse — it cannot distinguish "this
  segment's suggestion was applied" from "this segment happened to be
  touched by a batch that also applied a different suggestion on it," because
  a segment carries at most one `segment.update_text` op per chunk by
  construction (`applySplices` folds every splice for a segment into one
  op). In the ordinary case these coincide exactly; the imprecision is a
  documented consequence of keeping the idempotency key suggestion-id-only
  (§7), not a bug being tracked.
- **Double Metaphone is English-centric.** Philips' algorithm encodes
  English (and, by extension, the European-language sounds it was designed
  to also catch) phonotactics; a name from a language with sound patterns
  the algorithm has no rule for will get a plausible but not necessarily
  meaningful key. This is compensated, not eliminated, by requiring
  Jaro-Winkler letter agreement alongside every phonetic path (§3.1) — a
  window with no real letter resemblance cannot pass on a phonetic key
  alone — and by thorough mode's discovery pass, which reads meaning and
  context rather than spelling at all. A small number of rule-based
  respellings (`spellingsOf` in `candidates.ts`) extend coverage for a few
  known cross-language patterns (Spanish/Vietnamese `gu` before a vowel as
  `/w/` — "Nguyen" → "Nwyen," "Guadalupe" → "Wadalupe") without attempting a
  general solution.

## 12. Rejected alternatives

- **Have the LLM rewrite the whole transcript.** Rejected on cost (tens of
  thousands of input tokens for a two-hour recording, on every run, for
  every user, with no retrieval step to bound it), on over-correction risk
  (arXiv 2506.10779's central finding — see §4 — is specifically that
  full-document context measurably increases hallucinated changes to text
  that was already correct), and on output-token limits (rewriting an entire
  transcript's worth of text back out is exactly the kind of large,
  unbounded generation `docs/specs/notes.md` rule 4 refuses rather than
  risks truncating silently). The adopted design's LLM calls are all small,
  bounded, and verification-shaped — "is this span this name, yes or no" —
  never generation-shaped.
- **A literal `transcript.find_replace` op** (`docs/specs/transcription.md`
  §4.2–4.3) for every correction. Rejected because find & replace needs a
  known misspelling typed by a human and a choice of *which* occurrences to
  touch; a name check does not know the misspelling in advance (that is what
  Stage 1/1b discover) and needs per-occurrence targeting driven by model
  verification, not a single find/replace pattern applied uniformly across
  the transcript. The correction still lands as `segment.update_text` ops
  (§7) — the same concrete op family `find_replace` itself expands into
  before being recorded — just built directly from the pipeline's own
  resolved spans instead of from a pattern.
- **Apply suggestions client-side.** Rejected for the same reason every
  other bulk transcript mutation in this application goes through the
  server: `MAX_OPS_PER_BATCH` (200) chunking, the `rev`-based conflict
  detection, and the idempotency-key crash-recovery path (§7) all have to be
  correct against a version log the client does not own and cannot safely
  replay locally, and a client racing its own apply against another editor's
  concurrent change is exactly the class of bug `TranscriptEditingService`'s
  server-side transaction exists to make impossible.
- **AssemblyAI's `word_boost`/`boost_param`.** Rejected outright for feed-
  forward keyterms (§2) because it is deprecated in favour of
  `keyterms_prompt`, which this deployment uses exclusively — see the inline
  comment at the `keyterms_prompt` call site in `assemblyai.provider.ts` for
  the explicit "never the deprecated pair" note.

## 13. Verification

- `apps/api/src/transcripts/name-check/phonetic.spec.ts` — Double Metaphone
  vectors checked against PostgreSQL's `dmetaphone()`/`dmetaphone_alt()`,
  plus Jaro-Winkler and Levenshtein unit coverage.
- `apps/api/src/transcripts/name-check/candidates.spec.ts` — retrieval gating,
  scoring, stopword handling, greedy non-overlap selection, memoisation.
- `apps/api/src/transcription/providers/assemblyai.provider.spec.ts` —
  `keyterms_prompt` sent when terms exist, omitted entirely when they do not.
- `apps/api/src/transcription/transcription-config.service.spec.ts` —
  `keytermsSupported`/`maxKeyterms` for a keyterm-capable provider, a
  provider with none, and no provider chosen at all.
