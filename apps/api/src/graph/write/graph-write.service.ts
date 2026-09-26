// =============================================================================
// GraphWriteService (#355, epic #344; docs/specs/ontology.md §3.3, §5, §7, §8)
// =============================================================================
//
// THE ONLY SANCTIONED WRITE PATH for `kg_entities`, `kg_relations`,
// `kg_items`, their evidence and their aliases. The proposal commit (#366),
// speaker naming (#356), merges (#364), imports (#387) and the manual entity
// edit all call it. A PR that writes one of those rows any other way should be
// rejected in review: the no-orphans invariant (§3.3) holds only while every
// writer runs the same checks.
//
// EVERY METHOD TAKES THE CALLER'S TRANSACTION and never opens its own: a
// commit writes many rows and must succeed or fail as one. The deferred
// constraint trigger (`kg_evidence_invariant` migration) is the database's
// backstop, checked at that transaction's COMMIT.
//
// What each create checks, in order, BEFORE its first insert:
//   1. type      — in the effective schema, not deprecated for new rows, and
//                  stored where this method writes (entity vs item)
//   2. props     — closed validation (`validateProps`): an unknown key is a 400
//   3. endpoints — relations: `edge`/`speaker_link` only; endpoint types in
//                  `from`/`to`/`allowedPairs`; `fromSpeakerId` only for
//                  `IDENTIFIED_AS`; both entities owned and live
//   4. temporal  — non-temporal: no `valid`; temporal: a precision, and
//                  `unknown` means no range
//   5. items     — status in the type's statuses; a subject where required and
//                  of an allowed type; `person_fact` sensitivity defaulting to
//                  the type's default (`personal`), never `business`
//   6. evidence  — at least one, every anchor readable (`EvidenceValidator`)
//   7. stamping  — `ontology_version = ONTOLOGY_VERSION`
//   8. supersedes— the older row → `superseded`, linked to the new one
//   9. aliases   — an entity's own label is always an alias row
//
// Errors are DOMAIN errors (`graph-write.errors.ts`); an HTTP caller maps them
// with `toGraphHttpException`.
//
// ⚠ Never log a label, a statement, a quote or a props value: a graph is
// somebody's reading of their private conversations. Ids and counts only.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ONTOLOGY_VERSION,
  validateProps,
  type EffectiveEntityType,
  type EffectiveSchema,
  type KgItemKind,
  type ValidPrecision,
} from '@app/shared/ontology';
import {
  Prisma,
  type KgAliasSource,
  type KgEntity,
  type KgEntityAlias,
  type KgEvidence,
  type KgItem,
  type KgRelation,
  type KgSensitivity,
} from '@prisma/client';

import type { EvidenceInput } from '../dto/graph-evidence.dto';
import { GRAPH_NOT_FOUND_MESSAGES } from '../access/graph-access.service';
import { toPgRange, type ValidRange } from '../temporal';
import { EvidenceValidator } from './evidence-validator.service';
import {
  GraphDuplicateError,
  GraphInvariantError,
  GraphValidationError,
} from './graph-write.errors';
import { normalizeAlias, statementHash } from './normalize';

type Tx = Prisma.TransactionClient;
type CuratedStatus = 'accepted' | 'edited';

export interface AliasInput {
  alias: string;
  source: KgAliasSource;
}

export interface CreateEntityInput {
  ownerId: string;
  type: string;
  label: string;
  props?: Record<string, unknown>;
  occurredAt?: Date | null;
  reviewStatus: CuratedStatus;
  aliases?: AliasInput[];
  /** Provenance of the label's own alias row (rule 9). */
  labelSource: KgAliasSource;
  /** At least one — enforced. */
  evidence: EvidenceInput[];
}

export interface CreateRelationInput {
  ownerId: string;
  type: string;
  fromId?: string;
  fromSpeakerId?: string;
  toId: string;
  props?: Record<string, unknown>;
  valid?: ValidRange | null;
  validPrecision?: ValidPrecision | null;
  confidence?: number | null;
  reviewStatus: CuratedStatus;
  supersedesId?: string | null;
  evidence: EvidenceInput[];
}

export interface CreateItemInput {
  ownerId: string;
  kind: KgItemKind;
  /** Ontology key, e.g. 'Commitment'. */
  typeKey: string;
  subjectId?: string | null;
  meetingId?: string | null;
  ownerPersonId?: string | null;
  counterpartyId?: string | null;
  title?: string | null;
  statement: string;
  status?: string;
  occurredAt?: Date | null;
  dueAt?: Date | null;
  sensitivity?: KgSensitivity | null;
  props?: Record<string, unknown>;
  valid?: ValidRange | null;
  validPrecision?: ValidPrecision | null;
  confidence?: number | null;
  reviewStatus: CuratedStatus;
  supersedesId?: string | null;
  evidence: EvidenceInput[];
}

/** A manual edit (§8's second named exception). `type` is always refused. */
export interface EntityPatch {
  label?: string;
  /** Merge: `key → value` sets, `key → null` clears. */
  props?: Record<string, unknown>;
  addAliases?: string[];
  removeAliasIds?: string[];
  type?: unknown;
}

/** What an edit changed — keys and counts only, never values (audit meta). */
export interface EntityUpdateResult {
  entity: KgEntity;
  changed: boolean;
  changedKeys: string[];
  labelChanged: boolean;
  aliasesAdded: number;
  aliasesRemoved: number;
}

export type EvidenceSubjectKind = 'entity' | 'relation' | 'item' | 'proposal_item';

/** Review states in which a row is part of the owner's curated graph. */
const LIVE_STATUSES: CuratedStatus[] = ['accepted', 'edited'];

/** `kg_items` columns that carry an entity reference, and the input field for each. */
const ITEM_ENTITY_COLUMNS = [
  { column: 'meeting_id', field: 'meetingId' },
  { column: 'owner_person_id', field: 'ownerPersonId' },
  { column: 'counterparty_id', field: 'counterpartyId' },
] as const;

function invalid(message: string, path: string, issueMessage = message): GraphValidationError {
  return new GraphValidationError(message, { issues: [{ path, message: issueMessage }] });
}

/** Drop `null`-valued keys: on write, null means "not set". */
function withoutNulls(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== null && v !== undefined));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

@Injectable()
export class GraphWriteService {
  constructor(private readonly evidenceValidator: EvidenceValidator) {}

  // ===========================================================================
  // Entities
  // ===========================================================================

  async createEntity(tx: Tx, input: CreateEntityInput, schema: EffectiveSchema): Promise<KgEntity> {
    this.requireEvidence(input.evidence);
    this.requireCuratedStatus(input.reviewStatus);

    const type = schema.entityType(input.type);
    if (!type || type.storage !== 'entity') {
      throw invalid(`'${input.type}' is not an entity type in your graph.`, 'type');
    }
    if (type.deprecated) throw invalid(`'${input.type}' is retired and takes no new entities.`, 'type');

    const props = this.validatedProps(schema, input.type, input.props ?? {}, false);

    const label = input.label.trim();
    const aliasRows = this.dedupeAliases([
      { alias: label, source: input.labelSource },
      ...(input.aliases ?? []),
    ]);

    const evidence = await this.evidenceValidator.assertReadable(input.ownerId, input.evidence, tx);

    const entity = await tx.kgEntity.create({
      data: {
        ownerId: input.ownerId,
        type: input.type,
        label,
        props: props as Prisma.InputJsonObject,
        occurredAt: input.occurredAt ?? null,
        reviewStatus: input.reviewStatus,
        ontologyVersion: ONTOLOGY_VERSION,
      },
    });

    await tx.kgEntityAlias.createMany({
      data: aliasRows.map((a) => ({
        entityId: entity.id,
        ownerId: input.ownerId,
        alias: a.alias,
        normalized: a.normalized,
        source: a.source,
      })),
      skipDuplicates: true,
    });

    await this.insertEvidence(tx, input.ownerId, 'entity', entity.id, evidence);
    return entity;
  }

  /** `updateEntityDetailed`, returning only the row (the contract signature). */
  async updateEntity(
    tx: Tx,
    ownerId: string,
    entityId: string,
    patch: EntityPatch,
    schema: EffectiveSchema,
  ): Promise<KgEntity> {
    return (await this.updateEntityDetailed(tx, ownerId, entityId, patch, schema)).entity;
  }

  /**
   * A manual edit. Evidence is untouched — the entity already has citations,
   * and an edit is curation (§8). `accepted` becomes `edited` when anything
   * changed. A changed label keeps the old one as an alias (`source: 'user'`),
   * so resolution still finds the previous name.
   */
  async updateEntityDetailed(
    tx: Tx,
    ownerId: string,
    entityId: string,
    patch: EntityPatch,
    schema: EffectiveSchema,
  ): Promise<EntityUpdateResult> {
    if (patch.type !== undefined) {
      throw invalid('Change a type through a proposal.', 'type');
    }

    const entity = await tx.kgEntity.findFirst({
      where: { id: entityId, ownerId, reviewStatus: { in: LIVE_STATUSES } },
    });
    if (!entity) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);

    // Props: merge, then validate the MERGED result — a patch that is valid on
    // its own can still leave a required attribute cleared.
    const current = (entity.props ?? {}) as Record<string, unknown>;
    let nextProps = current;
    const changedKeys: string[] = [];
    if (patch.props !== undefined) {
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch.props)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      nextProps = withoutNulls(this.validatedProps(schema, entity.type, merged, false));
      for (const key of new Set([...Object.keys(current), ...Object.keys(nextProps)])) {
        if (!sameJson(current[key], nextProps[key])) changedKeys.push(key);
      }
      changedKeys.sort();
    }

    // Label: the new label AND the old one become (or stay) aliases.
    const newLabel = patch.label?.trim();
    const labelChanged = newLabel !== undefined && newLabel !== entity.label;
    const wanted: AliasInput[] = [];
    if (labelChanged) {
      wanted.push({ alias: newLabel, source: 'user' }, { alias: entity.label, source: 'user' });
    }
    for (const alias of patch.addAliases ?? []) wanted.push({ alias, source: 'user' });
    const normalizedWanted = this.dedupeAliases(wanted);

    // Removal: never the alias that IS the current label (#364's exact-match
    // arm reads aliases only, never `kg_entities.label`).
    const removeIds = [...new Set(patch.removeAliasIds ?? [])];
    let aliasesRemoved = 0;
    if (removeIds.length > 0) {
      const labelNormalized = normalizeAlias(newLabel ?? entity.label);
      const targets = await tx.kgEntityAlias.findMany({
        where: { id: { in: removeIds }, entityId, ownerId },
        select: { id: true, normalized: true },
      });
      if (targets.some((t) => t.normalized === labelNormalized)) {
        throw invalid('The current label cannot be removed as an alias.', 'removeAliasIds');
      }
      if (targets.length > 0) {
        const deleted = await tx.kgEntityAlias.deleteMany({
          where: { id: { in: targets.map((t) => t.id) }, entityId, ownerId },
        });
        aliasesRemoved = deleted.count;
      }
    }

    let aliasesAdded = 0;
    if (normalizedWanted.length > 0) {
      const existing = await tx.kgEntityAlias.findMany({
        where: { entityId, normalized: { in: normalizedWanted.map((a) => a.normalized) } },
        select: { normalized: true },
      });
      const known = new Set(existing.map((e) => e.normalized));
      const fresh = normalizedWanted.filter((a) => !known.has(a.normalized));
      if (fresh.length > 0) {
        const created = await tx.kgEntityAlias.createMany({
          data: fresh.map((a) => ({
            entityId,
            ownerId,
            alias: a.alias,
            normalized: a.normalized,
            source: a.source,
          })),
          skipDuplicates: true,
        });
        aliasesAdded = created.count;
      }
    }

    // Only aliases the caller ASKED to add count as added — the old label
    // re-recorded on a rename is bookkeeping, not an addition they made.
    const changed = labelChanged || changedKeys.length > 0 || aliasesAdded > 0 || aliasesRemoved > 0;

    const updated = changed
      ? await tx.kgEntity.update({
          where: { id: entityId },
          data: {
            ...(labelChanged ? { label: newLabel } : {}),
            ...(changedKeys.length > 0 ? { props: nextProps as Prisma.InputJsonObject } : {}),
            reviewStatus: 'edited',
          },
        })
      : entity;

    return { entity: updated, changed, changedKeys, labelChanged, aliasesAdded, aliasesRemoved };
  }

  // ===========================================================================
  // Relations
  // ===========================================================================

  async createRelation(tx: Tx, input: CreateRelationInput, schema: EffectiveSchema): Promise<KgRelation> {
    this.requireEvidence(input.evidence);
    this.requireCuratedStatus(input.reviewStatus);

    const relation = schema.relationType(input.type);
    if (!relation) throw invalid(`'${input.type}' is not a relation type in your graph.`, 'type');
    if (relation.deprecated) throw invalid(`'${input.type}' is retired and takes no new relations.`, 'type');
    const representation = relation.representation.kind;
    if (representation !== 'edge' && representation !== 'speaker_link') {
      throw invalid(
        `'${input.type}' is not stored as a relation (it is represented as '${representation}').`,
        'type',
      );
    }

    // Endpoints: exactly one source, and a speaker only for IDENTIFIED_AS.
    if (input.fromSpeakerId !== undefined && input.fromSpeakerId !== null) {
      if (representation !== 'speaker_link') {
        throw invalid(`fromSpeakerId is allowed only for IDENTIFIED_AS, not '${input.type}'.`, 'fromSpeakerId');
      }
      if (input.fromId) throw invalid('Send fromId or fromSpeakerId, not both.', 'fromId');
    } else if (representation === 'speaker_link') {
      throw invalid(`'${input.type}' needs fromSpeakerId.`, 'fromSpeakerId');
    } else if (!input.fromId) {
      throw invalid('A relation needs fromId.', 'fromId');
    }

    const props = withoutNulls(this.validatedProps(schema, input.type, input.props ?? {}, true));
    this.checkTemporal(relation.temporal, input.valid, input.validPrecision, input.type);
    this.checkConfidence(input.confidence);

    // Both endpoints owned and live, and of permitted types.
    const entityIds = [input.toId, ...(input.fromId ? [input.fromId] : [])];
    const types = await this.liveEntityTypes(tx, input.ownerId, entityIds);
    const toType = types.get(input.toId);
    if (!toType) throw invalid('The target is not an entity in your graph.', 'toId');
    if (!relation.to.includes(toType)) {
      throw invalid(`'${input.type}' cannot point at a ${toType}.`, 'toId', `must be one of: ${relation.to.join(', ')}`);
    }
    if (input.fromId) {
      const fromType = types.get(input.fromId);
      if (!fromType) throw invalid('The source is not an entity in your graph.', 'fromId');
      if (!relation.from.includes(fromType)) {
        throw invalid(
          `'${input.type}' cannot start from a ${fromType}.`,
          'fromId',
          `must be one of: ${relation.from.join(', ')}`,
        );
      }
      if (relation.allowedPairs && !relation.allowedPairs.some(([a, b]) => a === fromType && b === toType)) {
        throw invalid(`'${input.type}' does not connect a ${fromType} to a ${toType}.`, 'toId');
      }
    } else {
      await this.requireViewableSpeaker(tx, input.ownerId, input.fromSpeakerId!);
    }

    if (input.supersedesId) {
      const older = await tx.kgRelation.findFirst({
        where: { id: input.supersedesId, ownerId: input.ownerId, reviewStatus: { in: LIVE_STATUSES } },
        select: { id: true },
      });
      if (!older) throw invalid('The relation to supersede is not in your graph.', 'supersedesId');
    }

    const evidence = await this.evidenceValidator.assertReadable(input.ownerId, input.evidence, tx);

    const created = await tx.kgRelation.create({
      data: {
        ownerId: input.ownerId,
        type: input.type,
        fromId: input.fromId ?? null,
        fromSpeakerId: input.fromSpeakerId ?? null,
        toId: input.toId,
        props: props as Prisma.InputJsonObject,
        confidence: input.confidence ?? null,
        reviewStatus: input.reviewStatus,
        ontologyVersion: ONTOLOGY_VERSION,
      },
    });

    const validPrecision = input.validPrecision ?? null;
    if (validPrecision !== null) {
      // `valid` and `valid_precision` land in ONE statement:
      // `kg_relations_valid_precision_chk` is immediate, so writing them
      // apart would fail between the two.
      const literal = input.valid ? toPgRange(input.valid) : null;
      await tx.$executeRaw`UPDATE kg_relations SET valid = ${literal}::tstzrange, valid_precision = ${validPrecision}::kg_valid_precision WHERE id = ${created.id}::uuid`;
    }

    await this.insertEvidence(tx, input.ownerId, 'relation', created.id, evidence);

    if (input.supersedesId) {
      await tx.kgRelation.update({
        where: { id: input.supersedesId },
        data: { supersededById: created.id, reviewStatus: 'superseded' },
      });
    }

    return { ...created, validPrecision } as KgRelation;
  }

  // ===========================================================================
  // Items
  // ===========================================================================

  async createItem(tx: Tx, input: CreateItemInput, schema: EffectiveSchema): Promise<KgItem> {
    this.requireEvidence(input.evidence);
    this.requireCuratedStatus(input.reviewStatus);

    const type = schema.entityType(input.typeKey);
    if (!type || type.storage !== 'item') {
      throw invalid(`'${input.typeKey}' is not an item type in your graph.`, 'typeKey');
    }
    if (type.deprecated) throw invalid(`'${input.typeKey}' is retired and takes no new items.`, 'typeKey');
    if (type.itemKind !== input.kind) {
      throw invalid(`'${input.typeKey}' is stored as '${type.itemKind}', not '${input.kind}'.`, 'kind');
    }

    const props = withoutNulls(this.validatedProps(schema, input.typeKey, input.props ?? {}, false));

    const status = input.status ?? (input.kind === 'commitment' ? 'open' : 'active');
    if (!(type.statuses ?? []).includes(status)) {
      throw invalid(`'${status}' is not a status of ${input.typeKey}.`, 'status', `must be one of: ${(type.statuses ?? []).join(', ')}`);
    }

    const subjectRequired = type.subjectRequired || input.kind === 'claim' || input.kind === 'person_fact';
    if (subjectRequired && !input.subjectId) throw invalid(`A ${input.typeKey} needs a subject.`, 'subjectId');

    // `person_fact` is the one kind that carries a sensitivity, defaulting to
    // the type's own default (`personal`) — never `business` (§15).
    const sensitivity: KgSensitivity | null =
      input.kind === 'person_fact' ? (input.sensitivity ?? (type.sensitivityDefault as KgSensitivity)) : null;

    this.checkTemporal(true, input.valid, input.validPrecision, input.typeKey);
    this.checkConfidence(input.confidence);

    const statement = input.statement.trim();
    const hash = statementHash(input.kind, statement);

    await this.checkItemReferences(tx, input, type, schema);

    if (input.supersedesId) {
      const older = await tx.kgItem.findFirst({
        where: { id: input.supersedesId, ownerId: input.ownerId, reviewStatus: { in: LIVE_STATUSES } },
        select: { id: true },
      });
      if (!older) throw invalid('The item to supersede is not in your graph.', 'supersedesId');
    }

    // The "known, skipped" check, BEFORE the insert: a unique violation inside
    // an interactive transaction aborts it, and the proposal commit (#366)
    // must be able to attach evidence to the existing row instead.
    if (input.subjectId) {
      const duplicate = await tx.kgItem.findFirst({
        where: {
          ownerId: input.ownerId,
          kind: input.kind,
          subjectId: input.subjectId,
          statementHash: hash,
          reviewStatus: { in: LIVE_STATUSES },
          ...(input.supersedesId ? { id: { not: input.supersedesId } } : {}),
        },
        select: { id: true },
      });
      if (duplicate) throw new GraphDuplicateError(hash, duplicate.id);
    }

    const evidence = await this.evidenceValidator.assertReadable(input.ownerId, input.evidence, tx);

    // Retire the older row FIRST: a restatement that supersedes its own
    // predecessor carries the same hash, and the live-statement index would
    // refuse the new row while the old one is still live.
    if (input.supersedesId) {
      await tx.kgItem.update({
        where: { id: input.supersedesId },
        data: { reviewStatus: 'superseded', status: 'superseded' },
      });
    }

    let created: KgItem;
    try {
      created = await tx.kgItem.create({
        data: {
          id: randomUUID(),
          ownerId: input.ownerId,
          kind: input.kind,
          subjectId: input.subjectId ?? null,
          meetingId: input.meetingId ?? null,
          ownerPersonId: input.ownerPersonId ?? null,
          counterpartyId: input.counterpartyId ?? null,
          title: input.title?.trim() || null,
          statement,
          status,
          props: props as Prisma.InputJsonObject,
          occurredAt: input.occurredAt ?? null,
          dueAt: input.dueAt ?? null,
          sensitivity,
          statementHash: hash,
          confidence: input.confidence ?? null,
          reviewStatus: input.reviewStatus,
          ontologyVersion: ONTOLOGY_VERSION,
        },
      });
    } catch (err) {
      // The race the pre-check cannot close. The transaction is aborted now;
      // the caller sees the same error type either way.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new GraphDuplicateError(hash);
      }
      throw err;
    }

    const validPrecision = input.validPrecision ?? null;
    if (validPrecision !== null) {
      const literal = input.valid ? toPgRange(input.valid) : null;
      await tx.$executeRaw`UPDATE kg_items SET valid = ${literal}::tstzrange, valid_precision = ${validPrecision}::kg_valid_precision WHERE id = ${created.id}::uuid`;
    }

    await this.insertEvidence(tx, input.ownerId, 'item', created.id, evidence);

    if (input.supersedesId) {
      await tx.kgItem.update({ where: { id: input.supersedesId }, data: { supersededById: created.id } });
    }

    return { ...created, validPrecision } as KgItem;
  }

  // ===========================================================================
  // Evidence
  // ===========================================================================

  async addEvidence(
    tx: Tx,
    ownerId: string,
    subjectKind: EvidenceSubjectKind,
    subjectId: string,
    evidence: EvidenceInput[],
  ): Promise<KgEvidence[]> {
    if (evidence.length === 0) return [];
    await this.requireOwnedSubject(tx, ownerId, subjectKind, subjectId);
    const parsed = await this.evidenceValidator.assertReadable(ownerId, evidence, tx);
    return tx.kgEvidence.createManyAndReturn({
      data: parsed.map((e) => this.evidenceRow(ownerId, subjectKind, subjectId, e)),
    });
  }

  /**
   * Remove one citation. Refuses the LAST citation of an accepted/edited
   * subject with a 400 — the request is invalid in itself, so it is not a new
   * 409 reason.
   */
  async removeEvidence(tx: Tx, ownerId: string, evidenceId: string): Promise<void> {
    const row = await tx.kgEvidence.findFirst({ where: { id: evidenceId, ownerId } });
    if (!row) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.evidence);

    if (row.subjectKind === 'entity' || row.subjectKind === 'relation' || row.subjectKind === 'item') {
      const status = await this.subjectStatus(tx, row.subjectKind, row.subjectId);
      if (status === 'accepted' || status === 'edited') {
        const remaining = await tx.kgEvidence.count({
          where: { subjectKind: row.subjectKind, subjectId: row.subjectId },
        });
        if (remaining <= 1) throw new GraphInvariantError('last_evidence');
      }
    }

    await tx.kgEvidence.delete({ where: { id: row.id } });
  }

  // ===========================================================================
  // Aliases
  // ===========================================================================

  /** Add aliases; one whose `normalized` form already exists is skipped, not an error. */
  async addAliases(tx: Tx, ownerId: string, entityId: string, aliases: AliasInput[]): Promise<KgEntityAlias[]> {
    const normalized = this.dedupeAliases(aliases);
    await this.requireOwnedSubject(tx, ownerId, 'entity', entityId);
    if (normalized.length === 0) return [];

    const existing = await tx.kgEntityAlias.findMany({
      where: { entityId, normalized: { in: normalized.map((a) => a.normalized) } },
      select: { normalized: true },
    });
    const known = new Set(existing.map((e) => e.normalized));
    const fresh = normalized.filter((a) => !known.has(a.normalized));
    if (fresh.length === 0) return [];

    return tx.kgEntityAlias.createManyAndReturn({
      data: fresh.map((a) => ({ entityId, ownerId, alias: a.alias, normalized: a.normalized, source: a.source })),
      skipDuplicates: true,
    });
  }

  async removeAliases(tx: Tx, ownerId: string, entityId: string, aliasIds: string[]): Promise<void> {
    if (aliasIds.length === 0) return;
    const entity = await tx.kgEntity.findFirst({ where: { id: entityId, ownerId }, select: { label: true } });
    if (!entity) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
    const labelNormalized = normalizeAlias(entity.label);
    const targets = await tx.kgEntityAlias.findMany({
      where: { id: { in: aliasIds }, entityId, ownerId },
      select: { id: true, normalized: true },
    });
    if (targets.some((t) => t.normalized === labelNormalized)) {
      throw invalid('The current label cannot be removed as an alias.', 'aliasIds');
    }
    await tx.kgEntityAlias.deleteMany({ where: { id: { in: targets.map((t) => t.id) }, entityId, ownerId } });
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private requireEvidence(evidence: readonly EvidenceInput[] | undefined): void {
    if (!evidence || evidence.length === 0) throw new GraphInvariantError('evidence_required');
  }

  private requireCuratedStatus(status: string): void {
    if (status !== 'accepted' && status !== 'edited') {
      throw invalid(`A new graph row is 'accepted' or 'edited', not '${status}'.`, 'reviewStatus');
    }
  }

  private validatedProps(
    schema: EffectiveSchema,
    typeKey: string,
    props: Record<string, unknown>,
    relation: boolean,
  ): Record<string, unknown> {
    const result = validateProps(schema, typeKey, props, { relation });
    if (!result.ok) {
      throw new GraphValidationError('Some attributes are not valid for this type.', { issues: result.issues });
    }
    return result.value;
  }

  private checkTemporal(
    temporal: boolean,
    valid: ValidRange | null | undefined,
    precision: ValidPrecision | null | undefined,
    typeKey: string,
  ): void {
    const hasValid = valid !== undefined && valid !== null;
    const hasPrecision = precision !== undefined && precision !== null;
    if (!temporal) {
      if (hasValid || hasPrecision) {
        throw invalid(`'${typeKey}' is not time-bounded; send no valid range or precision.`, hasValid ? 'valid' : 'validPrecision');
      }
      return;
    }
    if (hasValid && !hasPrecision) {
      throw invalid('A valid range needs a validPrecision.', 'validPrecision');
    }
    if (precision === 'unknown' && hasValid) {
      throw invalid("validPrecision 'unknown' means no valid range.", 'valid');
    }
    if (hasPrecision && precision !== 'unknown' && !hasValid) {
      throw invalid(`validPrecision '${precision}' needs a valid range.`, 'valid');
    }
    if (hasValid && valid.from && valid.to && valid.to.getTime() <= valid.from.getTime()) {
      throw invalid('A valid range must end after it starts.', 'valid');
    }
  }

  private checkConfidence(confidence: number | null | undefined): void {
    if (confidence === undefined || confidence === null) return;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw invalid('confidence must be between 0 and 1.', 'confidence');
    }
  }

  /**
   * The types of the owner's LIVE entities among `ids`, in one query on the
   * caller's transaction — so an entity the same commit created a moment ago
   * is visible, which `GraphAccessService.ownsAll` (on the pool) could not see.
   */
  private async liveEntityTypes(tx: Tx, ownerId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await tx.kgEntity.findMany({
      where: { id: { in: unique }, ownerId, reviewStatus: { in: LIVE_STATUSES } },
      select: { id: true, type: true },
    });
    return new Map(rows.map((r) => [r.id, r.type]));
  }

  /** Subject, meeting, owner person and counterparty: owned, live, and of an allowed type. */
  private async checkItemReferences(
    tx: Tx,
    input: CreateItemInput,
    type: EffectiveEntityType,
    schema: EffectiveSchema,
  ): Promise<void> {
    const refs: { field: string; id: string; allowed: readonly string[] }[] = [];
    if (input.subjectId) refs.push({ field: 'subjectId', id: input.subjectId, allowed: type.subjectTypes ?? [] });
    for (const { column, field } of ITEM_ENTITY_COLUMNS) {
      const id = input[field];
      if (!id) continue;
      // The relation types represented by this column, from this item type.
      const allowed = schema.relationTypes
        .filter(
          (r) =>
            r.representation.kind === 'item_column' &&
            r.representation.column === column &&
            r.from.includes(type.key),
        )
        .flatMap((r) => r.to);
      if (allowed.length === 0) throw invalid(`A ${type.key} has no ${field}.`, field);
      refs.push({ field, id, allowed });
    }
    if (refs.length === 0) return;

    const types = await this.liveEntityTypes(tx, input.ownerId, refs.map((r) => r.id));
    for (const ref of refs) {
      const actual = types.get(ref.id);
      if (!actual) throw invalid(`${ref.field} is not an entity in your graph.`, ref.field);
      if (!ref.allowed.includes(actual)) {
        throw invalid(`A ${type.key}'s ${ref.field} cannot be a ${actual}.`, ref.field, `must be one of: ${ref.allowed.join(', ')}`);
      }
    }
  }

  /** A diarized speaker, in a transcript the owner can view (the evidence rule). */
  private async requireViewableSpeaker(tx: Tx, ownerId: string, speakerId: string): Promise<void> {
    const speaker = await tx.transcriptSpeaker.findFirst({
      where: {
        id: speakerId,
        transcript: { deletedAt: null, OR: [{ ownerId }, { shares: { some: { userId: ownerId } } }] },
      },
      select: { id: true },
    });
    if (!speaker) throw invalid('The speaker is not in a transcript you can view.', 'fromSpeakerId');
  }

  private async requireOwnedSubject(tx: Tx, ownerId: string, kind: EvidenceSubjectKind, id: string): Promise<void> {
    let found: unknown;
    switch (kind) {
      case 'entity':
        found = await tx.kgEntity.findFirst({ where: { id, ownerId }, select: { id: true } });
        break;
      case 'relation':
        found = await tx.kgRelation.findFirst({ where: { id, ownerId }, select: { id: true } });
        break;
      case 'item':
        found = await tx.kgItem.findFirst({ where: { id, ownerId }, select: { id: true } });
        break;
      case 'proposal_item':
        found = await tx.kgProposalItem.findFirst({ where: { id, proposal: { ownerId } }, select: { id: true } });
        break;
    }
    if (!found) {
      throw new NotFoundException(
        kind === 'proposal_item' ? GRAPH_NOT_FOUND_MESSAGES.proposal : GRAPH_NOT_FOUND_MESSAGES[kind],
      );
    }
  }

  private async subjectStatus(tx: Tx, kind: 'entity' | 'relation' | 'item', id: string): Promise<string | null> {
    const select = { reviewStatus: true } as const;
    const row =
      kind === 'entity'
        ? await tx.kgEntity.findUnique({ where: { id }, select })
        : kind === 'relation'
          ? await tx.kgRelation.findUnique({ where: { id }, select })
          : await tx.kgItem.findUnique({ where: { id }, select });
    return row?.reviewStatus ?? null;
  }

  /** Normalize (throwing on an empty result) and dedupe by `normalized`, first wins. */
  private dedupeAliases(aliases: readonly AliasInput[]): (AliasInput & { normalized: string })[] {
    const seen = new Set<string>();
    const out: (AliasInput & { normalized: string })[] = [];
    for (const a of aliases) {
      const alias = a.alias.trim();
      const normalized = normalizeAlias(alias);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push({ alias, source: a.source, normalized });
    }
    return out;
  }

  private evidenceRow(
    ownerId: string,
    subjectKind: EvidenceSubjectKind,
    subjectId: string,
    e: EvidenceInput,
  ): Prisma.KgEvidenceCreateManyInput {
    return {
      ownerId,
      subjectKind,
      subjectId,
      transcriptId: e.transcriptId,
      segmentId: e.segmentId,
      segmentRev: e.segmentRev,
      startMs: e.startMs,
      endMs: e.endMs,
      noteId: e.noteId,
      noteVersion: e.noteVersion,
      charStart: e.charStart,
      charEnd: e.charEnd,
      quote: e.quote,
      importObjectId: e.importObjectId,
      sourceIri: e.sourceIri,
    };
  }

  private async insertEvidence(
    tx: Tx,
    ownerId: string,
    subjectKind: EvidenceSubjectKind,
    subjectId: string,
    evidence: readonly EvidenceInput[],
  ): Promise<void> {
    await tx.kgEvidence.createMany({
      data: evidence.map((e) => this.evidenceRow(ownerId, subjectKind, subjectId, e)),
    });
  }
}
