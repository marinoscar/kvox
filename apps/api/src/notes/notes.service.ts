// =============================================================================
// NotesService (issue #53, epic #45)
// =============================================================================
//
// Everything that happens to a note after #49 produces one — which is the half
// of the epic that decides whether a note is a KNOWLEDGE OBJECT or a chat reply
// somebody pastes elsewhere and never returns to. Concretely: the user can
// change the text, the AI's original is never lost, and the note keeps naming
// what produced it for as long as it exists.
//
// -----------------------------------------------------------------------------
// ⚠ THE ONE INVARIANT EVERY WRITE PATH IN THIS FILE HOLDS
// -----------------------------------------------------------------------------
//
//   notes.body === the `note_versions` row at notes.current_version
//
// (schema's `Note.body` comment, spec §4.1.) It is what lets `GET /api/notes`
// render a title and an excerpt for a whole page of results with one row read
// and no join. There are exactly three writers of a note's body for its entire
// life, and all three append a `note_versions` row IN THE SAME TRANSACTION they
// touch `body` in:
//
//   1. `NoteGenerationService.commit` — a generation finishing (#49);
//   2. `update()` below — an explicit body `PATCH`;
//   3. `restore()` below — restoring an earlier version.
//
// A fourth writer that updated one column without the other would be a bug in
// that path, not an expected state, which is why the schema can afford to leave
// the invariant unenforced by a trigger.
//
// -----------------------------------------------------------------------------
// CURSOR PAGINATION OVER `(updatedAt, id)`, NEVER OFFSET
// -----------------------------------------------------------------------------
//
// Generation and every save rewrite `updatedAt`, so a note moves to the top of
// the ordering while the user is reading page two. An offset page over a list
// that reorders itself under the reader SKIPS rows and REPEATS others — and
// does so silently, which is the worst property a list can have. The compound
// key is `(updatedAt, id)` rather than `updatedAt` alone because `updatedAt` is
// not unique and two rows sharing a millisecond would make one unreachable.
// `test/notes/notes-pagination.db.spec.ts` mutates a list mid-pagination
// against real Postgres and asserts neither happens.
//
// -----------------------------------------------------------------------------
// OPTIMISTIC CONCURRENCY: A VERSION NUMBER, NOT A PER-ENTITY `rev`
// -----------------------------------------------------------------------------
//
// A note is ONE prose body, so a single version number is a sufficient check
// where a transcript needed a `rev` per segment and per speaker
// (`docs/specs/transcription.md` §5): two people correcting different LINES of
// a transcript are not in conflict, but two people rewriting the same paragraph
// are. A stale `baseVersion` is a **409 that names `currentVersion`**, so the
// client can show what it is about to overwrite — silently discarding the other
// tab's paragraph is the exact failure "the user controls the truth" exists to
// rule out, and two tabs is the ordinary case rather than an exotic one.
//
// -----------------------------------------------------------------------------
// EVERY READ GOES THROUGH `NoteAccessService`
// -----------------------------------------------------------------------------
//
// There is no `findUnique` on `notes` anywhere in this file that is not
// preceded by an access check, because the access check RETURNS the row — the
// arrangement that makes "look it up, then authorise" impossible to write by
// accident. No access is a **404, never a 403** (spec §6.1), on every route:
// read, patch, version, restore and delete.
// =============================================================================

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Note, NoteGeneration, NoteVersion } from '@prisma/client';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { NoteAccessService } from './access/note-access.service';
import { NoteTemplateAccessService } from './access/note-template-access.service';
import { HOUSEKEEPING_PRIORITY } from '../jobs/housekeeping.enqueue';
import {
  EXCERPT_CHARS,
  NOTE_CONFLICT_REASONS,
  RETITLE_SWEEP_LIMIT,
  type CreateNoteDto,
  type NoteListItem,
  type NoteListQueryDto,
  type NoteResponse,
  type NoteTitleSource,
  type NoteVersionsQueryDto,
  type RegenerateNoteDto,
  type RestoreNoteVersionDto,
  type UpdateNoteDto,
} from './dto/note.dto';
import {
  NoteGenerationRequestService,
  type ResolvedModel,
} from './generation/note-generation-request.service';
import { NoteSourceService, type SourceSelector } from './generation/note-source.service';
import { assemblePrompt, parseTemplateStructure } from './generation/prompt';
import {
  NOTE_GENERATE_JOB_TYPE,
  NOTE_PURGE_JOB_TYPE,
  NOTE_RETITLE_JOB_TYPE,
  NOTE_SUBJECT_TYPE,
} from './job-types';

/** How many rows each list inside `GET /api/notes/summary` carries. */
export const SUMMARY_LIST_SIZE = 8;

/** The statuses a note may be deleted from. `generating` is deliberately absent. */
export const DELETABLE_STATUSES = ['draft', 'ready', 'failed'] as const;

/**
 * The queue priority a bulk retitle job takes (issue #184, epic #163).
 *
 * ⚠ ASCENDING IS MORE URGENT, so this is the opposite end of the spectrum from
 * `NOTE_EXPORT_JOB_PRIORITY = -10`: nobody is watching a spinner for a sweep
 * over a library, and a hundred titling jobs must never be claimed ahead of the
 * note somebody is generating right now. It is `HOUSEKEEPING_PRIORITY` itself
 * rather than a new literal `100`, for the reason that constant states about
 * its own reuse — a second copy is a second chance for one of them to become
 * `-100` and starve the queue behind a batch of renames.
 *
 * ⚠ THE SINGLE-NOTE ROUTE DOES NOT USE IT. `POST /api/notes/{id}/retitle` takes
 * the column default (`0`), because a person pressed a button and is waiting
 * for the answer; queueing that behind a sweep they started an hour ago would
 * make the button look broken.
 */
export const NOTE_RETITLE_JOB_PRIORITY = HOUSEKEEPING_PRIORITY;

/** What `POST /api/notes/{id}/retitle` queued. */
export interface QueuedRetitle {
  noteId: string;
  jobId: string;
}

/** What `POST /api/notes/retitle` queued, and what it left behind. */
export interface RetitleSweep {
  queued: number;
  remaining: number;
}

/** What one create or regenerate produced. */
export interface QueuedGeneration {
  note: NoteResponse;
  generationId: string;
  jobId: string;
  providerId: string;
  model: string;
}

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NoteAccessService,
    private readonly templates: NoteTemplateAccessService,
    private readonly requests: NoteGenerationRequestService,
    private readonly sources: NoteSourceService,
    private readonly jobs: JobsService,
  ) {}

  // ===========================================================================
  // Create
  // ===========================================================================

  /**
   * `POST /api/notes` — the note AND its generation, in one call.
   *
   * The same shape `POST /api/transcripts` has, and for the same reason: the
   * thing the user asked for is "a note from this recording", not "a row I will
   * later ask you to fill in". Two calls would make a note that exists but was
   * never generated a reachable state for every client that forgot the second
   * one.
   *
   * ⚠ EVERY CHECK RUNS BEFORE ANYTHING IS CREATED, so a refused request leaves
   * no half-made note behind — the identical ordering `TranscriptsService
   * .create` states for its own three pre-flight checks. In particular a
   * **409 for a caller with no API key creates no note**: the deployment is
   * fine, the caller is not configured, and a `draft` note nobody can generate
   * is worse than no note at all.
   */
  async create(dto: CreateNoteDto, user: RequestUser): Promise<QueuedGeneration> {
    const { template } = await this.templates.require(user.id, dto.templateId, 'read');

    // The source, and whether this caller may read it. 404 for both "gone" and
    // "not yours" (spec §6.1).
    const selector = await this.requests.resolveSource(dto.source, user);

    // ⚠ THE 409s LIVE HERE — before the row, before the generation, before the
    // job. `details.reason` is `ai_not_configured` or `ai_key_missing`.
    const { provider, model, policy } = await this.requests.resolveModel(
      user.id,
      dto.model ?? template.model ?? null,
      'note',
    );

    const contextText = dto.contextText?.trim() ? dto.contextText.trim() : null;

    await this.assertPromptFits({
      template,
      selector,
      contextText,
      provider,
      model,
      policy,
    });

    // ⚠ THE TITLE AND WHERE IT CAME FROM ARE DECIDED TOGETHER, here, once. A
    // human typing a name is the strongest signal this application ever gets
    // about what a note should be called, so it is recorded as `user` and the
    // AI titling path reads exactly this field before it renames anything. The
    // fallback is `template`: nobody named this note, it inherited the recipe's
    // name, and a later titling pass is welcome to improve on that.
    const supplied = dto.title?.trim();
    const title = supplied || template.name;
    const titleSource: NoteTitleSource = supplied ? 'user' : 'template';

    const created = await this.prisma.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          ownerId: user.id,
          title,
          titleSource,
          // ⚠ `body: ''` AND `currentVersion: 0`, which agree with each other:
          // the invariant is "body equals the version at currentVersion", and
          // version 0 is the one version number that names no row. A `draft`
          // note has nothing to read yet and says so.
          body: '',
          status: 'draft',
          currentVersion: 0,
          sourceType: selector.sourceType,
          sourceTranscriptId: selector.sourceTranscriptId,
          sourceNoteId: selector.sourceNoteId,
          sourceObjectId: selector.sourceObjectId,
          templateId: template.id,
          contextText,
        },
      });

      return this.queueGeneration(tx, {
        note,
        kind: 'create',
        templateId: template.id,
        templateName: template.name,
        contextText,
        selector,
        providerId: provider.id,
        model,
        userId: user.id,
      });
    });

    await this.audit(user.id, 'note:create', created.note.id, {
      title,
      titleSource,
      templateId: template.id,
      sourceType: selector.sourceType,
      provider: provider.id,
      model,
    });

    this.logger.log(
      `Note ${created.note.id} created for user ${user.id} from ${selector.sourceType}; ` +
        `generation ${created.generationId} queued as job ${created.jobId}`,
    );

    return {
      note: await this.shape(created.note),
      generationId: created.generationId,
      jobId: created.jobId,
      providerId: provider.id,
      model,
    };
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  /** `GET /api/notes` — cursor-paginated, `updatedAt` descending. */
  async list(query: NoteListQueryDto, userId: string) {
    // TWO PREDICATES, NOT ONE MUTATED IN PLACE. `filterWhere` is the question
    // the caller asked; `pageWhere` is that question plus the keyset clause
    // bounding this one page. `total` counts the first, which is what makes it
    // identical on page one and on every `loadMore` — a count over `pageWhere`
    // would shrink as the user paged, and a client showing "42 notes" would
    // watch the number fall to 22 for pressing a button.
    const filterWhere = this.listWhere(query, userId);
    const cursor = decodeCursor(query.cursor);

    const pageWhere: Prisma.NoteWhereInput = cursor
      ? {
          ...filterWhere,
          // KEYSET, NOT OFFSET. See the file header.
          AND: [
            {
              OR: [
                { updatedAt: { lt: cursor.updatedAt } },
                { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : filterWhere;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.note.findMany({
        where: pageWhere,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        include: { template: { select: { name: true } } },
        // One more than asked for: the extra row answers "is there a next
        // page?" without a second `count` over the same predicate. That is
        // still true — `total` below answers a DIFFERENT question ("how many
        // match at all"), and the two are deliberately not derived from each
        // other.
        take: query.limit + 1,
      }),
      // COUNTED, NOT ESTIMATED. This predicate is owner-scoped and covered by
      // `(owner_id, updated_at desc)`, so the count is a cheap index scan over
      // one user's rows; an approximation would be a worse answer for no gain.
      // Read in the SAME transaction as the page so the count and the rows
      // cannot describe two different states of the table.
      this.prisma.note.count({ where: filterWhere }),
    ]);

    const page = rows.slice(0, query.limit);

    return {
      items: page.map((row) => listShape(row)),
      total,
      nextCursor:
        rows.length > query.limit && page.length > 0
          ? encodeCursor(page[page.length - 1])
          : null,
    };
  }

  /**
   * `GET /api/notes/summary` — the home page's ONE request.
   *
   * Three lists and four counts in a single round trip, deliberately: the
   * alternative is a home page that fires four requests and renders in four
   * stages, and the queries are cheap enough (all covered by
   * `(owner_id, updated_at desc)`) that combining them costs nothing. The same
   * arrangement `GET /api/transcripts/summary` already has.
   */
  async summary(userId: string) {
    const visible = { ownerId: userId, deletedAt: null } as const;
    const include = { template: { select: { name: true } } } as const;
    const order = [{ updatedAt: 'desc' as const }, { id: 'desc' as const }];

    const [inProgress, recent, failed, total, ready, failedCount] = await Promise.all([
      this.prisma.note.findMany({
        where: { ...visible, status: { in: ['draft', 'generating'] } },
        orderBy: order,
        include,
        take: 20,
      }),
      this.prisma.note.findMany({
        where: visible,
        orderBy: order,
        include,
        take: SUMMARY_LIST_SIZE,
      }),
      this.prisma.note.findMany({
        where: { ...visible, status: 'failed' },
        orderBy: order,
        include,
        take: SUMMARY_LIST_SIZE,
      }),
      this.prisma.note.count({ where: visible }),
      this.prisma.note.count({ where: { ...visible, status: 'ready' } }),
      this.prisma.note.count({ where: { ...visible, status: 'failed' } }),
    ]);

    return {
      inProgress: inProgress.map((row) => listShape(row)),
      recent: recent.map((row) => listShape(row)),
      failed: failed.map((row) => listShape(row)),
      counts: {
        total,
        ready,
        inProgress: inProgress.length,
        failed: failedCount,
      },
    };
  }

  /** `GET /api/notes/:id`. The controller adds the weak ETag and the 304. */
  async detail(id: string, user: RequestUser): Promise<NoteResponse> {
    const { note } = await this.access.require(user.id, id, 'view', user.permissions);

    return this.shape(note);
  }

  /** `GET /api/notes/:id/versions` — newest first, cursor-paginated. */
  async listVersions(id: string, query: NoteVersionsQueryDto, user: RequestUser) {
    const { note } = await this.access.require(user.id, id, 'view', user.permissions);

    const rows = await this.prisma.noteVersion.findMany({
      where: {
        noteId: note.id,
        // KEYSET over the version sequence itself, which is dense, unique per
        // note and never rewritten — so unlike the note list it needs no
        // timestamp tie-break.
        ...(query.cursor ? { version: { lt: decodeVersionCursor(query.cursor) } } : {}),
      },
      orderBy: { version: 'desc' },
      include: { author: { select: { id: true, displayName: true, providerDisplayName: true, email: true } } },
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);

    return {
      currentVersion: note.currentVersion,
      items: page.map((row) => versionShape(row)),
      nextCursor:
        rows.length > query.limit && page.length > 0
          ? encodeVersionCursor(page[page.length - 1].version)
          : null,
    };
  }

  /**
   * `GET /api/notes/:id/versions/:version` — one version, in full.
   *
   * ⚠ A ROW READ, NOT A REPLAY. `note_versions.body` is the whole markdown as
   * it stood (spec §4.5): a note is a page or two of prose, so an operation log
   * — with its pure reducers, its `materialize()` and its snapshot compaction —
   * would be over-engineering for a document this small. Reading history here
   * is a `findUnique`.
   */
  async getVersion(id: string, version: number, user: RequestUser) {
    const { note } = await this.access.require(user.id, id, 'view', user.permissions);

    const row = await this.prisma.noteVersion.findUnique({
      where: { noteId_version: { noteId: note.id, version } },
      include: { author: { select: { id: true, displayName: true, providerDisplayName: true, email: true } } },
    });

    if (!row) throw new NotFoundException('Note version not found');

    return {
      ...versionShape(row),
      noteId: note.id,
      body: row.body,
      isCurrent: row.version === note.currentVersion,
    };
  }

  // ===========================================================================
  // Write
  // ===========================================================================

  /**
   * `PATCH /api/notes/:id` — the title, the body, or both.
   *
   * ⚠ A TITLE CHANGE IS NOT VERSIONED, and a body change always is. A title is
   * metadata about the note rather than content of it, so recording a rename as
   * a version would put a no-op in the edit history that a later restore could
   * "undo" into a name nobody chose — the identical argument `PATCH
   * /api/transcripts/:id` makes for itself.
   *
   * ⚠ IDEMPOTENT ON `clientBatchId`. A repeated save returns the ORIGINAL
   * result and creates no second version, so a retry after a dropped connection
   * is always safe — and, importantly, does not present the user with a
   * spurious conflict against their own successful save.
   */
  async update(id: string, dto: UpdateNoteDto, user: RequestUser): Promise<NoteResponse> {
    const { note } = await this.access.require(user.id, id, 'edit', user.permissions);

    this.assertNotDeleting(note);

    if (dto.body === undefined) {
      // ⚠ A RENAME IS ALWAYS `user`. This branch exists only because a title
      // was sent, so the person editing has just told us what they want this
      // note called — the strongest signal there is, and the one the AI titling
      // path checks before it renames anything.
      const updated = await this.prisma.note.update({
        where: { id: note.id },
        data: { title: dto.title!.trim(), titleSource: 'user' },
      });

      return this.shape(updated);
    }

    // A body save while the model is writing would give the note two writers
    // and make "which text is version N" a race. The stream is the only writer
    // until it settles (spec §1.2).
    if (note.status === 'generating') {
      throw new ConflictException({
        message:
          'This note is being generated right now. Wait for it to finish, then edit it — ' +
          'your change would otherwise be overwritten by the text still arriving.',
        details: { reason: NOTE_CONFLICT_REASONS.GENERATING, currentVersion: note.currentVersion },
      });
    }

    if (dto.clientBatchId) {
      const replay = await this.prisma.noteVersion.findUnique({
        where: {
          noteId_clientBatchId: { noteId: note.id, clientBatchId: dto.clientBatchId },
        },
      });

      if (replay) {
        // The same save, arriving twice. Answer with the note as that save left
        // it rather than with a conflict against the caller's own success.
        const current = await this.prisma.note.findUnique({ where: { id: note.id } });

        return this.shape(current ?? note);
      }
    }

    if (dto.baseVersion !== note.currentVersion) {
      throw this.staleVersion(note.currentVersion, dto.baseVersion!);
    }

    const body = dto.body;
    const title = dto.title?.trim();

    const updated = await this.commitVersion({
      note,
      body,
      title,
      kind: 'edit',
      authorId: user.id,
      summary: dto.summary?.trim() || null,
      clientBatchId: dto.clientBatchId ?? null,
    });

    await this.audit(user.id, 'note:edit', note.id, {
      version: updated.currentVersion,
      renamed: title !== undefined,
    });

    return this.shape(updated);
  }

  /**
   * `POST /api/notes/:id/versions/:version/restore`.
   *
   * ⚠ HISTORY IS NEVER REWRITTEN. A restore APPENDS a new version whose body is
   * the old one's, records `restoredFromVersion`, and leaves every version in
   * between — including the one that was current a moment ago — exactly as it
   * was. **Version 1, the AI's original, is always retrievable.**
   *
   * `baseVersion` must EQUAL `currentVersion`, unlike a transcript's op batch
   * where it is informational: a restore carries no per-entity expectations of
   * its own, so a stale view means asking to discard edits the caller has never
   * seen.
   */
  async restore(
    id: string,
    version: number,
    dto: RestoreNoteVersionDto,
    user: RequestUser,
  ): Promise<NoteResponse> {
    const { note } = await this.access.require(user.id, id, 'edit', user.permissions);

    this.assertNotDeleting(note);

    if (note.status === 'generating') {
      throw new ConflictException({
        message: 'This note is being generated right now. Wait for it to finish, then restore.',
        details: { reason: NOTE_CONFLICT_REASONS.GENERATING, currentVersion: note.currentVersion },
      });
    }

    if (dto.baseVersion !== note.currentVersion) {
      throw this.staleVersion(note.currentVersion, dto.baseVersion);
    }

    const target = await this.prisma.noteVersion.findUnique({
      where: { noteId_version: { noteId: note.id, version } },
    });

    if (!target) throw new NotFoundException('Note version not found');

    if (version === note.currentVersion) {
      throw new ConflictException({
        message: 'That version is already the current one.',
        details: {
          reason: NOTE_CONFLICT_REASONS.ALREADY_CURRENT,
          currentVersion: note.currentVersion,
        },
      });
    }

    const updated = await this.commitVersion({
      note,
      body: target.body,
      kind: 'restore',
      authorId: user.id,
      summary: dto.summary?.trim() || `Restored version ${version}`,
      restoredFromVersion: version,
      clientBatchId: null,
    });

    await this.audit(user.id, 'note:version_restored', note.id, {
      restoredFromVersion: version,
      version: updated.currentVersion,
    });

    return this.shape(updated);
  }

  /**
   * `POST /api/notes/:id/regenerate` — the ONLY retry path.
   *
   * `note.generate` declares `maxAttempts: 1` (#49) precisely because a retry
   * would call the same provider with the USER'S OWN KEY a second time and, a
   * completion being non-deterministic, show them different text than the
   * partial stream they watched fail. So retrying is a person pressing a
   * button, and it enqueues a BRAND-NEW job with its own fresh one-attempt
   * budget.
   *
   * ⚠ HISTORY IS KEPT: the previous body is already a `note_versions` row and
   * stays one. A successful regeneration appends version N+1; nothing
   * overwrites N. A note that is still `ready` keeps showing its last good
   * content until the new generation commits (spec §1.1) — the status flips to
   * `generating` when the JOB starts, not when this request returns.
   */
  async regenerate(
    id: string,
    dto: RegenerateNoteDto,
    user: RequestUser,
  ): Promise<QueuedGeneration> {
    const { note } = await this.access.require(user.id, id, 'edit', user.permissions);

    this.assertNotDeleting(note);

    if (note.status === 'generating') {
      throw new ConflictException({
        message:
          'This note is already being generated. Wait for it to finish or fail before asking ' +
          'for another run — each one is billed to your own provider account.',
        details: { reason: NOTE_CONFLICT_REASONS.GENERATING, currentVersion: note.currentVersion },
      });
    }

    const templateId = dto.templateId ?? note.templateId;

    if (!templateId) {
      // The template was deleted and its reference nulled out (`SetNull`, spec
      // §4.1). A regeneration needs instructions; the caller names one.
      throw new ConflictException({
        message:
          'The template this note was generated with no longer exists. Choose a template to ' +
          'regenerate with.',
        details: { reason: NOTE_CONFLICT_REASONS.TEMPLATE_REQUIRED },
      });
    }

    const { template } = await this.templates.require(user.id, templateId, 'read');

    const selector: SourceSelector = {
      sourceType: note.sourceType,
      sourceTranscriptId: note.sourceTranscriptId,
      sourceNoteId: note.sourceNoteId,
      sourceObjectId: note.sourceObjectId,
    };

    // ⚠ THE SOURCE IS RE-AUTHORISED, not trusted because it is on the row. A
    // transcript share can be revoked between the note's creation and this
    // request, and a regeneration is a fresh read of the source text.
    await this.requests.resolveSource(sourceDto(selector), user);

    const { provider, model, policy } = await this.requests.resolveModel(
      user.id,
      dto.model ?? template.model ?? null,
      'note',
    );

    const contextText =
      dto.contextText === undefined
        ? note.contextText
        : dto.contextText && dto.contextText.trim()
          ? dto.contextText.trim()
          : null;

    await this.assertPromptFits({
      template,
      selector,
      contextText,
      provider,
      model,
      policy,
    });

    const queued = await this.prisma.$transaction(async (tx) => {
      const refreshed = await tx.note.update({
        where: { id: note.id },
        data: { templateId: template.id, contextText, failureReason: null },
      });

      return this.queueGeneration(tx, {
        note: refreshed,
        kind: 'regenerate',
        templateId: template.id,
        templateName: template.name,
        contextText,
        selector,
        providerId: provider.id,
        model,
        userId: user.id,
      });
    });

    await this.audit(user.id, 'note:regenerate', note.id, {
      templateId: template.id,
      provider: provider.id,
      model,
      fromVersion: note.currentVersion,
    });

    this.logger.log(
      `Note ${note.id} regeneration ${queued.generationId} queued as job ${queued.jobId} ` +
        `for user ${user.id}`,
    );

    return {
      note: await this.shape(queued.note),
      generationId: queued.generationId,
      jobId: queued.jobId,
      providerId: provider.id,
      model,
    };
  }

  /**
   * `DELETE /api/notes/:id` — soft delete, then purge.
   *
   * ⚠ `deleting` IS A REAL, VISIBLE STATUS RATHER THAN AN IMMEDIATE ROW DELETE.
   * A note owns storage artifacts (a source document, its extracted text, its
   * rendered exports) and removing them is work that outlives this request —
   * CLAUDE.md rule 1. Soft-deleting first makes the user-visible delete instant
   * and the cleanup durable and retryable, and means a failure to reach object
   * storage does not strand a note the user believes is gone. **There is no
   * path back.**
   *
   * ⚠ TWO REFUSALS, BOTH BEFORE THE STATE CHANGE:
   *   • `generating` → 409. `note.purge` would otherwise race the still-running
   *     `note.generate` job for the same rows, or have to know how to interrupt
   *     it; neither is a thing this design accepts (spec §1.1).
   *   • another note names this one as its source → 409 naming them.
   *     `notes.source_note_id` is `Restrict` (spec §4.1), so the row delete the
   *     purge eventually performs is refused by PostgreSQL while a derived note
   *     exists. Without this check that refusal surfaces as a raw foreign-key
   *     violation — a 500 out of a purge job, minutes after a 204 told the user
   *     their note was on its way out. The identical pre-check
   *     `TranscriptsService.remove` runs for exactly the same constraint.
   */
  async remove(id: string, user: RequestUser): Promise<void> {
    const { note } = await this.access.require(user.id, id, 'own', user.permissions);

    if (note.status === 'deleting') {
      // Already going. Idempotent rather than a 409: the caller asked for it to
      // be gone and it is on its way, which is success.
      return;
    }

    if (note.status === 'generating') {
      throw new ConflictException({
        message:
          'This note is being generated right now and cannot be deleted until that finishes. ' +
          'Cancel or wait, then delete it.',
        details: { reason: NOTE_CONFLICT_REASONS.GENERATING },
      });
    }

    await this.assertNoDerivedNotes(note.id);

    await this.prisma.note.update({
      where: { id: note.id },
      data: { status: 'deleting', deletedAt: new Date() },
    });

    await this.audit(user.id, 'note:delete', note.id, {
      title: note.title,
      status: note.status,
    });

    await this.enqueuePurge(note.id);
  }

  // ===========================================================================
  // Retitle (issue #184, epic #163)
  // ===========================================================================

  /**
   * `POST /api/notes/{id}/retitle` — name ONE note from what it says.
   *
   * The action behind "Suggest a title". Returns as soon as the job is queued;
   * the title changes when it settles.
   *
   * ⚠ `force: true`, AND THIS IS THE ONE PLACE IT IS EVER PASSED. The bulk
   * sweep below must never rename a title a person chose, because it renames
   * notes nobody is looking at and there is no undo. A person pressing this
   * button on a note they named themselves has asked, explicitly and about this
   * one note, for a suggestion — refusing them on the strength of a column they
   * never saw would be the application overruling the user to protect them from
   * a choice they just made. See `NoteTitleService`'s header for the same
   * argument stated where the guard lives.
   *
   * ⚠ `skipDedup: true`, UNLIKE THE SWEEP, and for a reason that is specific
   * rather than stylistic: a sweep may already have a `note.retitle` job
   * pending for this note carrying `force: false`, and dedup would collapse
   * this request into it — returning 202 with a job id for a job that will read
   * `force: false`, skip the note, and leave the user pressing a button that
   * does nothing. Two retitles of one note are idempotent (the second re-reads
   * the row), so the cost of not deduplicating is one extra small request and
   * the cost of deduplicating is a silently broken button.
   */
  async retitle(id: string, user: RequestUser): Promise<QueuedRetitle> {
    const { note } = await this.access.require(user.id, id, 'edit', user.permissions);

    if (note.status === 'generating') {
      // A generation names the note itself the moment it commits (#182, spec
      // §3.4). A retitle running alongside it would be two passes racing for
      // one title, and the loser's tokens are spent either way.
      throw new ConflictException({
        message:
          'This note is being generated right now, and the generation will name it when it ' +
          'finishes. Wait for it, then ask for a new title if you want a different one.',
        details: { reason: NOTE_CONFLICT_REASONS.GENERATING },
      });
    }

    const job = await this.jobs.enqueue({
      type: NOTE_RETITLE_JOB_TYPE,
      // The enum has no "a user asked for this" member, and `upload` would
      // claim the job descends from an upload, which a rename plainly does not.
      reason: 'rerun',
      subjectType: NOTE_SUBJECT_TYPE,
      subjectId: note.id,
      payload: { noteId: note.id, force: true } satisfies Prisma.InputJsonObject,
      // No `priority`: the column default (`0`) outranks the sweep by
      // construction. See `NOTE_RETITLE_JOB_PRIORITY`.
      skipDedup: true,
    });

    await this.audit(user.id, 'note:retitle', note.id, {
      titleSource: note.titleSource,
      jobId: job.id,
    });

    return { noteId: note.id, jobId: job.id };
  }

  /**
   * `POST /api/notes/retitle` — the bulk sweep, one capped page at a time.
   *
   * ⚠ THE SELECTION IS `titleSource: 'template'`, WHICH IS NARROWER THAN
   * "NOT `user`", AND THE NARROWING IS WHAT MAKES THE SWEEP TERMINATE.
   * `title_source` has three values. `user` is a name a person chose and is
   * never touched here. `ai` is a note this exact pass has ALREADY named from
   * its own content — re-running it spends the owner's money to re-derive an
   * answer they already have. `template` is precisely the problem this endpoint
   * exists for: a note called whatever its template was called. Selecting
   * "everything that is not `user`" would re-include every note the sweep had
   * just finished with, so `remaining` could never reach zero and a caller
   * following the resumption protocol would loop forever, billing themselves
   * each lap. A successful rename writes `titleSource: 'ai'` and the note
   * leaves the selection; that is the whole convergence argument.
   *
   * ⚠ OLDEST `updatedAt` FIRST, and the direction is load-bearing too. A rename
   * touches the row, so `@updatedAt` moves a titled note to the BACK of this
   * ordering — the next call's page is the next hundred that still need it,
   * with no cursor for the caller to carry and no page to lose. Newest-first
   * would hand back the same hundred every time. It also picks the right notes
   * first: the ones untouched for longest are the ones least likely to be
   * renamed by their owner in the next minute.
   *
   * ⚠ NO `skipDedup`, DELIBERATELY, AND IT IS THE OPPOSITE CHOICE FROM
   * `retitle` ABOVE. `type` + `note` + id is the active dedup key, so a note
   * that already has a `note.retitle` job pending or running collapses into it:
   * pressing the button twice cannot queue one note twice, and an impatient
   * caller cannot bill themselves twice for one library.
   *
   * `remaining` is counted at request time, so it does not yet reflect the jobs
   * this call just queued. Call again once they settle; `0` means done.
   */
  async retitleAll(user: RequestUser): Promise<RetitleSweep> {
    const where: Prisma.NoteWhereInput = {
      ownerId: user.id,
      deletedAt: null,
      // Only a `ready` note has a settled body to name it from. A `draft` or
      // `generating` note is about to be named by its own generation; a
      // `failed` one has no content at all.
      status: 'ready',
      titleSource: 'template',
    };

    const total = await this.prisma.note.count({ where });

    const notes = await this.prisma.note.findMany({
      where,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: RETITLE_SWEEP_LIMIT,
      select: { id: true },
    });

    for (const note of notes) {
      await this.jobs.enqueue({
        type: NOTE_RETITLE_JOB_TYPE,
        // Scheduled work over rows that already exist — the same reading
        // `enqueueHousekeepingJob` gives its own sweeps.
        reason: 'backfill',
        subjectType: NOTE_SUBJECT_TYPE,
        subjectId: note.id,
        // ⚠ NO `force`. A sweep renames notes nobody is watching; see
        // `retitle` above for why only that route may set it.
        payload: { noteId: note.id } satisfies Prisma.InputJsonObject,
        priority: NOTE_RETITLE_JOB_PRIORITY,
      });
    }

    // ⚠ WRITTEN INLINE RATHER THAN THROUGH `audit()`, which hardcodes
    // `targetType: 'note'`. This action has no single note as its target — the
    // target is the caller's own library — and filing it under a note id that
    // happened to be in the page would make the audit trail claim something
    // that is not true about that note.
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: user.id,
        action: 'note:retitle-sweep',
        targetType: 'user',
        targetId: user.id,
        meta: { queued: notes.length, total } satisfies Prisma.InputJsonObject,
      },
    });

    this.logger.log(
      `Queued ${notes.length} retitle job(s) for user ${user.id}; ${Math.max(total - notes.length, 0)} remain`,
    );

    return { queued: notes.length, remaining: Math.max(total - notes.length, 0) };
  }

  /**
   * Queue `note.purge` for one note.
   *
   * Shared with `notes.housekeeping`, which re-queues a note that has been
   * sitting in `deleting` with no purge job — a purge whose row was lost is a
   * note the user believes is gone and whose bytes are still there.
   */
  async enqueuePurge(noteId: string): Promise<void> {
    await this.jobs.enqueue({
      type: NOTE_PURGE_JOB_TYPE,
      reason: 'rerun',
      subjectType: NOTE_SUBJECT_TYPE,
      subjectId: noteId,
      payload: { noteId },
    });
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Write one new version and the body it denormalizes to, in ONE transaction.
   *
   * ⚠ THE VERSION NUMBER IS CLAIMED BY A GUARDED `updateMany`, not by reading
   * `currentVersion` and adding one. Two writers (this save and a generation
   * committing moments earlier) would otherwise both compute the same next
   * version and `@@unique([noteId, version])` would reject one of them at
   * random, with a 500. Here the loser sees `count === 0` and is told, in the
   * words every other stale writer is told, what the note is actually at.
   */
  private async commitVersion(input: {
    note: Note;
    body: string;
    title?: string;
    kind: 'edit' | 'restore';
    authorId: string;
    summary: string | null;
    restoredFromVersion?: number;
    clientBatchId: string | null;
  }): Promise<Note> {
    const nextVersion = input.note.currentVersion + 1;

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.note.updateMany({
        where: {
          id: input.note.id,
          currentVersion: input.note.currentVersion,
          deletedAt: null,
        },
        data: {
          currentVersion: nextVersion,
          body: input.body,
          // ⚠ `titleSource` MOVES ONLY WITH THE TITLE. A body-only save (and a
          // restore, which supplies none) must leave the provenance exactly as
          // it was — otherwise every edit would quietly claim the user named a
          // note the AI or the template named, and the titling path would stop
          // renaming notes nobody ever titled.
          ...(input.title !== undefined
            ? { title: input.title, titleSource: 'user' as const }
            : {}),
          // A note whose body a human just wrote is no longer `failed`: the
          // failure was the generation's, and there is content now.
          ...(input.note.status === 'failed' ? { status: 'ready' as const, failureReason: null } : {}),
        },
      });

      if (claimed.count === 0) {
        throw this.staleVersion(
          (await tx.note.findUnique({ where: { id: input.note.id } }))?.currentVersion ??
            input.note.currentVersion,
          input.note.currentVersion,
        );
      }

      await tx.noteVersion.create({
        data: {
          noteId: input.note.id,
          version: nextVersion,
          kind: input.kind,
          body: input.body,
          summary: input.summary,
          // ⚠ A REAL AUTHOR ID HERE, ALWAYS. `null` means the AI (spec §4.5) —
          // a convention, not a missing value — so a human edit recorded with a
          // null author would claim the model wrote it.
          authorId: input.authorId,
          restoredFromVersion: input.restoredFromVersion ?? null,
          clientBatchId: input.clientBatchId,
        },
      });

      const updated = await tx.note.findUnique({ where: { id: input.note.id } });

      // Unreachable — the guarded update above already proved the row is there.
      if (!updated) throw new NotFoundException('Note not found');

      return updated;
    });
  }

  /**
   * Create the `note_generations` row and the `note.generate` job together, and
   * point the note at it.
   *
   * ⚠ `currentGenerationId` IS SET AT ENQUEUE TIME AND NEVER CLEARED (spec
   * §1.3), so a `ready` note's pointer always names the generation that
   * produced its current content — which is what lets the stream endpoint and
   * the detail page find "the generation to watch" with no query across
   * `note_generations`.
   *
   * ⚠ `skipDedup: true`, for the same reason a preview needs it: two
   * regenerations of one note are two pieces of work the user deliberately
   * asked for. Without it the second request would silently return the first
   * job, and the user would watch a run they had already seen.
   */
  private async queueGeneration(
    tx: Prisma.TransactionClient,
    input: {
      note: Note;
      kind: 'create' | 'regenerate';
      templateId: string;
      templateName: string;
      contextText: string | null;
      selector: SourceSelector;
      providerId: string;
      model: string;
      userId: string;
    },
  ): Promise<{ note: Note; generation: NoteGeneration; generationId: string; jobId: string }> {
    const generation = await tx.noteGeneration.create({
      data: {
        noteId: input.note.id,
        kind: input.kind,
        status: 'pending',
        templateId: input.templateId,
        templateNameSnapshot: input.templateName,
        contextText: input.contextText,
        sourceType: input.selector.sourceType,
        sourceTranscriptId: input.selector.sourceTranscriptId,
        sourceNoteId: input.selector.sourceNoteId,
        sourceObjectId: input.selector.sourceObjectId,
        providerId: input.providerId,
        model: input.model,
      },
    });

    const job = await this.jobs.enqueueWithin(tx, {
      type: NOTE_GENERATE_JOB_TYPE,
      reason: input.kind === 'create' ? 'upload' : 'rerun',
      subjectType: NOTE_SUBJECT_TYPE,
      subjectId: input.note.id,
      payload: {
        generationId: generation.id,
        // The handler reads the note's owner off the row; `userId` is carried
        // anyway so every `note.generate` payload has the same shape whether or
        // not there is a note behind it (a preview has none).
        userId: input.userId,
      } satisfies Prisma.InputJsonObject,
      skipDedup: true,
    });

    await tx.noteGeneration.update({
      where: { id: generation.id },
      data: { jobId: job.id },
    });

    const note = await tx.note.update({
      where: { id: input.note.id },
      data: { currentGenerationId: generation.id },
    });

    return { note, generation, generationId: generation.id, jobId: job.id };
  }

  /**
   * Assemble the prompt this request WOULD send and refuse early with a number
   * (spec §3.3), using the same pure functions the job itself calls.
   */
  private async assertPromptFits(input: {
    template: {
      instructions: string;
      outputFormat: string;
      structure: Prisma.JsonValue;
      tone: string | null;
      length: string | null;
    };
    selector: SourceSelector;
    contextText: string | null;
    provider: ResolvedModel['provider'];
    model: string;
    policy: ResolvedModel['policy'];
  }): Promise<void> {
    const source = await this.sources.resolve(input.selector);

    const prompt = assemblePrompt({
      templateInstructions: input.template.instructions,
      templateOutputFormat: input.template.outputFormat,
      templateStructure: parseTemplateStructure(input.template.structure),
      templateTone: input.template.tone,
      templateLength: input.template.length,
      contextText: input.contextText,
      sourceText: source.text,
    });

    this.requests.assertPromptFits({
      provider: input.provider,
      model: input.model,
      policy: input.policy,
      systemPrompt: prompt.systemPrompt,
      userContent: prompt.userContent,
    });
  }

  /** The `where` clause for one list request. Owner-scoped, always. */
  private listWhere(query: NoteListQueryDto, userId: string): Prisma.NoteWhereInput {
    const where: Prisma.NoteWhereInput = { ownerId: userId, deletedAt: null };

    if (query.status) where.status = query.status;
    if (query.sourceType) where.sourceType = query.sourceType;
    if (query.sourceTranscriptId) where.sourceTranscriptId = query.sourceTranscriptId;
    if (query.sourceNoteId) where.sourceNoteId = query.sourceNoteId;
    if (query.sourceObjectId) where.sourceObjectId = query.sourceObjectId;
    if (query.templateId) where.templateId = query.templateId;
    if (query.q) where.title = { contains: query.q, mode: 'insensitive' };

    return where;
  }

  /**
   * Refuse the delete with a 409 while any note still names this one as its
   * source.
   *
   * ⚠ `deletedAt` IS DELIBERATELY NOT FILTERED OUT — the identical subtlety
   * `TranscriptsService.assertNoDependentNotes` documents for itself. A note's
   * soft delete sets `deleted_at` and nothing else: the row, and therefore the
   * foreign key, is still there. Ignoring soft-deleted derivatives would let
   * this delete proceed and hand `note.purge` exactly the foreign-key violation
   * this check exists to prevent, with the note now stuck in a state there is
   * no path back from. The MESSAGE carries the distinction instead.
   */
  private async assertNoDerivedNotes(noteId: string): Promise<void> {
    const blocking = await this.prisma.note.findMany({
      where: { sourceNoteId: noteId },
      select: { id: true, title: true, deletedAt: true },
      orderBy: { createdAt: 'asc' },
    });

    if (blocking.length === 0) return;

    const purging = blocking.filter((entry) => entry.deletedAt !== null);
    const live = blocking.length - purging.length;

    const message =
      live === 0
        ? `This note has ${plural(purging.length, 'deleted note')} generated from it that ` +
          `${purging.length === 1 ? 'has' : 'have'} not finished purging yet. Try again shortly.`
        : `This note cannot be deleted while ${plural(live, 'note')} generated from it still ` +
          `${live === 1 ? 'exists' : 'exist'}. Delete ${live === 1 ? 'it' : 'them'} first.`;

    throw new ConflictException({
      message,
      details: {
        reason: NOTE_CONFLICT_REASONS.DERIVED_NOTES_EXIST,
        blockingCount: blocking.length,
        pendingPurgeCount: purging.length,
        notes: blocking.map((entry) => ({
          id: entry.id,
          title: entry.title,
          pendingPurge: entry.deletedAt !== null,
        })),
      },
    });
  }

  /** A note on its way out takes no more writes. */
  private assertNotDeleting(note: Note): void {
    if (note.status !== 'deleting' && note.deletedAt === null) return;

    throw new ConflictException({
      message: 'This note is being deleted.',
      details: { reason: NOTE_CONFLICT_REASONS.DELETING },
    });
  }

  /**
   * The 409 a stale `baseVersion` produces.
   *
   * ⚠ `currentVersion` IS IN THE BODY, under `details`. A client that cannot
   * see what the note is actually at cannot show the user what they are about
   * to overwrite, which is the entire reason this is a 409 rather than a
   * last-write-wins update.
   */
  private staleVersion(currentVersion: number, baseVersion: number): ConflictException {
    return new ConflictException({
      message:
        `This note is at version ${currentVersion}; you were editing version ${baseVersion}. ` +
        'Reload to see the current text, then re-apply your change.',
      details: { reason: NOTE_CONFLICT_REASONS.STALE_BASE_VERSION, currentVersion },
    });
  }

  /** The detail projection. One definition, used by every route that returns a note. */
  private async shape(note: Note): Promise<NoteResponse> {
    const template = note.templateId
      ? await this.prisma.noteTemplate.findUnique({
          where: { id: note.templateId },
          select: { name: true },
        })
      : null;

    return detailShape(note, template?.name ?? null);
  }

  /** One audit row. `targetType: 'note'`, matching the subject naming. */
  private async audit(
    userId: string,
    action: string,
    noteId: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'note',
        targetId: noteId,
        meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}

/** The note detail projection. Exported for the shapes' own spec. */
export function detailShape(note: Note, templateName: string | null): NoteResponse {
  return {
    id: note.id,
    title: note.title,
    titleSource: note.titleSource,
    body: note.body,
    status: note.status,
    currentVersion: note.currentVersion,
    provider: note.provider,
    model: note.model,
    sourceType: note.sourceType,
    sourceTranscriptId: note.sourceTranscriptId,
    sourceNoteId: note.sourceNoteId,
    sourceObjectId: note.sourceObjectId,
    templateId: note.templateId,
    templateName,
    contextText: note.contextText,
    currentGenerationId: note.currentGenerationId,
    failureReason: note.failureReason,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

/** The list-row projection: everything the detail carries, with an excerpt for a body. */
export function listShape(
  note: Note & { template?: { name: string } | null },
): NoteListItem {
  const { body, contextText, ...rest } = detailShape(note, note.template?.name ?? null);

  void body;
  void contextText;

  return { ...rest, excerpt: excerpt(note.body) };
}

/** One version, as both version routes report it. */
export function versionShape(
  row: NoteVersion & {
    author?: {
      id: string;
      displayName: string | null;
      providerDisplayName: string | null;
      email: string;
    } | null;
  },
) {
  return {
    version: row.version,
    kind: row.kind,
    summary: row.summary,
    // ⚠ `null` MEANS THE AI. A version with no author is version 1 of an
    // AI-generated note, not a row whose author went missing.
    author: row.author
      ? {
          id: row.author.id,
          name:
            row.author.displayName || row.author.providerDisplayName || row.author.email,
        }
      : null,
    generationId: row.generationId,
    restoredFromVersion: row.restoredFromVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The first {@link EXCERPT_CHARS} characters of a body, on a whitespace boundary. */
export function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();

  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS).trimEnd()}…`;
}

/**
 * A stored selector, back as the request-shaped union.
 *
 * Regeneration re-authorises the note's EXISTING source, and the one authority
 * on "may this caller read that" takes the request shape. Converting here keeps
 * a second, row-shaped access path from existing at all.
 */
function sourceDto(selector: SourceSelector) {
  if (selector.sourceType === 'transcript') {
    return { type: 'transcript' as const, transcriptId: selector.sourceTranscriptId! };
  }

  if (selector.sourceType === 'note') {
    return { type: 'note' as const, noteId: selector.sourceNoteId! };
  }

  return { type: 'document' as const, objectId: selector.sourceObjectId! };
}

/** `updatedAt|id`, base64url. Opaque to the client, trivially decodable here. */
export function encodeCursor(note: Pick<Note, 'updatedAt' | 'id'>): string {
  return Buffer.from(`${note.updatedAt.toISOString()}|${note.id}`, 'utf8').toString('base64url');
}

/**
 * The other half of {@link encodeCursor}.
 *
 * Returns `null` for anything malformed rather than throwing: a cursor is a
 * value a client copied from a previous response, and a stale or truncated one
 * should restart the list from the top, not 500.
 */
export function decodeCursor(
  cursor: string | undefined,
): { updatedAt: Date; id: string } | null {
  if (!cursor) return null;

  try {
    const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');

    if (!timestamp || !id) return null;

    const updatedAt = new Date(timestamp);

    if (Number.isNaN(updatedAt.getTime())) return null;

    return { updatedAt, id };
  } catch {
    return null;
  }
}

/** The version-history cursor: just a version number, since the sequence is dense. */
export function encodeVersionCursor(version: number): string {
  return Buffer.from(String(version), 'utf8').toString('base64url');
}

/** `Number.MAX_SAFE_INTEGER` for anything malformed — i.e. "start from the top". */
export function decodeVersionCursor(cursor: string): number {
  try {
    const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));

    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** `1, 'note'` → `"1 note"`. A file-local pluraliser; every noun it counts is regular. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
