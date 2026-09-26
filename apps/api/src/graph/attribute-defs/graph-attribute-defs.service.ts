// =============================================================================
// GraphAttributeDefsService (#355, epic #344; docs/specs/ontology.md §17.3)
// =============================================================================
//
// A user's own attribute definitions — "Nickname" on Person, "Tier" on
// Organization. Three rules §17.3 makes binding:
//
//   1. THE KEY IS THE SERVER'S. `u_` + ten `[a-z0-9]`, generated here, never
//      chosen by the client and never changed: `props` store values under it,
//      so the label can be renamed freely without touching a single row.
//      `kind`, `entityType` and `key` are immutable (the DTO refuses them).
//   2. DEPRECATE, NEVER DELETE. `DELETE` sets `deprecated_at`; a hard delete
//      would strand every stored value with nothing to render it. For the same
//      reason a `select` choice may be added or relabelled but NEVER REMOVED.
//   3. THE DEFINITION MUST STAY COMPUTABLE. Every rule `computeEffectiveSchema`
//      enforces on a user attribute (choices for selects, target types only for
//      `entity_ref`, …) is checked here first, so a saved definition can never
//      make `GET /api/graph/ontology` throw.
//
// Owner-only, through `GraphAccessService` (404 for another user's row).
// Audit meta is `{ entityType, key, kind }` — never a label or a choice.
// =============================================================================

import { randomInt } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';
import { USER_ATTRIBUTE_KEY_PREFIX, type AttributeOptions, type EffectiveSchema } from '@app/shared/ontology';
import { Prisma, type KgAttributeDef } from '@prisma/client';

import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphAccessService } from '../access/graph-access.service';
import type {
  AttributeDefListQuery,
  CreateAttributeDefDto,
  GraphAttributeDefResponse,
  PatchAttributeDefDto,
} from '../dto/graph-attribute-def.dto';
import { GraphOntologyService } from '../ontology/graph-ontology.service';

/** At most this many LIVE definitions per (owner, entity type). */
export const MAX_LIVE_ATTRIBUTE_DEFS_PER_TYPE = 50;

export const ATTRIBUTE_DEF_AUDIT_ACTIONS = {
  created: 'graph.attribute_def_created',
  updated: 'graph.attribute_def_updated',
  deprecated: 'graph.attribute_def_deprecated',
} as const;

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEY_ATTEMPTS = 3;

/** `u_` + ten random `[a-z0-9]`. */
export function generateAttributeKey(): string {
  let suffix = '';
  for (let i = 0; i < 10; i++) suffix += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  return `${USER_ATTRIBUTE_KEY_PREFIX}${suffix}`;
}

export function toGraphAttributeDefResponse(row: KgAttributeDef): GraphAttributeDefResponse {
  return {
    id: row.id,
    entityType: row.entityType,
    key: row.key,
    label: row.label,
    kind: row.kind,
    options: (row.options ?? null) as GraphAttributeDefResponse['options'],
    extractable: row.extractable,
    extractionHint: row.extractionHint,
    sensitivity: row.sensitivity,
    sortOrder: row.sortOrder,
    deprecatedAt: row.deprecatedAt ? row.deprecatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function badRequest(message: string, details?: Record<string, unknown>): BadRequestException {
  return new BadRequestException(details ? { message, details } : { message });
}

@Injectable()
export class GraphAttributeDefsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GraphAccessService,
    private readonly ontology: GraphOntologyService,
  ) {}

  async list(userId: string, query: AttributeDefListQuery): Promise<{ items: GraphAttributeDefResponse[] }> {
    const rows = await this.prisma.kgAttributeDef.findMany({
      where: {
        ownerId: userId,
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.includeDeprecated ? {} : { deprecatedAt: null }),
      },
      orderBy: [{ entityType: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { items: rows.map(toGraphAttributeDefResponse) };
  }

  async create(dto: CreateAttributeDefDto, user: RequestUser): Promise<GraphAttributeDefResponse> {
    const schema = await this.ontology.effectiveSchemaFor(user.id);
    const type = schema.entityType(dto.entityType);
    if (!type || type.deprecated) {
      throw badRequest(`'${dto.entityType}' is not an entity type in your graph.`);
    }

    const options = this.checkOptions(dto.kind, dto.options, schema);
    const extractionHint = dto.extractionHint ?? null;
    if (dto.extractable && !extractionHint) {
      throw badRequest('An extractable attribute needs an extractionHint.');
    }

    const live = await this.prisma.kgAttributeDef.count({
      where: { ownerId: user.id, entityType: dto.entityType, deprecatedAt: null },
    });
    if (live >= MAX_LIVE_ATTRIBUTE_DEFS_PER_TYPE) {
      throw badRequest(
        `You already have ${MAX_LIVE_ATTRIBUTE_DEFS_PER_TYPE} attributes on ${dto.entityType}. Deprecate one first.`,
      );
    }

    let row: KgAttributeDef | null = null;
    for (let attempt = 0; attempt < KEY_ATTEMPTS && !row; attempt++) {
      try {
        row = await this.prisma.kgAttributeDef.create({
          data: {
            ownerId: user.id,
            entityType: dto.entityType,
            key: generateAttributeKey(),
            label: dto.label,
            kind: dto.kind,
            options: options === null ? Prisma.DbNull : (options as Prisma.InputJsonObject),
            extractable: dto.extractable ?? false,
            extractionHint,
            sensitivity: dto.sensitivity ?? null,
            sortOrder: dto.sortOrder ?? 0,
          },
        });
      } catch (err) {
        // A key collision (36^10 space, so a retry is astronomically rare).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    if (!row) throw new Error('Could not generate a unique attribute key');

    await this.audit(user.id, ATTRIBUTE_DEF_AUDIT_ACTIONS.created, row);
    return toGraphAttributeDefResponse(row);
  }

  async update(id: string, dto: PatchAttributeDefDto, user: RequestUser): Promise<GraphAttributeDefResponse> {
    const current = await this.access.require(user.id, 'attribute_def', id, 'edit', user.permissions);

    const data: Prisma.KgAttributeDefUpdateInput = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.sensitivity !== undefined) data.sensitivity = dto.sensitivity;
    if (dto.extractable !== undefined) data.extractable = dto.extractable;
    if (dto.extractionHint !== undefined) data.extractionHint = dto.extractionHint;

    if (dto.options !== undefined) {
      const schema = await this.ontology.effectiveSchemaFor(user.id);
      const next = this.checkOptions(current.kind, dto.options, schema);
      const before = ((current.options ?? null) as AttributeOptions | null)?.choices ?? [];
      const kept = new Set((next?.choices ?? []).map((c) => c.value));
      const removed = before.map((c) => c.value).filter((v) => !kept.has(v));
      if (removed.length > 0) {
        throw badRequest(
          'Choices can be added or relabelled, but not removed: stored values would lose their label.',
          { removedChoices: removed },
        );
      }
      data.options = next === null ? Prisma.DbNull : (next as Prisma.InputJsonObject);
    }

    const extractable = dto.extractable ?? current.extractable;
    const hint = dto.extractionHint !== undefined ? dto.extractionHint : current.extractionHint;
    if (extractable && !hint) throw badRequest('An extractable attribute needs an extractionHint.');

    let deprecating = false;
    if (dto.deprecated === true && current.deprecatedAt === null) {
      data.deprecatedAt = new Date();
      deprecating = true;
    } else if (dto.deprecated === false && current.deprecatedAt !== null) {
      await this.assertBelowLimit(user.id, current.entityType);
      data.deprecatedAt = null;
    }

    const row = await this.prisma.kgAttributeDef.update({ where: { id: current.id }, data });
    await this.audit(
      user.id,
      deprecating ? ATTRIBUTE_DEF_AUDIT_ACTIONS.deprecated : ATTRIBUTE_DEF_AUDIT_ACTIONS.updated,
      row,
    );
    return toGraphAttributeDefResponse(row);
  }

  /** Deprecate. Idempotent: an already-deprecated definition is returned unchanged. */
  async deprecate(id: string, user: RequestUser): Promise<GraphAttributeDefResponse> {
    const current = await this.access.require(user.id, 'attribute_def', id, 'edit', user.permissions);
    if (current.deprecatedAt !== null) return toGraphAttributeDefResponse(current);

    const row = await this.prisma.kgAttributeDef.update({
      where: { id: current.id },
      data: { deprecatedAt: new Date() },
    });
    await this.audit(user.id, ATTRIBUTE_DEF_AUDIT_ACTIONS.deprecated, row);
    return toGraphAttributeDefResponse(row);
  }

  /**
   * The per-kind option rules, against the caller's effective schema. Returns
   * the options to store (`null` for a kind that takes none).
   */
  private checkOptions(
    kind: KgAttributeDef['kind'],
    options: AttributeOptions | undefined,
    schema: EffectiveSchema,
  ): AttributeOptions | null {
    const isSelect = kind === 'select' || kind === 'multi_select';
    const isRef = kind === 'entity_ref';

    if (!isSelect && !isRef) {
      if (options !== undefined) throw badRequest(`A ${kind} attribute takes no options.`);
      return null;
    }
    if (isSelect) {
      if (!options?.choices || options.choices.length === 0) {
        throw badRequest(`A ${kind} attribute needs at least one choice.`);
      }
      if (options.targetTypes !== undefined) throw badRequest('targetTypes are only valid on entity_ref.');
      return { choices: options.choices.map((c) => ({ value: c.value, label: c.label })) };
    }
    // entity_ref
    if (options?.choices !== undefined) throw badRequest('choices are only valid on select and multi_select.');
    const targets = options?.targetTypes ?? [];
    const invalid = targets.filter((t) => schema.entityType(t)?.storage !== 'entity');
    if (targets.length === 0 || invalid.length > 0) {
      throw badRequest('An entity_ref attribute needs targetTypes that are entity types in your graph.', {
        invalidTargetTypes: invalid,
      });
    }
    return { targetTypes: [...new Set(targets)] };
  }

  private async assertBelowLimit(ownerId: string, entityType: string): Promise<void> {
    const live = await this.prisma.kgAttributeDef.count({ where: { ownerId, entityType, deprecatedAt: null } });
    if (live >= MAX_LIVE_ATTRIBUTE_DEFS_PER_TYPE) {
      throw badRequest(
        `You already have ${MAX_LIVE_ATTRIBUTE_DEFS_PER_TYPE} attributes on ${entityType}. Deprecate one first.`,
      );
    }
  }

  private async audit(userId: string, action: string, row: KgAttributeDef): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'kg_attribute_def',
        targetId: row.id,
        meta: { entityType: row.entityType, key: row.key, kind: row.kind },
      },
    });
  }
}
