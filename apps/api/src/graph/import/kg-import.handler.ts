// =============================================================================
// `kg.import` (#387, epic #349; docs/specs/ontology.md §7, §8, §11, §17, §18.3)
// =============================================================================
//
// One uploaded RDF file in, one DRAFT `import` proposal out — never graph
// rows. An import is powerful precisely because it is not a third way in: the
// user reviews it with #367's sheet and commits it through #366's "Send to
// graph", exactly like an extraction.
//
//   1. parse        streamed from storage (`rdf-parse.ts`); > 200,000 triples
//                   → `too_large`, a syntax error → `parse_error` (line only),
//                   no node typed with a known class → `empty`
//   2. version      `version-negotiation.ts`: a newer MAJOR → refused; rows of
//                   this owner still awaiting `kg.migrate` → refused (and the
//                   migration queued); older → migrated in memory
//   3. unknown      every undeclared property offered and removed
//                   (`unknown-properties.ts`), before validation
//   4. validate     SHACL against the shapes generated for THIS owner, in a
//                   child process (`shacl-engine.ts`). Any `sh:Violation` →
//                   `shacl_violations`, the report stored, NOTHING imported —
//                   all or nothing (§18.3). Warnings are stored, never fatal.
//   5. map          `rdf-to-proposal.ts` → `kg_proposal_items` (`origin: user`,
//                   flag `imported`) + one `kg_evidence` per row citing the
//                   file itself (`import_object_id`, `source_iri`, the file's
//                   own annotation text or "Imported from <filename>")
//   6. stages       every registered proposal stage, in order — #364's
//                   resolution first, so an imported "Joe Smith" links to the
//                   existing Joe exactly as an extracted mention would; then
//                   #365's dedup/closing stages
//   7. pre-check → `extracting → draft`
//
// FAILURES (steps 1–4, and an empty mapping) mark the proposal `failed` with
// `stats.failureReason` and the job RETURNS: determining a permanent outcome is
// success. A `RateLimitError` from a stage is rethrown (deferred, no attempt
// charged, rows rewritten on the re-run). Anything else marks it `failed` and
// rethrows.
//
//   profile       { maxRuntimeMs: 30 min, maxAttempts: 1 } — a half-applied
//                 import must surface as failed, never resume silently (§11)
//   node-eligible NO — it reads and writes several tables, the parsers and the
//                 shapes generator live in the API, and resolution may spend
//                 the owner's own AI key (CLAUDE.md rule 2's exemptions)
//   throttle      `aiProviderThrottleKey(ownerId)`, registered before the
//                 stages, which may adjudicate on the owner's key
//
// ⚠ §18.4: this handler is the ONLY importer of `rdf-parse.ts` and
// `shacl-engine.ts`. Logs carry ids, counts and reasons — never a label,
// quote, value or IRI from the file.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { Prisma, type Job } from '@prisma/client';
import { APP_SLUG } from '@app/shared';
import { kvNamespace } from '@app/shared/ontology';
import { z } from 'zod';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobsService } from '../../jobs/jobs.service';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { PrismaService } from '../../prisma/prisma.service';
import { applyPrecheck, reviewOnlyTypes, type PrecheckItem } from '../extraction/precheck';
import { ProposalStageRegistry } from '../extraction/proposal-stage';
import { GraphObjectsService } from '../graph-objects.service';
import { KG_IMPORT_JOB_TYPE } from '../job-types';
import {
  DEFAULT_KG_MIGRATE_DEFINITION,
  KG_MIGRATE_DEFINITION,
  KG_MIGRATE_TABLES,
  candidatePredicate,
  kgMigrateEnqueueFields,
  migrationsUpTo,
  type KgMigrateDefinition,
  type KgMigrateTable,
} from '../migrate/kg-migrate.plan';
import { KgMigrateRepository } from '../migrate/kg-migrate.repository';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { GraphPreferencesService } from '../preferences/graph-preferences.service';
import type { ProposalResolution } from '../proposals/proposal-payload.schema';
import { generateShacl } from '../rdf/shacl-generator';
import {
  GRAPH_IMPORT_FORMATS,
  GRAPH_IMPORT_MAX_VIOLATIONS,
  type GraphImportFailureReason,
  type GraphImportStats,
} from './dto/graph-import.dto';
import { GRAPH_IMPORT_MAX_BYTES, GRAPH_IMPORT_MAX_TRIPLES, IMPORT_PENDING_STATS_KEY, failureMessage, type ImportPendingStats } from './graph-import.constants';
import type { ImportQuad } from './import-dataset';
import { buildImportVocabulary } from './import-vocabulary';
import { RdfParseError, parseRdf, parseTurtleText } from './rdf-parse';
import { mapImportToProposal, type ImportRow } from './rdf-to-proposal';
import { ChildProcessShaclEngine, type ShaclEngine } from './shacl-engine';
import { splitUnknownProperties } from './unknown-properties';
import { migrateQuads, negotiateVersion, readSourceVersion } from './version-negotiation';

export const KG_IMPORT_MAX_RUNTIME_MS = 30 * 60_000;

/** DI token: a spec may inject its own engine; production spawns a child process. */
export const GRAPH_SHACL_ENGINE = Symbol('GRAPH_SHACL_ENGINE');

const payloadSchema = z.object({
  proposalId: z.guid(),
  ownerId: z.guid(),
  objectId: z.guid(),
  format: z.enum(GRAPH_IMPORT_FORMATS),
});
export type KgImportJobPayload = z.infer<typeof payloadSchema>;

export function readKgImportPayload(payload: unknown): KgImportJobPayload | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** A permanent outcome: the proposal is `failed`, the job returns. */
export class ImportFailure extends Error {
  constructor(
    readonly reason: GraphImportFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'ImportFailure';
  }
}

type WorkingStats = GraphImportStats & { [IMPORT_PENDING_STATS_KEY]?: ImportPendingStats; failure?: { errorClass: string; message: string } };

/** The stats every run starts from: the upload's own facts plus empty results. */
export function initialImportStats(base: { filename: string; format: GraphImportStats['format']; bytes: number }): GraphImportStats {
  return {
    filename: base.filename,
    format: base.format,
    bytes: base.bytes,
    triples: 0,
    sourceOntologyVersion: null,
    migratedFrom: null,
    validation: { conforms: false, violations: [], violationCount: 0 },
    unknownProperties: [],
    counts: { entities: 0, relations: 0, items: 0, skippedSensitive: 0 },
    failureReason: null,
  };
}

@Injectable()
export class KgImportHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(KgImportHandler.name);
  private readonly ns = kvNamespace(APP_SLUG);
  private readonly definition: KgMigrateDefinition;
  private readonly engine: ShaclEngine;

  readonly type = KG_IMPORT_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: KG_IMPORT_MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly objects: GraphObjectsService,
    private readonly ontology: GraphOntologyService,
    private readonly preferences: GraphPreferencesService,
    private readonly stages: ProposalStageRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly jobs: JobsService,
    private readonly migrations: KgMigrateRepository,
    @Optional() @Inject(KG_MIGRATE_DEFINITION) definition?: KgMigrateDefinition,
    @Optional() @Inject(GRAPH_SHACL_ENGINE) engine?: ShaclEngine,
  ) {
    this.definition = definition ?? DEFAULT_KG_MIGRATE_DEFINITION;
    this.engine = engine ?? new ChildProcessShaclEngine();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = readKgImportPayload(job.payload);
    if (!payload) {
      this.logger.warn(`${KG_IMPORT_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }
    const proposal = await this.prisma.kgProposal.findUnique({
      where: { id: payload.proposalId },
      select: { id: true, kind: true, status: true, ownerId: true, stats: true },
    });
    if (!proposal || proposal.kind !== 'import' || proposal.status !== 'extracting' || proposal.ownerId !== payload.ownerId) {
      this.logger.log(`${KG_IMPORT_JOB_TYPE} proposal ${payload.proposalId} is not an extracting import; job ${job.id} is a no-op`);
      return;
    }

    const stored = (proposal.stats ?? {}) as Partial<GraphImportStats>;
    const stats: WorkingStats = initialImportStats({
      filename: typeof stored.filename === 'string' ? stored.filename : 'import',
      format: payload.format,
      bytes: typeof stored.bytes === 'number' ? stored.bytes : 0,
    });
    const started = Date.now();
    try {
      await this.run(payload, stats);
      this.logger.log(
        `${KG_IMPORT_JOB_TYPE} proposal=${payload.proposalId} format=${payload.format} triples=${stats.triples} ` +
          `entities=${stats.counts.entities} relations=${stats.counts.relations} items=${stats.counts.items} ` +
          `offers=${stats.unknownProperties.length} skippedSensitive=${stats.counts.skippedSensitive} ms=${Date.now() - started}`,
      );
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      if (error instanceof ImportFailure) {
        await this.markFailed(payload.proposalId, { ...stats, failureReason: error.reason }, error.message);
        this.logger.log(`${KG_IMPORT_JOB_TYPE} proposal=${payload.proposalId} failed: ${error.reason} (triples=${stats.triples})`);
        return;
      }
      await this.markFailed(payload.proposalId, stats, 'The import failed because of an unexpected error. Upload the file again.');
      this.logger.warn(
        `${KG_IMPORT_JOB_TYPE} proposal=${payload.proposalId} failed unexpectedly: ${error instanceof Error ? error.name : 'error'}`,
      );
      throw error;
    }
  }

  // ===========================================================================
  // The pipeline
  // ===========================================================================

  private async run(payload: KgImportJobPayload, stats: WorkingStats): Promise<void> {
    const { ownerId, proposalId, objectId, format } = payload;

    // 1. Parse.
    const opened = await this.objects.openStream(objectId);
    if (!opened || opened.object.uploadedById !== ownerId) {
      throw new ImportFailure('parse_error', 'The uploaded file is no longer stored. Upload it again.');
    }
    let quads: ImportQuad[];
    try {
      quads = await parseRdf(opened.stream, format, { maxTriples: GRAPH_IMPORT_MAX_TRIPLES, maxBytes: GRAPH_IMPORT_MAX_BYTES, ns: this.ns });
    } catch (error) {
      if (error instanceof RdfParseError) throw new ImportFailure(error.reason, error.message);
      throw error;
    }
    stats.triples = quads.length;

    const registry = this.definition.registry;
    const attributeDefs = await this.ontology.attributeDefsFor(ownerId);
    const vocabulary = buildImportVocabulary(registry, attributeDefs, this.ns);
    const typed = quads.some((q) => q.p === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && q.o.termType === 'NamedNode' && vocabulary.classes.has(q.o.value));
    if (!typed) throw new ImportFailure('empty', failureMessage('empty'));

    // 2. Version negotiation.
    const source = readSourceVersion(quads, this.ns);
    stats.sourceOntologyVersion = source;
    const decision = negotiateVersion(source, this.definition.targetVersion, this.definition.migrations);
    if (decision.kind === 'newer_major') throw new ImportFailure('ontology_version_newer', failureMessage('ontology_version_newer'));
    if (await this.ownerNeedsMigration(ownerId)) {
      await this.enqueueMigration(ownerId);
      throw new ImportFailure('migration_pending', failureMessage('migration_pending'));
    }
    if (decision.kind === 'older' && decision.migrations.length > 0) {
      quads = migrateQuads(quads, this.ns, registry, decision.migrations);
      stats.migratedFrom = source;
    }

    // 3. Unknown properties — offered and removed before validation.
    const split = splitUnknownProperties(quads, vocabulary, this.ns);
    stats.unknownProperties = split.offers;

    // 4. SHACL, all or nothing.
    const shapes = parseTurtleText(generateShacl(registry, attributeDefs, this.ns));
    const report = await this.engine.validate(shapes, split.quads, GRAPH_IMPORT_MAX_VIOLATIONS);
    stats.validation = {
      conforms: report.conforms,
      violations: report.results
        .filter((r) => r.severity === 'Violation' || r.severity === 'Warning')
        .slice(0, GRAPH_IMPORT_MAX_VIOLATIONS)
        .map((r) => ({ focusNode: r.focusNode, path: r.path, message: r.message, severity: r.severity as 'Violation' | 'Warning' })),
      violationCount: report.violationCount,
    };
    if (!report.conforms) throw new ImportFailure('shacl_violations', failureMessage('shacl_violations'));

    // 5. Map to proposal rows.
    const mapped = mapImportToProposal({
      quads: split.quads,
      ns: this.ns,
      registry,
      vocabulary,
      userAttributes: attributeDefs,
      filename: stats.filename,
      sensitivity: split.sensitivity,
    });
    stats.counts = mapped.counts;
    if (mapped.rows.length === 0) throw new ImportFailure('empty', failureMessage('empty'));

    const ids = mapped.rows.map(() => randomUUID());
    const itemByNode = new Map<string, string>();
    mapped.rows.forEach((row, i) => {
      if (row.kind !== 'relation' && !itemByNode.has(row.node)) itemByNode.set(row.node, ids[i]);
    });
    const pending: ImportPendingStats = {};
    for (const [offerId, byNode] of split.pending) {
      const entries: ImportPendingStats[string] = [];
      for (const [node, values] of byNode) {
        const itemId = itemByNode.get(node);
        if (!itemId) continue;
        entries.push({
          itemId,
          values: values.map((v) => ({ v: v.v, ...(v.d ? { d: v.d } : {}), ...(v.node && itemByNode.has(v.node) ? { item: itemByNode.get(v.node) } : {}) })),
        });
      }
      if (entries.length > 0) pending[offerId] = entries;
    }
    stats[IMPORT_PENDING_STATS_KEY] = pending;

    await this.writeRows(proposalId, ownerId, objectId, mapped.rows, ids, stats);

    // 6. Stages — resolution first. Adjudication may spend the owner's key.
    this.throttle.registerProviderKey(this.type, aiProviderThrottleKey(ownerId));
    const preferences = await this.preferences.get(ownerId);
    const stageStats: Record<string, unknown> = {};
    for (const stage of this.stages.ordered()) {
      const own: Record<string, unknown> = {};
      await stage.run({ proposalId, userId: ownerId, noteId: null, preferences, ai: null, prisma: this.prisma, stats: own });
      stageStats[stage.name] = own;
    }

    // 7. Pre-check, then draft.
    const items = await this.prisma.kgProposalItem.findMany({
      where: { proposalId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, kind: true, payload: true, resolution: true, flags: true, decision: true },
    });
    const precheck: Array<PrecheckItem & { id: string }> = items.map((item) => ({
      id: item.id,
      kind: item.kind,
      payload: (item.payload ?? {}) as Record<string, unknown>,
      resolution: (item.resolution ?? null) as ProposalResolution | null,
      flags: item.flags,
      decision: item.decision,
    }));
    const schema = await this.ontology.effectiveSchemaFor(ownerId);
    applyPrecheck(precheck, preferences, { reviewOnlyTypes: reviewOnlyTypes(schema) });
    await this.finalize(proposalId, precheck, { ...stats, ...stageStats });
  }

  // ===========================================================================
  // Writes — only the proposal, its rows and their evidence (§8)
  // ===========================================================================

  /** Replace this proposal's rows (a deferred re-run leaves none behind twice). */
  private async writeRows(
    proposalId: string,
    ownerId: string,
    objectId: string,
    rows: readonly ImportRow[],
    ids: readonly string[],
    stats: WorkingStats,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const previous = await tx.kgProposalItem.findMany({ where: { proposalId }, select: { id: true } });
        if (previous.length > 0) {
          await tx.kgEvidence.deleteMany({ where: { subjectKind: 'proposal_item', subjectId: { in: previous.map((p) => p.id) } } });
          await tx.kgProposalItem.deleteMany({ where: { proposalId } });
        }
        for (let start = 0; start < rows.length; start += 1000) {
          const slice = rows.slice(start, start + 1000);
          await tx.kgProposalItem.createMany({
            data: slice.map((row, j) => ({
              id: ids[start + j],
              proposalId,
              kind: row.kind,
              payload: row.payload as unknown as Prisma.InputJsonValue,
              resolution: row.resolution === null ? Prisma.DbNull : (row.resolution as unknown as Prisma.InputJsonValue),
              flags: ['imported'],
              decision: 'pending' as const,
              origin: 'user' as const,
              sortOrder: start + j,
            })),
          });
          await tx.kgEvidence.createMany({
            data: slice.map((row, j) => ({
              ownerId,
              subjectKind: 'proposal_item' as const,
              subjectId: ids[start + j],
              importObjectId: objectId,
              sourceIri: row.evidence.sourceIri,
              quote: row.evidence.quote,
            })),
          });
        }
        await tx.kgProposal.update({ where: { id: proposalId }, data: { stats: stats as unknown as Prisma.InputJsonValue } });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  private async finalize(proposalId: string, precheck: Array<PrecheckItem & { id: string }>, stats: Record<string, unknown>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.kgProposal.findUnique({ where: { id: proposalId }, select: { status: true } });
      if (current?.status !== 'extracting') return;
      for (const decision of ['accept', 'reject'] as const) {
        const ids = precheck.filter((p) => p.decision === decision).map((p) => p.id);
        if (ids.length > 0) await tx.kgProposalItem.updateMany({ where: { proposalId, id: { in: ids } }, data: { decision } });
      }
      const prechecked = precheck.filter((p) => p.decision === 'accept').map((p) => p.id);
      await tx.kgProposal.update({
        where: { id: proposalId },
        data: { status: 'draft', stats: { ...stats, prechecked } as unknown as Prisma.InputJsonValue },
      });
    });
  }

  /** `extracting → failed`; nothing is written to any graph table, and any rows a stage left are dropped. */
  private async markFailed(proposalId: string, stats: WorkingStats, message: string): Promise<void> {
    const { [IMPORT_PENDING_STATS_KEY]: _pending, ...rest } = stats;
    const failure = { errorClass: stats.failureReason ?? 'other', message };
    await this.prisma.$transaction(async (tx) => {
      const items = await tx.kgProposalItem.findMany({ where: { proposalId }, select: { id: true } });
      if (items.length > 0) {
        await tx.kgEvidence.deleteMany({ where: { subjectKind: 'proposal_item', subjectId: { in: items.map((i) => i.id) } } });
        await tx.kgProposalItem.deleteMany({ where: { proposalId } });
      }
      await tx.kgProposal.updateMany({
        where: { id: proposalId, status: 'extracting' },
        data: { status: 'failed', stats: { ...rest, failure } as unknown as Prisma.InputJsonValue },
      });
    });
  }

  // ===========================================================================
  // Migration gate (§17.4)
  // ===========================================================================

  private async ownerNeedsMigration(ownerId: string): Promise<boolean> {
    const migrations = migrationsUpTo(this.definition.targetVersion, this.definition);
    if (migrations.length === 0) return false;
    const predicates: Partial<Record<KgMigrateTable, Prisma.Sql>> = {};
    for (const table of KG_MIGRATE_TABLES) {
      const predicate = candidatePredicate(table, migrations, this.definition.registry);
      if (predicate !== null) predicates[table] = predicate;
    }
    return this.migrations.ownerHasPendingMigration(ownerId, predicates, this.definition.targetVersion);
  }

  private async enqueueMigration(ownerId: string): Promise<void> {
    try {
      const fields = kgMigrateEnqueueFields(ownerId, this.definition.targetVersion);
      await this.jobs.enqueue({ ...fields, reason: 'rerun', payload: fields.payload as Prisma.InputJsonValue });
    } catch (error) {
      this.logger.warn(`Could not queue kg.migrate for owner ${ownerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
