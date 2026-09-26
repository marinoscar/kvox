// =============================================================================
// GraphOntologyService (#354, epic #344, docs/specs/ontology.md §17.2–§17.4)
// =============================================================================
//
// One user's EFFECTIVE SCHEMA: `core` ∪ their enabled domains, the mixins those
// domains add, and their own `kg_attribute_defs` rows. It is computed by
// `@app/shared/ontology`'s `computeEffectiveSchema` — never hand-assembled
// here — so the web forms, the props validators and the extraction prompts can
// never disagree about what a user's graph consists of.
//
// ONE QUERY. The only database read is the caller's attribute definitions,
// ALL of them including deprecated ones: a deprecated attribute is still
// readable on existing rows, and the payload flags it rather than hiding it.
//
// THE `enabledDomains` SEAM. Which domains a user has switched on is not
// persisted yet; until #369 adds the user-settings storage, everybody gets
// `DEFAULT_ENABLED_DOMAINS` (`core`, `work`). #369 replaces ONLY the protected
// `enabledDomains()` method — nothing else in this file needs to change.
//
// NOT GATED ON `ai.graphEnabled`: reading one's own schema is not an AI call.
// That flag gates AI-spending actions (#360), and turning AI off must never
// make an already-curated graph unreadable.
//
// ⚠ Never log the effective schema: it includes the user's own attribute
// labels, which are their words about their own contacts.
// =============================================================================

import { Injectable } from '@nestjs/common';
import {
  computeEffectiveSchema,
  DEFAULT_ENABLED_DOMAINS,
  toEffectiveSchemaPayload,
  type AttributeOptions,
  type DomainKey,
  type EffectiveSchema,
  type EffectiveSchemaPayload,
  type UserAttributeDef,
} from '@app/shared/ontology';
import type { KgAttributeDef } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** Maps one `kg_attribute_defs` row to the shared package's plain-data shape. */
export function toUserAttributeDef(row: KgAttributeDef): UserAttributeDef {
  return {
    id: row.id,
    entityType: row.entityType,
    key: row.key,
    label: row.label,
    kind: row.kind,
    options: (row.options ?? null) as AttributeOptions | null,
    extractable: row.extractable,
    extractionHint: row.extractionHint,
    sensitivity: row.sensitivity,
    sortOrder: row.sortOrder,
    deprecatedAt: row.deprecatedAt ? row.deprecatedAt.toISOString() : null,
  };
}

@Injectable()
export class GraphOntologyService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's resolved, frozen effective schema. */
  async effectiveSchemaFor(userId: string): Promise<EffectiveSchema> {
    const [enabledDomains, rows] = await Promise.all([
      this.enabledDomains(userId),
      this.prisma.kgAttributeDef.findMany({
        where: { ownerId: userId },
        orderBy: [{ entityType: 'asc' }, { sortOrder: 'asc' }, { key: 'asc' }],
      }),
    ]);

    return computeEffectiveSchema({
      enabledDomains,
      userAttributes: rows.map(toUserAttributeDef),
    });
  }

  /** Exactly what `GET /api/graph/ontology` returns. */
  async payloadFor(userId: string): Promise<EffectiveSchemaPayload> {
    return toEffectiveSchemaPayload(await this.effectiveSchemaFor(userId));
  }

  /**
   * The domains this user has switched on. `core` is forced in by
   * `computeEffectiveSchema` regardless.
   *
   * ⚠ THE SEAM #369 REPLACES with the persisted `graph.domains` preference.
   * Until then: the defaults, for everybody.
   */
  protected async enabledDomains(_userId: string): Promise<DomainKey[]> {
    return [...DEFAULT_ENABLED_DOMAINS];
  }
}
