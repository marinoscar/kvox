// =============================================================================
// `list_commitments` (#377; docs/specs/ontology.md §5.1, §9.1, §21)
// =============================================================================
//
// One owner-scoped `kg_items` read: `kind = 'commitment'`, readable review
// statuses only (`readable.ts`), optionally narrowed to one person or
// organization by `direction` (`owned_by` → `owner_person_id`, `owed_to` →
// `counterparty_id`, `any` → either), by commitment `status` (default `open`)
// and by `due_at <= dueBefore`. Ordered by what is due soonest, then by what
// was promised most recently: `due_at ASC NULLS LAST, occurred_at DESC`.
// Every filter is a bound Prisma parameter.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { parseAsOf } from '../../graph/read/as-of';
import { READABLE_ENTITY_STATUSES, READABLE_ITEM_STATUSES } from '../../graph/read/readable';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AskToolError,
  clip,
  isoDate,
  jsonNullableEnum,
  jsonNullableInteger,
  jsonNullableString,
  objectParameters,
  optionalOf,
  plural,
  resolveHandleOrThrow,
  STATEMENT_MAX_CHARS,
  zDate,
  zHandle,
  type AskTool,
  type AskToolContext,
  type AskToolResult,
} from './ask-tool';
import { firstEvidenceIds, INLINE_EVIDENCE_PER_ENTRY } from './tool-queries';

export const COMMITMENT_DIRECTIONS = ['owned_by', 'owed_to', 'any'] as const;
export const COMMITMENT_STATUSES = ['open', 'done', 'dropped', 'superseded', 'any'] as const;
export const COMMITMENTS_DEFAULT_LIMIT = 15;
export const COMMITMENTS_MAX_LIMIT = 25;

const input = z.object({
  entity: optionalOf(zHandle),
  direction: optionalOf(z.enum(COMMITMENT_DIRECTIONS)),
  status: optionalOf(z.enum(COMMITMENT_STATUSES)),
  dueBefore: optionalOf(zDate),
  limit: optionalOf(z.number().int().min(1).max(COMMITMENTS_MAX_LIMIT)),
});
export type ListCommitmentsToolInput = z.output<typeof input>;

const PARTY_SELECT = { id: true, label: true, reviewStatus: true, mergedIntoId: true } as const;

@Injectable()
export class ListCommitmentsTool implements AskTool<ListCommitmentsToolInput> {
  readonly name = 'list_commitments';
  readonly description = 'List commitments, optionally for one person or organization, by status and due date.';
  readonly parameters = objectParameters({
    entity: jsonNullableString('A person or organization reference (entN). Default: every commitment.'),
    direction: jsonNullableEnum(
      COMMITMENT_DIRECTIONS,
      'With entity: "owned_by" (they promised it), "owed_to" (it was promised to them) or "any" (default).',
    ),
    status: jsonNullableEnum(COMMITMENT_STATUSES, 'Commitment status to keep. Default "open"; "any" keeps all.'),
    dueBefore: jsonNullableString('Only commitments due on or before this date (YYYY-MM-DD).'),
    limit: jsonNullableInteger(`Most commitments to return, 1–${COMMITMENTS_MAX_LIMIT}. Default ${COMMITMENTS_DEFAULT_LIMIT}.`),
  });
  readonly input = input;

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: AskToolContext, args: ListCommitmentsToolInput): Promise<AskToolResult> {
    const ownerId = ctx.user.id;
    const status = args.status ?? 'open';
    const direction = args.direction ?? 'any';
    const limit = args.limit ?? COMMITMENTS_DEFAULT_LIMIT;
    const entity = args.entity ? resolveHandleOrThrow(ctx, args.entity, ['ent']) : null;

    const where: Prisma.KgItemWhereInput = {
      ownerId,
      kind: 'commitment',
      reviewStatus: { in: [...READABLE_ITEM_STATUSES] },
    };
    if (status !== 'any') where.status = status;
    if (args.dueBefore) {
      let due: Date;
      try {
        due = parseAsOf(args.dueBefore, ctx.now);
      } catch {
        throw new AskToolError('dueBefore must be a date such as 2026-10-01.');
      }
      // A bare date means "by the end of that day".
      if (/^\d{4}-\d{2}-\d{2}$/.test(args.dueBefore)) due = new Date(due.getTime() + 24 * 60 * 60 * 1000 - 1);
      where.dueAt = { lte: due };
    }
    if (entity) {
      if (direction === 'owned_by') where.ownerPersonId = entity.id;
      else if (direction === 'owed_to') where.counterpartyId = entity.id;
      else where.OR = [{ ownerPersonId: entity.id }, { counterpartyId: entity.id }];
    }

    const rows = await this.prisma.kgItem.findMany({
      where,
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { occurredAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        title: true,
        statement: true,
        status: true,
        dueAt: true,
        occurredAt: true,
        ownerPerson: { select: PARTY_SELECT },
        counterparty: { select: PARTY_SELECT },
      },
    });
    const page = rows.slice(0, limit);
    const evidence = await firstEvidenceIds(
      this.prisma,
      ownerId,
      'item',
      page.map((r) => r.id),
      INLINE_EVIDENCE_PER_ENTRY,
    );

    const party = (e: { id: string; label: string; reviewStatus: string; mergedIntoId: string | null } | null) =>
      e && (READABLE_ENTITY_STATUSES as readonly string[]).includes(e.reviewStatus) && e.mergedIntoId === null
        ? { ref: ctx.handles.register({ kind: 'ent', id: e.id, label: e.label }), label: e.label }
        : null;

    const out = page.map((r) => ({
      ref: ctx.handles.register({ kind: 'itm', id: r.id, label: r.title ?? clip(r.statement, 80) }),
      statement: clip(r.title ? `${r.title}: ${r.statement}` : r.statement, STATEMENT_MAX_CHARS),
      status: r.status,
      due: isoDate(r.dueAt),
      owner: party(r.ownerPerson),
      counterparty: party(r.counterparty),
      madeOn: isoDate(r.occurredAt),
      evidence: (evidence.get(r.id) ?? []).map((id) => ctx.handles.register({ kind: 'ev', id })),
    }));

    const statusWord = status === 'any' ? '' : `${status} `;
    const scope = entity ? ` for ${entity.label ?? 'entity'}` : '';
    return {
      data: out,
      resultCount: out.length,
      summary: `Listed ${plural(out.length, `${statusWord}commitment`, `${statusWord}commitments`)}${scope}`,
      truncated: rows.length > limit,
    };
  }
}
