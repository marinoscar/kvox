# Audio → Trusted Transcript

> Epic #19 (issues #20–#32): upload, diarized transcription, corrections,
> versions, sharing, export, and the redesigned signed-in home page. This
> document **is** issue #20 — the architecture spec the epic requires before
> any of the issues it blocks (#21, #23, #24) starts, per CLAUDE.md's
> Issue-Driven Development rule and the settings/job-queue precedent of
> writing the *why* down before the code. Nothing described below is merged
> yet. Every file path named in this document is where the implementing issue
> commits to putting the code, not a file that exists today; treat a path
> reference the way `job-queue.md`'s header treats "on what is merged today",
> inverted — this is "on what is committed to being built, and where".
>
> Planned locations: `apps/api/src/transcription/` (#23 — the provider
> framework, AssemblyAI, admin settings), `apps/api/src/transcripts/` (#24–#29
> — data model, pipeline, corrections, export, sharing), the `media.audio
> .transcode` handler under `apps/api/src/transcripts/handlers/` (#26, built),
> `apps/web/src/pages/Transcripts/` and `apps/web/src/pages/Admin
> /TranscriptionSettingsPage.tsx` (#23, #30–#32), and this document's own
> schema companion, `docs/specs/transcript-export.v1.schema.json`.
>
> **Suggested build order** (from the epic): #20 (this document) →
> (#21 storage hardening, #23 provider framework, #24 data model, all three
> depending only on this document) → (#22 web upload client, #25 pipeline) →
> (#26 transcode, #27 corrections) → (#28 export, #29 sharing, #30 web
> viewer) → (#31 correction UI, #32 home page).
>
> **Before this epic is declared final**, AssemblyAI's parameter names, the
> speech model identifiers and the two capability numbers quoted in §2.7 MUST
> be re-checked against AssemblyAI's current documentation. This document
> states them as the *implementation target*, not as something verified
> against a live account — see §2.7's own note.

## Why this shape, and not the obvious one

KVox's own thesis, from `VISION.md`, is *"AI proposes. The user controls the
truth."* A transcription feature that only ever showed the AI's first answer
would violate that on day one, and the whole of §4 and §5 below — the version
log, the per-entity `rev`, the fact that `materialize(v1)` is permanently
reachable — exists because "the user controls the truth" has to survive a
found-and-fixed misheard name, a merged speaker, and two editors correcting
the same recording at once.

Four decisions shape everything that follows, and each is a direct
application of a rule this repository already has rather than a new one
invented for this epic:

1. **The pipeline is queue jobs, not a detached promise, not webhooks.**
   CLAUDE.md's "Every Long-Running Activity Is a Queue Job" rule 1 was written
   for exactly this shape of problem — work that outlives the request that
   started it — and a provider transcription of a multi-hour recording can
   take minutes to hours. §1 is that rule applied end to end: upload → submit
   → poll → ingest is four job types and zero held worker slots, because a
   worker slot held for hours to babysit a provider is the queue's own
   `stuckThresholdMinutes` problem that `docs/specs/database-backup.md`
   already had to solve once (§1.6 and this document's own §11 explain why the
   backup's fix — a lease derived from a declared runtime ceiling — is reused
   here rather than re-invented).
2. **Node eligibility is the default, and every exception is named against a
   CLAUDE.md rule 2 exemption, not asserted.** `media.audio.transcode` is
   CPU-bound and secret-free, which is precisely what rule 2 means by
   "node-eligible by default" — so it carries `nodeResultSchema` and
   `persistNodeResult` from day one, following the `example.checksum`
   "one write, two paths" shape (`docs/specs/worker-nodes.md` §21). Every
   other job type in §1.5's table is server-only, and each row says which of
   rule 2's genuine exceptions applies to it — never "server-only because that
   was simpler."
3. **A provider never gets a database, and the database never gets a
   provider's format.** `TranscriptionProviderRegistry` (§2) is the same shape
   as the email module's SES/SMTP registry and the storage module's provider
   interface: one small contract, one `NormalizedTranscript` on the way in,
   and a provider-neutral `ExportDocument` (§8) on the way out. Nothing in
   `apps/api/src/transcripts/` imports an AssemblyAI type, and nothing in
   `apps/api/src/transcription/providers/assemblyai.provider.ts` imports a
   Prisma model.
4. **Versioning is a normalized current state plus an operation log, not a
   JSONB snapshot per save.** A 10-hour recording is roughly 90,000 words;
   issue #24's own arithmetic (about 7 MB per full snapshot) is why §3 and §4
   store *ops*, not documents, and rebuild history by replaying them through
   the same pure reducers the live edit path uses — the identical argument
   `job-stats-rollup` makes for surviving history purges without a second
   source of truth (`docs/specs/job-queue.md` §7.6), applied to correction
   history instead of throughput history.

Two further postures run through every section below and are worth stating
once, up front, rather than repeating at every point they bind:

- **Privacy is the default, not a setting.** There is no `transcripts:read_any`
  permission (§6), no-access is a 404 rather than a 403 (§6), and the
  provider's copy of the audio is deleted after ingest by default (§10). This
  is a stronger posture than this repository's own storage objects (which do
  have `storage:read_any` for admins) and a deliberate one: a transcript is a
  private conversation, not a managed asset.
- **Nothing here is a new mechanism.** The provider registry copies the email
  module's pattern; the job types copy the housekeeping-cron-to-job shape from
  `docs/specs/job-queue.md` §7.10; the admin settings card reuses
  `system_settings:*` following the SMTP-password precedent (§6.4); the
  storage hardening in §9 extends `ObjectsService` rather than building a
  second upload path. An epic this large earns no license to invent a fifth
  way to register something when this repository already has four.

## 1. Pipeline and state machines

### 1.1 `transcripts.status` — the top-level lifecycle

```
uploading → processing → ready
                 ↘          ↘
                  failed   deleting
```

| Status | Meaning | Set by |
|---|---|---|
| `uploading` | The transcript row exists; the audio is not fully received yet | `POST /api/transcripts` |
| `processing` | The audio arrived; transcode and/or transcription are in flight | The upload-complete listener (§1.5) |
| `ready` | `transcript_versions` has a v1 row; the transcript can be read, played and edited | `transcription.ingest`, at the end of its one write transaction |
| `failed` | Something in the pipeline gave up permanently | Any stage that hits a domain failure or the poll deadline (§1.7) |
| `deleting` | The owner asked to delete it; `transcript.purge` is removing its storage and rows | `DELETE /api/transcripts/:id` |

`deleting` is a real, visible status rather than an immediate row delete for
the same reason `database_backup_runs` records a `stale` status instead of
silently vanishing: a delete that purges multi-gigabyte objects and calls a
provider's own delete endpoint is itself long-running work (rule 1 again),
so the row has to exist long enough to say "this is going away" while
`transcript.purge` runs. There is no path back from `deleting` — a
transcript the owner asked to delete does not get a `PATCH` that changes its
mind, matching `DELETE /api/admin/db-backup/runs/:id`'s own posture of "this
is a request to remove, not a soft state a later request reverses."

`failed` is reachable from `processing` only. There is no `failed` from
`uploading`: an upload that never completes is not the transcript's failure
to record. It is either the user cancelling — `ObjectsService.abortUpload`
marks the (managed) source object `failed` and emits
`storage.object.upload_aborted`, which `TranscriptsUploadAbortedListener`
turns into an immediate `transcript.purge` (§9.3, §9.4) — or the upload
simply going quiet, which `transcripts.housekeeping` (§1.5.8) notices by the
source object's own `updated_at` and reconciles the same way, on
`transcription.abandonedUploadHours`' clock (issue #322). Either path
**purges** the transcript rather than failing it: there is no audio to retry
with, so a `failed` card here would be permanent and un-retryable.

### 1.2 `transcription_status` — the provider round trip

```
waiting_input → queued → submitting → submitted → processing → completed
                                                              ↘
                                                               failed
                                                               cancelled
```

| Status | Meaning |
|---|---|
| `waiting_input` | Transcription cannot start yet: the provider does not accept the original file and `media.audio.transcode`'s rendition has not finished (§2.4) |
| `queued` | Waiting for a `transcription.submit` job to run |
| `submitting` | `transcription.submit` is executing right now |
| `submitted` | The provider has accepted the job and returned a `remoteId`; `transcription.poll` owns it from here |
| `processing` | The provider itself reports it is transcribing (distinct from `submitted`, which only means "accepted") |
| `completed` | The provider reports `completed`; `transcription.ingest` has not necessarily run yet — this is the provider's word, not this application's |
| `failed` | A domain failure (§1.8) or the poll deadline (§1.7) |
| `cancelled` | `POST /api/transcripts/:id/cancel` was called while transcription was in flight |

This is a **separate** state machine from `transcripts.status`, not a finer
view of the same one, because the two answer different questions at
different times. A transcript is `processing` (top-level) for the entire
span from upload-complete to `ready`, which covers both the transcode and
the transcription round trip running concurrently; `transcription_status`
exists so the pipeline stepper the web app shows (issue #30's "Uploaded →
Preparing audio → Transcribing → Ready") can distinguish "waiting on ffmpeg"
from "waiting on AssemblyAI" without inventing a combinatorial top-level
enum for every interleaving of two independent sub-pipelines.

### 1.3 `playback_status` — the transcode sub-pipeline

| Status | Meaning |
|---|---|
| `pending` | No rendition needed yet, or not started |
| `processing` | `media.audio.transcode` is running |
| `ready` | The rendition exists and `playback_object_id` is set |
| `failed` | Transcode failed; playback falls back to the original when the browser's `canPlayType` allows it (issue #30) |
| `not_needed` | The original file is already directly playable and streamable (rare — most phone-recorded and provider-native formats still get a rendition for size and seekability, §7.1), so no transcode job runs at all |

### 1.4 Why three status fields, not one

**Rejected: a single top-level status with more values** (`transcoding`,
`transcribing`, `transcoding_and_transcribing`, …). The two sub-pipelines run
**concurrently** — the transcode and the transcription submit can both be in
flight at once, racing each other, and issue #26's `selectTranscriptionInput`
even depends on that concurrency (transcription can start immediately on the
original while a rendition is still being produced, when the provider
accepts the original directly). A single enum would need one member per
*combination* of the two sub-pipelines' states, growing quadratically every
time either one gains a state, and would still need a second field to say
which failure belongs to which sub-pipeline. Three independent fields is the
same design `worker_nodes` already uses for its own health (`status` for the
operator's stated intent, `lastHeartbeatAt` for computed liveness) — small,
independently updatable pieces of state, not one field pretending to be
several.

**The three fields are asymmetric on purpose.** `transcripts.status` is what
every list view and every permission check reads; `transcription_status` and
`playback_status` are detail fields on `GET /api/transcripts/:id` for the
pipeline stepper. A list endpoint filters on the first only — filtering
`GET /api/transcripts?status=` by a sub-pipeline status would leak
implementation detail (a caller would have to know that `processing`
top-level can mean either or both sub-pipelines are running) into a surface
meant to answer "is this transcript usable yet."

### 1.5 The job types

Eight job types, all under `apps/api/src/transcripts/` except the provider
calls themselves, which live behind `apps/api/src/transcription/`'s registry
and are called *from* the job handlers rather than duplicated into them.

| Job type | Profile | Node-eligible? | CLAUDE.md rule cited |
|---|---|---|---|
| `media.audio.transcode` | `{ maxRuntimeMs: 3h, maxAttempts: 3 }` | **Yes** | Rule 2 — CPU-bound, secret-free work is node-eligible *by default* |
| `transcription.submit` | `{ maxRuntimeMs: 2h, maxAttempts: 3 }` | No | Rule 3 — needs the provider API key, a long-lived secret no per-job broker can narrow |
| `transcription.poll` | `{ maxRuntimeMs: 2m, maxAttempts: 5 }` | No | Rule 3 — same key, needed again on every poll |
| `transcription.ingest` | `{ maxRuntimeMs: 15m, maxAttempts: 3 }` | No | Rule 2's "reads/writes several tables mid-computation" exemption, *and* rule 3 (calls `deleteRemote`, which also needs the key) |
| `transcript.snapshot` | `{ maxRuntimeMs: 10m, maxAttempts: 3 }` | No | Rule 2's "reads several tables mid-computation" exemption — a `REPEATABLE READ` read of live current-state tables |
| `transcript.export` | `{ maxRuntimeMs: 5m, maxAttempts: 2 }`, priority **−10** (more urgent than the default `0`) | No, **in v1** — see §1.5.6 | Not one of rule 2's three named exemptions; documented as its own case below |
| `transcript.purge` | Deployment default (no profile declared) | No | Rule 3 (calls `deleteRemote`) and rule 2 (deletes rows across several tables as it goes) |
| `transcripts.housekeeping` | Deployment default (no profile declared) | No | Rule 2's "reads/writes several tables mid-computation" exemption |

Every server-only row above is server-only **because a specific rule 2
exemption or rule 3 constraint applies to it**, never because it was
convenient — CLAUDE.md rule 2 states node-eligibility as the default posture
precisely so that a spec cannot wave a type to "server-only" without saying
why, and the table above is that accounting made explicit for all eight
types at once.

#### 1.5.1 `media.audio.transcode`

**Built (#26).** `apps/api/src/transcripts/handlers/media-audio-transcode.handler.ts`
is the handler, `apps/api/src/transcripts/media/` holds the decisions
(`audio-transcode.ts`) and the spawns (`ffmpeg.service.ts`),
`apps/api/src/jobs/contracts/media-audio-transcode.contract.ts` is the node
result contract, and `apps/cli/src/node/executors/media-audio-transcode.ts` is
the node executor. It is written up as the fleet's third node-eligible type in
[`worker-nodes.md` §20.2](worker-nodes.md). Converts whatever format was
uploaded into a small, universally
playable AAC/m4a mono file with the `moov` atom moved to the front
(`+faststart`), so iOS Safari can play it and a phone on cellular data can
seek into a multi-hour recording without downloading it first (§7.1).

Enqueued with `subjectType: 'storage_object'` and `subjectId:
sourceObjectId` — **not** `subjectType: 'transcript'` — specifically so it
reuses `resolveStorageObjectInput` (`docs/specs/worker-nodes.md` §19)
unchanged: the node data plane, the presigned-download resolution and the
`422`-on-missing-input handling all already exist for a storage-object
subject, and inventing a second subject shape here would mean either
teaching that resolver a transcript-specific branch or writing a second
resolver that could drift from the first. `payload: { transcriptId }` carries
the one piece of context the handler needs that the subject id does not: which
transcript's `playback_object_id`, `duration_ms` and `playback_status` to
update once the rendition exists.

It is the **second** real-world node-eligible job type in this repository,
after `db.backup.run`, and the **first that needs a native binary
dependency** (`ffmpeg`, which bundles `ffprobe`) shipped in both the API
image and the CLI/node image — `example.checksum`
(`docs/specs/worker-nodes.md` §21) deliberately avoided exactly this
("REJECTED: anything domain-specific — … `ffmpeg` …") because a *template's*
worked example must not force a dependency a fork will delete on day one.
`media.audio.transcode` is real product code, so it pays that cost
deliberately: `apps/api/Dockerfile` and `apps/cli/Dockerfile` both gain an
`ffmpeg` install step (following the existing `postgresql17-client`
precedent for a base-stage system dependency), and `apps/cli/src/node
/capabilities.ts` gains `ffmpeg`/`ffprobe` in `PROBED_BINARIES` so a node
missing them self-reports as ineligible for this type rather than claiming a
job it cannot run.

**One write, two paths**, following `example.checksum`'s shape exactly
(`docs/specs/worker-nodes.md` §21): the server path (`ffprobe` the presigned
URL, remux or re-encode, `StorageProvider.upload` the result) and the node
path (the CLI executor doing the same ffprobe/ffmpeg steps, then PUTting to
the signed upload URL) both funnel into one private `recordRendition()` that
creates the managed `StorageObject`, sets `playback_object_id`/`duration_ms`
/`playback_status: ready`, enforces the provider's `maxDurationMs`, and
enqueues `transcription.submit` if transcription was `waiting_input` for this
exact rendition. Neither path may recompute or "fix up" what the other
produced — `persistNodeResult` does a read-back confirmation that the object
exists, never a second ffprobe.

`deriveOutputKey(job)` returns
`transcripts/<transcriptId>/renditions/<jobId>.m4a` rather than the data
plane's default `node-outputs/<jobId>/<uuid>` — the rendition is a durable,
externally-referenced artifact (`transcripts.playback_object_id` points at
it, and `transcript.purge` must be able to enumerate every object under a
transcript's prefix without a lookup table), exactly the shape
`docs/specs/worker-nodes.md` §17.1 describes as `deriveOutputKey`'s intended
use, and idempotent per job because it is derived purely from `jobId` and
`transcriptId`, both already fixed on the row.

`nodeOffloadEnabled()` reads `transcription.transcodeNodeOffloadEnabled`
(default **true** — unlike the database backup's node-offload setting, which
defaults **false** because a `pg_dump` needs a brokered database credential
and epic #345 shipped that broker disabled by default; transcoding needs no
credential at all, so there is no comparable trust boundary to default shut).

**The target bitrate travels on the job**, in `payload.bitrateKbps`, beside
`transcriptId`. A worker node reads no system settings — it has no database —
so `transcription.playback.bitrateKbps` has to be told to it or a
node-executed transcode silently falls back to the shipped default and two
executors produce different files for one job. `TranscriptPipelineService
.enqueueTranscode` reads the setting once at enqueue time; the handler prefers
the payload's number over the live setting for the same reason, so the server
path and the node path cannot disagree. A job enqueued by a build older than
#26 carries no such field and falls back to reading the setting.

**Two things about the encode are easy to get wrong and are worth stating
here.** First, the output is a **temp file, never a pipe**, on both paths:
`+faststart` rewrites the MP4 header *after* the stream ends and therefore
needs a seekable destination, and on a socket ffmpeg warns and silently
produces a `moov`-last file that uploads perfectly and cannot be scrubbed —
the exact defect the flag exists to prevent, invisible to every check either
side performs. `media-audio-transcode.ffmpeg.spec.ts` runs a real ffmpeg and
reads the produced bytes precisely because no assertion about the *arguments*
can see this. Second, **a permanently failed transcode writes
`playback_status: failed`** on its last attempt rather than leaving
`processing`, because `transcription.submit` reads exactly that column to
decide whether a rendition is still coming (§2.4's `renditionExpected`); a
column left at `processing` forever leaves every transcript whose original
the provider cannot accept sitting in `waiting_input` with no error anywhere.

**The duration ceiling is enforced here as well as in `transcription.submit`,
and neither check subsumes the other.** This is the first moment the duration
is known — nothing measured it before the probe — so it is the first moment
the ceiling *can* be applied, and it is applied before the provider has been
asked to do anything, which is when refusing is still free. The submit
handler's own check covers the transcripts that never needed a rendition at
all. Failing on duration fails the **transcript**, never the rendition: the
audio is still worth playing back.

#### 1.5.2–1.5.4 `transcription.submit`, `.poll`, `.ingest`

All three are **server-only for the same reason**: `TranscriptionProvider
.submit`/`getStatus`/`fetchResult`/`deleteRemote` all authenticate with the
provider's API key, which `CredentialsService` stores encrypted at
`(purpose: 'transcription', name: <providerId>)` and which is a **long-lived,
account-level** secret — unlike `db.backup.run`'s PostgreSQL role, AssemblyAI
has no API for minting a job-scoped, auto-expiring sub-key, so there is
nothing rule 3's `nodeSecretBroker` mechanism could broker even if a node
plane broker existed for it. A node holding this key would hold the same
account-wide access the API server has, indefinitely, on a machine this
deployment may not fully control — exactly what rule 3 exists to prevent.

**`transcription.submit`** is idempotent by re-reading `provider_job_id`: if
it is already set (a retry after the write committed but the job then died,
or a stale re-enqueue), the handler skips straight to enqueueing
`transcription.poll` rather than calling `submit` a second time and creating
two remote jobs for one transcript. The presigned GET for the input (§2.5)
is generated **when the job runs**, not when it is enqueued — a job can sit
`pending` for a while behind other work, and a URL signed at enqueue time
could be stale or unnecessarily long-lived by the time `submit` actually
calls the provider. `provider_job_id` is saved to the row **immediately**
after the provider accepts the submission, before the job returns — so even
if the process is killed between the provider's 200 and this job's own
terminal write, the retry's idempotency check finds it.

**`transcription.poll`** is the one job type in this document that
re-enqueues itself, and everything about it follows from that:

- **The backoff schedule.** First check after
  `clamp(durationMs × 0.05, 30s, 5m)` — proportional to the recording's own
  length, because a 90-second voice memo and a 6-hour meeting do not finish
  transcribing on the same timescale, and a fixed 30-second poll on a 6-hour
  job would burn hundreds of wasted polls before anything is likely to have
  changed. Each subsequent check multiplies the previous delay by 1.5, capped
  at 5 minutes — the same equal-jitter-style shape `docs/specs/job-queue.md`
  §5.5 uses for its own retry backoff, adapted here to "poll a status
  endpoint" rather than "retry a failed attempt."
- **The hard deadline.** `submittedAt + max(6h, 3 × durationMs)`. Below the
  deadline, "still processing" is normal; past it, the provider has either
  lost the job or is taking pathologically long, and continuing to poll
  forever would leave a transcript silently `processing` with nothing telling
  the user it will never finish. Past the deadline the poll marks the
  transcript `failed` with a reason naming the timeout, which the owner can
  retry from (§1.8).
- **`skipDedup: true` is not an optimisation on the re-enqueue — it is
  required for correctness.** The active-dedup index (`docs/specs/job-queue.md`
  §4.1) is keyed on `(type, subject)` and its predicate is `status IN
  ('pending', 'running')`. The *currently executing* `transcription.poll` job
  — the one whose `process()` is calling `enqueue()` right now, to schedule
  its **own next check** — is itself a `running` row matching that exact
  key. Enqueueing the next check without `skipDedup: true` would collide with
  that active row, and per `docs/specs/job-queue.md` §4.1 the caller cannot
  tell a dedup collision from a fresh insert: `enqueue()` would silently
  return the row that is *already running right now*, with its
  `scheduledFor` **unchanged** — the newly computed backoff delay would be
  discarded, the current job would finish normally moments later with
  nothing left scheduled to check on it again, and the transcript would be
  stuck in `submitted` forever with no error anywhere. `skipDedup: true`
  leaves `dedup_key` `NULL`, and `docs/specs/job-queue.md` §4.2 already
  establishes that a `NULL` key never collides with anything — the new row is
  inserted unconditionally, exactly as intended.
- **Not one job holding a slot in a loop.** §11 covers this as a rejected
  alternative in detail; the summary is that a single long-lived polling job
  holds a worker slot for the recording's entire transcription time and
  fights the lease/timeout machinery the moment it runs longer than
  `maxRuntimeMs`, while a **chain** of short, cheap `transcription.poll` runs
  holds a slot for milliseconds at a time and is trivially observable as a
  sequence of rows in the admin job list.

**`transcription.ingest`** is idempotent by checking whether version 1
already exists (the same pattern `submit` uses for `provider_job_id`).
`fetchResult` returns the raw provider JSON and the `NormalizedTranscript`
(§2.2); the raw JSON is gzipped and stored as a managed object purely for
**provenance** — if a normalization bug is found later, the original
provider response is still there to re-derive from, without calling the
provider (and paying) a second time. Inside **one transaction** it writes
`transcript_speakers`, `transcript_segments`, the `transcript_versions` v1
row (`kind: ai_original`, `author_id: null` — see §4.5 on why `null` means
"the AI"), and flips `transcripts.status` to `ready`; only after that
transaction commits does it enqueue `transcript.snapshot` (a policy read, see
§4.3 — v1 always snapshots) and, if `transcription.deleteRemoteAfterIngest`
is on (default **true**), call `provider.deleteRemote` and record
`remote_deleted_at` (§10).

**Domain failures do not spend a job attempt on any of the three.** A
`ProviderAuthError`, a `ProviderInputError`, or the provider itself reporting
its own terminal `error` status all set `transcripts.status: failed` and
`failure_reason`, and the **job returns normally** — it did its job
correctly by recognising the failure and recording it; retrying it would
re-ask a provider the exact same malformed question and get the exact same
answer. This is the identical shape `docs/specs/database-backup.md`'s guided
outcomes use for a `CREATEROLE` probe that fails for an ordinary,
non-retryable reason: a **200 with `outcome: guided`** rather than a 4xx.
Here it is a job that **succeeds** at determining failure, rather than a job
that **fails** at determining anything.

A `429` from the provider throws `RateLimitError` from any of the three, and
all three register the **same** throttle key,
`ProviderThrottleService.registerProviderKey(type, 'transcription-provider')`
— one shared cooldown across submit, poll and ingest, because all three
share one AssemblyAI account and its one rate-limit bucket; a 429 discovered
by `poll` should back off `submit` and `ingest` too, exactly the sharing
`docs/specs/job-queue.md` §5.6 describes ("several handlers hitting one
vendor account are one bucket").

#### 1.5.5 `transcript.snapshot`

Server-only under rule 2's "reads several tables mid-computation" exemption:
it reads the **current live state** of `transcript_speakers` and
`transcript_segments` inside a `REPEATABLE READ` transaction — a snapshot
read consistent with a single point in time — gzips it to JSON, and writes it
as a managed object, recording `snapshot_object_id` on the
`transcript_versions` row it is snapshotting. `REPEATABLE READ` rather than
the default `READ COMMITTED` because a snapshot taken mid-edit under `READ
COMMITTED` could observe some rows before a concurrent correction's commit
and others after it — a snapshot that is nobody's actual historical state.
Policy (§4.3) decides *when* to snapshot; this handler only *takes* one, and
never runs inline inside the request that triggered a save (rule 1).

#### 1.5.6 `transcript.export` — server-only in v1, and why that is not a rule 2 exemption

This is the one job type in the table that does not map onto one of rule 2's
three named reasons ("writes as it goes," "reads several tables
mid-computation," "needs a privilege a remote machine must never hold"). Its
actual input — a materialized snapshot (§4.4) — is pure data a node could be
handed with no database access at all, and its computation (render Markdown,
render a PDF with pdfkit) is exactly the kind of CPU-bound, secret-free work
rule 2 says should default to node-eligible.

It stays server-only anyway, for a reason CLAUDE.md's rule 2 does not
enumerate because it is not about privilege or database access at all: **the
renderers live in the API**, and a second, independently-maintained copy in
`apps/cli`'s node executors would mean the *same* export request could
produce byte-for-byte different PDFs depending on which of two codebases
happened to claim the job — the same failure mode `docs/specs/worker-nodes.md`
§21 rejects for a checksum handler with "the node's answer is decorative" if
`persistNodeResult` ever recomputed, generalised to "the node's answer would
be a *different, independently drifting* implementation" for a renderer.
This is stated here explicitly, rather than left implicit, because a future
issue may well add `nodeResultSchema` + `persistNodeResult` to this handler
once the renderers are extracted into a package both `apps/api` and
`apps/cli` can share — the input is already snapshot data with no
server-only privilege attached, so nothing about §8's design would need to
change to make that move; it is a deliberate v1 scope line, not a structural
limit.

It runs at **priority −10**, more urgent than the default `0` (ascending is
more urgent — `docs/specs/job-queue.md` §4.4), the opposite end of the
spectrum from `HOUSEKEEPING_PRIORITY = 100`: a user is looking at a spinner
waiting for a download, which is the one case in this whole epic where "jump
the queue slightly" is the right answer, in contrast to every housekeeping
type in this table, which must never be claimed ahead of user-facing work.

#### 1.5.7 `transcript.purge`

Server-only under both rule 3 (calls `provider.deleteRemote` if the audio was
not already remote-deleted, needing the API key) and rule 2 (walks and
deletes every managed object — original, playback rendition, gzipped raw
result, every snapshot, every export file — before deleting the SQL rows,
which is exactly "writes/deletes as it goes" against several tables). It
takes no profile: deleting a bounded, enumerable set of objects for one
transcript does not resemble the multi-hour, must-never-auto-retry shape
`maxRuntimeMs`/`maxAttempts: 1` exist for, so the deployment-wide
`JOBS_JOB_TIMEOUT_MS`/`JOBS_MAX_ATTEMPTS` are the right numbers for it, same
as every ordinary handler before profiles existed at all
(`docs/specs/job-queue.md` §5.10).

#### 1.5.8 `transcripts.housekeeping`

Enqueued by a ten-minute `@Cron` in
`apps/api/src/transcripts/tasks/transcripts-housekeeping.task.ts`, through
the shared `enqueueHousekeepingJob` helper (`apps/api/src/jobs
/housekeeping.enqueue.ts`) — the exact helper `docs/specs/job-queue.md` §7.10
introduced so that "the cron decides whether work is due and enqueues it; a
handler does the work" costs six lines per conversion rather than sixty. This
cron, and only this cron, is what `apps/api/test/jobs/cron-enqueue-only.spec.ts`
(§12) will need to keep passing once this handler exists: the test reads
every `@Cron` method's body and requires it to enqueue rather than act, and a
`transcripts-housekeeping.task.ts` that queried and mutated rows inline
inside the `@Cron` method itself would fail that test the same way a
`@Cron` that deleted device codes inline would have before #353.

The handler is server-only under rule 2 (reads/writes across
`transcripts`, `jobs`, and `transcript_exports` in one sweep) and does three
things:

1. **Restarts a lost poll chain.** A `transcription.poll` chain can go
   silent if the process holding it dies between one poll and the
   `skipDedup: true` re-enqueue of the next — the reaper (`docs/specs
   /job-queue.md` §7) recovers the *job row* itself, but a transcript whose
   `transcription_status` is `submitted`/`processing` with no
   pending-or-running `transcription.poll` job at all (the chain broke,
   rather than one link being stuck) needs a **new** poll enqueued, which the
   reaper has no way to know to do — it reasons about jobs, not about
   transcripts. This sweep is the second, transcript-aware layer above the
   reaper's job-aware one.
2. **Purges transcripts whose upload was abandoned (issue #322).** A
   transcript stuck in `uploading` whose source upload has gone IDLE — no
   part-URL batch, no status poll, so `storage_objects.updated_at` hasn't
   moved — for longer than `transcription.abandonedUploadHours` (default 3,
   1–720; §9.4) is soft-deleted to `deleting` and handed to
   `transcript.purge`, which aborts the multipart upload and frees the
   object. Measured from the source object's last **activity**, never from
   the transcript's creation, so an upload being actively pushed is never
   killed however long it takes. **Purged, not failed** — the earlier design
   failed these rows after a hardcoded 96 hours, which left a permanent card
   nobody could retry (there is no audio to retry with); the same step also
   purges the legacy rows that behavior left behind (`failed` +
   `transcription_status: waiting_input` with no completed audio). This
   sweep is the *only* thing that reclaims an abandoned upload — the generic
   stale-upload sweep (§9.4) now skips managed objects entirely, since
   deleting one would violate `transcripts.source_object_id`'s `Restrict`
   foreign key. A **cancelled** upload does not wait for this sweep at all:
   `TranscriptsUploadAbortedListener` purges it immediately on
   `storage.object.upload_aborted` (§9.3).
3. **Expires exports.** Deletes `transcript_exports` rows and their storage
   objects past their `expires_at` (§8.4).

### 1.6 Domain failures, retryable failures, and `RateLimitError`

Three kinds of thing can go wrong in this pipeline, and telling them apart
correctly is the same discipline `docs/specs/job-queue.md` §5.2 already
establishes for the queue generally, applied to what a transcription
provider specifically can say:

| Kind | Examples | What happens |
|---|---|---|
| **Domain failure** | `ProviderAuthError` (bad/revoked key), `ProviderInputError` (file the provider rejects as corrupt or unsupported despite passing this app's own checks), the provider's own `error` status on a completed job, the poll hard deadline (§1.5.3) | `transcripts.status: failed` with a `failure_reason`; the **job succeeds** — it correctly determined a permanent outcome. No attempt is spent retrying a question whose answer will not change. |
| **Ordinary retryable failure** | A network error, a `5xx` from the provider, an unexpected exception in the handler | Normal queue retry on the type's own `maxAttempts` (§1.5's table); after the budget is spent, terminal `failed` on the **job**, and `transcripts.transcription_status` also moves to `failed` via the job's `job.settled` listener so the transcript does not sit `processing` forever with no job left working on it. |
| **`RateLimitError` (429)** | The provider's own rate limit | Deferred through the shared `'transcription-provider'` throttle key (§1.5.2–4); does not spend an attempt (`docs/specs/job-queue.md` §5.3); the transcript's own status does not change — from the user's point of view this is invisible backoff, not a failure. |

The dividing line between the first two is drawn once, in
`apps/api/src/transcription/providers/errors.ts`, and every provider
implementation is required to map into it rather than let a caller
downstream guess from an HTTP status. This is the same posture
`docs/specs/job-queue.md` §5.2 takes for `classifyRateLimit`: a total,
defensive classification function is written once so three job handlers do
not each grow their own slightly different `catch` block that drifts from
the others the first time one of them is patched.

**When the "ordinary retryable failure" budget runs out with nothing left
watching (issue #95).** The row above says `transcripts.transcription_status`
moves to `failed` via the job's `job.settled` listener "so the transcript does
not sit `processing` forever" — but that only happens for a failure the
handler itself recognized as unclassifiable and rethrew *from inside its own
`process()`*. It does nothing for a failure that IS an ordinary retryable
failure on every individual attempt, none of which is ever unclassifiable,
but whose retry budget still runs out: AssemblyAI's `speech_model` parameter
change (§2.7) is the live example — `assertOk` reports the vendor's 400 as a
plain `Error`, which is correctly retryable, and after `maxAttempts: 3` the
**job** goes `failed` with no code path having ever decided the **transcript**
should. `TranscriptJobFailureListener`
(`apps/api/src/transcripts/listeners/transcript-job-failure.listener.ts`)
closes that gap from outside the handler entirely: on `JOB_SETTLED_EVENT` with
`status: 'failed'` for `transcription.submit`/`transcription.poll` (stage
`transcription`), `transcription.ingest` (stage `ingest`), or
`media.audio.transcode`, when the transcript is still `processing` and no
other `pending`/`running` pipeline job exists for it (a fresh retry or a newer
poll-chain link, if one exists, owns the outcome instead), it calls
`markFailed` — retryable, for the transcription/ingest stages — with a reason
that quotes the job's `lastError` (bounded to 500 characters). For
`media.audio.transcode` it mirrors `MediaAudioTranscodeHandler
.onTranscodeError`'s own last-attempt branch (`playback_status: failed`, and
the transcript only fails if transcription was `waiting_input` on that
rendition) — needed because that method runs inside the **server's**
`process()` catch, which never executes when a worker node reports the
exhaustion through `POST /api/nodes/:id/jobs/:jobId/failure`, or when the
server process itself is killed mid-transcode and the reaper settles the last
attempt. The listener is detached from the event dispatch, idempotent
(`markFailed` guards in its own `UPDATE`), and never rethrows — a failure to
reconcile is logged and left to `transcripts.housekeeping` as the backstop,
never something that could affect the job's own terminal row.

## 2. The provider contract

### 2.1 `TranscriptionProvider`

`apps/api/src/transcription/providers/transcription-provider.interface.ts`.
Each provider declares an `id`, a `label`, a `capabilities` object, and a
`settingsSchema` (Zod) for its own provider-specific configuration fields
(AssemblyAI's is `{ region, speechModel }`):

```ts
interface TranscriptionProviderCapabilities {
  diarization: boolean;
  wordTimestamps: boolean;
  languageDetection: boolean;
  speakersExpectedHint: boolean;   // accepts a hint about how many speakers to expect
  acceptsUrl: boolean;             // can be pointed at a URL rather than sent bytes
  acceptsUpload: boolean;          // can accept a direct upload of bytes
  maxInputBytes: number;
  maxDurationMs: number;
  acceptedMimeTypes: string[];
  remoteDelete: boolean;           // supports deleting its own copy after ingest
  cancel: boolean;                 // supports cancelling a submitted job
}
```

and implements:

| Method | Returns | Notes |
|---|---|---|
| `testConnection(ctx)` | `{ ok, latencyMs, detail }` | Called both from the saved settings and from an unsaved key the admin is currently typing — never persists anything, never queues a job |
| `submit(ctx, { audio, options })` | `{ remoteId }` | `audio` is a discriminated union: `{ kind: 'url', url }` (the `presigned_url` delivery mode) or `{ kind: 'stream', stream, size, mimeType }` (the `upload` delivery mode, §2.6) |
| `getStatus(ctx, remoteId)` | `queued \| processing \| completed \| failed` | Provider-neutral status, mapped from whatever vocabulary the provider itself uses |
| `fetchResult(ctx, remoteId)` | `{ raw, normalized: NormalizedTranscript }` | `raw` is kept for provenance (§1.5.2–4); `normalized` is what the rest of the application ever touches |
| `cancel?(ctx, remoteId)` | `void` | Optional — declared only when `capabilities.cancel` is true |
| `deleteRemote(ctx, remoteId)` | `void` | Required, even for a provider whose `capabilities.remoteDelete` is false — such a provider's implementation is a documented no-op, so `transcription.ingest` never has to branch on capability before calling it |

This is the same shape as `docs/specs/database-backup.md`'s worked precedent
for a provider abstraction that spans a settings surface and a job handler:
one small interface, one settings schema, one registry, and the actual HTTP
calls confined to files under `providers/` that the rest of the module never
imports directly.

### 2.2 `NormalizedTranscript`

The one shape every provider must produce, and the only shape
`transcription.ingest` ever reads:

```ts
interface NormalizedTranscript {
  language: string | null;
  durationMs: number;
  speakers: Array<{ label: string }>;
  segments: Array<{
    speakerLabel: string;
    startMs: number;
    endMs: number;
    text: string;
    confidence: number | null;
    words: Array<{ text: string; startMs: number; endMs: number; confidence: number | null }>;
  }>;
  provider: { id: string; model: string | null; remoteId: string };
}
```

Normalization also **splits any utterance longer than roughly 45 seconds** at
sentence-ending punctuation. A raw provider utterance can legitimately run for
several minutes of uninterrupted speech, and a single multi-minute segment is
both unusable for the correction UI's segment-scoped edits (§4) and unusable
for per-speaker interval playback's granularity (§7.2) — the interval a user
can jump into is only as fine as the segments that exist. The 45-second figure
is a starting heuristic, not a provider-declared capability, chosen to keep a
segment short enough to read at a glance on a phone while long enough that
routine speech (a sentence, a short exchange) is rarely split mid-thought.

### 2.3 Error taxonomy

`ProviderAuthError` (the key is invalid, revoked, or lacks the needed scope),
`ProviderInputError` (the provider rejects this specific input — an
unsupported codec it did not actually support despite matching
`acceptedMimeTypes`, a corrupt file, an unreadable stream) and
`RateLimitError` (`apps/api/src/jobs/rate-limit.error.ts`, reused verbatim —
see §1.6) are the three named classes; **everything else is retryable by
default**, following the identical "positively identify, otherwise assume
retryable" posture `classifyRateLimit` takes for HTTP status codes
(`docs/specs/job-queue.md` §5.2) — a provider error this application does not
recognise gets one wasted attempt, never a permanently `failed` transcript
for a transient condition nobody classified correctly yet.

### 2.4 Choosing the input file: original vs. rendition

`selectTranscriptionInput()` (issue #25, extended by #26) decides which
storage object a `transcription.submit` job should point the provider at:

- **The original**, when the active provider's `acceptedMimeTypes` and
  `capabilities.maxInputBytes` accept it directly **and** the delivery mode
  is `presigned_url` — no reason to wait for a transcode that adds latency
  and cost with no benefit to the provider round trip.
- **Otherwise, the `media.audio.transcode` rendition**, once it is ready —
  transcription is left `waiting_input` until then, and `media.audio
  .transcode`'s own completion (§1.5.1) is what enqueues `transcription
  .submit` for a transcript sitting in that state.

This means the two sub-pipelines are not strictly sequential: for a format
the provider accepts natively, transcription starts on the original
immediately while the rendition is still being produced purely for
*playback*, and the two race each other to `ready`/`completed` independently
— which is the concrete reason §1.4 rejects collapsing the two sub-pipeline
statuses into one field.

### 2.5 Presigned-URL TTL, and the STS caveat

`transcription.submit` presigns a GET for the chosen input **when the job
runs**, valid for `transcriptionSettings.presignedUrlTtlMinutes` (default
360 = 6 hours) — long enough that a provider queueing the job behind other
customers' work still has a live URL by the time it actually starts reading
bytes, following the same "mint on demand, not at claim time" reasoning
`docs/specs/worker-nodes.md` §18 gives for node data-plane URLs, generalised
here to an external provider rather than a worker node.

**⚠ The STS caveat, stated because it is easy to configure into silent
failure.** When `StorageProvider` is backed by AWS credentials obtained
through STS (an assumed role with a temporary session token) rather than a
long-lived IAM access key, a presigned URL's *actual* maximum lifetime is
bounded by the **remaining lifetime of the session token that signed it** —
S3 rejects the URL past that point regardless of what `expiresIn` the code
requested. A deployment running its API under an assumed role with, say, a
1-hour session duration will find `presignedUrlTtlMinutes: 360` silently
produces URLs that stop working after roughly an hour, with no error at
signing time — the presign call itself succeeds; only the eventual GET from
the provider's side fails, hours later, as an opaque `403` this application
did not cause and cannot see. This is not this application's bug to fix;
it is an operational constraint to document, and it is why a deployment
using STS-issued credentials must provision a session duration at least as
long as `presignedUrlTtlMinutes`.

### 2.6 `presigned_url` vs. `upload` delivery modes

`transcriptionSettings.audioDelivery` is `'presigned_url'` (the default) or
`'upload'`. In `presigned_url` mode the provider fetches the bytes itself
from the URL §2.5 mints, and the API server never touches the audio — the
same "bytes never pass through the API" posture
`docs/specs/worker-nodes.md` §15 states for the node data plane, here
extended to an external SaaS provider instead of a worker node.

`upload` mode exists for exactly one case: a private, non-internet-reachable
S3-compatible endpoint (a MinIO instance reachable only from inside a VPC,
say) that the transcription provider's own infrastructure cannot reach at
all, no matter how the URL is signed. In that mode the API downloads the
input via `StorageProvider.download()` and re-uploads the stream directly
to the provider's own upload endpoint, so the API becomes a relay for this
one delivery mode only. This is a deliberate, narrow exception to the
"bytes never pass through the API" rule: it is opt-in, it applies only to
deployments with a storage backend the provider cannot reach at all, and the
alternative — no transcription at all for such a deployment — is strictly
worse. It is not the default, and nothing in §9's CSP or upload-hardening
work assumes it.

### 2.7 AssemblyAI as the reference implementation

The first (and, at epic completion, only) registered provider,
`apps/api/src/transcription/providers/assemblyai.provider.ts`. Built on
Node's built-in `fetch` (injected, so tests substitute it) rather than an SDK
— the same "a thin client is easier to mock and adds no dependency" reasoning
already applied to every other outbound HTTP call in this repository.

| Fact | Value |
|---|---|
| Base URL, US | `https://api.assemblyai.com` |
| Base URL, EU | `https://api.eu.assemblyai.com` |
| Auth | `authorization: <api_key>` request header — **no** `Bearer` prefix |
| Submit | `POST /v2/transcript` with `audio_url`, `speaker_labels: true`, optional `speakers_expected`, either `language_code` or `language_detection: true`, and the configured `speech_models` (an ordered array — see below; **not** the singular `speech_model`) |
| Poll / fetch | `GET /v2/transcript/{id}` — `status` ∈ `queued \| processing \| completed \| error`, plus `audio_duration` (**seconds**), `speech_model_used` (the model the vendor actually ran — falls back to the older `speech_model` field for a payload predating #95), `utterances[]` (`speaker`, `start`, `end`, `text`, `confidence`, `words[]`) and `words[]` (`text`, `start`, `end`, `confidence`) — **`start`/`end` are milliseconds** |
| Delete | `DELETE /v2/transcript/{id}` — redacts/removes the stored transcript |
| Auth probe | `GET /v2/transcript?limit=1` — `401` on an invalid key, used by `testConnection` |
| Capabilities | `maxInputBytes`: 5 GB. `maxDurationMs`: 10 hours |

Error mapping: `401` → `ProviderAuthError`; `429` → `RateLimitError`,
honouring `Retry-After` when present (through the same `parseRetryAfterMs`
`docs/specs/job-queue.md` §5.2 already uses); a `status: error` result on an
otherwise-`completed` poll → `ProviderInputError`; anything else defaults
retryable, per §2.3.

**RE-VERIFIED 2026-09-14 (issue #95):** the model selector. AssemblyAI now
refuses the singular `speech_model` request parameter with an HTTP 400 ("The
speech_model parameter is deprecated. Use speech_models: [...]"), which
`assertOk` reports as a plain retryable error — every submission exhausted
`transcription.submit`'s `maxAttempts: 3` and the transcript sat at
`processing` forever with no visible error. The provider now sends
`speech_models: string[]` (ordered; AssemblyAI falls back through the list by
language support) and reads the model actually used back from the response's
`speech_model_used` (falling back to the older `speech_model` field for a
payload predating this change). Current documented ids:
`universal-3-5-pro` (recommended, most accurate) and `universal-2` (broadest
language coverage) — see
https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model.
The stored `transcription.providers.assemblyai.speechModel` setting is
unchanged in shape (still a string) and is now read as a comma-separated,
ordered list; the retired singular ids `universal`, `best`, `nano` and
`slam-1` are dropped, and an empty result resolves to the default list
`universal-3-5-pro, universal-2` — so an existing deployment's stored
`"universal"` keeps working with no migration. See
`resolveAssemblyAiSpeechModels` in `assemblyai.provider.ts`.

**⚠ These parameter names, the speech-model identifiers, and the two
capability numbers are the implementation target as of this document's
writing (2026-09), not a value re-verified against AssemblyAI's live API at
the moment issue #23 is implemented.** Per this document's acceptance
criteria (and issue #23's own), AssemblyAI's current documentation MUST be
re-checked before this epic is declared final — an API's parameter names,
default models and published limits are exactly the kind of fact that drifts
between when a spec is written and when the code implementing it ships.

## 3. Data model

Six tables (issue #24), Prisma models with `snake_case` `@@map`, all keyed to
one `transcripts` row per uploaded recording.

### 3.1 `transcripts`

| Group | Columns |
|---|---|
| Identity | `id`, `owner_id` (FK `users`, `Cascade`), `title`, `language` |
| State | `status` (`TranscriptStatus`, §1.1), `transcription_status` (§1.2), `playback_status` (§1.3) |
| Storage links | `source_object_id` (FK `storage_objects`, `Restrict`), `playback_object_id?`, `raw_result_object_id?` |
| Provider | `provider`, `provider_job_id?`, `provider_options` (JSONB: `speakersExpected`, `language`) |
| Timestamps | `submitted_at?`, `last_polled_at?`, `completed_at?`, `remote_deleted_at?`, `deleted_at?`, `created_at`, `updated_at` |
| Derived | `duration_ms?`, `failure_reason?`, `current_version` (int, default 0), `speaker_count`, `word_count` |
| Indexes | `(owner_id, updated_at desc)`, `(status)` |

`source_object_id` is `Restrict`, not `Cascade` — a `storage_objects` row a
transcript still references may never be deleted out from under it by an
unrelated storage cleanup; the *only* path that may remove it is
`transcript.purge` deleting the transcript row first. This is the same
ownership discipline §9.3 gives `managed_by`: a `storage_objects` row
belonging to a transcript is invisible to and untouchable by the generic
storage endpoints.

### 3.2 `transcript_speakers`

`id`, `transcript_id` (`Cascade`), `label` (the provider's own label, e.g.
`"A"` — nullable for a speaker the user created directly, §4.1's
`speaker.create`), `display_name`, `color_index`, `rev` (int). **Unique on
`(transcript_id, label)`**, expressed as a **partial** unique index —
`WHERE label IS NOT NULL` — reusing the exact pattern
`jobs_active_dedup_uniq_idx` and `database_backup_runs_active_uniq_idx`
already establish in this repository for "unique among the rows where a
condition holds, and Prisma's `@@index` DSL cannot express the `WHERE`
clause": a provider-labelled speaker's label must be unique per transcript,
but a user-created speaker legitimately has none, and two user-created
speakers with no label must not collide on `NULL = NULL` under the naive
reading of a non-partial unique index. This migration therefore hand-writes
that index in `migration.sql`, exactly as the two precedents do, and is the
same kind of intentional schema drift CLAUDE.md's own "Database Tables"
section already documents for `jobs`.

### 3.3 `transcript_segments`

`id` (**stable across edits** — see §3.5), `transcript_id`, `speaker_id` (FK,
`Restrict` — a speaker cannot be deleted while segments still reference it;
`speaker.merge`, §4.1, re-points every segment away before deleting the
source speaker rows), `start_ms`, `end_ms`, `ordinal` (float, gap-based, §3.4),
`text`, `words` (JSONB, `[{t, s, e, c}]` — text, start, end, confidence, kept
terse because a 10-hour transcript's word array is the single largest thing
in this schema), `words_alignment` (`exact \| interpolated \| none`, §3.5),
`confidence?`, `origin` (`ai \| user`), `rev` (int), `edited_by_id?`,
`edited_at?`. Index on `(transcript_id, start_ms, ordinal)` — the compound
order a segment list and a time-window query (`GET /:id/words?fromMs&toMs`)
both need.

### 3.4 `ordinal`: gap-based floats, so a split needs no renumbering

New segments are assigned ordinals with real gaps between them — for
example `1000, 2000, 3000, …` for the AI original — so that inserting a
segment (the later half of a `segment.split`, §4.1) only needs the **midpoint
between its two neighbours**, e.g. `1500` between `1000` and `2000`, and
touches no other row. This is the direct alternative to an integer sequence
that would require renumbering every later segment on every insert — an
`UPDATE` whose size grows with how far into a 6,000-segment transcript the
split happened, on every single split, for the entire life of the document.

The float scheme is not unbounded for free: repeated splits at the same
point eventually produce ordinals close enough together that floating-point
precision runs out (in practice, after dozens of splits at the same seam,
which is far beyond ordinary editing but not impossible under a pathological
sequence of undo/redo). The op reducer's answer is a **local** renumber, not
a document-wide one: when a split's midpoint would land on or too close to
either neighbour, the reducer widens the gap by renumbering only the small
neighbourhood around the insertion point (the segment before and the
segment after, spread back out to a round gap), never the whole transcript.
This keeps every write's cost bounded by "how many segments sit in this one
neighbourhood," not by "how many segments this transcript has."

### 3.5 Word-timing alignment survives edits, splits and joins

`words_alignment` on each segment states how much to trust the segment's own
`words[]` array after an edit:

- **`exact`** — every word's timing is the provider's own, untouched. A
  freshly ingested (`ai_original`) segment is always `exact`. A
  `segment.split` or `segment.join` (§4.1) that only divides or concatenates
  an existing `words[]` array — never inventing a timing — also produces
  `exact` segments on both sides, because every word retained its original
  provider-supplied `{s, e}`.
- **`interpolated`** — some tokens' timings were **reconstructed**, because
  `segment.update_text` (or the concrete ops `transcript.find_replace`
  expands into, §4.2) changed the text. The reducer computes a **token-level
  Longest Common Subsequence** between the segment's old word list and the
  new text, tokenized the same way. Tokens the LCS matches keep their
  original `{s, e, c}` untouched; a token with no match (an insertion, or the
  replacement half of a substitution) gets a timing **linearly interpolated**
  between the nearest matched neighbours on either side — or extrapolated at
  a segment boundary, when the change is at the very start or end.
- **`none`** — the reducer could not align at all (an LCS with too little
  overlap to be meaningful — a full retype of the segment, for instance).
  Word timings are spread **evenly** across the segment's `[start_ms,
  end_ms]` span as a last resort, purely so downstream consumers (word
  highlighting during playback) always have *some* timing rather than a
  crash on a missing array — `none` is what tells the player that timing is
  a placeholder, not a measurement.

`segment.split` divides the words array **at the split point** — by word
index, or by character offset resolved to the nearest word boundary — and
each half keeps its original members' exact timings, so both resulting
segments are `exact`. `segment.join` (adjacent segments only, per §4.1)
concatenates the two words arrays in order; the joined segment's
`[start_ms, end_ms]` become `[min(a.start, b.start), max(a.end, b.end)]`,
and the result is `exact` because nothing was invented — the two arrays were
simply laid end to end.

## 4. Operations and versions

### 4.1 Op semantics, with test vectors

All ops are pure functions over `{ speakers, segments }`
(`apps/api/src/transcripts/editing/`), returning the next state plus the
per-entity `rev` bumps that happened. A batch of up to 200 ops is applied in
one transaction (§5).

| Op | Payload | What it does |
|---|---|---|
| `segment.update_text` | `{ segmentId, rev, text }` | Replaces a segment's text; re-aligns words per §3.5 |
| `segment.set_speaker` | `{ segmentId, rev, speakerId }` | Reassigns one line to a different (existing) speaker |
| `segment.split` | `{ segmentId, rev, atWordIndex \| atCharOffset, newSpeakerId? }` | Divides one segment into two, at a word or character boundary |
| `segment.join` | `{ segmentIds: [a, b], revs }` | Merges two **adjacent** segments into one |
| `segment.delete` | `{ segmentId, rev }` | Removes a segment entirely |
| `speaker.rename` | `{ speakerId, rev, displayName }` | Changes a speaker's display name |
| `speaker.create` | `{ displayName }` | Adds a new, label-less speaker (§3.2) |
| `speaker.merge` | `{ sourceIds[], targetId, keepName? }` | Re-points every segment on any source speaker to the target, then deletes the sources |
| `transcript.find_replace` | `{ find, replace, matchCase, wholeWord, speakerId? }` | Expanded server-side into concrete `segment.update_text` ops before recording (§4.2) |

**Test vectors** (illustrative; the real acceptance criterion — issue #27 —
is a table-driven test over exactly these):

- **`segment.update_text`**: segment `s1` (`rev: 1`, `text: "Hello wrld"`,
  words `[{Hello,0,400},{wrld,420,700}]`). Op `{segmentId: 's1', rev: 1, text:
  "Hello world"}`. Result: `rev → 2`; the LCS matches `"Hello"` unchanged
  (`{0,400}` kept exactly); `"world"` has no exact match to `"wrld"`, so its
  timing is interpolated from the segment's remaining boundary
  (`{420, 700}` inherited as the closest available anchor); `words_alignment:
  'interpolated'`.
- **`segment.split`**: segment `s1` (`rev: 1`, `ordinal: 2000`, 10 words,
  next segment at `ordinal: 3000`), op `atWordIndex: 5`. Result: the
  **earlier** half keeps id `s1`, `ordinal: 2000`, and words 0–4 with their
  original timings (`exact`); a **new** segment `s2` is created with a fresh
  id, `ordinal: 2500` (the midpoint), and words 5–9 with their original
  timings (`exact`). Keeping the earlier id stable means a bookmark, an
  export reference, or a concurrent editor's stale `rev` for the original
  segment still names something real.
- **`segment.join`**: adjacent segments `a` (`rev: 1`, speaker `X`) and `b`
  (`rev: 1`, speaker `Y`, immediately following `a` by `ordinal`). Result: a
  single segment keeping id `a`'s id, `ordinal`, and speaker `X` — joining
  across a speaker change is allowed (the payload carries no speaker
  override), and the merged segment's speaker is deliberately the **first**
  segment's; a user who wanted the second speaker follows up with
  `segment.set_speaker`. `text` is the two texts joined with a single space;
  `words` is the two arrays concatenated in order (`exact`, per §3.5).
- **`speaker.merge`, 3 → 1**: speakers `A`, `B`, `C`; op `{sourceIds: ['B',
  'C'], targetId: 'A'}`. Every segment whose `speaker_id` was `B` or `C`
  becomes `A` (each such segment's own `rev` bumps, exactly as
  `segment.set_speaker` would bump it — a concurrent editor holding a stale
  `rev` for one of those segments correctly gets a 409, §5); speakers `B` and
  `C` are deleted; the transcript ends with one speaker, `A`, carrying every
  segment. `keepName` defaults to `true` (the target keeps its own current
  `display_name`); passing `false` instead adopts the **first** `sourceIds`
  entry's `display_name` onto the target — for the case where the surviving
  id is a duplicate the user actually wants renamed away.

### 4.2 Find & replace: expanded server-side, before it is ever recorded

`transcript.find_replace`'s matching rules:

- **Literal substring matching only — never regular expressions.** A regex
  engine exposed to end-user input is a ReDoS surface (a hostile or merely
  unlucky pattern can pin a worker thread), and it is also simply the wrong
  tool for a non-technical user who typed a company name they want corrected
  everywhere — "find and replace text," not "find and replace a pattern."
- **Optional case sensitivity** (`matchCase`).
- **Optional whole-word matching** (`wholeWord`), with **Unicode-aware** word
  boundaries — not the ASCII `\b` a naive implementation reaches for first,
  which treats every non-ASCII letter as a boundary and would, for instance,
  match `"José"` as a whole-word hit for a search on `"os"` because `\b`
  cannot see `é` as a word character at all.
- **Optional speaker scope** (`speakerId`) — restrict matching to one
  speaker's segments, for the common case of a name one specific person
  mispronounces or one speaker's technical jargon.

**The match is computed once, server-side, over the current text, and the
result is recorded as concrete `segment.update_text` ops — never as the
abstract `transcript.find_replace` call itself.** This is the load-bearing
design decision, and it is why replaying history is safe forever: if this
application's matching implementation ever changes (a Unicode table update,
a bug fix in word-boundary detection, a future case-folding improvement), a
*historical* version that recorded a `find_replace` op literally would
replay **differently** after that change — the exact "materialize a version
and get something other than what was actually saved" failure §4.4's
invariant exists to rule out. Expanding to concrete ops before recording
means a version's ops are a permanent, self-contained description of exactly
what changed, immune to any future change in how matches are *found*.

### 4.3 Snapshot policy

`transcript.snapshot` (§1.5.5) runs:

- **Always** for version 1 (the AI original) and for **every** restore
  (§4.5) — these are the two versions a user is most likely to want to view
  or restore back to quickly, so they should never require replaying a long
  chain of ops to materialize.
- **Otherwise**, after **50 versions** or **1 MB of accumulated ops** since
  the last snapshot, whichever comes first — a size-or-count trigger, so a
  transcript edited in many tiny bursts (crossing the count threshold
  quickly) and one edited in a few enormous batches (crossing the byte
  threshold quickly) are both bounded.

Snapshots are never taken inline inside the request that triggered the save
— `POST /:id/operations` enqueues `transcript.snapshot` (rule 1) and returns
as soon as its own transaction commits; the snapshot follows asynchronously.

### 4.4 The invariant: `materialize(currentVersion) == DB state`

`materialize(transcriptId, version)` loads the nearest snapshot at or before
`version`, then replays every later version's `ops` through **the exact same
pure reducers** the live edit path uses (§4.1), never a second
implementation. Because the live path itself both updates the current-state
tables **and** appends the version-log entry inside one transaction, the
invariant holds **by construction** at the moment of every write:
`materialize(currentVersion)` — replaying every version from the nearest
snapshot up to the newest — must equal the live tables, because the live
tables are themselves the result of applying the same ops in the same
order. The property test issue #27 requires (`materialize(currentVersion)`
after a random sequence of ops equals the live state) is therefore not
testing a hopeful design; it is testing that no reducer accidentally has a
side effect the log does not capture, or a log entry the reducer does not
reproduce.

This is the same relationship `docs/specs/job-queue.md` §7.6 describes for
`JobStatsRollup` — "purging becomes pure compaction: what is summarised
changes, what is true does not" — applied to correction history: a snapshot
is a compaction of the replay work, never a second source of truth that
could disagree with the ops it stands in for.

### 4.5 Restore creates a new version; the AI original is permanent

`POST /:id/versions/:v/restore` does **not** rewrite history. It records a
new version (`kind: restore`, `ops: [{op: 'restore', fromVersion: v}]`,
`restored_from_version: v`), replaces the current-state tables with the
materialized content of version `v` in one transaction, and enqueues a
snapshot (§4.3 — restores always snapshot). Every version before it —
including the one just restored *from*, and the one that existed
immediately before the restore — stays exactly as it was: a restore is
`current_version + 1`, appended, never a rewind that erases the versions in
between.

**Version 1 is permanent for the life of the transcript.** It is `kind:
ai_original`, `author_id: null` (`null` specifically **means** "the AI," the
same convention `transcript_versions.author_id` uses everywhere else — a
restore or an edit always has a human `author_id`, and only the ingest
handler ever leaves it `null`), and nothing in this design ever deletes a
`transcript_versions` row — the history-purge precedent
(`docs/specs/job-queue.md` §7.5–7.7) explicitly does not apply here: that
purge deletes **terminal job rows** that have already been folded into a
rollup with no further meaning; a transcript's version 1 is exactly the
"AI proposes" half of this epic's own thesis and is retained for as long as
the transcript exists, full stop, deleted only when the whole transcript is
(`transcript.purge`, §1.5.7, §10).

## 5. Concurrency

Optimistic, using a **per-entity `rev`** (one on `transcript_speakers`, one
on `transcript_segments`) **plus** a batch-level `baseVersion`:

- **`baseVersion`** is informational about *when* the client last saw the
  transcript, not a lock — it may be stale by the time the batch is applied,
  and that is fine, because…
- **…every op's own `rev` is checked against the current row**, so edits to
  **different** segments merge automatically even when `baseVersion` is
  behind: two editors correcting two different speakers' lines at the same
  moment both succeed, because neither op's `rev` check touches the other's
  row.
- **Two ops targeting the same entity's stale `rev`** — the genuine conflict
  — return **409** with:
  ```json
  { "currentVersion": 7, "conflicts": [{ "entity": "segment", "id": "seg_42", "current": 3 }] }
  ```
  naming every conflicting entity in one response, so a client can resolve
  all of them in one re-fetch-and-retry rather than discovering conflicts one
  at a time.
- **`current_version` is bumped with a conditional `UPDATE … WHERE
  current_version = $n`** inside the same transaction as the per-entity `rev`
  checks — the same "the write itself is the check" discipline
  `docs/specs/job-queue.md` §8.5 uses for a job retry's running-row guard,
  applied here to the transcript's own version counter so two batches
  racing to be "version 8" cannot both succeed.
- **`clientBatchId`** (unique with `transcript_id` on `transcript_versions`)
  makes a retried save **idempotent**: a client that saved successfully but
  never saw the response (a dropped connection, a backgrounded tab) retries
  the identical batch with the identical `clientBatchId`, and the server
  returns the **original** result rather than creating a second version —
  the exact shape `enqueue()`'s dedup already gives job creation
  (`docs/specs/job-queue.md` §4.1), applied here to a write endpoint instead
  of a queue insert.
- **Reads poll with a weak ETag**, `W/"v<currentVersion>"`, on `GET
  /:id` and `GET /:id/segments`. A client polling while nothing has changed
  gets a `304` with no body — the transcript's own equivalent of
  `useTranscript`'s (issue #30) adaptive 5s/20s polling costing nothing on
  the common case where the answer has not moved.

**Rejected: CRDTs or full operational-transform real-time collaboration.**
Per-entity optimistic concurrency is enough for the realistic case this epic
targets — one or two editors making occasional corrections, not a live
Google-Docs-style co-editing session — and a CRDT's correctness guarantees
(convergence under arbitrary interleaving, no central arbiter) are paid for
with a much larger, harder-to-reason-about implementation for a workload
that does not need them. §11 restates this as one of the rejected
alternatives with the rest.

## 6. Access model

### 6.1 Owner > editor > viewer, and 404 on no access

`TranscriptAccessService.require(userId, transcriptId, level)` with `level`
∈ `'view' | 'edit' | 'own'`. Precedence: the owner satisfies every level;
an `editor` share satisfies `view` and `edit`; a `viewer` share satisfies
only `view`. `edit` additionally requires the caller to hold
`transcripts:write` — a share alone cannot grant an editor access this
application's own RBAC withholds from their role.

**No access is a 404, never a 403.** A 403 confirms the resource exists and
merely refuses the caller; a 404 reveals nothing about whether transcript
`abc123` exists at all. For a product whose stated privacy stance is that a
transcript is a **private conversation**, the existence of a specific id is
itself information a stranger has no business learning — the identical
reasoning `docs/specs/notification-broadcasts.md` and the sharing design in
issue #29 both apply to "no partial matching, no listing" for the share-by-
email lookup (§6.3): a system that answers "no such thing" identically for
"does not exist" and "exists, but not for you" leaks nothing either way.

### 6.2 What `transcripts:read`/`write` gate — and why there is no `read_any`

`transcripts:read` and `transcripts:write` are seeded to **all three roles**
— Admin, Contributor and **Viewer** (`apps/api/prisma/seed-data.ts`
`ROLE_PERMISSIONS`) — because creating a transcript is the core action this
whole epic exists to enable, and a brand-new user's default role is
`Viewer`; a permission model that made a fresh signup unable to record their
first conversation until an admin promoted them would contradict the
product's own onboarding. `transcripts:read` gates every read endpoint (list,
get, segments, words, search, versions, exporters); `transcripts:write` is
the **additional** requirement `edit`-level access checks on top of a share
(§6.1) — a viewer share can never correct a transcript no matter what a
future role grants, because a share caps the *ceiling* an RBAC permission
can raise a user to, never the floor.

**There is deliberately no `transcripts:read_any`.** Every other
"any"-scoped permission in this codebase — `storage:read_any`,
`db_backup:*` as a whole, `nodes:*` covering the whole fleet — exists because
the resource it governs is either infrastructure (a backup, a worker node) or
explicitly shared organisational state (a storage object another user
uploaded for a shared purpose). A transcript is neither: it is somebody's
private recorded conversation, and the epic's own success criteria state the
constraint plainly — "Admins reading other users' transcripts (deliberately
excluded for privacy)." No permission string exists for it because granting
one, ever, to any role, is out of scope for this feature, not merely unused
today.

### 6.3 Sharing: viewer and editor, and the narrow email lookup

`transcript_shares` (`transcript_id`, `user_id`, `role`: `viewer | editor`,
`granted_by_id`; unique on `(transcript_id, user_id)`) is populated only
through `POST /api/transcripts/:id/shares`, callable only by the owner. It
looks up an **active** user by **exact, case-insensitive email** — never a
partial match, never a listing — and answers a generic 404 ("No KVox user
with that email") for no match, rate-limited per owner, for the reason §6.1
already states: a system that must not leak whether transcript `X` exists
must equally not leak whether user `Y` has an account, and the two checks
share the same "answer identically for absent and for forbidden" posture.
Revocation and role changes take effect on the **next request** — there is
no cached grant anywhere for `TranscriptAccessService` to invalidate.

The exact 404 text is **"No user with that email"**, with no product name in
it. That is deliberate and is not a slip against the wording above: this
repository is a renameable template, `apps/cli`'s `template-identity` test
fails any hardcoded product-name literal, and a message that named the
product would have to be re-derived from `APP_NAME` for no gain — the message
must name *nothing*, and the product is one more thing it does not need to
name.

### 6.3.1 Four endpoints, and the one that is not owner-only

| Endpoint | Who | Level asked of `TranscriptAccessService` |
|---|---|---|
| `GET /api/transcripts/:id/shares` | owner | `view`, plus an explicit owner check |
| `POST /api/transcripts/:id/shares` | owner | `own` |
| `PATCH /api/transcripts/:id/shares/:userId` | owner | `own` |
| `DELETE /api/transcripts/:id/shares/:userId` | owner, **or the recipient leaving** | `own` / `view` |

Two rows of that table are worth stating in words, because both are easy to
get subtly wrong:

**The list asks for `view`, not `own`.** `require` turns any level above
`view` into a `transcripts:write` check — correctly, since both levels above
it mutate — but *reading* the share list writes nothing, and an owner whose
role lost `transcripts:write` must still be able to see who they shared with
even though they can no longer change it. So the list asks for `view` and
rejects a non-owner itself, with the same `TRANSCRIPT_NOT_FOUND_MESSAGE`. It
is owner-only and **not** viewer-or-better: who else can read a recording is
a fact about those other people, and a recipient enumerating the others would
learn about people who never agreed to be visible to them.

**`DELETE` is gated on `transcripts:read`, not `transcripts:write`.** Giving
up your own access is not a write against somebody else's recording, and a
role change that removed `transcripts:write` must not trap a recipient in a
share they want out of. The leave path passes an empty permission list for
the same reason.

**Sharing with yourself is a 400, not the generic 404**, and costs no
rate-limit budget. The 404 is generic because the caller must not learn
whether a *stranger's* address has an account; there is nothing to conceal
from somebody about their own, a generic answer there would read as "your
account does not exist", and charging the limiter would punish a typo rather
than a probe.

Re-sharing with somebody who already holds a share **updates their role**
rather than failing: the dialog's email field does not know who is already on
the list, and a 409 would make the owner delete a row in order to type it
again. `@@unique([transcript_id, user_id])` is what makes the upsert's
"exactly one row per pair" a property of the database rather than of the
service.

### 6.3.2 Rate-limiting the lookup: per caller, misses only, in process

There was **no rate-limiting precedent in this repository to reuse** when
issue #29 landed, and the three things that look like one are all about
something else: `jobs/provider-throttle.service.ts` shares an *outbound*
bucket so a vendor is not hammered; `jobs/rate-limit.error.ts` classifies a
429 a provider returned *to us*; and the device-authorization poll interval
is a hint in a response body, not an enforced limit. So
`ShareLookupThrottleService` is deliberately the simplest correct thing, with
three properties stated rather than implied:

- **Per authenticated caller, not per IP.** That is who the oracle answers
  to: an attacker behind a thousand addresses is still one account, and an
  office behind one NAT is many.
- **Only a miss spends budget.** Sharing with eight colleagues in a row is
  the feature working; it is the run of misses that is the enumeration.
  Charging only failures makes the limit invisible to every honest user and
  immediate for the attack it exists to stop.
- **In process**, which is a real limit and not a hidden one: N replicas
  permit N times the budget and a restart forgets everything. That is an
  acceptable trade for a control whose job is to turn "ten thousand addresses
  in a minute" into "ten thousand addresses in a week", and it is the honest
  shape for a codebase with no shared cache — a Postgres-backed counter would
  put a write on the hot path of every failed lookup, and a Redis-backed one
  would add infrastructure this deployment does not have. The service is the
  seam to replace if a shared limiter is ever wanted; nothing outside it
  knows how the counting is done.

Audit: `transcript:share:grant`, `transcript:share:update` and
`transcript:share:revoke`, all `targetType: 'transcript'`. A **leave**
records the revoke with the person leaving as the actor and `left: true` in
its meta, so an audit reader does not have to compare two ids to tell the two
shapes apart.

### 6.4 Why the admin card reuses `system_settings:*`, and not a new permission

The Transcription settings card (`/admin/settings/transcription`, issue #23)
is gated on `system_settings:read`/`write`, **not** a new
`transcription:*` permission pair — deliberately following the SMTP-password
precedent rather than the `push:*`/`nodes:*`/`broadcasts:*`/`db_backup:*`
precedent for splitting a permission out. CLAUDE.md's own "Key Permissions"
section states the test each of those four splits passed to earn its own
permission, and the AssemblyAI API key fails all four of them:

| Split permission | Why it exists | Does the transcription key share that property? |
|---|---|---|
| `push:*` | Rotating VAPID keys disrupts **every existing subscriber**, who goes dark until re-subscribing — a real, described blast radius that should not ride along with routine settings edits | **No.** Rotating the AssemblyAI key affects nothing already in flight; it takes effect on the next `transcription.submit` |
| `nodes:*` | "What work is queued" and "which machines are attached to this deployment" are different questions | **No.** There is no fleet-vs-queue distinction here at all |
| `broadcasts:*` | Sending a message to every active user has its own blast radius distinct from ordinary settings | **No.** Configuring a provider sends nothing to anyone |
| `db_backup:restore` | Replacing the live database is a fundamentally different authority than scheduling a nightly dump | **No.** There is no restore-shaped operation in this feature at all |

What the AssemblyAI key actually **is**, is the same kind of secret the SMTP
password already is: an API credential for an outbound integration, stored
through the identical `CredentialsService.setSecret('transcription',
<providerId>)` call the email module makes for its own transport secret,
masked the same way on read (`describe()`, never the plaintext), and gated
by the same permission pair the SMTP settings page already uses for exactly
this reason. Inventing `transcription:*` here would be the mistake epic #90
warns against from the other direction — a permission that exists because a
new feature showed up, not because the controller it gates checks anything
a shared permission does not already check.

`GET /api/transcription/config` is the one **non-admin** endpoint in this
group (`transcripts:read`), following the `/api/notifications/config`
pattern CLAUDE.md's Browser Notifications section already establishes: a
regular user needs to know *whether* transcription is available, the upload
limits, and the provider's name for the privacy notice (§10), without
needing `system_settings:read` to ask.

## 7. Playback

### 7.1 AAC/m4a mono, faststart, and Range seeking

Every transcript that needs one gets a rendition: mono AAC in an MP4
container at 64–96 kbps, with `-movflags +faststart` moving the `moov` atom
(the index of where every frame lives in the file) to the **front** of the
file. Without it, a browser opening the file has to download the **entire**
file before it knows where anything is, which defeats seeking on a
multi-hour recording entirely; with it, the browser reads a small header and
can immediately issue **HTTP Range** requests for whatever position the user
scrubs to. This is the whole reason a rendition is produced even for a
format that would technically *play*: seekability, not merely playability,
is the requirement, and mono at a modest bitrate additionally keeps a
multi-hour recording's rendition small enough to stream comfortably on
cellular data. Range support itself needs no code in this application at
all — it is a native capability of the S3-compatible storage the signed URL
points at, which is exactly why §9.5's S3 CORS configuration has to
explicitly allow the `Range` request header: without it, the browser's Range
request is blocked by CORS before it ever reaches the storage layer.

### 7.2 Per-speaker interval playback

`usePlaybackEngine` (issue #30) builds a selected speaker's **sorted list of
segment intervals** and treats the whole recording as "play only inside
these windows, skip everything else":

- **Gaps under 300 ms between two consecutive intervals of the same
  selection are merged into one interval.** Diarization frequently produces
  a handful of milliseconds of silence or a breath between two segments from
  the same speaker that are really one continuous thought; without merging,
  the engine would seek-pause-seek across dozens of sub-second gaps a
  listener cannot perceive as separate at all, producing an audibly jittery
  playback experience out of what should sound like one continuous stream.
  300 ms is chosen as comfortably below the threshold of a perceptible pause
  in ordinary speech while still respecting genuine multi-second silences
  between different thoughts.
- **While the tab is visible**, a `requestAnimationFrame` loop checks
  `currentTime` against the current interval's end on every frame and, on
  crossing it, seeks straight to the next interval's start — or pauses, past
  the last one. `rAF` gives frame-rate resolution (effectively sub-16ms),
  which matters because a merged 300ms-gap boundary crossed late by even a
  hundred milliseconds is audible as an unwanted snippet of the *next*
  speaker's actual words.
- **When the tab is backgrounded**, browsers throttle or fully suspend `rAF`
  callbacks (Chrome and Safari both stop firing them for a hidden tab), so
  the engine falls back to the `timeupdate` media event instead, which
  continues firing (audio playback itself is not throttled, only the visual
  frame loop) but at a **much coarser resolution — the HTML spec's own
  minimum firing interval is around 250 ms**. The **documented overshoot** is
  therefore up to roughly 250 ms past an interval boundary while backgrounded
  — a small, bounded, and explicitly accepted imprecision, not a bug: a
  user who backgrounds the app to check a notification while listening to
  one speaker's parts should not lose per-speaker filtering entirely, and
  "occasionally plays a quarter-second of someone else's word" is a far
  better failure than "silently falls back to the whole recording" or
  "stops updating and needs the app reopened to recover."
- **Seeking outside any selected interval snaps forward** to the next
  interval's start — pressing play (or manually scrubbing) into a gap
  between this speaker's parts does not play the other speaker's audio, it
  jumps past it.
- **The current segment** (for highlighting, and for word-level highlighting
  when word timings exist) is found by **binary search** over the sorted
  segment list against `currentTime`, re-run only when `currentTime` crosses
  a segment boundary rather than on every frame — a linear scan over up to
  ~6,000 segments (issue #30's own benchmark fixture) sixty times a second
  is needless work a sorted binary search avoids entirely.

### 7.3 Media Session integration

`navigator.mediaSession` is set with the transcript's title and the current
speaker as metadata, so a phone's lock screen and a desktop's OS media
control surface both show something meaningful rather than a bare filename.
Action handlers: `play`/`pause` map directly; `seekbackward`/`seekforward`
implement the ±10s skip the in-app player also exposes; `previoustrack`/
`nexttrack` map to the previous/next **segment** rather than a literal
previous/next track, so the hardware media keys on a headset or a lock
screen become a segment-scoped skip control, matching what tapping a
timestamp in the segment list already does. `setPositionState` keeps the
lock screen's own scrubber in sync with `currentTime` so the two controls
never disagree about where playback actually is.

### 7.4 Per-segment playback

Issue #108, epic #105. A reader can play **one line** and have playback stop
at its end, from a 40px control in each segment row. The engine exposes
`playSegment(segment)` and `activeSegmentId` beside the transport it already
had.

Three properties of this are load-bearing, and all three are pinned by tests
in `apps/web/src/__tests__/hooks/usePlaybackEngine.test.tsx`:

1. **It bypasses the speaker filter.** `playSegment` writes `currentTime`
   directly rather than going through `seekToMs`, which snaps to the
   selection's intervals (§7.2). A line the filter excludes is still a line
   the user pointed at, and snapping out of it on the first tick would make
   the button silently do nothing on exactly the rows where a reader is most
   likely to press it.
2. **The boundary check and the interval logic are one `if/else`, never two
   independent checks.** Letting the interval branch run underneath an active
   segment play would re-introduce the snap the previous point exists to
   avoid.
3. ⚠ **Everything below that branch still runs on every tick.** The obvious
   way to write the boundary check is an early `return`, and it would freeze
   both the scrubber and the active-line highlight for the entire length of
   the line being played — the only two pieces of feedback that tell a user
   the button did anything at all.

Segment mode ends on any scrub, skip, timestamp activation, previous/next
segment, `pause`, or the media element's own `pause`/`ended`. A Media
Session `play` resumes ordinary playback rather than the segment, because it
routes through `play` → `seekToMs`, which clears the mode; that is
documented rather than special-cased.

**One emergent behaviour is pinned rather than papered over.** When a
speaker filter is active *and* the played line's `endMs` falls outside every
filter window, the engine parks on the boundary as specified, and the
pre-existing interval loop — which runs every frame regardless of play
state, and has just had segment mode cleared out from under it — then pulls
the playhead to the nearest allowed position on the next frame. That comes
from §7.2's loop, not from this feature, and it is the better of the two
available answers: the alternative leaves the playhead somewhere the next
Play jumps away from with nothing on screen explaining why.

**The transport's skip is ±10s, not ±15s.** It had been 15s in `SKIP_MS` and
in the accessible labels while the buttons drew MUI's `Replay10`/`Forward10`
glyphs, which ship in 5/10/30 only. The labels were the half that was wrong.

See [`docs/specs/ux-refresh.md`](ux-refresh.md) §3 for the full reasoning,
including why the 24px timestamp deliberately stays small beside the new
40px control.


## 8. Exports

### 8.1 The exporter registry

`apps/api/src/transcripts/export/`, following the exact self-registration
shape `docs/specs/job-queue.md` §1.2 and the email module's provider
registry both already establish — an exporter declares `format`, `label`,
`mimeType`, `extension`, an `optionsSchema` (Zod), and a
`render(doc: ExportDocument, options, out: Writable): Promise<void>` that
**streams** its output rather than building it in memory (§8.4 explains why
this matters specifically for PDF). `TranscriptExporterRegistry.get(format)`
is the only thing `POST /:id/exports` ever calls; adding a future `docx`
exporter (the `docx` package, deferred out of this epic's scope per issue
#19's own scope list) is one new class registering itself, with **no**
change to the endpoint, the job handler, or the export dialog beyond it
picking up the new format from `GET /api/transcripts/exporters`.

`ExportDocument` is built once, from `materialize(transcriptId, version)`
(§4.4) — every exporter renders from the **same** provider-neutral document
shape (title, date, duration, language, version and author info, speakers
with computed talk-time percentages, segments optionally carrying words),
so the three renderers cannot disagree about what the transcript *says*,
only about how they *format* it.

### 8.2 `kvox.transcript/v1`: a public, versioned JSON schema

Published as
[`docs/specs/transcript-export.v1.schema.json`](transcript-export.v1.schema.json)
(JSON Schema, draft 2020-12) alongside this document, with an example
instance embedded in the schema file itself. `schema: "kvox.transcript/v1"`
is a literal, required field a consumer switches on — never an implicit
"whatever KVox happens to export today." **The contract is permanent once
published: a field is added, never removed or repurposed.** A breaking
change is `kvox.transcript/v2`, with its own `$id` and its own exporter
registration, coexisting with `v1` for as long as anything depends on the
old shape — the same "rows outlive the handler that produced them" posture
`docs/specs/job-queue.md` §1 takes for a job `type` string, applied here to
an export format string instead. This is *why* the schema is published as a
standalone, versioned artifact rather than left as "whatever the JSON
exporter currently emits, described in prose": automation and other AI
systems (the epic's own stated audience for this format) can validate
against it and pin to it without reading this application's source.

### 8.3 Markdown layout

YAML front matter (`title`, `date`, `duration`, `speakers`, `version`)
followed by one paragraph per segment: `**Speaker Name** · 00:01:23` then
the segment's text, optionally with consecutive same-speaker segments merged
into one paragraph (an export option) for a more prose-like read. Every
value interpolated into the Markdown — a speaker's `display_name`, a
segment's `text`, the transcript's `title` — is **escaped** for Markdown's
own special characters (`*_\`[]\` and friends), because a speaker name or a
line of speech is user- or AI-originated text, not markup, and an
unescaped `*` in someone's spoken words must not silently start emphasis
that swallows the rest of the paragraph, nor may a segment beginning with
`"# "` become a heading in the rendered document.

### 8.4 PDF via pdfkit, streamed, with bundled fonts

**pdfkit**, not a headless browser and not `pdfmake` — see §11 for the
comparison in full; the summary is that pdfkit **streams** its output
incrementally rather than building the whole document in memory the way
`pdfmake` does, which matters directly for a document that can run to
hundreds of pages for a 10-hour recording, and it needs no browser engine at
all, unlike a headless-Chromium HTML-to-PDF path.

Fonts (**Noto Sans**, **Noto Sans Mono**) are bundled under
`apps/api/assets/fonts` and `COPY`'d into the production Docker image,
rather than relying on whatever fonts happen to be installed on the
container's base image — a PDF exporter whose typography depends on the
host's installed fonts would render differently, or fail outright, on a
minimal Alpine base with none installed. Layout: a cover block (title, date,
duration, participants with computed talk time), speaker names rendered in
each speaker's own colour (mirroring the same colour a speaker gets in the
web viewer), a timestamp margin, a running header, and a footer reading
"Page x of y · Version n · Exported from KVox" via pdfkit's `bufferPages`
mode (buffering page metadata so the total page count is known before the
footer is drawn, without buffering the whole document's *content*).

**CJK and right-to-left scripts are a documented v1 limitation, not a
silent gap.** Noto Sans (Latin/Greek/Cyrillic) does not cover CJK glyphs,
and pdfkit performs no bidirectional-text reordering — an RTL segment would
render with its glyphs individually correct but in the wrong visual order.
Both are real, known gaps rather than accidents discovered later: a future
fix bundles the relevant Noto CJK/Arabic font families and adds a proper
bidi pass, and is out of this epic's scope exactly as the epic's own scope
list states ("Word (.docx) export," similarly deferred, is the same kind of
"the registry is ready, the specific renderer is not yet built" boundary).

### 8.5 Always a queue job; reuse by `options_hash`; 7-day expiry

`transcript.export` (§1.5.6) is the **only** path to an export — there is no
size threshold below which an export runs synchronously inside the request,
because a threshold is exactly the trap `docs/specs/job-queue.md`'s rule 1
warns against: two code paths for "the same operation, sometimes fast
enough to inline," where the inline path silently breaks the day a
short recording happens to have an unusually dense correction history or a
slow render, at the one moment nobody is watching for it.

`POST /:id/exports` hashes `{ format, version, options }` into
`options_hash` and checks `transcript_exports` for an existing,
**unexpired** row with the same `(transcriptId, version, format,
options_hash)` — the index issue #24 declares for exactly this lookup. A
match returns **200** with the existing export immediately, skipping a
redundant render entirely; no match enqueues the job and returns **202**
`{ exportId }`. This reuse check is deliberately **not** the queue's own
active-dedup mechanism (`docs/specs/job-queue.md` §4.1) — that index only
covers `pending`/`running` rows and exists to collapse concurrent requests
for identical *in-flight* work, whereas a reusable export is normally
already `ready` (terminal), which the active-dedup predicate does not even
see. The two mechanisms solve genuinely different problems and neither
substitutes for the other: the queue's dedup stops two people exporting the
same thing at the same instant from running the render twice; this
content-addressed lookup stops the *same* person re-downloading an export
that already exists from rendering it a second time an hour later.

Exports expire after **7 days**; `transcripts.housekeeping` (§1.5.8) deletes
the file and the row past `expires_at` on its ten-minute sweep — a bounded
retention window for what is, after all, a byte-for-byte reproducible
artifact of a specific version and a specific set of options: nothing is
lost by expiring it, because requesting the identical export again produces
the identical file.

## 9. Large uploads and CSP

### 9.1 Why storage needs hardening at all

`ObjectsService`'s resumable multipart path (`apps/api/src/storage/objects
/objects.service.ts`) exists today, but not for multi-gigabyte, multi-hour
phone recordings: `initUpload` presigns only parts 1–10 with no endpoint to
presign more (capping a file at 100 MB at the default part size),
`getUploadStatus` reports upload progress from a chunks table that is only
ever written at *completion* (so status shows zero progress the entire time
an upload is actually happening), and `part_size` is recomputed from
whatever the *current* configuration says rather than saved at `init` —
three independent defects that together make "pause a large upload overnight
and resume it tomorrow" simply not work. Issue #21 is the fix, and this
section is what §22 and #25 build against.

### 9.2 The part-presign endpoint and `ListParts`-based resume

`StorageProvider.listParts(key, uploadId)` (new interface method,
implemented against S3's own `ListParts`, paginated) becomes the **single
source of truth** for what has actually been uploaded — never the
client-reported chunk rows the current design writes too late to be useful.
`POST /api/storage/objects/:id/upload/parts` (body `{ partNumbers: number[]
}`, capped at 100 per call) presigns exactly the parts asked for, checks
ownership and that the upload is still active, and — this is what makes
staleness (§9.4) work at all — **refreshes the object's activity
timestamp** on every call, because presigning more parts is itself evidence
the upload is still alive even though no bytes have moved through this
endpoint yet. `GET :id/upload/status` is rebuilt to report from `listParts`
directly (part numbers, sizes, `uploadedBytes`), so a reloaded page or a
reconnected client asks S3 itself "what do you actually have," rather than
trusting a table this application populated too late in the previous
design. `POST :id/upload/complete` makes its `parts` body **optional** —
when omitted, the server builds the completion list from `listParts` itself,
so the browser never has to read an `ETag` response header off a cross-origin
`PUT`, which is the next section's own reason for existing.

**Rejected: making the browser read and report ETags.** It works, and it
requires the S3 CORS configuration to expose the `ETag` header
(`Access-Control-Expose-Headers`), which breaks on any S3-compatible store
whose CORS implementation is stricter about exposed headers than AWS's own —
a real portability cost for a template that must run against MinIO and other
providers, not only AWS. Server-side `ListParts` needs no such exposure and
is authoritative regardless of what the client remembers.

### 9.3 `managed_by`, and why transcript files are not generic storage objects

A migration adds `part_size int null` (saved once, at `init`, and used for
every later calculation rather than recomputed) and `managed_by text null`
to `storage_objects`. An object with `managed_by` set (e.g. `'transcripts'`)
is **excluded** from `GET /api/storage/objects`'s generic listing, and a
`DELETE` against it through the generic endpoint returns **409** — only the
owning module (here, `transcript.purge`, §1.5.7) may remove it. This is the
same ownership boundary §3.1 gives `transcripts.source_object_id`'s
`Restrict` foreign key, stated from the storage side instead of the
transcript side: a file a feature depends on must be invisible and
untouchable to a generic operation that has no idea what depends on it.

`DELETE /api/storage/objects/:id/upload/abort` respects the same boundary
(issue #322): for a managed object it cannot delete the row — the same FK
that blocks the generic `DELETE` blocks this too — so it aborts the
multipart upload, marks the object `failed`, and emits
`storage.object.upload_aborted` instead. The module named by `managed_by`
listens and reconciles its own record; for a transcript,
`TranscriptsUploadAbortedListener` soft-deletes it (`deleting`) and queues
`transcript.purge`, the one path allowed to free the object. **400** if the
managed upload already completed (`processing`/`ready`) — that is never
silently downgraded to `failed`. Unmanaged objects are unaffected: their
abort still deletes the row as before.

### 9.4 Adaptive part size, limits, and activity-based stale cleanup

Part size at `init` is `max(STORAGE_PART_SIZE, ceil(size / 10000))`, rounded
up to a whole MiB — S3 enforces a hard ceiling of 10,000 parts per upload, so
a fixed part size would silently cap the maximum file size at
`10,000 × STORAGE_PART_SIZE` regardless of what a provider's own
`maxInputBytes` allows; scaling the part size to the file keeps `totalParts`
under that ceiling for any file up to the provider's real limit (5 GB for
AssemblyAI). `storage.maxFileSize` and `storage.allowedMimeTypes` — both
already present in `configuration.ts` and, until this issue, never actually
enforced at `init` — become real 400-on-violation checks, and the default
allowed-MIME list gains `audio/*`, plus a deliberate allowance for
`application/octet-stream` **when the file extension is a known audio
extension** — a concession to how inconsistently mobile browsers report
MIME types for less common formats like `.m4a` and `.amr`, which several
mobile OSes report generically or not at all.

`storage.allowedMimeTypes` is `ObjectsService.initUpload`'s **default**, read
when no caller supplies its own list — which, at the time this issue landed,
every caller including the transcript endpoint did. §9.6 records why that
stopped being true, and is not merely a restatement of this default gaining
`audio/*`.

**Stale-upload cleanup is measured from `updatedAt`, which the part-presign
and status endpoints now both touch, not from `createdAt`.** The existing
cleanup deletes `pending`/`uploading` objects 24 hours after creation — fine
for a small file uploaded in one burst, and actively destructive for a
multi-gigabyte phone recording somebody deliberately paused overnight and
intends to resume tomorrow. `STORAGE_STALE_UPLOAD_HOURS` (default **72**)
measured against **activity**, not **age**, is what makes "pause, close the
app, resume the next day" survive at all: the timestamp only goes stale when
nothing — no presign call, no status check, no part upload — has touched
the row in three days, which is a real absence of interest rather than
merely the passage of time.

This sweep now selects **unmanaged** rows only (`managed_by: null`, issue
#322): deleting a managed row here would violate the owning module's
`Restrict` foreign key (`transcripts.source_object_id`, for one), the exact
mistake the earlier design made. A managed object's own abandoned-upload
reconciliation belongs to the module named by `managed_by` — for transcripts,
that is `transcripts.housekeeping` §1.5.8's own activity-based check against
`transcription.abandonedUploadHours`, deliberately a *separate* setting from
`STORAGE_STALE_UPLOAD_HOURS` rather than a reuse of it, since the two now
govern disjoint sets of rows.

### 9.5 CSP and S3 CORS

`infra/nginx/csp.conf` and `csp.dev.conf` currently set `connect-src 'self'`
with no `media-src` directive at all, which blocks both of the two things
this epic needs the browser to do directly against S3: **PUT** a part
straight to a presigned URL (`connect-src`) and **play** an `<audio>` element
whose `src` is a signed S3 GET URL (`media-src`). Both directives gain the
storage origin — derived from configuration (`S3_ENDPOINT`, or the bucket's
regional endpoint when no custom endpoint is set), **never a wildcard**.
This is a narrower allowance than the existing `img-src https:` (broadened
for Google avatar URLs and a configurable S3 endpoint together, because an
avatar's exact host is not something this application controls) — a fetch
or an `<audio>` source is a far more consequential capability than an
`<img>` tag, and the origin here is one this deployment's own configuration
names exactly, so there is no reason to accept anything broader than that
one host.

S3 CORS (documented in a new runbook, `docs/runbooks/s3-cors.md`) must allow
`PUT`, `GET` and `HEAD` from the app's own origin, and — this is the one
easy to miss — must explicitly **allow the `Range` request header**. `Range`
is not a CORS-safelisted header, so a browser's `<audio>` element issuing a
ranged GET against a signed S3 URL triggers a CORS preflight the bucket must
be configured to answer, or the browser's Range request is refused by CORS
before S3 ever sees it — the seekable playback §7.1 depends on failing
silently as "seeking does nothing" with no error obviously pointing at a
CORS configuration file.

### 9.6 Content-type allowlist: `TRANSCRIPT_SOURCE_MIME_TYPES`, not `storage.allowedMimeTypes` (issue #79)

§9.4 gave `initUpload`'s **default** `allowedMimeTypes` an `audio/*` entry —
correct for new deployments, but silent for an existing one: `.env` is never
migrated, so a deployment whose `ALLOWED_MIME_TYPES` predates issue #21 kept
whatever it already had (commonly `image/*,application/pdf,video/*`, the
pre-#21 default with no audio at all), and `POST /api/transcripts` inherited
that operator setting unchanged. The result was every Android `.m4a`
recording rejected with `Files of type "audio/x-m4a" are not accepted.
Allowed types: image/*, application/pdf, video/*` — for a type AssemblyAI's
own `ACCEPTED_MIME_TYPES` already contains, on a feature (`transcripts:*`)
seeded to every role specifically because recording is meant to work for a
brand-new account.

The bug is not really about the default; it is about *whose policy the check
was reading*. `storage.allowedMimeTypes` is an operator's answer to "what may
an authenticated user upload as an arbitrary file," enforced at
`POST /api/storage/objects*`. `POST /api/transcripts` is not that surface — it
accepts exactly one purpose-built kind of input (a recording, or something
close enough that the pipeline can turn it into one), and that acceptance
criterion is a property of *this feature*, not of the operator's general
upload policy. Letting one setting answer both questions means an operator
narrowing what arbitrary uploads they trust (a reasonable, unrelated
decision) can silently break every recording in the app, with no error
anywhere that names transcription as the affected system.

The fix gives `ObjectsService.initUpload` a service-level-only `options`
argument — `{ managedBy?, allowedMimeTypes? }` — absent from `InitUploadDto`
and therefore unreachable over HTTP, the same boundary `managedBy` already
established for exactly the same reason: a client able to name its own
allowlist has defeated the allowlist. `TranscriptsService.create` passes its
own module-level constant, `TRANSCRIPT_SOURCE_MIME_TYPES = ['audio/*',
'video/*']`, which **replaces** `storage.allowedMimeTypes` for this call
rather than extending it — a narrow module list must not be widened by
whatever a deployment permits generally, and the `??` in `initUpload` sits on
`options.allowedMimeTypes`, not on a merge of the two, for exactly that
reason. The 400 this endpoint raises on rejection names whichever list it
actually enforced, never the configured operator default unconditionally —
without that, a caller uploading a recording and told to pick one of
`image/*, application/pdf` has been pointed at a setting they have no access
to and that had no say in the rejection.

**Why the whole `audio/*`/`video/*` families, and not AssemblyAI's own
`acceptedMimeTypes` directly.** Narrowing the check to exactly what the
active provider accepts would reject files this pipeline transcribes
perfectly well: `media.audio.transcode` (§1.5.1) exists precisely to turn a
file the provider will not take directly into a rendition it will, and
`selectTranscriptionInput` (§2.4) is what decides between the original and
the rendition — a decision this endpoint cannot make yet, because at
`POST /api/transcripts` time the rendition does not exist. So the check here
answers a narrower question than "will the provider take this file": it
answers "is this audio or video at all." Video is included for the same
reason a phone's `.mov` of a meeting counts as a recording — the pipeline
extracts audio from it, and the person who pressed record does not think of
that as a format decision.

`initUpload` still applies its extension-aware `application/octet-stream`
fallback (§9.4) on top of whichever list it is given — that concession to
inconsistent mobile MIME reporting is orthogonal to *which* list is in force,
and unchanged by this issue.

**What did not change.** `POST /api/storage/objects*` is untouched and still
governed by `storage.allowedMimeTypes`/`ALLOWED_MIME_TYPES` exactly as before
— this issue narrows what one endpoint reads, not what the setting means. A
deployment whose `.env` predates issue #21 still has no `audio/*` in its
generic upload allowlist and should add one if it wants audio accepted
through the *generic* storage surface; that gap no longer affects
transcription, which is the point. See
[`docs/deployment/vps.md` §9](../deployment/vps.md#9-troubleshooting) for the
operator-facing version of this note.

## 10. Privacy

**Remote delete after ingest is on by default**
(`transcriptionSettings.deleteRemoteAfterIngest: true`). Once
`transcription.ingest` has copied the provider's result into this
application's own tables and stored the raw JSON for provenance (§1.5.2–4),
there is no remaining reason for the provider to keep its own copy of either
the audio or the transcript, and every additional day a third party holds a
copy of a private conversation is pure downside for a product whose stated
thesis is user control over their own data. `provider.deleteRemote` is
called, `remote_deleted_at` is recorded, and — because `deleteRemote` is a
**required** method on every provider (§2.1), including a no-op
implementation for a provider whose `capabilities.remoteDelete` is false —
`transcription.ingest` never has to branch on capability before calling it.

**The user is told which provider their audio goes to.** `GET
/api/transcription/config` (§6.4) exposes `providerLabel`, and the
New-transcript flow (issue #30) shows a privacy notice naming it before
upload — "Audio is sent to AssemblyAI for transcription" — the same
transparency posture `docs/specs/browser-notifications.md` already applies
to what a non-admin can learn about a system capability without needing an
admin permission to ask.

**Deleting a transcript purges everything.** `transcript.purge` (§1.5.7)
removes every managed storage object the transcript ever owned — the
original upload, the playback rendition, the gzipped raw provider result,
every snapshot, every export file — calls `deleteRemote` if the audio was
not already remote-deleted, and only then deletes the SQL rows. Nothing
about a deleted transcript survives anywhere this application controls,
which is the concrete backstop behind "the user controls the truth": control
includes the ability to make it disappear, completely, not merely to hide it
from a list view.

**There is no admin read-any**, restated here from §6.2 because privacy is
this section's whole subject: an administrator configuring which
transcription provider this deployment uses (§6.4) has no path, through any
permission this application grants, to read the content of a transcript
they do not own or hold a share on. Configuring the pipe is not the same
authority as reading what flows through it.

## Notifying somebody about a transcript

Three events, added to `NOTIFICATION_EVENTS`
(`apps/api/src/notifications/notification-events.ts`) following the exact
three-step recipe CLAUDE.md's "Adding a Notification" section already
documents — a registry entry, template(s), and a `notify()` call after the
triggering write commits, outside any transaction:

- **`transcripts.transcript_ready`** — raised by `transcription.ingest`
  after its transaction commits, to the owner.
- **`transcripts.transcript_failed`** — raised by whichever stage set
  `status: failed` (§1.6), carrying the failure reason and a link that opens
  straight to the retry action, to the owner.
- **`transcripts.transcript_shared`** — raised by `POST /:id/shares` (issue
  #29), to the **recipient only**, naming the owner, the transcript's title
  and the granted role. Default-enabled, **not** `mandatory: true` — unlike
  `security.role_changed`, being told about a share is a courtesy a
  recipient can reasonably choose to mute, not a security-relevant change to
  their own privileges. Three things it deliberately does **not** do:
  - It is **not raised for a no-op re-share** (the same address at the same
    role, from an owner clicking twice or a retried request): mailing
    somebody again about access they already have is how a useful
    notification becomes one people mute.
  - It is **not raised for a demotion**. "*Owner* shared *Title* with you
    (Viewer)" is simply the wrong message for "you can no longer correct
    this", and there is no second event for it. A demotion is silent and
    takes effect on the next request, exactly as a revocation does.
  - There is **no `transcript_unshared` counterpart at all**. "Your access
    was removed" is a message whose main effect is to tell somebody they were
    discussed; an owner is entitled to un-share a private conversation
    without composing an explanation.

  The email template carries the **role**, not just a link — "someone shared
  a recording with you" leaves the reader to click through to discover
  whether they can fix the misheard name they are about to find. It carries
  the title in the body and **deliberately not in the subject line**, which
  is the one part of an email that renders on a lock screen and in a
  notification preview: the title of somebody else's private conversation has
  no business appearing there before the recipient has opened the message.
  The browser template does carry it, because a toast is only shown to
  somebody already inside the application.

None of the three is a job-queue operational event in the sense
`docs/specs/job-queue.md`'s own "Notifying somebody a job gave up" section
describes (`jobs.job_failed`, addressed to a **permission**) — all three
here are addressed to a specific **user** (the owner, or the share
recipient), because a transcript's lifecycle is personal to the people who
can see it, not an operational fact about the queue that anyone holding
`jobs:read` should learn about.

## Rejected alternatives

- **Webhooks instead of polling.** Rejected for v1: a self-hosted or
  development KVox instance may not be reachable from the provider's
  infrastructure at all, there is no raw-body/signature-verification
  infrastructure anywhere in this codebase today, and `MaintenanceGuard`
  would block an inbound callback during a maintenance window with no way
  for the provider to know to retry later. Polling needs nothing reachable
  from the outside and degrades gracefully under maintenance (§1.5.3's
  hard deadline still applies; a callback that arrived during a blocked
  window would simply be lost). A webhook could be added later as a
  **hint** that enqueues an immediate poll rather than the source of truth
  itself — status is always confirmed by asking the provider, never merely
  asserted by an inbound request.
- **One job that polls in a loop until the provider finishes.** Rejected: it
  holds a worker slot for the recording's entire transcription time, which
  for a 10-hour meeting can itself be hours, and it fights the lease/timeout
  machinery the moment `process()` legitimately runs longer than whatever
  `maxRuntimeMs` was declared — the identical shape of problem
  `docs/specs/database-backup.md`'s "Why this *is* a queue job" section
  documents for the backup before epic #345 fixed the queue underneath it.
  A **chain** of short `transcription.poll` runs, each holding a slot for
  milliseconds, is both cheaper and directly observable in the admin job
  list as a sequence of rows rather than one long-lived opaque one.
- **A full JSONB snapshot per save.** Rejected on issue #24's own arithmetic:
  roughly 7 MB per save for a 10-hour, 90,000-word recording, which would
  grow the `transcripts` (or a per-version) table into the gigabytes for any
  transcript edited routinely — the identical shape of problem
  `docs/specs/job-queue.md` §7.6 solves for job history with a rollup
  instead of a second full copy, applied here to correction history with a
  normalized current state plus occasional snapshots instead.
- **An operation log with no current-state tables at all.** Rejected: every
  read — the segment list a viewer opens, the words a playback engine needs
  for a time window — would have to replay the **entire** history from
  scratch, and the replay logic becomes load-bearing for ordinary reads
  rather than only for the version browser; a schema change to a reducer's
  output shape would then also require re-deriving every historical replay
  path rather than only affecting the current live tables.
- **The whole transcript as one JSONB document.** Rejected: no row-level
  concurrency at all — two editors correcting two different segments would
  serialize on one document-sized write, and each edit rewrites the whole
  multi-megabyte blob regardless of how small the actual change was.
- **CRDTs or operational-transform real-time collaboration** (§5). Rejected
  for the workload this epic targets: per-entity optimistic concurrency
  already handles the realistic case (one or two editors, occasional
  corrections) without the much larger implementation a CRDT's stronger
  convergence guarantees would require for a concurrency pattern nobody is
  asking for yet.
- **Headless Chromium rendering HTML to PDF.** Rejected: 300 MB or more
  added to the API's Alpine-based image, meaningful memory per concurrent
  render, and a browser sandbox to manage inside a container that has no
  other reason to run one.
- **`pdfmake` instead of `pdfkit`.** Rejected: `pdfmake` builds the entire
  document in memory before it can be written anywhere, which does not scale
  to a several-hundred-page export of a 10-hour transcript the way
  `pdfkit`'s incremental stream does, for equivalent layout control.
- **Exporting synchronously below some size threshold.** Rejected: two code
  paths for the same operation is itself the trap — the inline path works
  until the day a short recording's correction history or a slow render
  happens to be unusually large, and the failure appears at the one moment
  nobody expected it, which is precisely the reasoning rule 1 exists to
  forbid rather than merely discourage.
- **Rendering exports in the browser.** Rejected: rendering a multi-hour
  transcript to PDF in client-side JavaScript is slow specifically on the
  phones this product is mobile-first for, and the `kvox.transcript/v1`
  contract (§8.2) needs to be enforced in one place, server-side, rather than
  trusted to whatever a browser's JavaScript happened to produce.
- **HLS or DASH segmented streaming for playback.** Rejected for v1: a
  faststart MP4 plus HTTP Range already covers seeking for recordings up to
  the provider's 10-hour ceiling; segmented streaming solves a problem
  (adaptive bitrate over a poor connection, extremely long-form content)
  this epic does not yet have. Worth revisiting if recordings routinely
  exceed what one MP4 comfortably serves.
- **Proxying audio playback through the API.** Rejected: it puts the API
  server in the data path for every second of every user's playback,
  exactly what the presigned-URL design throughout this document (§2.5,
  §7.1, §9) exists to keep the API out of — the same "bytes never pass
  through the API" posture `docs/specs/worker-nodes.md` §15 already states
  for the node data plane.
- **An `ObjectProcessor` that transcodes or transcribes inline on upload.**
  Rejected: `ObjectProcessor`s run synchronously as part of the upload
  pipeline and cannot be offloaded to a worker node — both directly violate
  rule 1 (work that outlives the triggering event, running inline) and rule
  2 (work that could be node-eligible, made structurally unable to be).
- **Admin read-any for transcripts.** Rejected for privacy, restated from
  §6.2 and §10: this feature's own success criteria state the exclusion
  explicitly, and no permission for it exists anywhere in this design.
- **tus, Uppy, or another third-party resumable-upload protocol.**
  Rejected: this repository already has a home-grown presigned-multipart
  resumable upload mechanism, extended by #21 (§9) to actually support
  multi-gigabyte files with real resume. Adopting a third-party protocol
  would mean either running a dedicated tus server with its own storage
  adapter or pulling in a client library that duplicates machinery
  `ObjectsService` already provides, and it would diverge from the
  presigned-URL architecture every other upload/download path in this
  application (including the worker-node data plane) already shares.
- **Persisting the selected `File`'s bytes into IndexedDB to survive a
  reload.** Rejected: duplicating a multi-gigabyte file into browser-managed
  storage is expensive, is likely to exceed a browser's storage quota for
  exactly the largest files this epic cares about, and buys nothing that
  server-side `ListParts` (§9.2) does not already provide — resuming an
  upload after a reload works by asking the server what has already
  arrived and re-selecting (or re-picking) the same file, verified by
  matching size, not by keeping a private copy of the file in the browser.
- **wavesurfer.js for a visual waveform.** Deferred: it decodes the entire
  audio file client-side to draw its waveform, which is not viable for
  multi-hour audio on a phone's memory budget. Server-generated peak data
  could be added later without this epic's playback design changing.
- **`react-window` for the segment list.** Rejected in favour of
  `@tanstack/react-virtual`: `react-window`'s fixed-row-height model does
  not fit segments whose rendered height varies with text length and word
  count, which is every segment in a real transcript.
- **A playlist of per-segment audio clips**, sliced server-side, instead of
  interval-skipping over one continuous stream. Rejected: it needs
  server-side audio slicing (more processing, more storage — one clip per
  segment, per transcript) for no benefit over seeking within one file the
  interval-skip approach (§7.2) already delivers with none of that cost.
- **Fixing issue #79 by changing the default `storage.allowedMimeTypes` in
  `configuration.ts`, or documenting that operators must add `audio/*` to
  their `.env`.** Rejected: the default already included `audio/*` (§9.4,
  since issue #21) — the bug was never the default, it was that an
  *existing* deployment's `.env` is never migrated, so any operator setting
  written before #21 shipped kept governing a pipeline it was never written
  for. Telling operators to edit their `.env` would have "fixed" only
  deployments created after the advice was read, left every existing
  deployment broken until someone found the note, and done nothing about the
  actual defect: one operator policy silently deciding two unrelated
  questions. §9.6 replaces the endpoint's dependency on that setting instead.

## Verification

What this document's decisions imply for testing, before any of it is
implemented — the tests named below are the ones the acceptance criteria in
issues #21, #23–#30 commit to writing, given here so a later reviewer can
check the built code against the same list this spec was designed against.

| Claim | Will be covered by |
|---|---|
| Every job type in §1.5's table declares the profile and node-eligibility this document states | Unit assertions over each handler's `profile`/`nodeResultSchema`/`persistNodeResult`, mirroring `job-handler.registry.spec.ts`'s own pattern |
| `transcripts-housekeeping.task.ts`'s `@Cron` only enqueues | `apps/api/test/jobs/cron-enqueue-only.spec.ts` — the existing, already-passing test this document's job additions must not break |
| `transcription.poll`'s backoff schedule and hard deadline | `apps/api/src/transcripts/handlers/transcription-poll.handler.spec.ts`, against an injected clock (the same `JOB_CLOCK` seam `docs/specs/job-queue.md` §5.9 already establishes) |
| The poll re-enqueue is `skipDedup: true` and does not collapse into the running job | A handler unit test asserting the `enqueue()` call's options directly, plus an integration test driving two real `PrismaClient` connections the way `docs/specs/job-queue.md` §4.8 drives its own claim-concurrency proofs |
| Domain failures (`ProviderAuthError`, `ProviderInputError`, provider `error` status) mark the transcript `failed` while the job itself succeeds | `transcription-submit.handler.spec.ts` / `-poll` / `-ingest`, each against a fake `TranscriptionProvider` |
| A 429 throws `RateLimitError` and shares one throttle key across all three provider-calling handlers | A test asserting `registerProviderKey` is called with the identical key string from all three handlers |
| AssemblyAI error mapping: 401 → auth, 429 (with and without `Retry-After`) → rate limit, provider `error` → input error, 5xx → retryable | `assemblyai.provider.spec.ts`, against a fake injected `fetch` |
| Word alignment: LCS-based interpolation, split/join word partitioning, and the three `words_alignment` states | Table-driven reducer tests in `apps/api/src/transcripts/editing/word-alignment.spec.ts`, including the exact test vectors in §4.1 |
| `materialize(currentVersion)` always equals live DB state | A property test generating random op sequences, per issue #27's own acceptance criterion |
| Find & replace expands to concrete ops before recording, with Unicode-aware whole-word boundaries | `find-replace.spec.ts`, including a non-ASCII test vector (`"José"` not matching a whole-word search for `"os"`) |
| A `rev` conflict returns 409 with every conflicting entity named; a repeated `clientBatchId` does not duplicate a version | `apps/api/test/transcripts/operations-concurrency.e2e.spec.ts`, driving two concurrent batches against the real database |
| No access is 404, never 403, across every access level and every endpoint | An RBAC matrix e2e (owner, editor, viewer, stranger) across read, play, export, edit, restore, share, delete and leave, per issue #29's own acceptance criterion |
| `transcripts:read`/`write` are seeded for Admin, Contributor and Viewer; no `transcripts:read_any` exists anywhere | `apps/api/test/prisma/seed-data.spec.ts`, extended |
| The admin transcription settings endpoints are gated on `system_settings:*`, not a new permission | An RBAC e2e asserting a Viewer gets 403 and an Admin gets 200 on `/api/transcription-settings/*` |
| The stored API key never appears in a response body, a log line, or an audit `meta` | A dedicated assertion sweeping every response and captured log line in the settings test suite, following the same technique `email-settings.service.spec.ts` already uses for the SMTP password |
| JSON export validates against the published `kvox.transcript/v1` schema | A schema-validation test loading `docs/specs/transcript-export.v1.schema.json` directly and validating rendered fixtures against it |
| Markdown escaping and PDF smoke tests, including a non-ASCII speaker name | `markdown-exporter.spec.ts` and a PDF parse-back smoke test, per issue #28's own acceptance criteria |
| An identical export request reuses the existing row by `options_hash`; an expired one is cleaned up by housekeeping | `export.service.spec.ts` plus `transcripts-housekeeping.task.spec.ts` |
| A 5 GB simulated upload gets presigned URLs past part 10, resumes correctly after a simulated reload, and stale cleanup never removes an upload active within `STORAGE_STALE_UPLOAD_HOURS` | Per issue #21's own acceptance criteria, against a mocked S3 provider |
| The CSP changes permit a real part `PUT` and `<audio src=signed-url>` in the dev stack, and nothing broader than the configured storage origin | A dev-stack integration check, plus a static assertion that `csp.conf`/`csp.dev.conf` name the storage origin explicitly rather than a wildcard |
| `usePlaybackEngine`'s per-speaker interval logic: gap merging, snapping into the next interval, and the documented backgrounded-tab overshoot | `apps/web/src/__tests__/hooks/usePlaybackEngine.spec.ts`, against a fake `HTMLMediaElement`, per issue #30's own acceptance criteria |
