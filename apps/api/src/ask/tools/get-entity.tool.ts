// =============================================================================
// `get_entity` (#377; docs/specs/ontology.md §5.6, §9.1, §21)
// =============================================================================
//
// `GraphReadService.getEntity` — the entity page's own read — reshaped for the
// model: attributes by their LABEL, filtered by the attribute definition's
// sensitivity (`sensitive` never, `personal` only with the opt-in), with every
// id-valued attribute either turned into a handle (`entity_ref`) or dropped (a
// system-set id such as a Meeting's `transcriptId`). No uuid leaves this tool.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GraphOntologyService } from '../../graph/ontology/graph-ontology.service';
import { GraphReadService } from '../../graph/read/graph-read.service';
import { READABLE_ENTITY_STATUSES } from '../../graph/read/readable';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isoDate,
  jsonString,
  objectParameters,
  resolveHandleOrThrow,
  zHandle,
  type AskTool,
  type AskToolContext,
  type AskToolResult,
} from './ask-tool';
import { sensitivityVisible } from './sensitivity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const input = z.object({ entity: zHandle });
export type GetEntityToolInput = z.output<typeof input>;

@Injectable()
export class GetEntityTool implements AskTool<GetEntityToolInput> {
  readonly name = 'get_entity';
  readonly description = "Get one entity's type, name, aliases, attributes and counts.";
  readonly parameters = objectParameters({
    entity: jsonString('An entity reference (entN) from an earlier tool result.'),
  });
  readonly input = input;

  constructor(
    private readonly graphRead: GraphReadService,
    private readonly ontology: GraphOntologyService,
    private readonly prisma: PrismaService,
  ) {}

  async run(ctx: AskToolContext, args: GetEntityToolInput): Promise<AskToolResult> {
    const target = resolveHandleOrThrow(ctx, args.entity, ['ent']);
    const [detail, schema] = await Promise.all([
      this.graphRead.getEntity(ctx.user, target.id),
      this.ontology.effectiveSchemaFor(ctx.user.id),
    ]);
    const ref = ctx.handles.register({ kind: 'ent', id: detail.id, label: detail.label });

    const definitions = schema.entityType(detail.type)?.attributes ?? [];
    const visible = definitions.filter(
      (a) => sensitivityVisible(a.sensitivity, ctx.personalFactsAllowed) && hasValue(detail.props[a.key]),
    );

    // entity_ref values → handles, for the caller's own readable entities only.
    const refIds = visible
      .filter((a) => a.kind === 'entity_ref')
      .flatMap((a) => toArray(detail.props[a.key]))
      .filter((v): v is string => typeof v === 'string' && UUID.test(v));
    const refEntities = refIds.length
      ? await this.prisma.kgEntity.findMany({
          where: {
            ownerId: ctx.user.id,
            id: { in: [...new Set(refIds)] },
            reviewStatus: { in: [...READABLE_ENTITY_STATUSES] },
            mergedIntoId: null,
          },
          select: { id: true, label: true, type: true },
        })
      : [];
    const refById = new Map(refEntities.map((e) => [e.id, e]));

    const attributes: Record<string, unknown> = {};
    for (const a of visible) {
      const raw = detail.props[a.key];
      let value: unknown;
      if (a.kind === 'entity_ref') {
        const refs = toArray(raw).flatMap((v) => {
          const e = typeof v === 'string' ? refById.get(v) : undefined;
          return e ? [{ ref: ctx.handles.register({ kind: 'ent', id: e.id, label: e.label }), label: e.label, type: e.type }] : [];
        });
        value = a.list ? refs : refs[0];
      } else if (a.kind === 'select' || a.kind === 'multi_select') {
        const labels = toArray(raw).map((v) => a.options?.choices?.find((c) => c.value === v)?.label ?? v);
        value = a.kind === 'multi_select' || a.list ? labels : labels[0];
      } else {
        const values = toArray(raw).filter((v) => !(typeof v === 'string' && UUID.test(v)));
        value = a.list ? values : values[0];
      }
      if (hasValue(value)) attributes[a.label] = value;
    }

    const counts = {
      relations: detail.counts.relations,
      commitments: detail.counts.items.commitment,
      decisions: detail.counts.items.decision,
      claims: detail.counts.items.claim,
      openCommitments: detail.counts.openCommitments,
    };

    const data: Record<string, unknown> = {
      ref,
      type: detail.type,
      label: detail.label,
      aliases: [...new Set(detail.aliases.map((a) => a.alias).filter((a) => a !== detail.label))],
      attributes,
      counts,
      firstSeen: isoDate(detail.firstSeenAt),
      lastSeen: isoDate(detail.lastSeenAt),
    };
    if (detail.occurredAt) data.occurredOn = isoDate(detail.occurredAt);

    return {
      data,
      resultCount: 1,
      summary: `Looked up ${detail.label} (${detail.type})`,
      truncated: false,
    };
  }
}

function toArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}
