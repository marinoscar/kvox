// =============================================================================
// GraphRelationEditsService (#586; docs/specs/ontology.md §5.2, §5.4, §8)
// =============================================================================
//
// The manual RELATION edit on an entity page — part of §8's second named
// exception (the manual edit) to "nothing enters the graph except through a
// reviewed proposal". A Person's manager (`REPORTS_TO`), employer
// (`WORKS_FOR`) or role (`HAS_ROLE`), set by hand, and a wrong one removed.
//
//   POST   /api/graph/entities/:id/relations
//   DELETE /api/graph/entities/:id/relations/:relationId
//
// The envelope mirrors `GraphEntitiesService.patch`:
//
//   1. authorise BOTH endpoints through `GraphAccessService.require(…,
//      'edit', …)` — 404 for no access (or a merged entity), never a 403 for
//      somebody else's row;
//   2. ONE transaction, every write through `GraphWriteService`;
//   3. afterwards, OUTSIDE it: the audit row (ids and counts only), the
//      `graph.changed` event (`manual_edit`) and the guarded follow-up
//      enqueues (`kg.embed`, `kg.entity_digest`) for both people/orgs.
//
// SET = THE CLOSING RULE THE COMMIT APPLIES. The three types are temporal and
// normally exclusive (§5.4). The new fact is dated (`validFrom`, default
// today, day precision, open-ended) and handed to #353's `planTemporalInsert`
// against the person's live edges of the type — the same planner, the same
// rule (`ruleForEffectiveRelation`) and the same edge query
// (`loadLiveTemporalEdges`) the proposal stages use:
//
//   attach_evidence  the same fact is already there (restated, or inside a
//                    known period) → the citation is added to it
//   create           a new edge; every `closes` entry is applied exactly as
//                    the commit applies a `closing` row: `closeRelation` at
//                    the new edge's start, `superseded_by_id` → the new edge
//
// One deliberate addition: an UNDATED live edge of the same fact (an
// extraction that stated no date) is cited rather than duplicated by a dated
// twin; the planner's closes still apply. An undated edge of a DIFFERENT fact
// is never closed (§5.4: it cannot be ordered) — the response flags it
// `unordered` and the page offers to remove it.
//
// EVIDENCE. The relation carries one server-authored `ManualEvidence` — the
// owner as the source, "Set by hand: Jenny Kim reports to Mark Chen" — so the
// deferred `kg_assert_has_evidence` trigger holds at COMMIT.
//
// REMOVE = A CORRECTION. `GraphWriteService.retractRelation`: the row becomes
// `rejected` (kept, never read), its range untouched, and whatever it closed
// is reopened. Ending a true fact is not a removal: set the next one.
//
// ⚠ Never log or audit a label or a quote: ids, types and counts only.
// =============================================================================

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  MANUAL_RELATION_TYPES,
  type CreateManualRelationDto,
  type CreateManualRelationResponse,
  type ManualRelation,
  type RemoveManualRelationResponse,
} from '@marinoscar/kvox-contract/graph';

import { GRAPH_NOT_FOUND_MESSAGES, GraphAccessService } from './access/graph-access.service.js';
import type { KgEntityRow, KvoxGraphDb, KvoxGraphTx, KgRelationRow } from './data/graph-db.js';
import type { GraphActor } from './graph-actor.js';
import { GraphEntitiesService } from './graph-entities.service.js';
import { GRAPH_CHANGED_EVENT, type GraphChangedEvent } from './graph-events.js';
import { KG_SUBJECT_ENTITY } from './job-types.js';
import { GraphOntologyService } from './ontology/graph-ontology.service.js';
import {
  fromPgRange,
  isExclusiveTemporal,
  planTemporalInsert,
  ruleForEffectiveRelation,
  sameIdentityProps,
  type CandidateEdge,
  type TemporalEdge,
  type TemporalFlag,
  type ValidPrecision,
} from './temporal/index.js';
import { toGraphHttpException } from './write/graph-write.errors.js';
import { GraphWriteService } from './write/graph-write.service.js';
import { loadLiveTemporalEdges } from './write/live-edges.js';
import { ManualEvidence } from './write/manual-evidence.js';
import { KVOX_AUDIT, KVOX_EVENTS, KVOX_PRISMA, type KvoxAuditPort, type KvoxEventsPort } from '../ports/index.js';

export const GRAPH_RELATION_SET_ACTION = 'graph.relation_set';
export const GRAPH_RELATION_REMOVED_ACTION = 'graph.relation_removed';

const MANUAL_TYPES: ReadonlySet<string> = new Set(MANUAL_RELATION_TYPES);

/** The UTC day `iso` names (`YYYY-MM-DD`), or today's. */
function dayStart(iso: string | undefined, now: Date): Date {
  const day = iso ?? now.toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00.000Z`);
}

/** The sentence the manual citation reads as. Labels are the owner's own data; never logged. */
export function manualRelationQuote(
  type: string,
  fromLabel: string,
  toLabel: string,
  props: { title?: string; businessUnit?: string | null } = {},
): string {
  switch (type) {
    case 'REPORTS_TO':
      return `Set by hand: ${fromLabel} reports to ${toLabel}`;
    case 'WORKS_FOR':
      return `Set by hand: ${fromLabel} works for ${toLabel}`;
    default: {
      const unit = props.businessUnit ? `, ${props.businessUnit}` : '';
      return `Set by hand: ${fromLabel} is ${props.title ?? 'a member'}${unit} at ${toLabel}`;
    }
  }
}

/**
 * GraphRelationEditsService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphRelationEditsService {
  private readonly logger = new Logger(GraphRelationEditsService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly access: GraphAccessService,
    private readonly ontology: GraphOntologyService,
    private readonly write: GraphWriteService,
    private readonly entities: GraphEntitiesService,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    @Inject(KVOX_AUDIT) private readonly auditPort: KvoxAuditPort,
  ) {}

  /** "Today", for a set without `validFrom` (a test seam). */
  protected now(): Date {
    return new Date();
  }

  /** `POST /api/graph/entities/:id/relations`. */
  async set(id: string, dto: CreateManualRelationDto, user: GraphActor): Promise<CreateManualRelationResponse> {
    const from = (await this.access.require(user.id, 'entity', id, 'edit', user.permissions)) as KgEntityRow;
    const to = (await this.access.require(user.id, 'entity', dto.toId, 'edit', user.permissions)) as KgEntityRow;
    if (from.id === to.id) throw new BadRequestException('A relation needs two different entities.');

    const schema = await this.ontology.effectiveSchemaFor(user.id);
    const relationType = schema.relationType(dto.type);
    if (!relationType || relationType.deprecated) {
      throw new BadRequestException(`'${dto.type}' is not a relation type in your graph.`);
    }
    const rule = ruleForEffectiveRelation(relationType);

    const props: Record<string, unknown> = {};
    if (dto.props) {
      props.title = dto.props.title;
      if (dto.props.businessUnit) props.businessUnit = dto.props.businessUnit;
    }
    const start = dayStart(dto.validFrom, this.now());
    const evidence = new ManualEvidence(manualRelationQuote(dto.type, from.label, to.label, dto.props));

    let outcome: { relationId: string; created: boolean; evidenceId: string; closed: string[]; flags: TemporalFlag[] };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // One manual edit per person at a time: two concurrent "set manager"
        // calls would otherwise both read the same open edge and both close it.
        await tx.$queryRaw`SELECT id FROM kg_entities WHERE id = ${from.id}::uuid FOR UPDATE`;

        const edges = await loadLiveTemporalEdges(tx, user.id, dto.type, from.id, rule.symmetric === true);
        const precision: ValidPrecision = 'day';
        const candidate: CandidateEdge = {
          type: dto.type,
          fromId: from.id,
          toId: to.id,
          props,
          valid: rule.temporal ? { from: start, to: null } : null,
          precision: rule.temporal ? precision : 'unknown',
        };
        const plan = planTemporalInsert(edges, candidate, rule);

        if (plan.action === 'attach_evidence') {
          const [row] = await this.write.addEvidence(tx, user.id, 'relation', plan.edgeId, [evidence]);
          return { relationId: plan.edgeId, created: false, evidenceId: row.id, closed: [], flags: [] };
        }

        let relationId: string;
        let created: boolean;
        let evidenceId: string;
        const undatedSame = edges.find(
          (e) => e.valid === null && e.toId === to.id && sameIdentityProps(e.props, props, rule),
        );
        if (undatedSame) {
          const [row] = await this.write.addEvidence(tx, user.id, 'relation', undatedSame.id, [evidence]);
          relationId = undatedSame.id;
          created = false;
          evidenceId = row.id;
        } else {
          const relation = await this.write.createRelation(
            tx,
            {
              ownerId: user.id,
              type: dto.type,
              fromId: from.id,
              toId: to.id,
              props,
              valid: candidate.valid ? { from: start, to: plan.candidateTo } : null,
              validPrecision: rule.temporal ? precision : null,
              reviewStatus: 'edited',
              evidence: [evidence],
            },
            schema,
          );
          relationId = relation.id;
          created = true;
          const row = await tx.kgEvidence.findFirst({
            where: { ownerId: user.id, subjectKind: 'relation', subjectId: relation.id },
            select: { id: true },
          });
          evidenceId = row!.id;
        }

        // The commit's closing step (#366 `commitClosing`), for each close the planner named.
        const closed: string[] = [];
        if (isExclusiveTemporal(rule)) {
          for (const close of plan.closes) {
            const edge = edges.find((e) => e.id === close.edgeId);
            if (!edge || edge.id === relationId) continue;
            const keep = edge.precision && edge.precision !== 'unknown' ? edge.precision : precision;
            await this.write.closeRelation(tx, user.id, edge.id, {
              valid: { from: edge.valid?.from ?? null, to: close.newTo },
              validPrecision: keep,
              supersededById: relationId,
            });
            closed.push(edge.id);
          }
        }
        return { relationId, created, evidenceId, closed: closed.sort(), flags: plan.flags };
      });
    } catch (err) {
      throw toGraphHttpException(err, this.logger) ?? err;
    }

    await this.auditPort.record({
      actorUserId: user.id,
      action: GRAPH_RELATION_SET_ACTION,
      targetType: KG_SUBJECT_ENTITY,
      targetId: from.id,
      meta: {
        relationId: outcome.relationId,
        relationType: dto.type,
        toId: to.id,
        created: outcome.created,
        closed: outcome.closed.length,
        flags: outcome.flags,
      },
    });
    await this.afterWrite(user.id, [from.id, to.id]);

    const relation = await this.readRelation(user.id, outcome.relationId);
    return {
      relation,
      created: outcome.created,
      evidenceId: outcome.evidenceId,
      closedRelationIds: outcome.closed,
      flags: outcome.flags,
    };
  }

  /** `DELETE /api/graph/entities/:id/relations/:relationId`. */
  async remove(id: string, relationId: string, user: GraphActor): Promise<RemoveManualRelationResponse> {
    await this.access.require(user.id, 'entity', id, 'edit', user.permissions);
    const relation = (await this.access.require(user.id, 'relation', relationId, 'edit', user.permissions)) as KgRelationRow;
    // A relation of another entity is not found HERE (the same 404, nothing leaks).
    if (relation.fromId !== id) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.relation);
    if (!MANUAL_TYPES.has(relation.type)) {
      throw new BadRequestException(`Only ${MANUAL_RELATION_TYPES.join(', ')} can be removed here.`);
    }

    let reopenedIds: string[];
    try {
      ({ reopenedIds } = await this.prisma.$transaction(async (tx: KvoxGraphTx) => {
        await tx.$queryRaw`SELECT id FROM kg_entities WHERE id = ${id}::uuid FOR UPDATE`;
        return this.write.retractRelation(tx, user.id, relationId);
      }));
    } catch (err) {
      throw toGraphHttpException(err, this.logger) ?? err;
    }

    await this.auditPort.record({
      actorUserId: user.id,
      action: GRAPH_RELATION_REMOVED_ACTION,
      targetType: KG_SUBJECT_ENTITY,
      targetId: id,
      meta: { relationId, relationType: relation.type, toId: relation.toId, reopened: reopenedIds.length },
    });
    await this.afterWrite(user.id, [id, relation.toId]);

    return { relationId, reviewStatus: 'rejected', reopenedRelationIds: reopenedIds };
  }

  /** After the commit: the layout listener's event, then each endpoint's embed/digest follow-ups. */
  private async afterWrite(ownerId: string, entityIds: string[]): Promise<void> {
    this.events.emit(GRAPH_CHANGED_EVENT, { ownerId, reason: 'manual_edit' } satisfies GraphChangedEvent);
    for (const entityId of new Set(entityIds)) await this.entities.enqueueFollowUps(ownerId, entityId);
  }

  private async readRelation(ownerId: string, relationId: string): Promise<ManualRelation> {
    const [row] = await this.prisma.$queryRaw<
      Array<{
        id: string;
        type: string;
        from_id: string;
        to_id: string;
        props: unknown;
        valid: string | null;
        valid_precision: string | null;
        review_status: string;
      }>
    >`SELECT id::text AS id, type, from_id::text AS from_id, to_id::text AS to_id, props,
             valid::text AS valid, valid_precision::text AS valid_precision, review_status::text AS review_status
        FROM kg_relations WHERE id = ${relationId}::uuid AND owner_id = ${ownerId}::uuid`;
    const range: TemporalEdge['valid'] = row.valid && !/^empty$/i.test(row.valid) ? fromPgRange(row.valid) : null;
    return {
      id: row.id,
      type: row.type,
      fromId: row.from_id,
      toId: row.to_id,
      props: (row.props ?? {}) as Record<string, unknown>,
      valid: range
        ? {
            from: range.from ? range.from.toISOString() : null,
            to: range.to ? range.to.toISOString() : null,
            precision: (row.valid_precision ?? 'unknown') as ValidPrecision,
          }
        : null,
      reviewStatus: row.review_status,
    };
  }
}
