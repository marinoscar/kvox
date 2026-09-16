/**
 * The notes API, as the web app sees it — issue #57, epic #45.
 *
 * The backend half is `apps/api/src/notes/notes.controller.ts`,
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
 * WHY DOCUMENT EXTRACTION IS READ OFF A STORAGE OBJECT
 * =============================================================================
 *
 * `POST /api/notes/sources/documents` answers `{ objectId, jobId, status:
 * 'extracting' }` and queues `note.source.extract`. There is deliberately no
 * sixth table and no "extraction status" endpoint: the extracted text is a
 * SECOND storage object, and the link plus the outcome are keys in the FIRST
 * object's own `metadata` (`apps/api/src/notes/source-metadata.ts` is the one
 * definition both the writer and the reader import).
 *
 * So {@link getNoteDocumentExtraction} polls `GET /api/storage/objects/:id` and
 * reads that block. It is `storage:read`-gated, which every seeded role holds,
 * and it is TOTAL OVER GARBAGE for the same reason the API's own reader is: the
 * column is shared JSONB written by several modules and by older builds, and
 * every shape this client cannot understand means the same thing — "not
 * extracted yet".
 */

import { api, ApiError } from './api';
import type { SemanticSearchQuality } from './searchIndex';

// =============================================================================
// The shapes (mirrors of `dto/note.dto.ts`)
// =============================================================================

/** `notes.status` — the coarse, list-visible lifecycle (spec §1.1). */
export type NoteStatus = 'draft' | 'generating' | 'ready' | 'failed' | 'deleting';

/** What a note was generated FROM. The API's three-member discriminated union. */
export type NoteSourceType = 'transcript' | 'note' | 'document';

/**
 * The machine-readable `details.reason` values a note 409 carries.
 *
 * Mirrors `NOTE_CONFLICT_REASONS` in `dto/note.dto.ts`. Only the ones this
 * client branches on are named as constants; the type is the full published
 * set, so a `switch` over it stays exhaustive as the API grows.
 */
export type NoteConflictReason =
  | 'ai_not_configured'
  | 'ai_key_missing'
  | 'stale_base_version'
  | 'already_current'
  | 'template_required'
  | 'generating'
  | 'derived_notes_exist'
  | 'deleting';

/**
 * Where a note's title came from — mirrors `noteTitleSourceSchema` (#197).
 *
 * ⚠ `user` IS STICKY. A person typed it, on create or in a later rename, and no
 * titling pass overwrites it: the guard lives in the API's own `WHERE` clause,
 * not in a client check. `ai` — a titling pass read it off the generated
 * content; `template` — nobody named it, so it inherited the template's name.
 */
export type NoteTitleSource = 'ai' | 'user' | 'template';

/** One note, as `GET /api/notes/{id}` returns it. */
export interface Note {
  id: string;
  title: string;
  /** Provenance of {@link Note.title}. See {@link NoteTitleSource}. */
  titleSource: NoteTitleSource;
  /** The live markdown body — by invariant, the version at `currentVersion`. */
  body: string;
  status: NoteStatus;
  /** 0 until the first generation commits. */
  currentVersion: number;
  provider: string | null;
  model: string | null;
  sourceType: NoteSourceType;
  sourceTranscriptId: string | null;
  sourceNoteId: string | null;
  sourceObjectId: string | null;
  templateId: string | null;
  templateName: string | null;
  contextText: string | null;
  /** The generation to watch. Never cleared once set. */
  currentGenerationId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of `GET /api/notes`.
 *
 * The API omits `body` and `contextText` and adds an `excerpt` — a list renders
 * a snippet, and shipping a page or two of prose per row to draw three lines of
 * it is the kind of thing that is invisible until somebody has four hundred
 * notes.
 */
export type NoteListItem = Omit<Note, 'body' | 'contextText'> & { excerpt: string };

/**
 * ⚠ EXTENDS `SemanticSearchQuality` — every field of it OPTIONAL and absent
 * today. See `services/transcripts.ts`'s identical declaration for why (issue
 * #191, epic #165): the fields arrive with this epic's hybrid-ranking issue,
 * and until then every consumer reads `undefined` and renders nothing.
 */
export interface NoteListResponse extends SemanticSearchQuality {
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

/** `GET /api/notes/summary` — the home page's one request. */
export interface NoteSummary {
  inProgress: NoteListItem[];
  recent: NoteListItem[];
  failed: NoteListItem[];
  counts: { total: number; ready: number; inProgress: number; failed: number };
}

/**
 * What to generate from.
 *
 * A DISCRIMINATED UNION, mirroring the API's `previewSourceSchema` exactly, so
 * a body carrying two ids (or none) cannot be constructed at all — the failure
 * mode a `{ type, transcriptId?, noteId?, objectId? }` bag would make routine.
 */
export type NoteSource =
  | { type: 'transcript'; transcriptId: string }
  | { type: 'note'; noteId: string }
  | { type: 'document'; objectId: string };

/**
 * Characters a note title may hold.
 *
 * MIRRORS `MAX_TITLE_CHARS` in `apps/api/src/notes/dto/note.dto.ts`, and lives
 * here — beside the types that mirror the rest of that DTO — rather than as a
 * literal in whichever form happens to accept a title, so the create form and
 * every rename surface cannot drift apart from each other or from the API.
 */
export const MAX_TITLE_CHARS = 200;

/**
 * `POST /api/notes` — creates the note AND queues its generation.
 *
 * ⚠ THERE IS NO `body` FIELD AND THERE NEVER MAY BE ONE. A note's first version
 * is `ai_generated` by construction, so a client able to supply the initial
 * body could mint a note whose history claims the AI wrote text a user pasted
 * in. Editing is `PATCH`'s job and records an `edit` version with an author.
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
  templateId: string;
  source: NoteSource;
  contextText?: string;
  model?: string;
}

export interface CreateNoteResult {
  note: Note;
  /** The `note_generations` row this note streams into. */
  generationId: string;
  jobId: string;
  providerId: string;
  /** ⚠ Billed to the CALLER's provider account, not the deployment's. */
  model: string;
}

/** `POST /api/notes/{id}/regenerate` — the only retry path. Every field optional. */
export interface RegenerateNoteInput {
  templateId?: string;
  /** `null` clears the note's context; omitting it keeps what the note has. */
  contextText?: string | null;
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
 */
export interface RetitleNoteResult {
  noteId: string;
  /** The `note.retitle` job. Watchable in the admin job list; nothing else needs it. */
  jobId: string;
}

export interface NoteVersion {
  version: number;
  kind: 'ai_generated' | 'edit' | 'restore';
  summary: string | null;
  /** ⚠ `null` MEANS THE AI — a statement, not a missing value. */
  author: { id: string; name: string } | null;
  generationId: string | null;
  restoredFromVersion: number | null;
  createdAt: string;
}

export interface NoteVersionsResponse {
  currentVersion: number;
  items: NoteVersion[];
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
 */
export interface NoteVersionDetail extends NoteVersion {
  noteId: string;
  /** The full markdown AS IT WAS at this version. */
  body: string;
  isCurrent: boolean;
}

/**
 * `PATCH /api/notes/{id}` — the title, the body, or both.
 *
 * ⚠ `baseVersion` IS REQUIRED WHENEVER `body` IS PRESENT, and the API refuses a
 * body without one with a 400. It is optional in this type for the same reason
 * it is optional in the API's schema: a RENAME carries no version, because a
 * title is metadata about the note rather than versioned content of it.
 */
export interface UpdateNoteInput {
  title?: string;
  body?: string;
  /** The `currentVersion` being edited. Required alongside `body`. */
  baseVersion?: number;
  summary?: string;
  /** Idempotency key — a repeat returns the ORIGINAL result and adds no version. */
  clientBatchId?: string;
}

export interface NoteListParams {
  status?: NoteStatus;
  sourceType?: NoteSourceType;
  sourceTranscriptId?: string;
  sourceNoteId?: string;
  sourceObjectId?: string;
  templateId?: string;
  /** Case-insensitive substring of the title. */
  q?: string;
  cursor?: string;
  limit?: number;
}

/** `POST /api/notes/sources/documents` — the upload, not the extraction. */
export interface NoteSourceDocument {
  objectId: string;
  filename: string;
  mimeType: string;
  size: number;
  jobId: string;
  status: 'extracting';
}

/**
 * What `note.source.extract` has recorded so far about one uploaded document.
 *
 * `extracting` is this client's word for "the metadata block is not there yet",
 * not a value the API stores — the job writes `extracted` or `unextractable`
 * when it finishes and nothing at all before that. Named the same as the upload
 * response's own `status` so a caller has one vocabulary for the whole wait.
 */
export interface NoteDocumentExtraction {
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
 * `apps/api/src/notes/extraction/document-format.ts`. The extensions are listed
 * alongside the media types because a `<input type="file" accept>` that names
 * only media types silently rejects a `.md` on the platforms that do not map
 * that extension to `text/markdown` — which is most of them.
 */
export const NOTE_DOCUMENT_ACCEPT = '.pdf,.txt,.md,application/pdf,text/plain,text/markdown';

/** The same list as a sentence, for the refusal message and the drop zone. */
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
 */
export function noteConflictReason(err: unknown): NoteConflictReason | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;

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
 */
export function noteConflictCurrentVersion(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;

  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;

  const version = (details as { currentVersion?: unknown }).currentVersion;
  return typeof version === 'number' ? version : null;
}

// =============================================================================
// Reads
// =============================================================================

/** `GET /api/notes`. */
export async function getNotes(params: NoteListParams = {}): Promise<NoteListResponse> {
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
  return api.get<NoteListResponse>(`/notes${suffix ? `?${suffix}` : ''}`);
}

/** `GET /api/notes/summary`. */
export async function getNoteSummary(): Promise<NoteSummary> {
  return api.get<NoteSummary>('/notes/summary');
}

/** `GET /api/notes/{id}`. */
export async function getNote(id: string): Promise<Note> {
  return api.get<Note>(`/notes/${encodeURIComponent(id)}`);
}

/** `GET /api/notes/{id}/versions`. */
export async function getNoteVersions(
  id: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<NoteVersionsResponse> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return api.get<NoteVersionsResponse>(
    `/notes/${encodeURIComponent(id)}/versions${suffix ? `?${suffix}` : ''}`,
  );
}

/** `GET /api/notes/{id}/versions/{version}` — one version, body included. */
export async function getNoteVersion(
  id: string,
  version: number,
): Promise<NoteVersionDetail> {
  return api.get<NoteVersionDetail>(
    `/notes/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}`,
  );
}

/**
 * How far `note.source.extract` has got with one uploaded document.
 *
 * See this file's header for why this reads a storage object rather than a
 * notes endpoint. Every unreadable shape resolves to `extracting`, which is the
 * only safe direction: the caller uses this to decide whether Generate is
 * enabled, and reporting "extracted" on a metadata block it could not parse
 * would let a user start a generation that fails minutes later on their own
 * provider account.
 */
export async function getNoteDocumentExtraction(
  objectId: string,
): Promise<NoteDocumentExtraction> {
  const object = await api.get<{ metadata: Record<string, unknown> | null }>(
    `/storage/objects/${encodeURIComponent(objectId)}`,
  );

  const metadata = object.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return { status: 'extracting', message: null, characters: null };
  }

  // ⚠ `noteSourceExtraction`, the namespaced key — NOT a bare `status` at the
  // top level. `metadata` is a shared bag several writers merge into, and the
  // API namespaces its own write for exactly that reason.
  const block = (metadata as Record<string, unknown>).noteSourceExtraction;
  if (typeof block !== 'object' || block === null) {
    return { status: 'extracting', message: null, characters: null };
  }

  const record = block as Record<string, unknown>;
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
 */
export async function createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
  return api.post<CreateNoteResult>('/notes', input);
}

/**
 * `PATCH /api/notes/{id}` — save an edit.
 *
 * REJECTS WITH A 409 THE CALLER MUST BRANCH ON, never render as an error
 * message: `stale_base_version` means somebody else's save landed first and
 * both versions are real. {@link noteConflictReason} names the branch and
 * {@link noteConflictCurrentVersion} names the version to show.
 */
export async function updateNote(id: string, input: UpdateNoteInput): Promise<Note> {
  return api.patch<Note>(`/notes/${encodeURIComponent(id)}`, input);
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
 */
export async function restoreNoteVersion(
  id: string,
  version: number,
  baseVersion: number,
  summary?: string,
): Promise<Note> {
  return api.post<Note>(
    `/notes/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}/restore`,
    summary ? { baseVersion, summary } : { baseVersion },
  );
}

/** `POST /api/notes/{id}/regenerate` — the only retry path. */
export async function regenerateNote(
  id: string,
  input: RegenerateNoteInput = {},
): Promise<CreateNoteResult> {
  return api.post<CreateNoteResult>(`/notes/${encodeURIComponent(id)}/regenerate`, input);
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
 */
export async function retitleNote(id: string): Promise<RetitleNoteResult> {
  return api.post<RetitleNoteResult>(`/notes/${encodeURIComponent(id)}/retitle`);
}

/**
 * `POST /api/notes/sources/documents` — store a document and queue its
 * extraction.
 *
 * Multipart with a single `file` part, through `api.postFormData` so the bearer
 * token, the 401 retry and the maintenance interception all still apply. The
 * object it creates is `managed_by: 'notes'` — invisible to the generic storage
 * list, and refusing the generic DELETE — which a client cannot ask for and
 * must not try to.
 */
export async function uploadNoteSourceDocument(file: File): Promise<NoteSourceDocument> {
  const form = new FormData();
  form.append('file', file);
  return api.postFormData<NoteSourceDocument>('/notes/sources/documents', form);
}
