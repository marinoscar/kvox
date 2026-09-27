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

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { KgExport, KgExportFormat } from '@prisma/client';
import { APP_SLUG } from '@app/shared';
import { ONTOLOGY_VERSION, kvNamespace } from '@app/shared/ontology';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobsService } from '../../jobs/jobs.service';
import { contentDisposition } from '../../notes/export/note-export.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GRAPH_CONFLICT_REASONS } from '../graph-conflict-reasons';
import { GraphObjectsService } from '../graph-objects.service';
import { KG_EXPORT_JOB_TYPE, KG_SUBJECT_EXPORT } from '../job-types';
import type { CreateGraphExportResponse, GraphExportList, KgExportView } from './dto/graph-export.dto';
import { GraphExportSource } from './graph-export.source';
import { graphExportFilename, type GraphExportFormat } from './graph-export-formats';
import { graphFingerprint } from './graph-fingerprint';

/** An export and its file live this long (spec §18.2, notes.md §8). */
export const KG_EXPORT_TTL_DAYS = 7;

/** Someone is waiting for a file — the `note.export`/`transcript.export` priority. */
export const KG_EXPORT_JOB_PRIORITY = -10;

/** How long a download URL lives. */
export const KG_EXPORT_DOWNLOAD_TTL_SECONDS = 15 * 60;

/** Most exports `GET /api/graph/exports` returns. */
export const KG_EXPORT_LIST_LIMIT = 20;

/** The fingerprint of `ownerId`'s graph for `format`, as of now. */
export async function currentFingerprint(source: GraphExportSource, ownerId: string, format: GraphExportFormat): Promise<string> {
  return graphFingerprint({
    ontologyVersion: ONTOLOGY_VERSION,
    format,
    namespace: kvNamespace(APP_SLUG),
    tables: await source.fingerprintTables(ownerId),
  });
}

@Injectable()
export class GraphExportService {
  private readonly logger = new Logger(GraphExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly source: GraphExportSource,
    private readonly objects: GraphObjectsService,
    private readonly handlers: JobHandlerRegistry,
    private readonly jobs: JobsService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /api/graph/exports
  // ---------------------------------------------------------------------------

  async requestExport(ownerId: string, format: GraphExportFormat): Promise<CreateGraphExportResponse> {
    if (!(await this.source.hasExportableRows(ownerId))) {
      throw new ConflictException({
        message: 'Your graph has nothing to export yet. Review a note’s proposal to add people and organizations.',
        details: { reason: GRAPH_CONFLICT_REASONS.GRAPH_EMPTY },
      });
    }

    const fingerprint = await currentFingerprint(this.source, ownerId, format);
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
    if (!this.handlers.get(KG_EXPORT_JOB_TYPE)) {
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

  async get(ownerId: string, id: string): Promise<KgExportView> {
    const row = await this.prisma.kgExport.findFirst({ where: { id, ownerId, expiresAt: { gt: new Date() } } });
    if (!row) throw new NotFoundException('Export not found');
    return this.view(row);
  }

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
    const filename = graphExportFilename(APP_SLUG, row.createdAt, format);
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
