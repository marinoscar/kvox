// =============================================================================
// ProposalsService (#366, epic #346; docs/specs/ontology.md §8, §12, §19)
// =============================================================================
//
// Everything about a proposal short of committing and reverting it: list, get,
// the per-note latest, the reviewer's per-row decisions, bulk decisions,
// adding what the model missed, and discarding.
//
// AUTHORISATION. Every proposal is owner-only through
// `GraphAccessService.require(…, 'proposal', …)` — a missing proposal and
// another owner's are the SAME 404; `edit` adds the `graph:write` 403 for the
// caller's own. There is no `read_any`.
//
// WRITES LOCK THE PROPOSAL. Every review write runs in one transaction that
// first takes `SELECT … FOR UPDATE` on the `kg_proposals` row and re-reads its
// status, so a decision can never land on a proposal a concurrent commit (or
// discard) has already moved out of `draft`: it waits for that transaction and
// then answers 409 `proposal_not_draft`.
//
// NOTHING HERE WRITES THE GRAPH. A review decision is a row of
// `kg_proposal_items`; an added span is a `kg_evidence` row with
// `subject_kind: 'proposal_item'`. Only `ProposalCommitService` turns a
// proposal into graph rows (§8).
//
// Per-item decisions are deliberately NOT audited — the commit is (§ Security).
// ⚠ Logs carry ids and counts only, never a label, a statement or a quote.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type KgProposal } from '@prisma/client';
import type { EffectiveSchema } from '@app/shared/ontology';

import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { NoteAccessService } from '../../notes/access/note-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GRAPH_NOT_FOUND_MESSAGES, GraphAccessService } from '../access/graph-access.service';
import { GRAPH_CONFLICT_REASONS } from '../graph-conflict-reasons';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import {
  PROPOSAL_BAD_REQUEST_REASONS,
  type AddItemDto,
  type BulkDecisionDto,
  type BulkDecisionResponse,
  type BulkSkipReason,
  type ItemDecisionResponse,
  type ListProposalsQuery,
  type NoteProposalResponse,
  type PatchItemDto,
  type ProposalDetail,
  type ProposalListResponse,
  type ProposalResponse,
  type ProposalSummary,
  type RelinkField,
} from './dto/proposal.dto';
import { decodeProposalCursor, encodeProposalCursor } from './proposal-cursor';
import type { EndpointRef, ProposalResolution } from './proposal-payload.schema';
import {
  endpointsOf,
  validateEntityPayload,
  validateItemPayload,
  validateRelationPayload,
  type PayloadIssue,
  type PayloadValidation,
} from './proposal-validation';
import {
  asObject,
  countsOf,
  effectivePayloadOf,
  itemViewOf,
  orderItemViews,
  precheckedOf,
  refLabelsOf,
  summaryOf,
  type EvidenceRowInput,
  type ProposalItemRowInput,
  type ViewLookups,
} from './proposal-view.mapper';
import { SpanValidator } from './span-validator';

type Tx = Prisma.TransactionClient;
type Json = Record<string, unknown>;

export const GRAPH_PROPOSAL_DISCARDED_ACTION = 'graph.proposal_discarded';
export const KG_PROPOSAL_TARGET_TYPE = 'kg_proposal';
export const PROPOSAL_ITEM_NOT_FOUND_MESSAGE = 'Proposal item not found';

const LIVE_REVIEW = ['accepted', 'edited'] as const;
const MAX_NOTE_CHAIN_HOPS = 5;

const RELINK_FIELDS_BY_KIND: Record<'relation' | 'item', readonly RelinkField[]> = {
  relation: ['from', 'to'],
  item: ['subject', 'owner', 'counterparty', 'meeting'],
};
const NULLABLE_RELINK_FIELDS: ReadonlySet<RelinkField> = new Set<RelinkField>(['owner', 'counterparty', 'meeting']);

const ITEM_ROW_SELECT = {
  id: true,
  kind: true,
  origin: true,
  decision: true,
  payload: true,
  editedPayload: true,
  resolution: true,
  mergeIntoId: true,
  distinctFrom: true,
  flags: true,
  committedRefId: true,
  sortOrder: true,
} as const;

export function notDraft(status: string): ConflictException {
  return new ConflictException({
    message: `This proposal is ${status}, not a draft, so it cannot be changed.`,
    details: { reason: GRAPH_CONFLICT_REASONS.PROPOSAL_NOT_DRAFT, status },
  });
}

function invalidPayload(issues: PayloadIssue[], message = 'The row is not valid for your graph.'): BadRequestException {
  return new BadRequestException({ message, details: { issues } });
}

/** Lock the proposal row; return its status (the row is known to exist — `require` ran). */
export async function lockProposal(tx: Tx, proposalId: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT status::text AS status FROM kg_proposals WHERE id = ${proposalId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.proposal);
  return rows[0].status;
}

const toJson = (value: Json | null): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);

@Injectable()
export class ProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GraphAccessService,
    private readonly notes: NoteAccessService,
    private readonly ontology: GraphOntologyService,
    private readonly spans: SpanValidator,
  ) {}

  // ===========================================================================
  // Reads
  // ===========================================================================

  async list(user: RequestUser, query: ListProposalsQuery): Promise<ProposalListResponse> {
    const cursor = query.cursor ? decodeProposalCursor(query.cursor) : null;
    const where: Prisma.KgProposalWhereInput = { ownerId: user.id, status: query.status };
    if (query.kind) where.kind = query.kind;

    const noteFilters: string[][] = [];
    if (query.noteId) noteFilters.push([query.noteId]);
    if (query.transcriptId) noteFilters.push(await this.notesFromTranscript(user.id, query.transcriptId));
    if (noteFilters.length > 0) {
      const allowed = noteFilters.reduce((a, b) => a.filter((id) => b.includes(id)));
      where.noteId = { in: allowed };
    }
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }

    const rows = await this.prisma.kgProposal.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const items = await this.summaries(page);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodeProposalCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async get(user: RequestUser, proposalId: string, includeContext: boolean): Promise<ProposalDetail> {
    const proposal = await this.access.require(user.id, 'proposal', proposalId, 'view', user.permissions);
    return this.detail(proposal, includeContext);
  }

  /** The newest proposal for a note whose status is not `discarded`, or null. */
  async latestForNote(user: RequestUser, noteId: string): Promise<NoteProposalResponse> {
    await this.notes.require(user.id, noteId, 'view', user.permissions);
    const proposal = await this.prisma.kgProposal.findFirst({
      where: { noteId, ownerId: user.id, status: { not: 'discarded' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { proposal: proposal ? await this.detail(proposal, false) : null };
  }

  /** Detail of a proposal the caller is already authorised for. */
  async detail(proposal: KgProposal, includeContext: boolean): Promise<ProposalDetail> {
    const [items, schema] = await Promise.all([
      this.prisma.kgProposalItem.findMany({
        where: { proposalId: proposal.id },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: ITEM_ROW_SELECT,
      }),
      this.ontology.effectiveSchemaFor(proposal.ownerId),
    ]);
    const rows = items as unknown as ProposalItemRowInput[];
    const evidence = rows.length === 0 ? [] : await this.prisma.kgEvidence.findMany({
      where: { ownerId: proposal.ownerId, subjectKind: 'proposal_item', subjectId: { in: rows.map((r) => r.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const lookups = await this.lookups(proposal, rows, evidence, schema);
    const note = proposal.noteId ? await this.noteHeader(proposal.noteId) : null;

    const byItem = new Map<string, EvidenceRowInput[]>();
    for (const e of evidence) {
      const list = byItem.get(e.subjectId) ?? [];
      list.push(e);
      byItem.set(e.subjectId, list);
    }
    const refLabels = refLabelsOf(rows);
    const views = rows.map((row) => itemViewOf(row, byItem.get(row.id) ?? [], refLabels, lookups));
    const ordered = orderItemViews(views, new Map(rows.map((r) => [r.id, r.sortOrder])));

    const context =
      includeContext && (proposal.systemPrompt !== null || proposal.userContent !== null)
        ? { systemPrompt: proposal.systemPrompt ?? '', userContent: proposal.userContent ?? '' }
        : null;

    return { proposal: summaryOf(proposal, note, countsOf(rows)), items: ordered, context };
  }

  /** Summaries of many proposals: one items query, one notes query. */
  async summaries(proposals: readonly KgProposal[]): Promise<ProposalSummary[]> {
    if (proposals.length === 0) return [];
    const ids = proposals.map((p) => p.id);
    const noteIds = [...new Set(proposals.flatMap((p) => (p.noteId ? [p.noteId] : [])))];
    const [items, notes] = await Promise.all([
      this.prisma.kgProposalItem.findMany({
        where: { proposalId: { in: ids } },
        select: { proposalId: true, kind: true, decision: true, flags: true, payload: true, editedPayload: true },
      }),
      noteIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; title: string; currentVersion: number }>)
        : this.prisma.note.findMany({ where: { id: { in: noteIds } }, select: { id: true, title: true, currentVersion: true } }),
    ]);
    const noteById = new Map(notes.map((n) => [n.id, n]));
    return proposals.map((p) =>
      summaryOf(
        p,
        p.noteId ? (noteById.get(p.noteId) ?? null) : null,
        countsOf(items.filter((i) => i.proposalId === p.id) as never),
      ),
    );
  }

  async summary(proposalId: string): Promise<ProposalSummary> {
    const proposal = await this.prisma.kgProposal.findUniqueOrThrow({ where: { id: proposalId } });
    return (await this.summaries([proposal]))[0];
  }

  // ===========================================================================
  // Review decisions
  // ===========================================================================

  async decide(user: RequestUser, proposalId: string, itemId: string, dto: PatchItemDto): Promise<ItemDecisionResponse> {
    const proposal = await this.access.require(user.id, 'proposal', proposalId, 'edit', user.permissions);
    this.checkDecisionShape(dto);
    const schema = await this.ontology.effectiveSchemaFor(user.id);

    await this.prisma.$transaction(
      async (tx) => {
        const status = await lockProposal(tx, proposalId);
        if (status !== 'draft') throw notDraft(status);

        const items = (await tx.kgProposalItem.findMany({
          where: { proposalId },
          select: ITEM_ROW_SELECT,
        })) as unknown as ProposalItemRowInput[];
        const row = items.find((i) => i.id === itemId);
        if (!row) throw new NotFoundException(PROPOSAL_ITEM_NOT_FOUND_MESSAGE);
        await this.applyDecision(tx, user.id, proposal, row, items, dto, schema);
      },
      { timeout: 30_000 },
    );

    const detail = await this.detail(await this.prisma.kgProposal.findUniqueOrThrow({ where: { id: proposalId } }), false);
    return { item: detail.items.find((i) => i.id === itemId)!, counts: detail.proposal.counts };
  }

  async bulk(user: RequestUser, proposalId: string, dto: BulkDecisionDto): Promise<BulkDecisionResponse> {
    await this.access.require(user.id, 'proposal', proposalId, 'edit', user.permissions);
    const ids = [...new Set(dto.itemIds.map((id) => id.toLowerCase()))];

    const { updated, skipped } = await this.prisma.$transaction(
      async (tx) => {
        const status = await lockProposal(tx, proposalId);
        if (status !== 'draft') throw notDraft(status);
        const items = await tx.kgProposalItem.findMany({
          where: { proposalId, id: { in: ids } },
          select: { id: true, kind: true, payload: true, editedPayload: true },
        });
        const found = new Map(items.map((i) => [i.id.toLowerCase(), i]));
        const skippedRows: Array<{ itemId: string; reason: BulkSkipReason }> = [];
        const apply: string[] = [];
        for (const id of ids) {
          const item = found.get(id);
          if (!item) {
            skippedRows.push({ itemId: id, reason: 'not_found' });
            continue;
          }
          if (dto.decision === 'accept') {
            // §5.6: a sensitive person fact, and a closing, are only ever accepted one at a time.
            if (item.kind === 'closing') {
              skippedRows.push({ itemId: item.id, reason: 'closing_requires_individual_accept' });
              continue;
            }
            const eff = effectivePayloadOf(item);
            if (item.kind === 'item' && eff.kind === 'person_fact' && eff.sensitivity === 'sensitive') {
              skippedRows.push({ itemId: item.id, reason: 'sensitive_requires_individual_accept' });
              continue;
            }
          }
          apply.push(item.id);
        }
        let count = 0;
        if (apply.length > 0) {
          // `merge_into_id` is set iff the decision is `merge_into` (the CHECK).
          const res = await tx.kgProposalItem.updateMany({
            where: { proposalId, id: { in: apply } },
            data: { decision: dto.decision, mergeIntoId: null },
          });
          count = res.count;
        }
        return { updated: count, skipped: skippedRows };
      },
      { timeout: 30_000 },
    );

    return { updated, skipped, counts: await this.countsFor(proposalId) };
  }

  async addItem(user: RequestUser, proposalId: string, dto: AddItemDto): Promise<ItemDecisionResponse> {
    const proposal = await this.access.require(user.id, 'proposal', proposalId, 'edit', user.permissions);
    if (dto.existingEntityId && dto.kind !== 'entity') {
      throw new BadRequestException('existingEntityId is only accepted for an entity row.');
    }
    const schema = await this.ontology.effectiveSchemaFor(user.id);

    const itemId = await this.prisma.$transaction(
      async (tx) => {
        const status = await lockProposal(tx, proposalId);
        if (status !== 'draft') throw notDraft(status);

        const items = (await tx.kgProposalItem.findMany({
          where: { proposalId },
          select: ITEM_ROW_SELECT,
        })) as unknown as ProposalItemRowInput[];

        const ref = nextUserRef(items);
        const raw = { ...asObject(dto.payload), ref };
        let payload: Json;
        let decision: 'accept' | 'merge_into' = 'accept';
        let mergeIntoId: string | null = null;

        if (dto.kind === 'entity') {
          const valid = validateEntityPayload(raw, schema);
          if (!valid.ok) throw invalidPayload(valid.issues);
          payload = valid.value as unknown as Json;
          if (dto.existingEntityId) {
            await this.requireMergeTarget(tx, user.id, dto.existingEntityId, valid.value.type);
            decision = 'merge_into';
            mergeIntoId = dto.existingEntityId;
          }
        } else {
          payload = await this.validateRowPayload(tx, user.id, dto.kind, raw, items, schema, null);
          await this.assertRefsReviewable(dto.kind, payload, items);
        }

        const evidence = await this.spans.validate(tx, { ownerId: user.id, noteId: proposal.noteId }, dto.evidence);
        const sortOrder = items.reduce((max, i) => Math.max(max, i.sortOrder), -1) + 1;
        const created = await tx.kgProposalItem.create({
          data: {
            proposalId,
            kind: dto.kind,
            payload: payload as Prisma.InputJsonValue,
            resolution: Prisma.DbNull,
            decision,
            mergeIntoId,
            origin: 'user',
            flags: [],
            sortOrder,
          },
          select: { id: true },
        });
        await tx.kgEvidence.createMany({
          data: evidence.map((e) => ({ ...e, ownerId: user.id, subjectKind: 'proposal_item' as const, subjectId: created.id })),
        });
        return created.id;
      },
      { timeout: 30_000 },
    );

    const detail = await this.detail(await this.prisma.kgProposal.findUniqueOrThrow({ where: { id: proposalId } }), false);
    return { item: detail.items.find((i) => i.id === itemId)!, counts: detail.proposal.counts };
  }

  // ===========================================================================
  // Discard
  // ===========================================================================

  /** `draft` or `failed` → `discarded`. Anything else is 409 `proposal_not_draft`. */
  async discard(user: RequestUser, proposalId: string): Promise<ProposalResponse> {
    const proposal = await this.access.require(user.id, 'proposal', proposalId, 'edit', user.permissions);
    const changed = await this.prisma.$executeRaw`
      UPDATE kg_proposals
         SET status = 'discarded',
             stats = stats || '{"discardReason":"user"}'::jsonb,
             updated_at = now()
       WHERE id = ${proposalId}::uuid
         AND status IN ('draft', 'failed')`;
    if (changed === 0) {
      const current = await this.prisma.kgProposal.findUnique({ where: { id: proposalId }, select: { status: true } });
      throw notDraft(current?.status ?? proposal.status);
    }
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: user.id,
        action: GRAPH_PROPOSAL_DISCARDED_ACTION,
        targetType: KG_PROPOSAL_TARGET_TYPE,
        targetId: proposalId,
        meta: { noteId: proposal.noteId },
      },
    });
    return { proposal: await this.summary(proposalId) };
  }

  // ===========================================================================
  // Private — decisions
  // ===========================================================================

  /** The body rules that need no database: which fields go with which decision. */
  private checkDecisionShape(dto: PatchItemDto): void {
    if (dto.decision === 'edit' && dto.editedPayload === undefined) {
      throw new BadRequestException({ message: "decision 'edit' needs editedPayload.", details: { issues: [{ path: 'editedPayload', message: 'Required' }] } });
    }
    if (dto.decision !== 'edit' && dto.editedPayload !== undefined) {
      throw new BadRequestException({ message: "editedPayload is only accepted with decision 'edit'.", details: { issues: [{ path: 'editedPayload', message: 'Only with decision edit' }] } });
    }
    if (dto.decision === 'merge_into' && dto.mergeIntoId === undefined) {
      throw new BadRequestException({ message: "decision 'merge_into' needs mergeIntoId.", details: { issues: [{ path: 'mergeIntoId', message: 'Required' }] } });
    }
    if (dto.decision !== 'merge_into' && dto.mergeIntoId !== undefined) {
      throw new BadRequestException({ message: "mergeIntoId is only accepted with decision 'merge_into'.", details: { issues: [{ path: 'mergeIntoId', message: 'Only with decision merge_into' }] } });
    }
  }

  private async applyDecision(
    tx: Tx,
    ownerId: string,
    proposal: KgProposal,
    row: ProposalItemRowInput,
    items: ProposalItemRowInput[],
    dto: PatchItemDto,
    schema: EffectiveSchema,
  ): Promise<void> {
    const bad = (path: string, message: string) => new BadRequestException({ message, details: { issues: [{ path, message }] } });

    if (row.kind === 'closing' && (dto.decision === 'edit' || dto.relinkTo || dto.distinctFrom)) {
      throw bad('decision', 'A closing row can only be accepted, rejected or left pending.');
    }
    if (dto.decision === 'merge_into' && row.kind !== 'entity') {
      throw bad('decision', "Only an entity row can be 'merge_into'.");
    }
    if (dto.distinctFrom && row.kind !== 'entity') {
      throw bad('distinctFrom', 'Only an entity row has candidates to set apart.');
    }
    if (dto.relinkTo) {
      if (row.kind !== 'relation' && row.kind !== 'item') throw bad('relinkTo.field', 'Only a relation or item row has endpoints.');
      if (!RELINK_FIELDS_BY_KIND[row.kind].includes(dto.relinkTo.field)) {
        throw bad('relinkTo.field', `A ${row.kind} row has no '${dto.relinkTo.field}' endpoint.`);
      }
      if (dto.relinkTo.target === null && !NULLABLE_RELINK_FIELDS.has(dto.relinkTo.field)) {
        throw bad('relinkTo.target', `'${dto.relinkTo.field}' cannot be cleared.`);
      }
    }

    const previous = effectivePayloadOf(row);
    let edited: Json | null = row.editedPayload !== null && typeof row.editedPayload === 'object' ? asObject(row.editedPayload) : null;
    let resolution = row.resolution !== null && typeof row.resolution === 'object' ? ({ ...(row.resolution as object) } as ProposalResolution) : null;
    let flags = [...row.flags];
    let distinctFrom = [...row.distinctFrom];
    let payloadChanged = false;

    if (dto.decision === 'edit') {
      edited = { ...asObject(dto.editedPayload), ref: asObject(row.payload).ref };
      payloadChanged = true;
    }

    if (dto.relinkTo) {
      const base = edited ?? { ...asObject(row.payload) };
      const target = dto.relinkTo.target;
      if (target && 'entityId' in target) {
        const live = await tx.kgEntity.findFirst({
          where: { id: target.entityId, ownerId, reviewStatus: { in: [...LIVE_REVIEW] } },
          select: { id: true },
        });
        if (!live) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
      }
      base[dto.relinkTo.field] = target;
      edited = base;
      payloadChanged = true;
    }

    if (payloadChanged && edited) {
      const kind = row.kind as 'entity' | 'relation' | 'item';
      edited = await this.validateRowPayload(tx, ownerId, kind, edited, items, schema, row.id);
      if (kind !== 'entity') await this.assertRefsReviewable(kind, edited, items);
      if (kind === 'entity' && edited.type !== previous.type) {
        // A type change: the old link cannot stand, and only candidates of the new type remain.
        if (resolution) {
          resolution = {
            ...resolution,
            ref: null,
            score: null,
            source: null,
            candidates: (resolution.candidates ?? []).filter((c) => c.type === edited!.type),
            adjudication: null,
          };
        }
        if (!flags.includes('type_changed')) flags = [...flags, 'type_changed'];
      }
    }

    let mergeIntoId: string | null = null;
    if (dto.decision === 'merge_into') {
      const type = String((edited ?? asObject(row.payload)).type ?? '');
      await this.requireMergeTarget(tx, ownerId, dto.mergeIntoId!, type);
      mergeIntoId = dto.mergeIntoId!;
    }

    if (dto.distinctFrom && dto.distinctFrom.length > 0) {
      const wanted = [...new Set(dto.distinctFrom.map((id) => id.toLowerCase()))];
      const owned = await tx.kgEntity.count({ where: { id: { in: wanted }, ownerId } });
      if (owned !== wanted.length) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
      distinctFrom = [...new Set([...distinctFrom.map((d) => d.toLowerCase()), ...wanted])];
      if (resolution) {
        const set = new Set(wanted);
        const refGone = typeof resolution.ref === 'string' && set.has(resolution.ref.toLowerCase());
        resolution = {
          ...resolution,
          candidates: (resolution.candidates ?? []).filter((c) => !set.has(c.entityId.toLowerCase())),
          ...(refGone ? { ref: null, score: null, source: null, adjudication: null } : {}),
        };
      }
    }

    if (dto.evidence && (dto.evidence.add.length > 0 || dto.evidence.remove.length > 0)) {
      const current = await tx.kgEvidence.findMany({
        where: { ownerId, subjectKind: 'proposal_item', subjectId: row.id },
        select: { id: true },
      });
      const currentIds = new Set(current.map((c) => c.id.toLowerCase()));
      const remove = [...new Set(dto.evidence.remove.map((id) => id.toLowerCase()))];
      if (remove.some((id) => !currentIds.has(id))) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.evidence);
      const added = await this.spans.validate(tx, { ownerId, noteId: proposal.noteId }, dto.evidence.add);
      if (current.length - remove.length + added.length < 1) {
        throw new BadRequestException({
          message: 'A row must keep at least one citation.',
          details: { reason: PROPOSAL_BAD_REQUEST_REASONS.WOULD_ORPHAN },
        });
      }
      if (remove.length > 0) {
        await tx.kgEvidence.deleteMany({ where: { id: { in: remove }, subjectKind: 'proposal_item', subjectId: row.id } });
      }
      if (added.length > 0) {
        await tx.kgEvidence.createMany({
          data: added.map((e) => ({ ...e, ownerId, subjectKind: 'proposal_item' as const, subjectId: row.id })),
        });
      }
    }

    await tx.kgProposalItem.update({
      where: { id: row.id },
      data: {
        decision: dto.decision,
        editedPayload: toJson(edited),
        mergeIntoId,
        resolution: resolution === null ? Prisma.DbNull : (resolution as unknown as Prisma.InputJsonValue),
        flags,
        distinctFrom,
      },
    });
  }

  /**
   * Validate an effective payload against the effective schema, resolving
   * `{ ref }` endpoints to this proposal's entity rows (`selfId`'s own new
   * type included) and `{ entityId }` endpoints to the caller's live entities.
   */
  private async validateRowPayload(
    tx: Tx,
    ownerId: string,
    kind: 'entity' | 'relation' | 'item',
    raw: Json,
    items: readonly ProposalItemRowInput[],
    schema: EffectiveSchema,
    selfId: string | null,
  ): Promise<Json> {
    let result: PayloadValidation<unknown>;
    if (kind === 'entity') {
      result = validateEntityPayload(raw, schema);
    } else {
      const refTypes = new Map<string, string>();
      for (const i of items) {
        if (i.kind !== 'entity' || i.id === selfId) continue;
        const eff = effectivePayloadOf(i);
        if (typeof eff.ref === 'string' && typeof eff.type === 'string') refTypes.set(eff.ref, eff.type);
      }
      const entityIds = endpointsOf(kind, raw).flatMap(({ endpoint }) =>
        'entityId' in endpoint && typeof endpoint.entityId === 'string' ? [endpoint.entityId] : [],
      );
      const entities = entityIds.length === 0 ? [] : await tx.kgEntity.findMany({
        where: { id: { in: entityIds }, ownerId, reviewStatus: { in: [...LIVE_REVIEW] } },
        select: { id: true, type: true },
      });
      const entityTypes = new Map(entities.map((e) => [e.id.toLowerCase(), e.type]));
      const typeOf = (e: EndpointRef): string | undefined =>
        'ref' in e ? refTypes.get(e.ref) : entityTypes.get(e.entityId.toLowerCase());
      result =
        kind === 'relation' ? validateRelationPayload(raw, schema, typeOf) : validateItemPayload(raw, schema, typeOf);
    }
    if (!result.ok) throw invalidPayload(result.issues);
    return result.value as Json;
  }

  /** Every `{ ref }` endpoint names an entity row of this proposal that is not rejected. */
  private async assertRefsReviewable(kind: 'relation' | 'item', payload: Json, items: readonly ProposalItemRowInput[]): Promise<void> {
    const byRef = new Map<string, ProposalItemRowInput>();
    for (const i of items) {
      if (i.kind !== 'entity') continue;
      const eff = effectivePayloadOf(i);
      if (typeof eff.ref === 'string') byRef.set(eff.ref, i);
    }
    const issues: PayloadIssue[] = [];
    for (const { field, endpoint } of endpointsOf(kind, payload)) {
      if (!('ref' in endpoint)) continue;
      const target = byRef.get(endpoint.ref);
      if (!target) issues.push({ path: field, message: `No entity row '${endpoint.ref}' in this proposal.`, code: 'endpoint_gone' });
      else if (target.decision === 'reject') {
        issues.push({ path: field, message: 'That entity row is rejected; accept it first.', code: 'endpoint_not_accepted' });
      }
    }
    if (issues.length > 0) throw invalidPayload(issues);
  }

  /** "This is the existing X": a live entity of the caller's, of the row's type. */
  private async requireMergeTarget(tx: Tx, ownerId: string, entityId: string, type: string): Promise<void> {
    const target = await tx.kgEntity.findFirst({
      where: { id: entityId, ownerId, reviewStatus: { in: [...LIVE_REVIEW] }, mergedIntoId: null },
      select: { id: true, type: true },
    });
    if (!target) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
    if (target.type !== type) {
      throw new BadRequestException({
        message: `That entity is a ${target.type}, not a ${type}.`,
        details: { issues: [{ path: 'mergeIntoId', message: `must be a ${type}` }] },
      });
    }
  }

  // ===========================================================================
  // Private — reads
  // ===========================================================================

  private async countsFor(proposalId: string) {
    const items = await this.prisma.kgProposalItem.findMany({
      where: { proposalId },
      select: { kind: true, decision: true, flags: true, payload: true, editedPayload: true },
    });
    return countsOf(items as never);
  }

  private async noteHeader(noteId: string): Promise<{ title: string; currentVersion: number } | null> {
    return this.prisma.note.findUnique({ where: { id: noteId }, select: { title: true, currentVersion: true } });
  }

  /** Every label, current rev and current version the mapper reads, in bounded queries. */
  private async lookups(
    proposal: KgProposal,
    rows: readonly ProposalItemRowInput[],
    evidence: ReadonlyArray<{ segmentId: string | null; noteId: string | null }>,
    schema: EffectiveSchema,
  ): Promise<ViewLookups> {
    const entityIds = new Set<string>();
    for (const row of rows) {
      const eff = effectivePayloadOf(row);
      for (const key of ['from', 'to', 'subject', 'owner', 'counterparty', 'meeting']) {
        const id = asObject(eff[key]).entityId;
        if (typeof id === 'string') entityIds.add(id);
      }
      if (typeof eff.existingEntityId === 'string') entityIds.add(eff.existingEntityId);
      const ref = asObject(row.resolution).ref;
      if (typeof ref === 'string') entityIds.add(ref);
      if (row.mergeIntoId) entityIds.add(row.mergeIntoId);
    }
    const segmentIds = [...new Set(evidence.flatMap((e) => (e.segmentId ? [e.segmentId] : [])))];
    const noteIds = [...new Set(evidence.flatMap((e) => (e.noteId ? [e.noteId] : [])))];
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = [...entityIds].filter((id) => UUID.test(id));

    const [entities, segments, notes] = await Promise.all([
      ids.length === 0 ? Promise.resolve([] as Array<{ id: string; label: string }>)
        : this.prisma.kgEntity.findMany({ where: { id: { in: ids }, ownerId: proposal.ownerId }, select: { id: true, label: true } }),
      segmentIds.length === 0 ? Promise.resolve([] as Array<{ id: string; rev: number; speaker: { displayName: string } | null }>)
        : this.prisma.transcriptSegment.findMany({
            where: { id: { in: segmentIds } },
            select: { id: true, rev: true, speaker: { select: { displayName: true } } },
          }),
      noteIds.length === 0 ? Promise.resolve([] as Array<{ id: string; currentVersion: number }>)
        : this.prisma.note.findMany({ where: { id: { in: noteIds } }, select: { id: true, currentVersion: true } }),
    ]);

    return {
      schema,
      entityLabels: new Map(entities.map((e) => [e.id, e.label])),
      segments: new Map(segments.map((s) => [s.id, { rev: s.rev, speakerName: s.speaker?.displayName ?? null }])),
      noteVersions: new Map(notes.map((n) => [n.id, n.currentVersion])),
      prechecked: precheckedOf(proposal.stats),
    };
  }

  /** The caller's notes that came from `transcriptId`, directly or through ≤ 5 hops of notes. */
  private async notesFromTranscript(ownerId: string, transcriptId: string): Promise<string[]> {
    const found = new Set<string>();
    let frontier = (
      await this.prisma.note.findMany({
        where: { ownerId, sourceType: 'transcript', sourceTranscriptId: transcriptId },
        select: { id: true },
      })
    ).map((n) => n.id);
    for (let hop = 0; frontier.length > 0 && hop <= MAX_NOTE_CHAIN_HOPS; hop += 1) {
      frontier.forEach((id) => found.add(id));
      if (hop === MAX_NOTE_CHAIN_HOPS) break;
      const next = await this.prisma.note.findMany({
        where: { ownerId, sourceType: 'note', sourceNoteId: { in: frontier } },
        select: { id: true },
      });
      frontier = next.map((n) => n.id).filter((id) => !found.has(id));
    }
    return [...found];
  }
}

/** The next server-assigned ref for a row the reviewer adds: `u1`, `u2`, … */
export function nextUserRef(items: ReadonlyArray<Pick<ProposalItemRowInput, 'payload'>>): string {
  let max = 0;
  for (const item of items) {
    const m = /^u(\d+)$/.exec(String(asObject(item.payload).ref ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `u${max + 1}`;
}
