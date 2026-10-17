/**
 * The notes API, as the web app sees it — issue #57, epic #45.
 *
 * The backend half is `packages/kvox-api/src/notes/notes.controller.ts`,
 * `note-sources.controller.ts` and `dto/note.dto.ts`; every type below is a
 * hand-written mirror of a Zod schema in those files, named identically so the
 * two can be diffed by eye. Shaped after `services/transcripts.ts`:
 * `services/api.ts` stays the transport (the bearer token, the one-shot
 * 401 → refresh → retry, the maintenance recogniser) and this file holds the
 * calls next to the types they produce.
 *
 * =============================================================================
 * ⚠ A 409 IS NOT AN ERROR MESSAGE, IT IS A BRANCH
 * =============================================================================
 *
 * `POST /api/notes` refuses with **409** in two importantly different ways, and
 * the difference is carried in `details.reason` rather than in the status or
 * the message:
 *
 *   `ai_key_missing`    YOU have saved no API key. Nothing is wrong with the
 *                       deployment; a note is generated on the caller's own
 *                       provider account. The answer is `AiKeyRequired` (#55),
 *                       never a red alert.
 *   `ai_not_configured` The DEPLOYMENT has not enabled AI at all. The user can
 *                       do nothing about it and must be told so.
 *
 * The reason lives under `details` and NOT at the top-level `code` because the
 * API's global exception filter derives `code` from the status and ignores any
 * a handler supplies — that is a published contract, so endpoint-specific
 * machine-readable data belongs exactly where the filter says it belongs.
 * {@link noteConflictReason} is the one place this client reads it, so no page
 * spells `(err.details as …)?.reason` for itself.
 *
 * =============================================================================
 * WHY DOCUMENT EXTRACTION IS READ THROUGH THE NOTES SLICE
 * =============================================================================
 *
 * `POST /api/notes/sources/documents` answers
 * `{ objectId, jobId, status: 'extracting' }` and queues `note.source.extract`.
 * There is deliberately no sixth table: the extracted text is a SECOND storage
 * object, and the link plus the outcome are still keys in the FIRST object's
 * own `metadata` (`packages/kvox-api/src/notes/source-metadata.ts` is the one
 * definition both the writer and the reader import).
 *
 * What changed in #596 is WHO READS IT. The notes slice owns the read:
 * {@link getNoteDocumentExtraction} polls
 * `GET /api/notes/sources/documents/:objectId`, which is `notes:read`-gated and
 * owner-scoped (404 for anyone else's document), and the API interprets the
 * metadata block itself. This client no longer reads storage at all, so a host
 * that embeds the notes slice needs no `GET /api/storage/objects/:id` route and
 * no `storage:read` grant to wait on an extraction.
 *
 * The client stays TOTAL OVER GARBAGE anyway: the answer crosses a version
 * boundary (an older or newer API, a host's own implementation of the route),
 * and every shape this client cannot understand means the same thing — "not
 * extracted yet".
 */

import type {
  NoteConflictReason as ContractNoteConflictReason,
  NoteTitleSource as ContractNoteTitleSource,
} from '@marinoscar/kvox-contract/notes';

import {
  KvoxApiError,
  kvoxGet,
  kvoxPatch,
  kvoxPost,
  kvoxPostFormData,
} from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';
import type { PlaybackStatus, TranscriptStatus } from '../../../transcripts/headless/index.js';
import type { NoteBodyFormat } from './noteTemplates.js';

// =============================================================================
// The shapes (mirrors of `dto/note.dto.ts`)
// =============================================================================

/**
 * `notes.status` — the coarse, list-visible lifecycle (spec §1.1).
 *
 * @stability experimental
 */
export type NoteStatus = 'draft' | 'generating' | 'ready' | 'failed' | 'deleting';

/**
 * What a note was generated FROM. The API's three-member discriminated union.
 *
 * @stability experimental
 */
export type NoteSourceType = 'transcript' | 'note' | 'document';

/**
 * The machine-readable `details.reason` values a note 409 carries.
 *
 * Mirrors `NOTE_CONFLICT_REASONS` in `dto/note.dto.ts`. Only the ones this
 * client branches on are named as constants; the type is the full published
 * set, so a `switch` over it stays exhaustive as the API grows.
 *
 * @stability experimental
 */
export type NoteConflictReason = ContractNoteConflictReason;

/**
 * Where a note's title came from — mirrors `noteTitleSourceSchema` (#197).
 *
 * ⚠ `user` IS STICKY. A person typed it, on create or in a later rename, and no
 * titling pass overwrites it: the guard lives in the API's own `WHERE` clause,
 * not in a client check. `ai` — a titling pass read it off the generated
 * content; `template` — nobody named it, so it inherited the template's name.
 *
 * @stability experimental
 */
export type NoteTitleSource = ContractNoteTitleSource;

/** One note, as `GET /api/notes/{id}` returns it. */
/**
 * The transcript a note was ultimately generated from — issue #309.
 *
 * Mirrors `originTranscript` in `packages/kvox-api/src/notes/dto/note.dto.ts`. DETAIL
 * ONLY: the single-note responses carry it, list and summary rows do not.
 * `via: 'note_chain'` means the note was generated from a note that
 * (eventually) was generated from this transcript; `hops` counts the notes in
 * between (0 for `direct`).
  *
  * @stability experimental
 */
export interface NoteOriginTranscript {
  /** The transcript's id. */
  id: string;
  /** The transcript's title. */
  title: string;
  /** The recording's length in milliseconds, or `null`. */
  durationMs: number | null;
  /** The transcript's lifecycle status. */
  status: TranscriptStatus;
  /** Whether the transcript has playable audio. */
  playbackStatus: PlaybackStatus;
  /** `direct` when the note came from the transcript, `note_chain` when it came from a note that did. */
  via: 'direct' | 'note_chain';
  /** How many notes sit between this one and the transcript (`0` for `direct`). */
  hops: number;
}

/**
 * One note, as `GET /api/notes/{id}` returns it.
 *
 * @stability experimental
 */
export interface Note {
  /** The note's id. */
  id: string;
  /** The note's title. */
  title: string;
  /** Provenance of {@link Note.title}. See {@link NoteTitleSource}. */
  titleSource: NoteTitleSource;
  /** The live markdown body — by invariant, the version at `currentVersion`. */
  body: string;
  /** Where the note is in its lifecycle. */
  status: NoteStatus;
  /** 0 until the first generation commits. */
  currentVersion: number;
  /** The AI provider the text was generated on, or `null`. */
  provider: string | null;
  /** The model that generated the note, or `null`. */
  model: string | null;
  /** What the note was generated from. */
  sourceType: NoteSourceType;
  /** The source transcript, when the source is a transcript. */
  sourceTranscriptId: string | null;
  /** The source note, when the source is a note. */
  sourceNoteId: string | null;
  /** The source document (a storage object), when the source is a document. */
  sourceObjectId: string | null;
  /** The template the note was generated from, or `null`. */
  templateId: string | null;
  /** The name of the template used, as it was when the note was generated. */
  templateName: string | null;
  /**
   * Issue #334 — the shape of {@link Note.body}, snapshotted from the template
   * at generation time and read-only here. Absent (a server predating the
   * field) means `markdown`; read it through `effectiveBodyFormat`.
   */
  bodyFormat?: NoteBodyFormat;
  /**
   * The SOURCE's name — issue #192, denormalised onto every row and the detail.
   *
   * ⚠ `null` MEANS "NO NAME AVAILABLE", NEVER "NO SOURCE". A deleted source and
   * one this caller may no longer read answer identically, and both render the
   * category noun. It replaced a per-source client lookup; do not reintroduce
   * one for a `null`.
   */
  sourceName: string | null;
  /** The extra context the author gave the generation, or `null`. */
  contextText: string | null;
  /** The generation to watch. Never cleared once set. */
  currentGenerationId: string | null;
  /** Why the generation failed, or `null`. */
  failureReason: string | null;
  /** When it was created, as an ISO timestamp. */
  createdAt: string;
  /** When it last changed, as an ISO timestamp. */
  updatedAt: string;
  /**
   * The transcript this note ultimately came from (#309), or `null` when there
   * is none the caller can read. Optional because only the detail responses
   * carry it — list and summary rows never do.
   */
  originTranscript?: NoteOriginTranscript | null;
}

/**
 * One row of `GET /api/notes`.
 *
 * The API omits `body` and `contextText` and adds an `excerpt` — a list renders
 * a snippet, and shipping a page or two of prose per row to draw three lines of
 * it is the kind of thing that is invisible until somebody has four hundred
 * notes.
  *
  * @stability experimental
 */
// TODO(web-domain): align with @marinoscar/kvox-contract
export type NoteListItem = Omit<Note, 'body' | 'contextText'> & {
  /** A snippet of the body for list rows. */
  excerpt: string;
};

/**
 * `GET /api/notes`.
 *
 * @stability experimental
 */
export interface NoteListResponse {
  /** The notes of this page, newest first. */
  items: NoteListItem[];
  /**
   * How many rows match the current filters, ignoring paging.
   *
   * THE FILTERS, NOT THE TABLE, and not "how many are left". Identical on page
   * one and on every `loadMore` for an unchanged filter set, so the result
   * count line can be rendered once and does not fall as the user pages.
   */
  total: number;

  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

/**
 * `GET /api/notes/summary` — the home page's one request.
 *
 * @stability experimental
 */
export interface NoteSummary {
  /** Notes still being written. */
  inProgress: NoteListItem[];
  /** The most recently updated notes. */
  recent: NoteListItem[];
  /** Notes whose generation failed. */
  failed: NoteListItem[];
  /** How many notes there are in each state. */
  counts: {
    /** All notes. */
    total: number;
    /** Notes whose generation succeeded. */
    ready: number;
    /** Notes still being written. */
    inProgress: number;
    /** Notes whose generation failed. */
    failed: number;
  };
}

/**
 * What to generate from.
 *
 * A DISCRIMINATED UNION, mirroring the API's `previewSourceSchema` exactly, so
 * a body carrying two ids (or none) cannot be constructed at all — the failure
 * mode a `{ type, transcriptId?, noteId?, objectId? }` bag would make routine.
  *
  * @stability experimental
 */
export type NoteSource =
  | {
      /** A transcript. */
      type: 'transcript';
      /** The transcript to generate from. */
      transcriptId: string;
    }
  | {
      /** Another note. */
      type: 'note';
      /** The note to generate from. */
      noteId: string;
    }
  | {
      /** An uploaded document. */
      type: 'document';
      /** The stored document to generate from. */
      objectId: string;
    };

/**
 * Characters a note title may hold.
 *
 * MIRRORS `MAX_TITLE_CHARS` in `packages/kvox-api/src/notes/dto/note.dto.ts`, and lives
 * here — beside the types that mirror the rest of that DTO — rather than as a
 * literal in whichever form happens to accept a title, so the create form and
 * every rename surface cannot drift apart from each other or from the API.
  *
  * @stability experimental
 */
export const MAX_TITLE_CHARS = 200;

/**
 * `POST /api/notes` — creates the note AND queues its generation.
 *
 * ⚠ THERE IS NO `body` FIELD AND THERE NEVER MAY BE ONE. A note's first version
 * is `ai_generated` by construction, so a client able to supply the initial
 * body could mint a note whose history claims the AI wrote text a user pasted
 * in. Editing is `PATCH`'s job and records an `edit` version with an author.
  *
  * @stability experimental
 */
export interface CreateNoteInput {
  /**
   * The user's own name for the note, when they supplied one (#187).
   *
   * ⚠ OMIT IT OR SEND A NON-EMPTY STRING — never `''` and never `null`. The
   * API's `title` is `z.string().trim().min(1)`, so an empty string is a **400**
   * rather than a fallback to the generated name. Supplying one records
   * `titleSource: 'user'`, which is sticky for the life of the note.
   */
  title?: string;
  /** The template to generate with. */
  templateId: string;
  /** What to generate from. */
  source: NoteSource;
  /** Extra context for the generation. Omit it for none. */
  contextText?: string;
  /** A model to generate on. Omit it for the template's or the deployment's default. */
  model?: string;
}

/**
 * What `POST /api/notes` answers.
 *
 * @stability experimental
 */
export interface CreateNoteResult {
  /** The new note, already `generating`. */
  note: Note;
  /** The `note_generations` row this note streams into. */
  generationId: string;
  /** The queue job that writes the note. */
  jobId: string;
  /** The provider the generation is billed to. */
  providerId: string;
  /** ⚠ Billed to the CALLER's provider account, not the deployment's. */
  model: string;
}

/**
 * `POST /api/notes/{id}/regenerate` — the only retry path. Every field optional.
 *
 * @stability experimental
 */
export interface RegenerateNoteInput {
  /** A different template to regenerate with. */
  templateId?: string;
  /** `null` clears the note's context; omitting it keeps what the note has. */
  contextText?: string | null;
  /** A different model to regenerate on. */
  model?: string;
}

/**
 * `POST /api/notes/{id}/retitle` — the job queued, NOT the new title.
 *
 * ⚠ THIS IS A 202, AND THE TITLE IS NOT IN IT. Naming a note is a provider
 * call, so the API queues a `note.retitle` job and answers immediately; the
 * title changes when that job settles. A caller that treated this result as the
 * answer would be rendering a name nobody has chosen yet — re-read the note (or
 * let the page's own poll do it) to see the one that was.
  *
  * @stability experimental
 */
export interface RetitleNoteResult {
  /** The note being retitled. */
  noteId: string;
  /** The `note.retitle` job. Watchable in the admin job list; nothing else needs it. */
  jobId: string;
}

/**
 * One row of a note's history.
 *
 * @stability experimental
 */
export interface NoteVersion {
  /** The version number, from 1. */
  version: number;
  /** How the version came to be: generated, edited or restored. */
  kind: 'ai_generated' | 'edit' | 'restore';
  /** The edit summary the author gave, or `null`. */
  summary: string | null;
  /** ⚠ `null` MEANS THE AI — a statement, not a missing value. */
  author: {
    /** The author's user id. */
    id: string;
    /** The author's display name. */
    name: string;
  } | null;
  /** The generation that wrote the version, or `null` for an edit. */
  generationId: string | null;
  /** The version a restore copied, or `null`. */
  restoredFromVersion: number | null;
  /** When the version was recorded, as an ISO timestamp. */
  createdAt: string;
  /**
   * This version's own body format (issue #337); absent from an older server
   * means `markdown`.
   */
  bodyFormat?: NoteBodyFormat;
}

/**
 * `GET /api/notes/{id}/versions`.
 *
 * @stability experimental
 */
export interface NoteVersionsResponse {
  /** The note's current version. */
  currentVersion: number;
  /** The versions of this page, newest first. */
  items: NoteVersion[];
  /** Opaque cursor for the next page, or `null` at the end. */
  nextCursor: string | null;
}

/**
 * One version, read in full — `GET /api/notes/{id}/versions/{version}`.
 *
 * ⚠ A STORED SNAPSHOT, NOT A REPLAY. Every `note_versions` row holds the whole
 * markdown body (a note is a page or two of prose, spec §4.5), so reading an
 * old version is one row read and **version 1 is always retrievable** — which
 * is what lets the history page promise that the AI's original can never be
 * lost, no matter how many edits sit on top of it.
  *
  * @stability experimental
 */
export interface NoteVersionDetail extends NoteVersion {
  /** The note this version belongs to. */
  noteId: string;
  /** The full markdown AS IT WAS at this version. */
  body: string;
  /** Whether this is the note's current version. */
  isCurrent: boolean;
  /**
   * This VERSION's own body format (issue #337) — not the note's current one,
   * since a note's format can change between versions. Absent means
   * `markdown`, which is also what every version predating #334 is.
   */
  bodyFormat?: NoteBodyFormat;
}

/**
 * `PATCH /api/notes/{id}` — the title, the body, or both.
 *
 * ⚠ `baseVersion` IS REQUIRED WHENEVER `body` IS PRESENT, and the API refuses a
 * body without one with a 400. It is optional in this type for the same reason
 * it is optional in the API's schema: a RENAME carries no version, because a
 * title is metadata about the note rather than versioned content of it.
  *
  * @stability experimental
 */
export interface UpdateNoteInput {
  /** A new title. Sets `titleSource` to `user`. */
  title?: string;
  /** A new markdown body; needs `baseVersion`. */
  body?: string;
  /** The `currentVersion` being edited. Required alongside `body`. */
  baseVersion?: number;
  /** A short description of the edit, kept on the version. */
  summary?: string;
  /** Idempotency key — a repeat returns the ORIGINAL result and adds no version. */
  clientBatchId?: string;
}

/**
 * Filters and paging of `GET /api/notes`.
 *
 * @stability experimental
 */
export interface NoteListParams {
  /** Only notes in this state. */
  status?: NoteStatus;
  /** Only notes generated from this kind of source. */
  sourceType?: NoteSourceType;
  /** Only notes generated from this transcript. */
  sourceTranscriptId?: string;
  /** Only notes generated from this note. */
  sourceNoteId?: string;
  /** Only notes generated from this document. */
  sourceObjectId?: string;
  /** Only notes generated with this template. */
  templateId?: string;
  /** Case-insensitive substring of the title. */
  q?: string;
  /** Opaque cursor returned by the previous page. */
  cursor?: string;
  /** The page size. */
  limit?: number;
}

/**
 * `POST /api/notes/sources/documents` — the upload, not the extraction.
 *
 * @stability experimental
 */
export interface NoteSourceDocument {
  /** The stored document, to pass as the source of a note. */
  objectId: string;
  /** The uploaded file's name. */
  filename: string;
  /** The uploaded file's media type. */
  mimeType: string;
  /** The uploaded file's size in bytes. */
  size: number;
  /** The `note.source.extract` job reading the text. */
  jobId: string;
  /** Always `extracting`: the text is read by a job. */
  status: 'extracting';
}

/**
 * What `note.source.extract` has recorded so far about one uploaded document.
 *
 * `extracting` means "no outcome recorded yet", not a value the job stores —
 * the job writes `extracted` or `unextractable` when it finishes and nothing at
 * all before that; the API answers `extracting` meanwhile, and this client
 * also maps any answer it cannot read to it. Named the same as the upload
 * response's own `status` so a caller has one vocabulary for the whole wait.
  *
  * @stability experimental
 */
export interface NoteDocumentExtraction {
  /** `extracting` until the job has recorded an outcome. */
  status: 'extracting' | 'extracted' | 'unextractable';
  /** The sentence the API stored for the user. Present for `unextractable`. */
  message: string | null;
  /** Characters of extracted text, when it succeeded. */
  characters: number | null;
}

/**
 * What this application will accept as a note source document.
 *
 * MIRRORS `NOTE_DOCUMENT_MIME_TYPES` in
 * `packages/kvox-api/src/notes/extraction/document-format.ts`. The extensions are listed
 * alongside the media types because a `<input type="file" accept>` that names
 * only media types silently rejects a `.md` on the platforms that do not map
 * that extension to `text/markdown` — which is most of them.
  *
  * @stability experimental
 */
export const NOTE_DOCUMENT_ACCEPT = '.pdf,.txt,.md,application/pdf,text/plain,text/markdown';

/**
 * The same list as a sentence, for the refusal message and the drop zone.
 *
 * @stability experimental
 */
export const NOTE_DOCUMENT_ACCEPT_LABEL = 'PDF, plain text or Markdown';

// =============================================================================
// Errors
// =============================================================================

/**
 * The machine-readable reason behind a note 409, or `null`.
 *
 * ONE READER, so no page spells the `details` cast for itself and no page
 * branches on the human-readable `message` — which is prose and will be
 * rewritten. Returns `null` for anything that is not a 409 carrying a string
 * reason, including a 409 from a build that names a reason this one has never
 * heard of: a caller that cannot identify the branch must fall back to showing
 * the message, never to guessing.
  *
  * @stability experimental
 */
export function noteConflictReason(err: unknown): NoteConflictReason | null {
  if (!(err instanceof KvoxApiError) || err.status !== 409) return null;

  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;

  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? (reason as NoteConflictReason) : null;
}

/**
 * What the note is ACTUALLY at, from a `stale_base_version` 409.
 *
 * The API publishes `details.currentVersion` as a real schema (`NoteConflictDto`)
 * precisely so a client can show the user what it was about to overwrite. A
 * conflict UI that could not name the other version would have nothing to offer
 * but "try again", and retrying a stale save is the one response that is
 * definitely wrong — it would overwrite the version the 409 exists to protect.
 *
 * `null` for a 409 that names no version, so a caller falls back to re-reading
 * the note rather than rendering `undefined`.
  *
  * @stability experimental
 */
export function noteConflictCurrentVersion(err: unknown): number | null {
  if (!(err instanceof KvoxApiError) || err.status !== 409) return null;

  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;

  const version = (details as { currentVersion?: unknown }).currentVersion;
  return typeof version === 'number' ? version : null;
}

// =============================================================================
// Generation context (issue #308)
// =============================================================================

/**
 * `GET /api/notes/{id}/context` and `.../generations/{generationId}/context` —
 * the exact prompt a generation sent. Mirrors `noteGenerationContextResponseSchema`
 * in `dto/note.dto.ts` field for field.
 *
 * `stored: false` marks a generation that predates capture: `systemPrompt` is
 * then rebuilt from the template as it is today (or `null`) and `userContent`
 * is `null`. `sourceRedacted: true` means the source material was withheld
 * from `userContent` because the caller can no longer read the source.
  *
  * @stability experimental
 */
export interface NoteGenerationContext {
  /** The generation this context belongs to. */
  generationId: string;
  /** Whether the generation created, regenerated or previewed. */
  kind: 'create' | 'regenerate' | 'preview';
  /** Where the generation is. */
  status: 'pending' | 'streaming' | 'succeeded' | 'failed';
  /** `false` for a generation that predates prompt capture. */
  stored: boolean;
  /** When the prompt was captured, or `null`. */
  capturedAt: string | null;
  /** The template used, or `null`. */
  templateId: string | null;
  /** The template's name when the generation ran, or `null`. */
  templateNameSnapshot: string | null;
  /** The provider the generation ran on, or `null`. */
  provider: string | null;
  /** The model the generation ran on, or `null`. */
  model: string | null;
  /** The extra context the author gave, or `null`. */
  contextText: string | null;
  /** What the generation read. */
  sourceType: 'transcript' | 'note' | 'document';
  /** The version of the source note that was read, or `null`. */
  sourceVersion: number | null;
  /** `true` when the source text was withheld because the caller can no longer read the source. */
  sourceRedacted: boolean;
  /** The system prompt that was sent, or `null`. */
  systemPrompt: string | null;
  /** The user message that was sent, or `null` when it was not stored. */
  userContent: string | null;
  /** Tokens in the prompt, or `null`. */
  promptTokens: number | null;
  /** Tokens in the answer, or `null`. */
  completionTokens: number | null;
}

/**
 * The `details.reason` of the 404 a note with no generation answers.
 *
 * @stability experimental
 */
export const NOTE_NO_GENERATION_REASON = 'no_generation';

/**
 * `true` for the 404 that means "this note has no generation yet" — not an error.
 *
 * @stability experimental
 */
export function isNoGenerationError(err: unknown): boolean {
  if (!(err instanceof KvoxApiError) || err.status !== 404) return false;
  const details = err.details;
  if (typeof details !== 'object' || details === null) return false;
  return (details as { reason?: unknown }).reason === NOTE_NO_GENERATION_REASON;
}

// =============================================================================
// Reads
// =============================================================================

/**
 * `GET /api/notes`.
 *
 * @stability experimental
 */
export async function getNotes(
  host: KvoxWebHost,
  params: NoteListParams = {},
): Promise<NoteListResponse> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.sourceType) query.set('sourceType', params.sourceType);
  if (params.sourceTranscriptId) query.set('sourceTranscriptId', params.sourceTranscriptId);
  if (params.sourceNoteId) query.set('sourceNoteId', params.sourceNoteId);
  if (params.sourceObjectId) query.set('sourceObjectId', params.sourceObjectId);
  if (params.templateId) query.set('templateId', params.templateId);
  // Trimmed-empty is OMITTED rather than sent: `q=` is a filter the API would
  // apply, and "title contains the empty string" is not what the user meant by
  // clearing the box. Same rule `getTranscripts` states for itself.
  if (params.q && params.q.trim()) query.set('q', params.q.trim());
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));

  const suffix = query.toString();
  return kvoxGet<NoteListResponse>(host, `/notes${suffix ? `?${suffix}` : ''}`);
}

/**
 * `GET /api/notes/summary`.
 *
 * @stability experimental
 */
export async function getNoteSummary(host: KvoxWebHost): Promise<NoteSummary> {
  return kvoxGet<NoteSummary>(host, '/notes/summary');
}

/**
 * `GET /api/notes/{id}`.
 *
 * @stability experimental
 */
export async function getNote(host: KvoxWebHost, id: string): Promise<Note> {
  return kvoxGet<Note>(host, `/notes/${encodeURIComponent(id)}`);
}

/**
 * `GET /api/notes/{id}/versions`.
 *
 * @stability experimental
 */
export async function getNoteVersions(
  host: KvoxWebHost,
  id: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<NoteVersionsResponse> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return kvoxGet<NoteVersionsResponse>(
    host,
    `/notes/${encodeURIComponent(id)}/versions${suffix ? `?${suffix}` : ''}`,
  );
}

/**
 * `GET /api/notes/{id}/versions/{version}` — one version, body included.
 *
 * @stability experimental
 */
export async function getNoteVersion(
  host: KvoxWebHost,
  id: string,
  version: number,
): Promise<NoteVersionDetail> {
  return kvoxGet<NoteVersionDetail>(
    host,
    `/notes/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}`,
  );
}

/**
 * `GET /api/notes/{id}/context` (the current generation) or, with a
 * `generationId`, `GET /api/notes/{id}/generations/{generationId}/context`.
 * A note with no generation is a 404 with `details.reason: 'no_generation'` —
 * see {@link isNoGenerationError}.
  *
  * @stability experimental
 */
export async function getNoteGenerationContext(
  host: KvoxWebHost,
  noteId: string,
  generationId?: string,
): Promise<NoteGenerationContext> {
  const base = `/notes/${encodeURIComponent(noteId)}`;
  return kvoxGet<NoteGenerationContext>(
    host,
    generationId
      ? `${base}/generations/${encodeURIComponent(generationId)}/context`
      : `${base}/context`,
  );
}

/**
 * How far `note.source.extract` has got with one uploaded document:
 * `GET /api/notes/sources/documents/:objectId` (`notes:read`, owner-scoped).
 *
 * See this file's header for why the notes slice, not storage, answers this
 * (#596). Every unreadable shape resolves to `extracting`, which is the only
 * safe direction: the caller uses this to decide whether Generate is enabled,
 * and reporting "extracted" on an answer it could not parse would let a user
 * start a generation that fails minutes later on their own provider account.
 *
 * @stability experimental
 */
export async function getNoteDocumentExtraction(
  host: KvoxWebHost,
  objectId: string,
): Promise<NoteDocumentExtraction> {
  const answer = await kvoxGet<unknown>(
    host,
    `/notes/sources/documents/${encodeURIComponent(objectId)}`,
  );

  if (typeof answer !== 'object' || answer === null) {
    return { status: 'extracting', message: null, characters: null };
  }

  const record = answer as Record<string, unknown>;
  const status = record.status;
  const message = typeof record.message === 'string' ? record.message : null;
  const characters = typeof record.characters === 'number' ? record.characters : null;

  if (status === 'extracted') return { status: 'extracted', message, characters };
  if (status === 'unextractable') return { status: 'unextractable', message, characters };

  return { status: 'extracting', message: null, characters: null };
}

// =============================================================================
// Writes
// =============================================================================

/**
 * `POST /api/notes` — creates the note AND queues its generation.
 *
 * Rejects with a 409 the caller is expected to BRANCH on rather than render;
 * see {@link noteConflictReason} and this file's header.
  *
  * @stability experimental
 */
export async function createNote(
  host: KvoxWebHost,
  input: CreateNoteInput,
): Promise<CreateNoteResult> {
  return kvoxPost<CreateNoteResult>(host, '/notes', input);
}

/**
 * `PATCH /api/notes/{id}` — save an edit.
 *
 * REJECTS WITH A 409 THE CALLER MUST BRANCH ON, never render as an error
 * message: `stale_base_version` means somebody else's save landed first and
 * both versions are real. {@link noteConflictReason} names the branch and
 * {@link noteConflictCurrentVersion} names the version to show.
  *
  * @stability experimental
 */
export async function updateNote(
  host: KvoxWebHost,
  id: string,
  input: UpdateNoteInput,
): Promise<Note> {
  return kvoxPatch<Note>(host, `/notes/${encodeURIComponent(id)}`, input);
}

/**
 * `POST /api/notes/{id}/versions/{version}/restore`.
 *
 * ⚠ APPENDS, NEVER REWRITES. The restore is recorded as a NEW version whose
 * body is the old one's; every version in between — including the one that was
 * current a moment ago — stays exactly as it was. `baseVersion` must EQUAL the
 * note's `currentVersion` here (unlike a `PATCH`, which merely checks it),
 * because a restore carries no per-entity expectations of its own and a stale
 * view would be asking to discard edits the caller has never seen.
  *
  * @stability experimental
 */
export async function restoreNoteVersion(
  host: KvoxWebHost,
  id: string,
  version: number,
  baseVersion: number,
  summary?: string,
): Promise<Note> {
  return kvoxPost<Note>(
    host,
    `/notes/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}/restore`,
    summary ? { baseVersion, summary } : { baseVersion },
  );
}

/**
 * `POST /api/notes/{id}/regenerate` — the only retry path.
 *
 * @stability experimental
 */
export async function regenerateNote(
  host: KvoxWebHost,
  id: string,
  input: RegenerateNoteInput = {},
): Promise<CreateNoteResult> {
  return kvoxPost<CreateNoteResult>(host, `/notes/${encodeURIComponent(id)}/regenerate`, input);
}

/**
 * `POST /api/notes/{id}/retitle` — ask for a title read off the note's own text.
 *
 * QUEUE WORK, NOT A RENAME. See {@link RetitleNoteResult}: this resolves as
 * soon as the job is enqueued, and the note on screen still has its old title
 * at that moment.
 *
 * ⚠ IT WILL RENAME A NOTE THE USER NAMED THEMSELVES, and that is the API's
 * deliberate choice rather than an oversight — asking for a suggestion about a
 * note in front of you is an explicit request about that note, unlike the bulk
 * sweep, which never touches a name a person chose. So no caller should hide or
 * disable this on a `titleSource: 'user'` note.
 *
 * Refuses with a **409** whose reason is `generating` while the note is being
 * written — that generation names the note itself when it commits, and two
 * passes racing for one title spend the user's money for one answer. That is a
 * BRANCH for {@link noteConflictReason}, not an error message to render raw.
  *
  * @stability experimental
 */
export async function retitleNote(host: KvoxWebHost, id: string): Promise<RetitleNoteResult> {
  return kvoxPost<RetitleNoteResult>(host, `/notes/${encodeURIComponent(id)}/retitle`);
}

/**
 * `POST /api/notes/sources/documents` — store a document and queue its
 * extraction.
 *
 * Multipart with a single `file` part, through `host.http.postFormData` so the host's
 * token, 401 retry and maintenance handling all still apply. The
 * object it creates is `managed_by: 'notes'` — invisible to the generic storage
 * list, and refusing the generic DELETE — which a client cannot ask for and
 * must not try to.
  *
  * @stability experimental
 */
export async function uploadNoteSourceDocument(
  host: KvoxWebHost,
  file: File,
): Promise<NoteSourceDocument> {
  const form = new FormData();
  form.append('file', file);
  return kvoxPostFormData<NoteSourceDocument>(host, '/notes/sources/documents', form);
}

/**
 * `POST /api/notes/import` — create a note from a Markdown note export (#585).
 *
 * Multipart with a single `file` part. Any Markdown or text file is accepted; a KVox note
 * export keeps its title and body. A refused file is a `KvoxApiError` (400) whose
 * `details.reason` is one of `NOTE_IMPORT_FAILURE_REASONS` (`not_text`,
 * `invalid_front_matter`, `unsupported_note_format`, `empty_note`) and whose message a
 * person can read; over the size limit is a 413.
 *
 * @param host - the host.
 * @param file - the file.
 * @returns the new note, as {@link getNote} returns it.
 * @stability experimental
 */
export async function importNoteMarkdown(host: KvoxWebHost, file: File): Promise<Note> {
  const form = new FormData();
  form.append('file', file);
  return kvoxPostFormData<Note>(host, '/notes/import', form);
}
