// =============================================================================
// `neighbors` (#377; docs/specs/ontology.md §9.1, §21, §22)
// =============================================================================
//
// `GraphNeighborhoodService.neighborhood` — the entity page's bounded 1–2-hop
// walk, with its own access check, as-of predicate and 3 s statement timeout —
// capped at 50 nodes for the model. The walk already drops `sensitive`
// PersonFacts; `personal` ones are dropped here unless the opt-in is on, with
// every edge that touched them.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GraphNeighborhoodService } from '../../graph/read/graph-neighborhood.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isoDate,
  jsonNullableEnum,
  jsonNullableInteger,
  jsonNullableString,
  jsonNullableStringArray,
  jsonString,
  objectParameters,
  optionalOf,
  plural,
  precisionField,
  resolveHandleOrThrow,
  zDate,
  zHandle,
  zKeyList,
  type AskTool,
  type AskToolContext,
  type AskToolResult,
} from './ask-tool';
import { visiblePersonFactIds } from './sensitivity';

export const NEIGHBORS_DEFAULT_LIMIT = 25;
export const NEIGHBORS_MAX_LIMIT = 50;

const input = z.object({
  entity: zHandle,
  hops: optionalOf(z.union([z.literal(1), z.literal(2)])),
  types: optionalOf(zKeyList),
  relationTypes: optionalOf(zKeyList),
  asOf: optionalOf(zDate),
  limit: optionalOf(z.number().int().min(1).max(NEIGHBORS_MAX_LIMIT)),
});
export type NeighborsToolInput = z.output<typeof input>;

@Injectable()
export class NeighborsTool implements AskTool<NeighborsToolInput> {
  readonly name = 'neighbors';
  readonly description = 'List what an entity is connected to, optionally as of a past date.';
  readonly parameters = objectParameters({
    entity: jsonString('An entity reference (entN).'),
    hops: jsonNullableEnum([1, 2], 'How far to walk: 1 (direct connections, default) or 2.'),
    types: jsonNullableStringArray(
      'Keep only these node types, e.g. ["Person", "Organization"] or item kinds ["commitment", "decision"]. Default: all.',
    ),
    relationTypes: jsonNullableStringArray('Walk only these relation types, e.g. ["WORKS_AT", "REPORTS_TO"]. Default: all.'),
    asOf: jsonNullableString('Evaluate the graph as of this date (YYYY-MM-DD). Default: today.'),
    limit: jsonNullableInteger(`Most nodes to return, 1–${NEIGHBORS_MAX_LIMIT}. Default ${NEIGHBORS_DEFAULT_LIMIT}.`),
  });
  readonly input = input;

  constructor(
    private readonly neighborhood: GraphNeighborhoodService,
    private readonly prisma: PrismaService,
  ) {}

  async run(ctx: AskToolContext, args: NeighborsToolInput): Promise<AskToolResult> {
    const target = resolveHandleOrThrow(ctx, args.entity, ['ent']);
    const slice = await this.neighborhood.neighborhood(ctx.user, target.id, {
      hops: args.hops ?? 1,
      types: args.types?.join(','),
      relationTypes: args.relationTypes?.join(','),
      as_of: args.asOf,
      limit: args.limit ?? NEIGHBORS_DEFAULT_LIMIT,
    });

    const factIds = slice.nodes.filter((n) => n.nodeKind === 'item' && n.type === 'person_fact').map((n) => n.id);
    const visibleFacts = await visiblePersonFactIds(this.prisma, ctx.user.id, factIds, ctx.personalFactsAllowed);
    const nodes = slice.nodes.filter((n) => !(n.nodeKind === 'item' && n.type === 'person_fact') || visibleFacts.has(n.id));

    const refById = new Map<string, string>();
    const outNodes = nodes.map((n) => {
      const ref = ctx.handles.register({ kind: n.nodeKind === 'entity' ? 'ent' : 'itm', id: n.id, label: n.label });
      refById.set(n.id, ref);
      return { ref, kind: n.nodeKind, type: n.type, label: n.label, depth: n.depth };
    });

    const edges = slice.edges.flatMap((e) => {
      const from = refById.get(e.source);
      const to = refById.get(e.target);
      if (!from || !to) return [];
      return [
        {
          // A stored relation is citable (and has evidence); a derived item-column edge is not.
          ref: e.virtual ? null : ctx.handles.register({ kind: 'rel', id: e.id, label: e.type }),
          type: e.type,
          from,
          to,
          validFrom: isoDate(e.valid?.from),
          validTo: isoDate(e.valid?.to),
          ...(e.valid ? precisionField(e.valid.precision) : {}),
        },
      ];
    });

    const seedLabel = nodes.find((n) => n.id === target.id)?.label ?? target.label ?? 'entity';
    return {
      data: { asOf: isoDate(slice.asOf), nodes: outNodes, edges, truncated: slice.truncated },
      resultCount: outNodes.length,
      summary: `Connections of ${seedLabel} · ${plural(Math.max(0, outNodes.length - 1), 'node', 'nodes')}, ${plural(edges.length, 'edge', 'edges')}`,
      truncated: slice.truncated,
    };
  }
}
