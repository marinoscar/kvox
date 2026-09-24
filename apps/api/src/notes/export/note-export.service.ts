// =============================================================================
// NoteExportService (issue #54, epic #45, docs/specs/notes.md §8.4)
// =============================================================================
//
// The three routes' server half, plus the one thing the `note.export` job
// handler needs from this module: `buildDocument(exportRow)`.
//
// -----------------------------------------------------------------------------
// THE REUSE LOOKUP IS NOT THE QUEUE'S DEDUP, AND NEITHER SUBSTITUTES
// -----------------------------------------------------------------------------
//
// `POST /api/notes/:id/exports` hashes `{ format, version, options }` and looks
// for an existing, UNEXPIRED `note_exports` row with the same
// `(noteId, version, format, options_hash)` — the `note_exports_lookup_idx`
// issue #48 declares for exactly this. A match answers **200** with that export
// and renders nothing.
//
// `docs/specs/transcription.md` §8.5 states, and `docs/specs/notes.md` §8.4
// cites, why this is a DIFFERENT mechanism from the queue's active-dedup index:
// the queue's index covers `pending`/`running` rows only and exists to collapse
// two people asking for the same thing at the same instant, whereas a reusable
// export is normally `ready` — a terminal state that the active-dedup predicate
// cannot see at all. One stops a double render; the other stops a re-download
// an hour later from rendering a second identical file. That is also why the
// export job is enqueued with `skipDedup: true`: three exports of one note in
// three formats are legitimately distinct work, and the queue's subject-scoped
// key would collapse them into one.
//
// ⚠ A `failed` ROW IS NEVER REUSED. It is the one status the lookup excludes,
// because "you asked for this before and it broke" is not an answer to "please
// export this" — a retry must actually retry. A `pending` row IS reused, so two
// clicks a second apart share one render rather than starting two.
//
// -----------------------------------------------------------------------------
// WHY THE OPTIONS ARE VALIDATED TWICE
// -----------------------------------------------------------------------------
//
// The global `ZodValidationPipe` validates the envelope (`format`, `version`,
// `options` as an object) because that is all a pipe can know before the
// request reaches a handler. WHICH option keys are legal depends on the format
// the body named, so the second pass — against the chosen exporter's own schema
// — happens here. It is also the pass that APPLIES DEFAULTS, and the defaults
// are what get hashed and stored, which is what makes `{}` and
// `{"includePageNumbers": true}` the same export rather than two.
//
// -----------------------------------------------------------------------------
// ⚠ EVERY ROUTE GOES THROUGH `NoteAccessService`, AND SO 404s NEVER 403s
// -----------------------------------------------------------------------------
//
// Including the download, which names no note id in its path: it looks the
// export row up, then authorises the NOTE that row belongs to. Answering 404
// for an export whose note the caller cannot see is what keeps the export id
// from becoming an oracle for the existence of somebody else's note.
// =============================================================================

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Note, NoteExport, Prisma } from '@prisma/client';

import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { JobsService } from '../../jobs/jobs.service';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { hashExportRequest, type ExportOptions } from '../../export/export-options';
import { NoteAccessService } from '../access/note-access.service';
import type { CreateNoteExportDto } from '../dto/note-export.dto';
import { NOTE_EXPORT_JOB_TYPE, NOTE_SUBJECT_TYPE } from '../job-types';
import { NoteObjectsService } from '../note-objects.service';
import {
  buildNoteExportDocument,
  noteExportFilename,
  type NoteExportDocument,
  type NoteExportSource,
} from './note-export-document';
import { NoteExporterRegistry, type NoteExporter } from './note-exporter.registry';

/** Spec §8.4: an export is a reproducible artifact with a bounded life. */
export const NOTE_EXPORT_TTL_DAYS = 7;

/**
 * Ascending is more urgent (`docs/specs/job-queue.md` §4.4), so this is the
 * opposite end of the spectrum from `HOUSEKEEPING_PRIORITY = 100`.
 *
 * Spec §8.5's table gives the reason in one phrase: somebody is watching a
 * spinner waiting for a download. Identical to `transcript.export`'s −10, and
 * deliberately the same number rather than a new one — two "a user is waiting"
 * job types that disagreed about how urgent that is would make the queue's
 * ordering arbitrary.
 */
export const NOTE_EXPORT_JOB_PRIORITY = -10;

/** How long a download URL lives. Long enough to click, short enough to leak. */
export const NOTE_EXPORT_DOWNLOAD_TTL_SECONDS = 15 * 60;

/** The export, as every route reports it. */
export interface NoteExportView {
  id: string;
  noteId: string;
  version: number;
  format: string;
  options: ExportOptions;
  status: 'pending' | 'ready' | 'failed';
  reused: boolean;
  mimeType: string;
  filename: string;
  sizeBytes: string | null;
  error: string | null;
  downloadUrl: string | null;
  downloadExpiresAt: string | null;
  expiresAt: string;
  createdAt: string;
}

/** What `POST /:id/exports` answers, and which status code it answers with. */
export interface CreateNoteExportResult {
  export: NoteExportView;
  /** False when an existing export was returned — the caller answers 200. */
  created: boolean;
}

/** What `GET /api/notes/exports/:id/download` answers. */
export interface NoteExportDownload {
  url: string;
  expiresAt: string;
  filename: string;
  mimeType: string;
  sizeBytes: string;
}

@Injectable()
export class NoteExportService {
  private readonly logger = new Logger(NoteExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NoteAccessService,
    private readonly objects: NoteObjectsService,
    private readonly registry: NoteExporterRegistry,
    private readonly handlers: JobHandlerRegistry,
    private readonly jobs: JobsService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /api/notes/exporters
  // ---------------------------------------------------------------------------

  listExporters() {
    return {
      exporters: this.registry.all().map((exporter) => ({
        format: exporter.format,
        label: exporter.label,
        mimeType: exporter.mimeType,
        extension: exporter.extension,
        options: exporter.options.map((option) => ({ ...option })),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/notes/:id/exports
  // ---------------------------------------------------------------------------

  async requestExport(
    noteId: string,
    dto: CreateNoteExportDto,
    user: RequestUser,
  ): Promise<CreateNoteExportResult> {
    // `notes:write`, not `notes:read`. Unlike a transcript — where a viewer
    // share may take the conversation they were shown out of the application —
    // a note has no sharing in this epic (spec §6.2), so every caller who
    // reaches here is the owner and the only question left is whether they hold
    // the write permission. Requiring it keeps the route's `@Auth` and the
    // service's own check saying the same thing.
    const { note } = await this.access.require(user.id, noteId, 'edit', user.permissions);

    const exporter = this.requireExporter(dto.format);
    const version = dto.version ?? note.currentVersion;

    if (version < 1 || version > note.currentVersion) {
      throw new NotFoundException(`Version ${version} does not exist for this note`);
    }

    const options = this.parseOptions(exporter, dto.options);
    const optionsHash = hashExportRequest({ format: exporter.format, version, options });
    const now = new Date();

    const existing = await this.prisma.noteExport.findFirst({
      where: {
        noteId,
        version,
        format: exporter.format,
        optionsHash,
        status: { in: ['pending', 'ready'] },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      this.logger.log(
        `Reusing export ${existing.id} for note ${noteId} v${version} (${exporter.format})`,
      );

      return { export: await this.view(existing, note.title, true), created: false };
    }

    const row = await this.prisma.noteExport.create({
      data: {
        noteId,
        version,
        format: exporter.format,
        options: options as Prisma.InputJsonValue,
        optionsHash,
        status: 'pending',
        requestedById: user.id,
        expiresAt: new Date(now.getTime() + NOTE_EXPORT_TTL_DAYS * 24 * 3_600_000),
      },
    });

    // ⚠ THE REGISTRY GUARD `job-types.ts` REQUIRES. A build without the handler
    // must queue nothing rather than queue a row no worker can ever claim,
    // which would sit `pending` forever and show in the admin job list as a
    // permanent backlog of one. Here it also has to mark the row, because a
    // `pending` export with no job behind it is a spinner that never stops.
    if (!this.handlers.get(NOTE_EXPORT_JOB_TYPE)) {
      const failed = await this.prisma.noteExport.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          error: 'This deployment has no note export worker registered.',
        },
      });

      this.logger.error(
        `No handler is registered for ${NOTE_EXPORT_JOB_TYPE}; export ${row.id} cannot run`,
      );

      return { export: await this.view(failed, note.title, false), created: true };
    }

    const job = await this.jobs.enqueue({
      type: NOTE_EXPORT_JOB_TYPE,
      // The enum has no "a user asked for this" member, and `upload` would
      // claim the job descends from an upload — which an export of a five-day
      // old note plainly does not.
      reason: 'rerun',
      subjectType: NOTE_SUBJECT_TYPE,
      subjectId: noteId,
      payload: { exportId: row.id, noteId },
      priority: NOTE_EXPORT_JOB_PRIORITY,
      // See the file header: three formats of one note are distinct work.
      skipDedup: true,
    });

    const linked = await this.prisma.noteExport.update({
      where: { id: row.id },
      data: { jobId: job.id },
    });

    await this.audit(user.id, noteId, {
      exportId: row.id,
      format: exporter.format,
      version,
      options,
    });

    this.logger.log(
      `Queued export ${row.id} (${exporter.format}, v${version}) for note ${noteId} as job ${job.id}`,
    );

    return { export: await this.view(linked, note.title, false), created: true };
  }

  // ---------------------------------------------------------------------------
  // GET /api/notes/:id/exports
  // ---------------------------------------------------------------------------

  async listExports(noteId: string, user: RequestUser): Promise<{ exports: NoteExportView[] }> {
    const { note } = await this.access.require(user.id, noteId, 'view', user.permissions);

    const rows = await this.prisma.noteExport.findMany({
      where: { noteId },
      orderBy: { createdAt: 'desc' },
      // An export lives seven days and a note has three formats; a page of
      // fifty is every export anybody could plausibly be holding at once, and
      // a cursor for a list that self-empties in a week would be ceremony.
      take: 50,
    });

    return {
      exports: await Promise.all(rows.map((row) => this.view(row, note.title, false))),
    };
  }

  // ---------------------------------------------------------------------------
  // GET /api/notes/exports/:exportId/download
  // ---------------------------------------------------------------------------

  async download(exportId: string, user: RequestUser): Promise<NoteExportDownload> {
    const row = await this.prisma.noteExport.findUnique({ where: { id: exportId } });

    // ⚠ THE SAME 404 A STRANGER GETS FOR A NOTE, and it is reached in two
    // different ways on purpose: the row does not exist, or `require` refuses
    // the note behind it. Both answer identically, so an export id cannot be
    // used to discover that somebody else's note exists.
    if (!row) throw new NotFoundException('Export not found');

    const { note } = await this.access.require(user.id, row.noteId, 'view', user.permissions);

    if (row.status !== 'ready' || !row.objectId) {
      throw new NotFoundException(
        row.status === 'failed'
          ? 'This export failed to render; request it again.'
          : 'This export is still rendering.',
      );
    }

    const filename = this.filenameFor(row, note.title);
    const signed = await this.objects.signedUrlFor(
      row.objectId,
      NOTE_EXPORT_DOWNLOAD_TTL_SECONDS,
      contentDisposition(filename),
    );

    if (!signed) {
      throw new NotFoundException('The rendered file is no longer available.');
    }

    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      filename,
      mimeType: this.registry.get(row.format)?.mimeType ?? 'application/octet-stream',
      sizeBytes: signed.object.size.toString(),
    };
  }

  // ---------------------------------------------------------------------------
  // The job handler's half
  // ---------------------------------------------------------------------------

  /** The exporter for a stored row's `format`, or undefined if unregistered. */
  exporterFor(format: string): NoteExporter | undefined {
    return this.registry.get(format);
  }

  /**
   * Build the document for one export row.
   *
   * ⚠ THE BODY COMES FROM `note_versions`, NEVER FROM `notes.body`, even when
   * the requested version IS the current one. `notes.body` is the LIVE working
   * copy and moves under a concurrent edit; the version row is immutable. If
   * the two ever disagree for `currentVersion`, the version log is right by
   * definition — it is what `GET /api/notes/:id/versions/:v` serves and what a
   * restore replays — and an export that quietly shipped the live copy would be
   * a file whose stated version does not match its contents.
   */
  async buildDocument(row: NoteExport): Promise<NoteExportDocument> {
    const note = await this.prisma.note.findUnique({
      where: { id: row.noteId },
      include: { template: { select: { name: true } } },
    });

    if (!note || note.deletedAt !== null) throw new NotFoundException('Note not found');

    const version = await this.prisma.noteVersion.findUnique({
      where: { noteId_version: { noteId: row.noteId, version: row.version } },
      include: { author: { select: { displayName: true, email: true } } },
    });

    if (!version) {
      throw new NotFoundException(`Version ${row.version} does not exist for this note`);
    }

    return buildNoteExportDocument({
      noteId: note.id,
      title: note.title,
      body: version.body,
      // The VERSION's own format (#337): `(noteId, version)` now fixes the
      // format too, so the content-addressed optionsHash needs no format term.
      bodyFormat: version.bodyFormat,
      version: row.version,
      createdAt: version.createdAt,
      exportedAt: new Date(),
      author: version.author
        ? {
            displayName: version.author.displayName ?? version.author.email,
            email: version.author.email,
          }
        : null,
      provider: note.provider ? { id: note.provider, model: note.model } : null,
      // The template NAME, resolved through the relation rather than stored on
      // the export: a template the user has since renamed should export under
      // the name it has now, which is the name they would recognise.
      templateName: note.template?.name ?? null,
      source: await this.resolveSource(note),
    });
  }

  /** The stored options, parsed back out of JSONB with defaults re-applied. */
  optionsOf(row: NoteExport, exporter: NoteExporter): ExportOptions {
    const parsed = exporter.optionsSchema.safeParse(row.options ?? {});

    // A row written by an older build may carry an option this build's schema
    // no longer accepts. Rendering with the defaults is strictly better than
    // failing a job over a checkbox: the user gets their document.
    return parsed.success ? parsed.data : this.parseOptions(exporter, {});
  }

  /** `<title> (v<n>).<ext>` for one row. Shared by the view and the download. */
  filenameFor(row: NoteExport, title: string): string {
    return noteExportFilename(title, row.version, this.registry.get(row.format)?.extension ?? row.format);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * The provenance source, resolved from whichever of the three columns is set.
   *
   * A MISSING SOURCE ROW IS NOT AN ERROR. A transcript the user deleted after
   * generating a note from it leaves `sourceTranscriptId` pointing at nothing,
   * and refusing to export the note at that point would make the note itself
   * hostage to its evidence still existing — the exact opposite of "the user
   * should never need this application to access information they created with
   * it." The provenance line then says what is still true: the kind of source
   * and its id.
   */
  private async resolveSource(note: Note): Promise<NoteExportSource> {
    if (note.sourceType === 'transcript' && note.sourceTranscriptId) {
      const transcript = await this.prisma.transcript.findUnique({
        where: { id: note.sourceTranscriptId },
        select: { title: true, createdAt: true },
      });

      return {
        type: 'transcript',
        id: note.sourceTranscriptId,
        title: transcript?.title ?? 'Deleted recording',
        date: transcript?.createdAt ?? null,
      };
    }

    if (note.sourceType === 'note' && note.sourceNoteId) {
      const source = await this.prisma.note.findUnique({
        where: { id: note.sourceNoteId },
        select: { title: true, createdAt: true },
      });

      return {
        type: 'note',
        id: note.sourceNoteId,
        title: source?.title ?? 'Deleted note',
        date: source?.createdAt ?? null,
      };
    }

    const objectId = note.sourceObjectId;

    if (objectId) {
      const object = await this.prisma.storageObject.findUnique({
        where: { id: objectId },
        select: { name: true, createdAt: true },
      });

      return {
        type: 'document',
        id: objectId,
        title: object?.name ?? 'Deleted document',
        date: object?.createdAt ?? null,
      };
    }

    return { type: note.sourceType, id: note.id, title: 'Unknown source', date: null };
  }

  /** The exporter, or a 400 that names the formats that do exist. */
  private requireExporter(format: string): NoteExporter {
    const exporter = this.registry.get(format);

    if (!exporter) {
      throw new BadRequestException(
        `Unknown export format "${format}". Available formats: ` +
          `${this.registry.formats().join(', ')}.`,
      );
    }

    return exporter;
  }

  /** The second validation pass. See the file header. */
  private parseOptions(exporter: NoteExporter, raw: unknown): ExportOptions {
    const parsed = exporter.optionsSchema.safeParse(raw ?? {});

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      throw new BadRequestException(
        `Invalid options for the "${exporter.format}" export: ` +
          `${issue ? `${issue.path.join('.') || '(root)'} — ${issue.message}` : 'unreadable'}. ` +
          `Accepted options: ${exporter.options.map((option) => option.key).join(', ') || 'none'}.`,
      );
    }

    return parsed.data;
  }

  /** One row as the API reports it, signing a download when there is one. */
  private async view(row: NoteExport, title: string, reused: boolean): Promise<NoteExportView> {
    const exporter = this.registry.get(row.format);
    const filename = this.filenameFor(row, title);

    let downloadUrl: string | null = null;
    let downloadExpiresAt: string | null = null;
    let sizeBytes: string | null = null;

    if (row.status === 'ready' && row.objectId) {
      const signed = await this.objects.signedUrlFor(
        row.objectId,
        NOTE_EXPORT_DOWNLOAD_TTL_SECONDS,
        contentDisposition(filename),
      );

      if (signed) {
        downloadUrl = signed.url;
        downloadExpiresAt = signed.expiresAt.toISOString();
        sizeBytes = signed.object.size.toString();
      }
    }

    return {
      id: row.id,
      noteId: row.noteId,
      version: row.version,
      format: row.format,
      options: (row.options ?? {}) as ExportOptions,
      status: row.status,
      reused,
      mimeType: exporter?.mimeType ?? 'application/octet-stream',
      filename,
      sizeBytes,
      error: row.error,
      downloadUrl,
      downloadExpiresAt,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** One audit row, matching `NotesService.audit`'s shape exactly. */
  private async audit(
    userId: string,
    noteId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'note:export',
        targetType: 'note',
        targetId: noteId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}

/**
 * The `Content-Disposition` value the signed URL carries.
 *
 * BOTH FORMS, per RFC 6266: a quoted ASCII `filename` every client understands,
 * and `filename*` in UTF-8 for the ones that do. A title containing `é` — or a
 * quote, which would otherwise terminate the quoted string early and let the
 * rest of the name be read as header parameters — must not be able to produce a
 * malformed header, so the ASCII form is reduced to a conservative set and the
 * real name travels in `filename*`.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
