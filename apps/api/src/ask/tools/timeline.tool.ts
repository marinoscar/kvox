// =============================================================================
// `timeline` (#377; docs/specs/ontology.md §9.1, §21)
// =============================================================================
//
// `GraphReadService.timeline` — the entity page's own union of dated items,
// relation starts/ends and meetings — NEVER with `includeSensitive`. A
// superseded item stays in, flagged: "what did we used to think" is exactly
// what a timeline answers. `personal` PersonFacts are dropped unless the §14
// opt-in is on.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TIMELINE_KINDS, type TimelineEvent } from '../../graph/read/dto/graph-read.dto';
import { GraphReadService } from '../../graph/read/graph-read.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  clip,
  isoDate,
  jsonNullableInteger,
  jsonNullableString,
  jsonNullableStringArray,
  jsonString,
  objectParameters,
  optionalOf,
  plural,
  precisionField,
  resolveHandleOrThrow,
  STATEMENT_MAX_CHARS,
  zDate,
  zHandle,
  zKeyList,
  type AskTool,
  type AskToolContext,
  type AskToolResult,
} from './ask-tool';
import { itemVisible } from './sensitivity';
import { evidenceRefsWithQuotes, INLINE_EVIDENCE_PER_ENTRY } from './tool-queries';

export const TIMELINE_DEFAULT_LIMIT = 15;
export const TIMELINE_MAX_LIMIT = 25;

const input = z.object({
  entity: zHandle,
  asOf: optionalOf(zDate),
  kinds: optionalOf(zKeyList),
  limit: optionalOf(z.number().int().min(1).max(TIMELINE_MAX_LIMIT)),
});
export type TimelineToolInput = z.output<typeof input>;

@Injectable()
export class TimelineTool implements AskTool<TimelineToolInput> {
  readonly name = 'timeline';
  readonly description =
    'List dated events about an entity (decisions, commitments, claims, role and employer changes, meetings), newest first.';
  readonly parameters = objectParameters({
    entity: jsonString('An entity reference (entN).'),
    asOf: jsonNullableString('Only events up to this date (YYYY-MM-DD). Default: today.'),
    kinds: jsonNullableStringArray(`Keep only these event kinds: ${TIMELINE_KINDS.join(', ')}. Default: all.`),
    limit: jsonNullableInteger(`Most events to return, 1–${TIMELINE_MAX_LIMIT}. Default ${TIMELINE_DEFAULT_LIMIT}.`),
  });
  readonly input = input;

  constructor(
    private readonly graphRead: GraphReadService,
    private readonly prisma: PrismaService,
  ) {}

  async run(ctx: AskToolContext, args: TimelineToolInput): Promise<AskToolResult> {
    const target = resolveHandleOrThrow(ctx, args.entity, ['ent']);
    const page = await this.graphRead.timeline(ctx.user, target.id, {
      as_of: args.asOf,
      kinds: args.kinds?.join(','),
      includeSensitive: false,
      limit: args.limit ?? TIMELINE_DEFAULT_LIMIT,
    });

    const events = page.items.filter(
      (e) => !e.item || itemVisible({ kind: e.item.kind, sensitivity: e.item.sensitivity }, ctx.personalFactsAllowed),
    );
    const quotes = await evidenceRefsWithQuotes(
      this.prisma,
      ctx,
      events.flatMap((e) => e.evidenceIds.slice(0, INLINE_EVIDENCE_PER_ENTRY)),
    );

    const out = events.map((e) => ({
      ...this.describe(ctx, e),
      at: isoDate(e.at),
      ...precisionField(e.precision),
      evidence: e.evidenceIds.slice(0, INLINE_EVIDENCE_PER_ENTRY).flatMap((id) => {
        const q = quotes.get(id);
        return q ? [q] : [];
      }),
    }));

    const label = target.label ?? 'entity';
    return {
      data: out,
      resultCount: out.length,
      summary: `Timeline of ${label} · ${plural(out.length, 'event', 'events')}`,
      truncated: page.nextCursor !== null,
    };
  }

  private describe(ctx: AskToolContext, e: TimelineEvent) {
    if (e.item) {
      const i = e.item;
      const label = i.title ?? clip(i.statement, 80);
      return {
        ref: ctx.handles.register({ kind: 'itm', id: i.id, label }),
        event: i.kind,
        text: clip(i.title ? `${i.title}: ${i.statement}` : i.statement, STATEMENT_MAX_CHARS),
        status: i.status,
        superseded: i.superseded,
        ...(i.dueAt ? { due: isoDate(i.dueAt) } : {}),
      };
    }
    if (e.relation) {
      const r = e.relation;
      const other = { ref: ctx.handles.register({ kind: 'ent', id: r.other.id, label: r.other.label }), label: r.other.label };
      const arrow = r.direction === 'out' ? '→' : '←';
      return {
        ref: ctx.handles.register({ kind: 'rel', id: r.id, label: r.type }),
        event: e.eventKind,
        text: `${r.type} ${arrow} ${r.other.label} (${r.other.type}) ${e.eventKind === 'relation_started' ? 'started' : 'ended'}`,
        other,
        status: null,
        superseded: false,
      };
    }
    const m = e.meeting!;
    return {
      ref: ctx.handles.register({ kind: 'ent', id: m.id, label: m.label }),
      event: 'meeting',
      text: m.label,
      status: null,
      superseded: false,
    };
  }
}
