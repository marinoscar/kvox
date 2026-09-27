// =============================================================================
// `kg.export` (issue #386, docs/specs/ontology.md §11, §18.2)
// =============================================================================
//
// Two modes, one type (no new job type for housekeeping):
//
//   render (default) — payload `{ mode: 'render', exportId }`, subject
//     `kg_export`/<id>. Reads the owner's graph in pages of 1,000, turns every
//     row into triples through `GraphRdfDatasetBuilder`, serializes them
//     (`serializers.ts`) and STREAMS the bytes into a `managed_by: 'graph'`
//     object — `pipeline()` into the upload, both awaited (the `db.backup.run`
//     discipline: either alone can report success on a truncated file). Never
//     buffers the file. Then `status: ready`, `stats`, `object_id`, an audit
//     row `graph.exported`.
//   sweep — payload `{ mode: 'sweep' }`, subject `kg_export_sweep`, enqueued
//     daily by `KgExportExpiryTask`. Deletes up to 500 expired exports and
//     their files.
//
// READ ORDER IS IRI ORDER. The file is written as the rows arrive, so they are
// read in the order their IRIs sort: the ontology header, `kv:attr/…`,
// `kv:entity/…` (each with its outgoing edges' direct triples), `kv:evidence/…`,
// `kv:export/<id>`, `kv:item/…`, `kv:note/…` labels, `kv:relation/…`,
// `kv:segment/…` labels — every reader keyset-paginates on `id`. With the
// builder's per-subject ordering, identical graphs produce identical bytes.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY — `note.export`'s reason, and the input is the private graph
// -----------------------------------------------------------------------------
//
// It carries neither `nodeResultSchema` nor `persistNodeResult`, so no worker
// node can claim it. The serializers live in the API: a second copy in
// `apps/cli` could render the same export differently, breaking the promise
// content-addressed reuse makes (the second caller gets the first caller's
// bytes). And its input is not an artefact a node could be handed — it reads
// five tables mid-computation (CLAUDE.md rule 2's exemption), across the
// owner's private graph.
//
// PROFILE `{ maxRuntimeMs: 10 min, maxAttempts: 3 }` (spec §11). Retry-safe: a
// re-run renders the same bytes (the export's own `created_at` is the
// generation time, and the storage key is a pure function of the row) over the
// same key, and the stored object row is reused.
//
// ⚠ Log `{ exportId, format, counts, bytes, ms }` only — never a label, quote
// or statement. `errorMessage` is short and generic for the same reason.
// =============================================================================

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, KgExport, Prisma } from '@prisma/client';
import { APP_SLUG } from '@app/shared';
import { ONTOLOGY, ONTOLOGY_VERSION, kvNamespace } from '@app/shared/ontology';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphObjectsService } from '../graph-objects.service';
import { evidenceIri } from '../rdf/iris';
import { KG_EXPORT_JOB_TYPE, KG_SUBJECT_EXPORT } from '../job-types';
import { currentFingerprint } from './graph-export.service';
import { GRAPH_EXPORT_PAGE_SIZE, GraphExportSource } from './graph-export.source';
import { GRAPH_EXPORT_FORMAT_INFO, graphExportFilename, type GraphExportFormat } from './graph-export-formats';
import {
  GraphRdfDatasetBuilder,
  entityRefIds,
  type RdfSubjectBlock,
} from './rdf-dataset-builder';
import { serializeGraph } from './serializers';

export const KG_EXPORT_MAX_RUNTIME_MS = 10 * 60_000;

/** Most expired exports one sweep deletes. */
export const KG_EXPORT_SWEEP_BATCH = 500;

/** The audit action written when an export becomes ready. */
export const GRAPH_EXPORTED_ACTION = 'graph.exported';

const nonNull = <T>(xs: Array<T | null>): T[] => xs.filter((x): x is T => x !== null);

@Injectable()
export class KgExportHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(KgExportHandler.name);
  private readonly ns = kvNamespace(APP_SLUG);

  readonly type = KG_EXPORT_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: KG_EXPORT_MAX_RUNTIME_MS, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly source: GraphExportSource,
    private readonly objects: GraphObjectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = asRecord(job.payload);
    if (payload.mode === 'sweep') {
      await this.sweep();
      return;
    }
    const exportId = typeof payload.exportId === 'string' ? payload.exportId : job.subjectType === KG_SUBJECT_EXPORT ? job.subjectId : null;
    if (!exportId) {
      this.logger.warn(`Export job ${job.id} names no export; nothing to do`);
      return;
    }

    const row = await this.prisma.kgExport.findUnique({ where: { id: exportId } });
    if (!row) {
      // Swept, or its owner's graph was purged, while the job sat in the queue.
      this.logger.log(`Export ${exportId} no longer exists; job ${job.id} has nothing to do`);
      return;
    }
    if (row.status === 'ready' && row.objectId !== null) {
      this.logger.log(`Export ${exportId} is already ready; job ${job.id} is a no-op`);
      return;
    }

    try {
      await this.render(row);
    } catch (error) {
      // Marked BEFORE the rethrow: the user polling the export must be told,
      // and the queue must still see a failed attempt (retry budget, job list).
      const name = error instanceof Error ? error.name : 'Error';
      await this.prisma.kgExport
        .update({
          where: { id: row.id },
          data: { status: 'failed', errorMessage: `The export could not be completed (${name}). Request it again.` },
        })
        .catch((updateError: unknown) => {
          this.logger.error(
            `Could not record the failure of export ${row.id}: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
          );
        });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // render
  // ---------------------------------------------------------------------------

  private async render(row: KgExport): Promise<void> {
    const started = Date.now();
    const format = row.format as GraphExportFormat;
    const info = GRAPH_EXPORT_FORMAT_INFO[format];
    await this.prisma.kgExport.update({ where: { id: row.id }, data: { status: 'running', errorMessage: null } });

    // What the file will actually contain: re-read at render time, so a graph
    // that changed after the request is reused under its new signature.
    const fingerprint = await currentFingerprint(this.source, row.ownerId, format);
    const defs = await this.source.attributeDefs(row.ownerId);
    const builder = new GraphRdfDatasetBuilder({
      ns: this.ns,
      registry: ONTOLOGY,
      attributeDefs: defs,
      exportId: row.id,
      generatedAt: row.createdAt,
      ontologyVersion: ONTOLOGY_VERSION,
    });

    const { body, done } = this.objects.putStream({
      // A pure function of the row: a retry overwrites, never orphans.
      storageKey: `graph/${row.ownerId}/exports/${row.id}.${info.extension}`,
      name: graphExportFilename(APP_SLUG, row.createdAt, format),
      mimeType: info.mimeType,
      ownerId: row.ownerId,
      metadata: { exportId: row.id, format, kind: 'graph-export' },
    });

    const text = Readable.from(serializeGraph(format, this.ns, this.batches(row.ownerId, builder, defs)));
    const [, object] = await Promise.all([pipeline(text, body), done]);

    const bytes = Number(object.size);
    const stats = { ...builder.stats, bytes };
    await this.prisma.kgExport.update({
      where: { id: row.id },
      data: {
        status: 'ready',
        objectId: object.id,
        graphFingerprint: fingerprint,
        stats: stats as Prisma.InputJsonValue,
        errorMessage: null,
      },
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: row.ownerId,
        action: GRAPH_EXPORTED_ACTION,
        targetType: KG_SUBJECT_EXPORT,
        targetId: row.id,
        meta: {
          exportId: row.id,
          format,
          counts: {
            entities: stats.entities,
            relations: stats.relations,
            items: stats.items,
            evidence: stats.evidence,
            excludedSensitive: stats.excludedSensitive,
          },
        },
      },
    });

    this.logger.log(
      JSON.stringify({
        msg: 'graph export ready',
        exportId: row.id,
        format,
        entities: stats.entities,
        relations: stats.relations,
        items: stats.items,
        bytes,
        ms: Date.now() - started,
      }),
    );
  }

  /** Every batch of subject blocks, in IRI order (see the header). */
  private async *batches(
    ownerId: string,
    builder: GraphRdfDatasetBuilder,
    defs: Awaited<ReturnType<GraphExportSource['attributeDefs']>>,
  ): AsyncGenerator<RdfSubjectBlock[]> {
    yield [builder.ontologyHeader(), ...builder.attributeDefinitions()];

    // --- kv:entity/… -----------------------------------------------------------
    for (let after: string | null = null; ; ) {
      const page = await this.source.entityPage(ownerId, after);
      if (page.length === 0) break;
      const ids = page.map((e) => e.id);
      const [aliases, evidence, outgoing, refTypes] = await Promise.all([
        this.source.aliasesFor(ids),
        this.source.evidenceIdsFor(ownerId, 'entity', ids),
        this.source.outgoingRelations(ownerId, ids),
        this.source.exportedEntityTypes(ownerId, page.flatMap((e) => entityRefIds(ONTOLOGY, e.type, e.props, defs))),
      ]);
      const byFrom = new Map<string, typeof outgoing>();
      for (const rel of outgoing) byFrom.set(rel.fromId, [...(byFrom.get(rel.fromId) ?? []), rel]);
      yield nonNull(
        page.map((e) =>
          builder.entity({
            ...e,
            aliases: aliases.get(e.id) ?? [],
            evidenceIds: evidence.get(e.id) ?? [],
            refTypes,
            outgoing: byFrom.get(e.id) ?? [],
          }),
        ),
      );
      if (page.length < GRAPH_EXPORT_PAGE_SIZE) break;
      after = ids[ids.length - 1];
    }

    // --- kv:evidence/… (collecting the cited sources' labels) ---------------
    const segmentLabels = new Map<string, string>();
    const noteLabels = new Map<string, { noteId: string; version: number; title: string }>();
    for (let after: string | null = null; ; ) {
      const page = await this.source.evidencePage(ownerId, after);
      if (page.length === 0) break;
      const blocks = nonNull(page.map((ev) => builder.evidence(ev)));
      const kept = new Set(blocks.map((b) => b.subject));
      const cited = page.filter((ev) => kept.has(evidenceIri(this.ns, ev.id)));
      const segmentIds = [...new Set(cited.flatMap((ev) => (ev.segmentId ? [ev.segmentId] : [])))];
      const noteRefs = cited.filter((ev) => !ev.segmentId && ev.noteId && ev.noteVersion);
      const titles = await this.source.sourceTitles(ownerId, segmentIds, [...new Set(noteRefs.map((ev) => ev.noteId as string))]);
      for (const [id, title] of titles.segments) segmentLabels.set(id, title);
      for (const ev of noteRefs) {
        const title = titles.notes.get(ev.noteId as string);
        if (title !== undefined) {
          noteLabels.set(`${ev.noteId}/v${ev.noteVersion}`, { noteId: ev.noteId as string, version: ev.noteVersion as number, title });
        }
      }
      yield blocks;
      if (page.length < GRAPH_EXPORT_PAGE_SIZE) break;
      after = page[page.length - 1].id;
    }

    // --- kv:export/<id> --------------------------------------------------------
    yield [builder.exportHeader()];

    // --- kv:item/… -------------------------------------------------------------
    for (let after: string | null = null; ; ) {
      const page = await this.source.itemPage(ownerId, after);
      if (page.length === 0) break;
      const ids = page.map((i) => i.id);
      const itemTypeKey = (kind: string) => ONTOLOGY.entityTypes().find((t) => t.itemKind === kind)?.key ?? '';
      const [evidence, supersedes, types] = await Promise.all([
        this.source.evidenceIdsFor(ownerId, 'item', ids),
        this.source.supersededBy(ownerId, ids),
        this.source.exportedEntityTypes(
          ownerId,
          page.flatMap((i) => [
            ...[i.subjectId, i.meetingId, i.ownerPersonId, i.counterpartyId].filter((x): x is string => x !== null),
            ...entityRefIds(ONTOLOGY, itemTypeKey(i.kind), i.props, defs),
          ]),
        ),
      ]);
      yield nonNull(
        page.map((i) =>
          builder.item({
            ...i,
            subject: GraphExportSource.ref(types, i.subjectId),
            meeting: GraphExportSource.ref(types, i.meetingId),
            ownerPerson: GraphExportSource.ref(types, i.ownerPersonId),
            counterparty: GraphExportSource.ref(types, i.counterpartyId),
            supersedes: supersedes.get(i.id) ?? [],
            evidenceIds: evidence.get(i.id) ?? [],
            refTypes: types,
          }),
        ),
      );
      if (page.length < GRAPH_EXPORT_PAGE_SIZE) break;
      after = ids[ids.length - 1];
    }

    // --- kv:note/…/v<n> labels, by IRI ----------------------------------------
    const notes = [...noteLabels.values()]
      .map((n) => builder.noteSpanLabel(n.noteId, n.version, n.title))
      .sort((a, b) => compare(a.subject, b.subject));
    for (let i = 0; i < notes.length; i += GRAPH_EXPORT_PAGE_SIZE) yield notes.slice(i, i + GRAPH_EXPORT_PAGE_SIZE);

    // --- kv:relation/… (reified) -----------------------------------------------
    for (let after: string | null = null; ; ) {
      const page = await this.source.relationPage(ownerId, after);
      if (page.length === 0) break;
      const evidence = await this.source.evidenceIdsFor(ownerId, 'relation', page.map((r) => r.id));
      yield nonNull(page.map((r) => builder.relation({ ...r, evidenceIds: evidence.get(r.id) ?? [] })));
      if (page.length < GRAPH_EXPORT_PAGE_SIZE) break;
      after = page[page.length - 1].id;
    }

    // --- kv:segment/… labels, by IRI -------------------------------------------
    const segments = [...segmentLabels.entries()]
      .map(([id, title]) => builder.segmentLabel(id, title))
      .sort((a, b) => compare(a.subject, b.subject));
    for (let i = 0; i < segments.length; i += GRAPH_EXPORT_PAGE_SIZE) yield segments.slice(i, i + GRAPH_EXPORT_PAGE_SIZE);
  }

  // ---------------------------------------------------------------------------
  // sweep
  // ---------------------------------------------------------------------------

  /** Deletes up to `KG_EXPORT_SWEEP_BATCH` expired exports and their files. */
  async sweep(now: Date = new Date()): Promise<number> {
    const stale = await this.prisma.kgExport.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true, objectId: true },
      orderBy: { expiresAt: 'asc' },
      take: KG_EXPORT_SWEEP_BATCH,
    });
    let removed = 0;
    for (const entry of stale) {
      // Reference first (object_id is Restrict), then bytes, then the row.
      if (entry.objectId) {
        await this.prisma.kgExport.update({ where: { id: entry.id }, data: { objectId: null } });
        await this.objects.deleteIfPresent(entry.objectId);
      }
      await this.prisma.kgExport.delete({ where: { id: entry.id } });
      removed += 1;
    }
    this.logger.log(`Graph export sweep removed ${removed} expired export(s)`);
    return removed;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
