// =============================================================================
// GraphExportService (issue #386, docs/specs/ontology.md §12, §18.2)
// =============================================================================
//
// The request half of `kg.export`: queue (or reuse) an export, poll one, list
// them. The render itself is the job's (`kg-export.handler.ts`) — there is no
// size below which it happens inside the request (CLAUDE.md rule 1).
//
// WHY POST + GET, NOT `GET /api/graph/export?format=` (the spec's first
// sketch): a GET that enqueues work is unsafe to prefetch — a browser, a link
// previewer or a crawler following it would start a render.
//
// CONTENT-ADDRESSED REUSE, like `POST /api/notes/{id}/exports`: an unexpired,
// non-failed export with the same `(owner, format, graph_fingerprint)` is
// returned with `reused: true` (a 200) instead of rendering the same graph
// again. A `failed` row is never reused — asking again must actually retry.
// The queue's own dedup is a different mechanism for a different race (see
// `note-export.service.ts`'s header); each export row is its own job subject.
//
// OWNER-SCOPED, 404 NEVER 403: every lookup is `WHERE owner_id = caller`, so a
// foreign export id is indistinguishable from a missing one. There is no
// `graph:read_any` (§12).
// =============================================================================

import { ConflictException, Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { ONTOLOGY_VERSION, kvNamespace } from '@marinoscar/kvox-contract/ontology';

import { contentDisposition } from '../../notes/index.js';
import { GRAPH_CONFLICT_REASONS, GraphObjectsService, KG_EXPORT_JOB_TYPE, KG_SUBJECT_EXPORT } from '../../graph/index.js';
import type { CreateGraphExportResponse, GraphExportList, KgExportView } from './dto/graph-export.dto.js';
import { GraphExportSource } from './graph-export.source.js';
import { graphExportFilename, type GraphExportFormat } from './graph-export-formats.js';
import { graphFingerprint } from './graph-fingerprint.js';
import { KVOX_BRAND, type KvoxBrand } from '../../core/index.js';
import { KVOX_PRISMA, KVOX_JOBS, type KvoxJobsPort } from '../../ports/index.js';
import type { KvoxGraphDb, KgExportRow as KgExport, KgExportFormatValue as KgExportFormat } from '../../graph/index.js';

/** An export and its file live this long (spec §18.2, notes.md §8). */
/**
 * KG_EXPORT_TTL_DAYS.
 *
 * @stability experimental
 */
export const KG_EXPORT_TTL_DAYS = 7;

/** Someone is waiting for a file — the `note.export`/`transcript.export` priority. */
export const KG_EXPORT_JOB_PRIORITY = -10;

/** How long a download URL lives. */
export const KG_EXPORT_DOWNLOAD_TTL_SECONDS = 15 * 60;

/** Most exports `GET /api/graph/exports` returns. */
export const KG_EXPORT_LIST_LIMIT = 20;

/** The fingerprint of `ownerId`'s graph for `format`, as of now. */
export async function currentFingerprint(
  source: GraphExportSource,
  ownerId: string,
  format: GraphExportFormat,
  appSlug: string,
): Promise<string> {
  return graphFingerprint({
    ontologyVersion: ONTOLOGY_VERSION,
    format,
    namespace: kvNamespace(appSlug),
    tables: await source.fingerprintTables(ownerId),
  });
}

/**
 * GraphExportService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphExportService {
  private readonly logger = new Logger(GraphExportService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly source: GraphExportSource,
    private readonly objects: GraphObjectsService,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_BRAND) private readonly brand: KvoxBrand,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /api/graph/exports
  // ---------------------------------------------------------------------------

  /**
   * Request export.
   */
  async requestExport(ownerId: string, format: GraphExportFormat): Promise<CreateGraphExportResponse> {
    if (!(await this.source.hasExportableRows(ownerId))) {
      throw new ConflictException({
        message: 'Your graph has nothing to export yet. Review a note’s proposal to add people and organizations.',
        details: { reason: GRAPH_CONFLICT_REASONS.GRAPH_EMPTY },
      });
    }

    const fingerprint = await currentFingerprint(this.source, ownerId, format, this.brand.appSlug);
    const now = new Date();

    const existing = await this.prisma.kgExport.findFirst({
      where: {
        ownerId,
        format: format as KgExportFormat,
        graphFingerprint: fingerprint,
        status: { in: ['pending', 'running', 'ready'] },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      this.logger.log(`Reusing graph export ${existing.id} (${format})`);
      return { export: await this.view(existing), reused: true };
    }

    const row = await this.prisma.kgExport.create({
      data: {
        ownerId,
        format: format as KgExportFormat,
        status: 'pending',
        graphFingerprint: fingerprint,
        ontologyVersion: ONTOLOGY_VERSION,
        expiresAt: new Date(now.getTime() + KG_EXPORT_TTL_DAYS * 24 * 3_600_000),
      },
    });

    // A build without the handler must not queue a row no worker can claim —
    // and must say so on the export, or the dialog would spin forever.
    if (!this.jobs.isRegistered(KG_EXPORT_JOB_TYPE)) {
      const failed = await this.prisma.kgExport.update({
        where: { id: row.id },
        data: { status: 'failed', errorMessage: 'This deployment has no graph export worker registered.' },
      });
      this.logger.error(`No handler is registered for ${KG_EXPORT_JOB_TYPE}; export ${row.id} cannot run`);
      return { export: await this.view(failed), reused: false };
    }

    const job = await this.jobs.enqueue({
      type: KG_EXPORT_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_EXPORT,
      subjectId: row.id,
      payload: { mode: 'render', exportId: row.id },
      priority: KG_EXPORT_JOB_PRIORITY,
    });
    const linked = await this.prisma.kgExport.update({ where: { id: row.id }, data: { jobId: job.id } });

    this.logger.log(`Queued graph export ${row.id} (${format}) as job ${job.id}`);
    return { export: await this.view(linked), reused: false };
  }

  // ---------------------------------------------------------------------------
  // GET /api/graph/exports/:id and GET /api/graph/exports
  // ---------------------------------------------------------------------------

  /**
   * Get.
   */
  async get(ownerId: string, id: string): Promise<KgExportView> {
    const row = await this.prisma.kgExport.findFirst({ where: { id, ownerId, expiresAt: { gt: new Date() } } });
    if (!row) throw new NotFoundException('Export not found');
    return this.view(row);
  }

  /**
   * List.
   */
  async list(ownerId: string): Promise<GraphExportList> {
    const rows = await this.prisma.kgExport.findMany({
      where: { ownerId, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: KG_EXPORT_LIST_LIMIT,
    });
    return { exports: await Promise.all(rows.map((row) => this.view(row))) };
  }

  /** One row as the API reports it, signing a download when it is ready. */
  async view(row: KgExport): Promise<KgExportView> {
    const format = row.format as GraphExportFormat;
    const filename = graphExportFilename(this.brand.appSlug, row.createdAt, format);
    let downloadUrl: string | null = null;
    if (row.status === 'ready' && row.objectId) {
      const signed = await this.objects.signedUrlFor(
        row.objectId,
        KG_EXPORT_DOWNLOAD_TTL_SECONDS,
        contentDisposition(filename),
      );
      downloadUrl = signed?.url ?? null;
    }
    return {
      id: row.id,
      format,
      status: row.status,
      ontologyVersion: row.ontologyVersion,
      stats: (row.stats ?? {}) as KgExportView['stats'],
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      downloadUrl,
      filename,
    };
  }
}
