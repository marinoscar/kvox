// =============================================================================
// `evidence` (#377; docs/specs/ontology.md §5.3, §21)
// =============================================================================
//
// The source quotes behind one entity, item or relation — what the model
// cites with `[^evN]`. The subject is re-checked before anything is read:
// it must still be the caller's, still readable (a superseded item or
// relation is readable here, because `timeline` shows it), and — for a
// PersonFact — pass the sensitivity rule. Then `GraphEvidenceService
// .listForSubject` (owner-scoped, newest source first) and its link mapper
// decide what is still openable: `available: false` keeps the quote but drops
// the title and date of a source the caller can no longer see.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GraphEvidenceService } from '../../graph/read/graph-evidence.service';
import {
  AS_OF_RELATION_STATUSES,
  READABLE_ENTITY_STATUSES,
  TIMELINE_ITEM_STATUSES,
} from '../../graph/read/readable';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AskToolError,
  clip,
  isoDate,
  jsonNullableInteger,
  jsonString,
  objectParameters,
  optionalOf,
  plural,
  QUOTE_MAX_CHARS,
  resolveHandleOrThrow,
  zHandle,
  type AskTool,
  type AskToolContext,
  type AskToolResult,
} from './ask-tool';
import type { HandleTarget } from './handle-registry';
import { itemVisible } from './sensitivity';

export const EVIDENCE_DEFAULT_LIMIT = 5;
export const EVIDENCE_MAX_LIMIT = 10;

const input = z.object({
  subject: zHandle,
  limit: optionalOf(z.number().int().min(1).max(EVIDENCE_MAX_LIMIT)),
});
export type EvidenceToolInput = z.output<typeof input>;

const SUBJECT_KIND = { ent: 'entity', itm: 'item', rel: 'relation' } as const;

@Injectable()
export class EvidenceTool implements AskTool<EvidenceToolInput> {
  readonly name = 'evidence';
  readonly description = 'Get the source quotes that support an entity, item or relation. Cite these with [^evN].';
  readonly parameters = objectParameters({
    subject: jsonString('An entity (entN), item (itmN) or relation (relN) reference.'),
    limit: jsonNullableInteger(`Most quotes to return, 1–${EVIDENCE_MAX_LIMIT}. Default ${EVIDENCE_DEFAULT_LIMIT}.`),
  });
  readonly input = input;

  constructor(
    private readonly evidence: GraphEvidenceService,
    private readonly prisma: PrismaService,
  ) {}

  async run(ctx: AskToolContext, args: EvidenceToolInput): Promise<AskToolResult> {
    const target = resolveHandleOrThrow(ctx, args.subject, ['ent', 'itm', 'rel']);
    await this.assertSubjectVisible(ctx, target, args.subject.trim());

    const subjectKind = SUBJECT_KIND[target.kind as keyof typeof SUBJECT_KIND];
    const limit = args.limit ?? EVIDENCE_DEFAULT_LIMIT;
    // One extra row tells us whether more exist.
    const rows = await this.evidence.listForSubject(ctx.user.id, subjectKind, target.id, limit + 1);
    const page = rows.slice(0, limit);

    const out = page.map(({ link, occurredAt }) => {
      const src = link.source;
      const kind = src.kind === 'segment' ? 'transcript' : src.kind;
      const title = src.kind === 'segment' ? src.transcriptTitle : src.kind === 'note' ? src.noteTitle : null;
      const startMs = src.kind === 'segment' && src.available ? src.startMs : null;
      return {
        ref: ctx.handles.register({ kind: 'ev', id: link.id, ...(title ? { label: title } : {}) }),
        quote: clip(link.quote, QUOTE_MAX_CHARS),
        source: { kind, title, at: isoDate(occurredAt), startMs },
        available: src.available,
      };
    });

    const label = target.label ?? 'this subject';
    return {
      data: out,
      resultCount: out.length,
      summary: `Found ${plural(out.length, 'quote', 'quotes')} for ${label}`,
      truncated: rows.length > limit,
    };
  }

  /** Owner-scoped re-check of the subject a handle names. */
  private async assertSubjectVisible(ctx: AskToolContext, target: HandleTarget, handle: string): Promise<void> {
    const ownerId = ctx.user.id;
    let visible = false;
    if (target.kind === 'ent') {
      visible =
        (await this.prisma.kgEntity.count({
          where: { id: target.id, ownerId, reviewStatus: { in: [...READABLE_ENTITY_STATUSES] }, mergedIntoId: null },
        })) > 0;
    } else if (target.kind === 'itm') {
      const item = await this.prisma.kgItem.findFirst({
        where: { id: target.id, ownerId, reviewStatus: { in: [...TIMELINE_ITEM_STATUSES] } },
        select: { kind: true, sensitivity: true },
      });
      visible = item !== null && itemVisible(item, ctx.personalFactsAllowed);
    } else {
      visible =
        (await this.prisma.kgRelation.count({
          where: { id: target.id, ownerId, reviewStatus: { in: [...AS_OF_RELATION_STATUSES] } },
        })) > 0;
    }
    if (!visible) {
      throw new AskToolError(`${handle} is no longer available (it may have been merged or removed).`);
    }
  }
}
