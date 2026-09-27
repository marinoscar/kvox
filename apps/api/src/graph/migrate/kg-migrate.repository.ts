// =============================================================================
// `kg.migrate` — batched SQL (#384; docs/specs/ontology.md §11, §17.4)
// =============================================================================
//
// Every statement is owner-scoped (`owner_id = $owner`): one job reshapes one
// user's rows and nobody else's.
//
// ⚠ WHY THIS WRITES kg_* ROWS WITHOUT `GraphWriteService`. CLAUDE.md routes
// every graph write through it, and this is the deliberate exception the
// issue's contract names: a migration is a SYSTEM reshape of rows that already
// passed that service's checks, and it changes only `type`, `props`, `status`
// and `ontology_version` — never evidence, endpoints, temporal fields or
// `review_status`. The props that change are validated against the effective
// schema (all domains) by the handler before they reach here, and because
// `review_status` is untouched the deferred no-orphans trigger (#355) is not
// even consulted. Going through the service would mean one `create`-shaped
// write per row, where this is one `UPDATE … FROM (VALUES …)` per batch.
//
// OPTIMISTIC GUARD. Each row's UPDATE also matches the type/status, props and
// version the handler READ. A row somebody edited between the SELECT and the
// UPDATE simply does not match, is not written, and is picked up again by the
// next run — a concurrent manual edit is never overwritten by a stale reshape.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { UserAttributeDef } from '@app/shared/ontology';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { toUserAttributeDef } from '../ontology/graph-ontology.service';
import type { KgMigrateTable } from './kg-migrate.plan';

/** One row as the handler sees it. `type` is null for an item (its type comes from `kind`). */
export interface KgMigrateRow {
  id: string;
  type: string | null;
  kind: string | null;
  status: string | null;
  props: Record<string, unknown>;
  ontologyVersion: string;
}

/** One reshaped row: what was read, and what to write. */
export interface KgMigrateUpdate {
  id: string;
  before: { type: string | null; status: string | null; props: Record<string, unknown>; ontologyVersion: string };
  after: { type: string | null; status: string | null; props: Record<string, unknown>; ontologyVersion: string };
}

const TABLE_SQL: Record<KgMigrateTable, Prisma.Sql> = {
  entity: Prisma.raw('kg_entities'),
  relation: Prisma.raw('kg_relations'),
  item: Prisma.raw('kg_items'),
};

interface RawRow {
  id: string;
  type: string | null;
  kind: string | null;
  status: string | null;
  props: unknown;
  ontology_version: string;
}

function asProps(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

@Injectable()
export class KgMigrateRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The next keyset page of `table`'s candidate rows for one owner. Keyset on
   * `id` (never OFFSET) so rows left untouched — failed validation, or a step
   * that turned out to change nothing — are passed over, not re-read forever.
   */
  async selectBatch(
    table: KgMigrateTable,
    ownerId: string,
    targetVersion: string,
    predicate: Prisma.Sql,
    afterId: string | null,
    limit: number,
  ): Promise<KgMigrateRow[]> {
    const columns =
      table === 'item'
        ? Prisma.sql`id::text AS id, NULL::text AS type, kind::text AS kind, status, props, ontology_version`
        : Prisma.sql`id::text AS id, type, NULL::text AS kind, NULL::text AS status, props, ontology_version`;
    const after = afterId === null ? Prisma.empty : Prisma.sql`AND id > ${afterId}::uuid`;
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT ${columns}
        FROM ${TABLE_SQL[table]}
       WHERE owner_id = ${ownerId}::uuid
         AND ontology_version <> ${targetVersion}
         AND ${predicate}
         ${after}
       ORDER BY id
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      kind: r.kind,
      status: r.status,
      props: asProps(r.props),
      ontologyVersion: r.ontology_version,
    }));
  }

  /**
   * Writes one batch in ONE statement inside a transaction; returns the ids
   * actually written (a row the optimistic guard rejected is absent).
   */
  async writeBatch(table: KgMigrateTable, ownerId: string, updates: readonly KgMigrateUpdate[]): Promise<string[]> {
    if (updates.length === 0) return [];
    const json = (v: Record<string, unknown>) => JSON.stringify(v);

    if (table === 'item') {
      const values = Prisma.join(
        updates.map(
          (u) => Prisma.sql`(${u.id}::uuid, ${u.after.status}::text, ${json(u.after.props)}::jsonb, ${u.after.ontologyVersion}::text,
                             ${u.before.status}::text, ${json(u.before.props)}::jsonb, ${u.before.ontologyVersion}::text)`,
        ),
      );
      const rows = await this.prisma.$transaction((tx) => tx.$queryRaw<Array<{ id: string }>>`
        UPDATE kg_items AS t
           SET status = v.status, props = v.props, ontology_version = v.version, updated_at = now()
          FROM (VALUES ${values}) AS v(id, status, props, version, old_status, old_props, old_version)
         WHERE t.id = v.id
           AND t.owner_id = ${ownerId}::uuid
           AND t.status = v.old_status
           AND t.props = v.old_props
           AND t.ontology_version = v.old_version
        RETURNING t.id::text AS id
      `);
      return rows.map((r) => r.id);
    }

    const values = Prisma.join(
      updates.map(
        (u) => Prisma.sql`(${u.id}::uuid, ${u.after.type}::text, ${json(u.after.props)}::jsonb, ${u.after.ontologyVersion}::text,
                           ${u.before.type}::text, ${json(u.before.props)}::jsonb, ${u.before.ontologyVersion}::text)`,
      ),
    );
    const rows = await this.prisma.$transaction((tx) => tx.$queryRaw<Array<{ id: string }>>`
      UPDATE ${TABLE_SQL[table]} AS t
         SET type = v.type, props = v.props, ontology_version = v.version, updated_at = now()
        FROM (VALUES ${values}) AS v(id, type, props, version, old_type, old_props, old_version)
       WHERE t.id = v.id
         AND t.owner_id = ${ownerId}::uuid
         AND t.type = v.old_type
         AND t.props = v.old_props
         AND t.ontology_version = v.old_version
      RETURNING t.id::text AS id
    `);
    return rows.map((r) => r.id);
  }

  /** The owner's attribute defs — deprecated included, so stored `u_*` values still validate. */
  async attributeDefsFor(ownerId: string): Promise<UserAttributeDef[]> {
    const rows = await this.prisma.kgAttributeDef.findMany({ where: { ownerId } });
    return rows.map(toUserAttributeDef);
  }

  /**
   * Appends `stale_ontology` to every item of the owner's `draft` proposals
   * created before `before`. Idempotent: an item already carrying the flag is
   * not touched. Returns the number of items flagged now.
   */
  async flagStaleDrafts(ownerId: string, before: Date): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE kg_proposal_items AS i
         SET flags = array_append(i.flags, 'stale_ontology'), updated_at = now()
        FROM kg_proposals AS p
       WHERE i.proposal_id = p.id
         AND p.owner_id = ${ownerId}::uuid
         AND p.status = 'draft'
         AND p.created_at < ${before}
         AND NOT ('stale_ontology' = ANY(i.flags))
    `;
  }

  /**
   * Up to `limit` distinct owners with at least one candidate row in any of the
   * three tables. Read-only; the scheduler enqueues one job per owner.
   */
  async ownersNeedingMigration(
    predicates: Partial<Record<KgMigrateTable, Prisma.Sql>>,
    targetVersion: string,
    limit: number,
  ): Promise<string[]> {
    const selects = (Object.entries(predicates) as [KgMigrateTable, Prisma.Sql][]).map(
      ([table, predicate]) => Prisma.sql`
        SELECT DISTINCT owner_id FROM ${TABLE_SQL[table]}
         WHERE ontology_version <> ${targetVersion} AND ${predicate}`,
    );
    if (selects.length === 0) return [];
    const rows = await this.prisma.$queryRaw<Array<{ owner_id: string }>>`
      SELECT owner_id::text AS owner_id
        FROM (${Prisma.join(selects, ' UNION ')}) AS owners
       ORDER BY owner_id
       LIMIT ${limit}
    `;
    return rows.map((r) => r.owner_id);
  }
}
