// =============================================================================
// GraphImportService (#387, docs/specs/ontology.md §8, §12, §17.3, §18.3)
// =============================================================================
//
// The request half of an import: accept the upload and queue `kg.import`, and
// decide the attribute offers the job produced. Nothing here parses RDF or
// touches a graph table — the job does the first (§18.4), and #366's commit
// alone does the second (§8).
//
// UPLOAD. Every refusal happens at the door, before a byte is stored (the
// `NoteSourcesService` rule — a `managed_by: 'graph'` object is invisible to
// the generic storage surface, so a rejected upload must never leave one).
// Then: bytes → proposal + job in ONE transaction → audit. At most one import
// may be `extracting` per owner: `kg_proposals_owner_import_extracting_uniq_idx`
// decides it at insert (a 409 `extraction_running`), and the file stored for
// the losing request is deleted again. The cheap lookup first is only for the
// common case of a double click — the index is the guarantee.
//
// OFFERS. Accepting creates one `kg_attribute_defs` row per entity type the
// property appeared on, through #355's `GraphAttributeDefsService` (so every
// rule a definition must satisfy is checked in one place), then — under the
// proposal's row lock — moves the stored values into the affected rows'
// `payload.props` (and `editedPayload.props` where the reviewer already edited
// the row), keyed by the new definition's `key`. Rejecting drops them. Either
// way the offer's status is recorded in `stats.unknownProperties`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { AttributeKind, AttributeOptions } from '@app/shared/ontology';
import { Prisma } from '@prisma/client';

import { AiSettingsService } from '../../ai/ai-settings.service';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphAccessService } from '../access/graph-access.service';
import { GraphAttributeDefsService } from '../attribute-defs/graph-attribute-defs.service';
import type { GraphAttributeDefResponse } from '../dto/graph-attribute-def.dto';
import { GRAPH_CONFLICT_REASONS } from '../graph-conflict-reasons';
import { GraphObjectsService } from '../graph-objects.service';
import { KG_IMPORT_JOB_TYPE, KG_SUBJECT_PROPOSAL } from '../job-types';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { lockProposal, notDraft } from '../proposals/proposals.service';
import type {
  AcceptAttributeOfferDto,
  AttributeOfferResponse,
  CreateGraphImportResponse,
  GraphImportOffer,
} from './dto/graph-import.dto';
import {
  GRAPH_IMPORT_FORMAT_INFO,
  GRAPH_IMPORT_MAX_BYTES,
  IMPORT_PENDING_STATS_KEY,
  detectImportFormat,
  graphImportStorageKey,
  type ImportPendingStats,
  type ImportPendingValue,
} from './graph-import.constants';
import type { KgImportJobPayload } from './kg-import.handler';
import { ASSERTION_SUBJECT_TYPE } from './unknown-properties';

/** The audit action written on upload. */
export const GRAPH_IMPORT_CREATED_ACTION = 'graph.import_created';

/** Someone is watching the import page: between extraction (−5) and an export (−10). */
export const KG_IMPORT_JOB_PRIORITY = -5;

const MAX_FILENAME_LENGTH = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface UploadedGraphFile {
  filename: string;
  mimeType: string;
  body: Buffer;
}

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});

/** One stored value as a value of `kind`, or undefined when it cannot be one. */
export function convertOfferValue(kind: AttributeKind, value: ImportPendingValue, linked: ReadonlyMap<string, string>): unknown {
  switch (kind) {
    case 'text':
      return value.v.length > 0 ? value.v.slice(0, 2000) : undefined;
    case 'number': {
      const n = Number(value.v);
      return value.v.trim() !== '' && Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return value.v === 'true' || value.v === '1' ? true : value.v === 'false' || value.v === '0' ? false : undefined;
    case 'date': {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.v);
      return m ? m[1] : undefined;
    }
    case 'url':
      return /^https?:\/\/\S+$/.test(value.v) ? value.v : undefined;
    case 'entity_ref':
      return value.item ? linked.get(value.item) : undefined;
    default:
      return undefined;
  }
}

@Injectable()
export class GraphImportService {
  private readonly logger = new Logger(GraphImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSettings: AiSettingsService,
    private readonly objects: GraphObjectsService,
    private readonly jobs: JobsService,
    private readonly access: GraphAccessService,
    private readonly ontology: GraphOntologyService,
    private readonly attributeDefs: GraphAttributeDefsService,
  ) {}

  // ===========================================================================
  // POST /api/graph/imports
  // ===========================================================================

  async upload(user: RequestUser, file: UploadedGraphFile): Promise<CreateGraphImportResponse> {
    const format = detectImportFormat(file.filename, file.mimeType);
    if (!format) {
      throw new BadRequestException(
        'Imports accept Turtle (.ttl, text/turtle), JSON-LD (.jsonld or .json, application/ld+json) or N-Quads (.nq, application/n-quads).',
      );
    }
    if (file.body.byteLength > GRAPH_IMPORT_MAX_BYTES) {
      throw new PayloadTooLargeException(`An import may be at most ${GRAPH_IMPORT_MAX_BYTES} bytes.`);
    }
    if (file.body.byteLength === 0) throw new BadRequestException('The file is empty.');

    const policy = await this.aiSettings.get();
    if (!policy.graphEnabled) {
      throw new ConflictException({
        message: 'Connected knowledge is switched off on this deployment, so nothing can be imported into it.',
        details: { reason: GRAPH_CONFLICT_REASONS.GRAPH_DISABLED },
      });
    }
    const running = await this.prisma.kgProposal.findFirst({
      where: { ownerId: user.id, kind: 'import', status: 'extracting' },
      select: { id: true },
    });
    if (running) throw this.importRunning();

    const filename = this.safeFilename(file.filename, format);
    const object = await this.objects.putBuffer({
      storageKey: graphImportStorageKey(user.id, randomUUID(), format),
      name: filename,
      mimeType: GRAPH_IMPORT_FORMAT_INFO[format].mimeType,
      ownerId: user.id,
      metadata: { kind: 'graph_import', uploadedFilename: filename },
      body: file.body,
    });

    let created: { proposalId: string; jobId: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const proposal = await tx.kgProposal.create({
          data: {
            ownerId: user.id,
            kind: 'import',
            status: 'extracting',
            stats: { filename, format, bytes: file.body.byteLength },
          },
        });
        const payload: KgImportJobPayload = { proposalId: proposal.id, ownerId: user.id, objectId: object.id, format };
        const job = await this.jobs.enqueueWithin(tx, {
          type: KG_IMPORT_JOB_TYPE,
          reason: 'upload',
          subjectType: KG_SUBJECT_PROPOSAL,
          subjectId: proposal.id,
          priority: KG_IMPORT_JOB_PRIORITY,
          payload: payload as unknown as Prisma.InputJsonValue,
        });
        await tx.kgProposal.update({ where: { id: proposal.id }, data: { jobId: job.id } });
        return { proposalId: proposal.id, jobId: job.id };
      });
    } catch (error) {
      await this.objects.deleteIfPresent(object.id);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw this.importRunning();
      throw error;
    }

    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: user.id,
          action: GRAPH_IMPORT_CREATED_ACTION,
          targetType: KG_SUBJECT_PROPOSAL,
          targetId: created.proposalId,
          meta: { proposalId: created.proposalId, format, bytes: file.body.byteLength },
        },
      });
    } catch (error) {
      this.logger.warn(`Audit for import ${created.proposalId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.logger.log(`Queued graph import ${created.proposalId} (${format}, ${file.body.byteLength} bytes) as job ${created.jobId}`);
    return created;
  }

  // ===========================================================================
  // Attribute offers
  // ===========================================================================

  async acceptOffer(user: RequestUser, proposalId: string, offerId: string, dto: AcceptAttributeOfferDto): Promise<AttributeOfferResponse> {
    const { offer, pending } = await this.loadOffer(user, proposalId, offerId);
    const realTypes = offer.subjectTypes.filter((t) => t !== ASSERTION_SUBJECT_TYPE);
    if (realTypes.length === 0) throw new BadRequestException('A property on a relation cannot become an attribute.');

    // Types targeted by entity references, for an `entity_ref` definition.
    const rowIds = new Set<string>();
    for (const entry of pending) for (const v of entry.values) if (v.item) rowIds.add(v.item);
    const targets = rowIds.size
      ? await this.prisma.kgProposalItem.findMany({
          where: { proposalId, id: { in: [...rowIds] } },
          select: { id: true, payload: true, editedPayload: true, resolution: true, mergeIntoId: true },
        })
      : [];
    const linked = new Map<string, string>();
    const targetTypes = new Set<string>();
    for (const t of targets) {
      const eff = asObject(t.editedPayload ?? t.payload);
      if (typeof eff.type === 'string') targetTypes.add(eff.type);
      const ref = t.mergeIntoId ?? asObject(t.resolution).ref;
      if (typeof ref === 'string') linked.set(t.id, ref);
    }
    let kind: AttributeKind = offer.suggestedKind;
    let options: AttributeOptions | undefined;
    if (kind === 'entity_ref') {
      if (targetTypes.size > 0) options = { targetTypes: [...targetTypes].sort() } as AttributeOptions;
      else kind = 'text';
    }
    if (kind === 'select' || kind === 'multi_select') kind = 'text';

    const label = dto.label ?? offer.label ?? this.labelFromIri(offer.iri);
    const schema = await this.ontology.effectiveSchemaFor(user.id);
    const defs: GraphAttributeDefResponse[] = [];
    for (const entityType of realTypes) {
      if (!schema.entityType(entityType)) continue;
      defs.push(await this.attributeDefs.create({ entityType, label, kind, options, extractable: false }, user));
    }
    if (defs.length === 0) throw new BadRequestException('None of the types carrying this property is in your graph.');
    const keyByType = new Map(defs.map((d) => [d.entityType, d.key]));

    let rowsUpdated = 0;
    let valuesDropped = 0;
    await this.prisma.$transaction(async (tx) => {
      const status = await lockProposal(tx, proposalId);
      if (status !== 'draft') throw notDraft(status);
      const rows = await tx.kgProposalItem.findMany({
        where: { proposalId, id: { in: pending.map((p) => p.itemId) } },
        select: { id: true, payload: true, editedPayload: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const entry of pending) {
        const row = byId.get(entry.itemId);
        if (!row) {
          valuesDropped += entry.values.length;
          continue;
        }
        const payload = asObject(row.payload);
        const type = typeof payload.type === 'string' ? payload.type : this.itemTypeKey(schema, payload.kind);
        const key = type ? keyByType.get(type) : undefined;
        const converted = entry.values.map((v) => convertOfferValue(kind, v, linked)).filter((v) => v !== undefined);
        valuesDropped += entry.values.length - Math.min(1, converted.length);
        if (!key || converted.length === 0) continue;
        const value = converted[0];
        const withProp = (p: Json): Prisma.InputJsonValue => ({ ...p, props: { ...asObject(p.props), [key]: value } }) as Prisma.InputJsonValue;
        await tx.kgProposalItem.update({
          where: { id: row.id },
          data: {
            payload: withProp(payload),
            ...(row.editedPayload ? { editedPayload: withProp(asObject(row.editedPayload)) } : {}),
          },
        });
        rowsUpdated += 1;
      }
      await this.recordDecision(tx, proposalId, offerId, 'accepted');
    });

    return { offer: { ...offer, status: 'accepted' }, attributeDefs: defs, rowsUpdated, valuesDropped };
  }

  async rejectOffer(user: RequestUser, proposalId: string, offerId: string): Promise<AttributeOfferResponse> {
    const { offer, pending } = await this.loadOffer(user, proposalId, offerId);
    await this.prisma.$transaction(async (tx) => {
      const status = await lockProposal(tx, proposalId);
      if (status !== 'draft') throw notDraft(status);
      await this.recordDecision(tx, proposalId, offerId, 'rejected');
    });
    const dropped = pending.reduce((n, p) => n + p.values.length, 0);
    return { offer: { ...offer, status: 'rejected' }, attributeDefs: [], rowsUpdated: 0, valuesDropped: dropped };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async loadOffer(
    user: RequestUser,
    proposalId: string,
    offerId: string,
  ): Promise<{ offer: GraphImportOffer; pending: ImportPendingStats[string] }> {
    const proposal = await this.access.require(user.id, 'proposal', proposalId, 'edit', user.permissions);
    const notFound = () => new NotFoundException('No such attribute offer on this proposal.');
    if (proposal.kind !== 'import') throw notFound();
    const stats = asObject(proposal.stats);
    const offers = Array.isArray(stats.unknownProperties) ? (stats.unknownProperties as GraphImportOffer[]) : [];
    const offer = offers.find((o) => o.offerId === offerId);
    if (!offer) throw notFound();
    if (proposal.status !== 'draft') throw notDraft(proposal.status);
    if (offer.status !== 'offered') {
      throw new ConflictException({ message: `This property was already ${offer.status}.`, details: { reason: 'offer_decided', status: offer.status } });
    }
    const pending = (asObject(stats[IMPORT_PENDING_STATS_KEY]) as ImportPendingStats)[offerId] ?? [];
    return { offer, pending };
  }

  /** Mark the offer decided and drop its held values, re-reading stats under the lock. */
  private async recordDecision(tx: Prisma.TransactionClient, proposalId: string, offerId: string, status: 'accepted' | 'rejected'): Promise<void> {
    const current = await tx.kgProposal.findUniqueOrThrow({ where: { id: proposalId }, select: { stats: true } });
    const stats = asObject(current.stats);
    const offers = (Array.isArray(stats.unknownProperties) ? (stats.unknownProperties as GraphImportOffer[]) : []).map((o) =>
      o.offerId === offerId ? { ...o, status } : o,
    );
    const pending = { ...(asObject(stats[IMPORT_PENDING_STATS_KEY]) as ImportPendingStats) };
    delete pending[offerId];
    await tx.kgProposal.update({
      where: { id: proposalId },
      data: { stats: { ...stats, unknownProperties: offers, [IMPORT_PENDING_STATS_KEY]: pending } as unknown as Prisma.InputJsonValue },
    });
  }

  private itemTypeKey(schema: { entityTypes: ReadonlyArray<{ key: string; itemKind?: string | null }> }, kind: unknown): string | undefined {
    return typeof kind === 'string' ? schema.entityTypes.find((t) => t.itemKind === kind)?.key : undefined;
  }

  private labelFromIri(iri: string): string {
    const seg = iri.split(/[#/]/).filter((s) => s.length > 0).pop() ?? 'Imported property';
    const spaced = seg.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    const label = spaced.length > 0 ? spaced[0].toUpperCase() + spaced.slice(1) : 'Imported property';
    return label.slice(0, 80);
  }

  private importRunning(): ConflictException {
    return new ConflictException({
      message: 'Another import of yours is still being checked. Wait for it to finish, then try again.',
      details: { reason: GRAPH_CONFLICT_REASONS.EXTRACTION_RUNNING },
    });
  }

  private safeFilename(raw: string, format: keyof typeof GRAPH_IMPORT_FORMAT_INFO): string {
    const stripped = (raw ?? '').replace(/[\\/]+/g, '_').replace(CONTROL_CHARACTERS, '').trim();
    return stripped.length === 0 ? `import.${GRAPH_IMPORT_FORMAT_INFO[format].extension}` : stripped.slice(0, MAX_FILENAME_LENGTH);
  }
}
