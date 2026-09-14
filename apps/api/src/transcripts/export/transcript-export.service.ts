// =============================================================================
// TranscriptExportService (issue #28, epic #19, spec §8.5)
// =============================================================================
//
// The three routes' server half, plus the one thing the job handler needs from
// this module: `buildDocument(exportRow)`.
//
// -----------------------------------------------------------------------------
// THE REUSE LOOKUP IS NOT THE QUEUE'S DEDUP, AND NEITHER SUBSTITUTES
// -----------------------------------------------------------------------------
//
// `POST /:id/exports` hashes `{ format, version, options }` and looks for an
// existing, UNEXPIRED `transcript_exports` row with the same
// `(transcriptId, version, format, options_hash)` — the index issue #24
// declares for exactly this. A match answers **200** with that export and
// renders nothing.
//
// Spec §8.5 is emphatic that this is a different mechanism from the queue's
// active-dedup index, and the distinction is worth keeping in view while
// editing: the queue's index covers `pending`/`running` rows only and exists to
// collapse two people asking for the same thing at the same instant, whereas a
// reusable export is normally `ready` — a terminal state that the active-dedup
// predicate cannot see at all. One stops a double render; the other stops a
// re-download an hour later from rendering a second identical file. That is
// also why the export job is enqueued with `skipDedup: true`: several exports
// of one transcript in different formats are legitimately distinct work, and
// the queue's subject-scoped key would collapse them into one.
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
// the body named, so the second pass — against the chosen exporter's own
// schema — happens here. It is also the pass that APPLIES DEFAULTS, and the
// defaults are what get hashed and stored, which is what makes `{}` and
// `{"includeTimestamps": true}` the same export rather than two.
// =============================================================================

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, TranscriptExport } from '@prisma/client';

import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateTranscriptExportDto } from '../dto/transcript-export.dto';
import {
  TRANSCRIPT_EXPORT_JOB_TYPE,
  TRANSCRIPT_SUBJECT_TYPE,
} from '../job-types';
import { TranscriptAccessService } from '../transcript-access.service';
import { TranscriptMaterializeService } from '../transcript-materialize.service';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { buildExportDocument, type ExportDocument } from './export-document';
import { hashExportRequest, type ExportOptions } from './export-options';
import {
  TranscriptExporterRegistry,
  type TranscriptExporter,
} from './transcript-exporter.interface';

/** Spec §8.5: an export is a reproducible artifact with a bounded life. */
export const EXPORT_TTL_DAYS = 7;

/**
 * Ascending is more urgent (`docs/specs/job-queue.md` §4.4), so this is the
 * opposite end of the spectrum from `HOUSEKEEPING_PRIORITY = 100`.
 *
 * Spec §1.5.6 gives the reason in one sentence: a user is looking at a spinner
 * waiting for a download. It is the one job type in this epic where jumping the
 * queue slightly is the right answer.
 */
export const EXPORT_JOB_PRIORITY = -10;

/** How long a download URL lives. Long enough to click, short enough to leak. */
export const EXPORT_DOWNLOAD_TTL_SECONDS = 15 * 60;

/** The export, as every route reports it. */
export interface TranscriptExportView {
  id: string;
  transcriptId: string;
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
export interface CreateExportResult {
  export: TranscriptExportView;
  /** False when an existing export was returned — the caller answers 200. */
  created: boolean;
}

@Injectable()
export class TranscriptExportService {
  private readonly logger = new Logger(TranscriptExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TranscriptAccessService,
    private readonly materialize: TranscriptMaterializeService,
    private readonly objects: TranscriptObjectsService,
    private readonly registry: TranscriptExporterRegistry,
    private readonly jobs: JobsService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /api/transcripts/exporters
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
  // POST /api/transcripts/:id/exports
  // ---------------------------------------------------------------------------

  async requestExport(
    transcriptId: string,
    dto: CreateTranscriptExportDto,
    user: RequestUser,
  ): Promise<CreateExportResult> {
    // VIEW, not edit. Exporting reads; a viewer share is entitled to take the
    // conversation they were shown out of this application (spec §8's premise).
    const { transcript } = await this.access.require(user.id, transcriptId, 'view');

    const exporter = this.requireExporter(dto.format);
    const version = dto.version ?? transcript.currentVersion;

    if (version < 1 || version > transcript.currentVersion) {
      throw new NotFoundException(`Version ${version} does not exist for this transcript`);
    }

    const options = this.parseOptions(exporter, dto.options);
    const optionsHash = hashExportRequest({ format: exporter.format, version, options });
    const now = new Date();

    const existing = await this.prisma.transcriptExport.findFirst({
      where: {
        transcriptId,
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
        `Reusing export ${existing.id} for transcript ${transcriptId} v${version} ` +
          `(${exporter.format})`,
      );

      return { export: await this.view(existing, transcript.title, true), created: false };
    }

    const row = await this.prisma.transcriptExport.create({
      data: {
        transcriptId,
        version,
        format: exporter.format,
        options: options as Prisma.InputJsonValue,
        optionsHash,
        status: 'pending',
        requestedById: user.id,
        expiresAt: new Date(now.getTime() + EXPORT_TTL_DAYS * 24 * 3_600_000),
      },
    });

    const job = await this.jobs.enqueue({
      type: TRANSCRIPT_EXPORT_JOB_TYPE,
      // The enum has no "a user asked for this" member, and `upload` would
      // claim the job descends from an upload — which an export of a five-day
      // old transcript plainly does not.
      reason: 'rerun',
      subjectType: TRANSCRIPT_SUBJECT_TYPE,
      subjectId: transcriptId,
      payload: { exportId: row.id, transcriptId },
      priority: EXPORT_JOB_PRIORITY,
      // See the file header: two formats of one transcript are distinct work.
      skipDedup: true,
    });

    const linked = await this.prisma.transcriptExport.update({
      where: { id: row.id },
      data: { jobId: job.id },
    });

    await this.audit(user.id, transcriptId, {
      exportId: row.id,
      format: exporter.format,
      version,
      options,
    });

    this.logger.log(
      `Queued export ${row.id} (${exporter.format}, v${version}) for transcript ` +
        `${transcriptId} as job ${job.id}`,
    );

    return { export: await this.view(linked, transcript.title, false), created: true };
  }

  // ---------------------------------------------------------------------------
  // GET /api/transcripts/:id/exports/:exportId
  // ---------------------------------------------------------------------------

  async getExport(
    transcriptId: string,
    exportId: string,
    user: RequestUser,
  ): Promise<TranscriptExportView> {
    const { transcript } = await this.access.require(user.id, transcriptId, 'view');

    const row = await this.prisma.transcriptExport.findFirst({
      // ⚠ THE `transcriptId` PREDICATE IS THE AUTHORISATION, not a tidy extra
      // filter. Looking the export up by id alone and checking afterwards would
      // let a caller with access to transcript A read the status — and the
      // download URL — of an export belonging to transcript B.
      where: { id: exportId, transcriptId },
    });

    if (!row) throw new NotFoundException('Export not found');

    return this.view(row, transcript.title, false);
  }

  // ---------------------------------------------------------------------------
  // The job handler's half
  // ---------------------------------------------------------------------------

  /** The exporter for a stored row's `format`, or undefined if unregistered. */
  exporterFor(format: string): TranscriptExporter | undefined {
    return this.registry.get(format);
  }

  /**
   * Build the document for one export row.
   *
   * Everything that is NOT in `EditingState` — the title, the language, the
   * duration, the version's author, the provider — is read here, from the rows,
   * so the exporters stay pure and the handler stays thin.
   */
  async buildDocument(row: TranscriptExport): Promise<ExportDocument> {
    const transcript = await this.prisma.transcript.findUnique({
      where: { id: row.transcriptId },
      select: {
        id: true,
        title: true,
        language: true,
        durationMs: true,
        provider: true,
        providerOptions: true,
        deletedAt: true,
      },
    });

    if (!transcript || transcript.deletedAt !== null) {
      throw new NotFoundException('Transcript not found');
    }

    const [materialized, version] = await Promise.all([
      this.materialize.materialize(row.transcriptId, row.version),
      this.prisma.transcriptVersion.findUnique({
        where: { transcriptId_version: { transcriptId: row.transcriptId, version: row.version } },
        select: {
          createdAt: true,
          author: { select: { displayName: true, email: true } },
        },
      }),
    ]);

    return buildExportDocument({
      transcriptId: transcript.id,
      title: transcript.title,
      language: transcript.language,
      durationMs: transcript.durationMs,
      version: row.version,
      // A version row should always exist for a version `materialize` accepted.
      // Falling back to "now" rather than throwing keeps a render possible for
      // a transcript whose history predates a column; the date is the one field
      // in the document nothing depends on being exact.
      createdAt: version?.createdAt ?? new Date(),
      exportedAt: new Date(),
      author: version?.author
        ? { displayName: version.author.displayName ?? version.author.email, email: version.author.email }
        : null,
      provider: { id: transcript.provider, model: readModel(transcript.providerOptions) },
      state: materialized.state,
    });
  }

  /** The stored options, parsed back out of JSONB with defaults re-applied. */
  optionsOf(row: TranscriptExport, exporter: TranscriptExporter): ExportOptions {
    const parsed = exporter.optionsSchema.safeParse(row.options ?? {});

    // A row written by an older build may carry an option this build's schema
    // no longer accepts. Rendering with the defaults is strictly better than
    // failing a job over a checkbox: the user gets their document.
    return parsed.success ? parsed.data : this.parseOptions(exporter, {});
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** The exporter, or a 400 that names the formats that do exist. */
  private requireExporter(format: string): TranscriptExporter {
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
  private parseOptions(exporter: TranscriptExporter, raw: unknown): ExportOptions {
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
  private async view(
    row: TranscriptExport,
    title: string,
    reused: boolean,
  ): Promise<TranscriptExportView> {
    const exporter = this.registry.get(row.format);
    const extension = exporter?.extension ?? row.format;
    const filename = exportFilename(title, row.version, extension);

    let downloadUrl: string | null = null;
    let downloadExpiresAt: string | null = null;
    let sizeBytes: string | null = null;

    if (row.status === 'ready' && row.objectId) {
      const signed = await this.objects.signedUrlFor(
        row.objectId,
        EXPORT_DOWNLOAD_TTL_SECONDS,
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
      transcriptId: row.transcriptId,
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

  /** One audit row, matching `TranscriptsService.audit`'s shape exactly. */
  private async audit(
    userId: string,
    transcriptId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'transcript:export',
        targetType: 'transcript',
        targetId: transcriptId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}

/**
 * `<title> (v<n>).<ext>`, spec §8's own shape, made safe for a filename.
 *
 * Path separators, control characters and the Windows-reserved set are replaced
 * rather than stripped, so two differently-punctuated titles cannot collapse
 * onto one name. A title that reduces to nothing (all punctuation, or a name in
 * a script this replacement removes) falls back to `transcript`, because an
 * attachment called `(v3).pdf` is worse than a generic one.
 */
export function exportFilename(title: string, version: number, extension: string): string {
  const safe = title
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["*/:<>?\\|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Bounded so the whole name stays inside the 255-byte limit every
    // filesystem and every browser's download path has.
    .slice(0, 120)
    .replace(/[. ]+$/, '');

  return `${safe || 'transcript'} (v${version}).${extension}`;
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

/** The provider's model out of `provider_options`, when it recorded one. */
function readModel(value: Prisma.JsonValue | null): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const model = (value as Record<string, unknown>).model;

  return typeof model === 'string' && model.length > 0 ? model : null;
}
