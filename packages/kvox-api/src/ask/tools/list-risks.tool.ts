// =============================================================================
// `list_risks` (#664; docs/specs/ontology.md §5.1, §9.1, §21)
// =============================================================================
//
// One owner-scoped `kg_items` read: `kind = 'risk'`, readable review statuses
// only (`readable.ts`), optionally narrowed to one subject (a Project, Product,
// Organization, Person or Topic) by its handle, by risk `status` (default
// `open`) and by `severity`. Ordered by what matters most, then by what was
// raised most recently: severity high, medium, low, unstated; then
// `occurred_at DESC NULLS LAST`; then id.
//
// Sibling of `list_commitments`: same handle registry, same compact result,
// read-only. When the caller's `work` domain is off there is no Risk type in
// their schema and the tool lists nothing. Every filter is a bound parameter.
// =============================================================================

import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';

import { Prisma } from '../../core/index.js';
import { GraphOntologyService, READABLE_ENTITY_STATUSES, readableItemSql } from '../../graph/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';
import type { KvoxAskDb } from '../data/ask-db.js';
import {
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
  zHandle,
  type AskTool,
  type AskToolContext,
  type AskToolResult,
} from './ask-tool.js';
import { firstEvidenceIds, INLINE_EVIDENCE_PER_ENTRY } from './tool-queries.js';

export const RISK_STATUSES = ['open', 'mitigated', 'closed', 'superseded', 'any'] as const;
export const RISK_SEVERITIES = ['low', 'medium', 'high'] as const;
export const RISKS_DEFAULT_LIMIT = 15;
export const RISKS_MAX_LIMIT = 25;

const input = z.object({
  subject: optionalOf(zHandle),
  status: optionalOf(z.enum(RISK_STATUSES)),
  severity: optionalOf(z.enum(RISK_SEVERITIES)),
  limit: optionalOf(z.number().int().min(1).max(RISKS_MAX_LIMIT)),
});
export type ListRisksToolInput = z.output<typeof input>;

interface RiskRow {
  id: string;
  title: string | null;
  statement: string;
  status: string;
  severity: string | null;
  risk_kind: string | null;
  mitigation: string | null;
  occurred_at: Date | null;
  subject_id: string | null;
  subject_label: string | null;
  subject_review_status: string | null;
  subject_merged_into_id: string | null;
}

@Injectable()
export class ListRisksTool implements AskTool<ListRisksToolInput> {
  readonly name = 'list_risks';
  readonly description =
    'List risks, issues and blockers, optionally for one project, product, organization or person, by status and severity. Highest severity first.';
  readonly parameters = objectParameters({
    subject: jsonNullableString('A project, product, organization, person or topic reference (entN). Default: every risk.'),
    status: jsonNullableEnum(RISK_STATUSES, 'Risk status to keep. Default "open"; "any" keeps all.'),
    severity: jsonNullableEnum(RISK_SEVERITIES, 'Only risks of this severity. Default: any severity.'),
    limit: jsonNullableInteger(`Most risks to return, 1–${RISKS_MAX_LIMIT}. Default ${RISKS_DEFAULT_LIMIT}.`),
  });
  readonly input = input;

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxAskDb,
    private readonly ontology: GraphOntologyService,
  ) {}

  async run(ctx: AskToolContext, args: ListRisksToolInput): Promise<AskToolResult> {
    const ownerId = ctx.user.id;
    const status = args.status ?? 'open';
    const limit = args.limit ?? RISKS_DEFAULT_LIMIT;
    const subject = args.subject ? resolveHandleOrThrow(ctx, args.subject, ['ent']) : null;

    // With the work domain off the caller's schema has no Risk type: nothing is listed.
    const schema = await this.ontology.effectiveSchemaFor(ownerId);
    if (schema.entityType('Risk') === undefined) {
      return { data: [], resultCount: 0, summary: 'Risks are not enabled in your graph (the work domain is off)', truncated: false };
    }

    const filters = [
      Prisma.sql`i.owner_id = ${ownerId}::uuid`,
      Prisma.sql`i.kind = 'risk'`,
      readableItemSql('i'),
    ];
    if (status !== 'any') filters.push(Prisma.sql`i.status = ${status}`);
    if (args.severity) filters.push(Prisma.sql`i.props->>'severity' = ${args.severity}`);
    if (subject) filters.push(Prisma.sql`i.subject_id = ${subject.id}::uuid`);

    const rows = await this.prisma.$queryRaw<RiskRow[]>(Prisma.sql`
      SELECT i.id::text AS id, i.title, i.statement, i.status,
             i.props->>'severity' AS severity, i.props->>'riskKind' AS risk_kind, i.props->>'mitigation' AS mitigation,
             i.occurred_at, s.id::text AS subject_id, s.label AS subject_label,
             s.review_status::text AS subject_review_status, s.merged_into_id::text AS subject_merged_into_id
      FROM kg_items i
      LEFT JOIN kg_entities s ON s.id = i.subject_id AND s.owner_id = i.owner_id
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY CASE i.props->>'severity' WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
               i.occurred_at DESC NULLS LAST, i.id ASC
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const evidence = await firstEvidenceIds(
      this.prisma,
      ownerId,
      'item',
      page.map((r) => r.id),
      INLINE_EVIDENCE_PER_ENTRY,
    );

    const out = page.map((r) => {
      const readableSubject =
        r.subject_id !== null &&
        r.subject_label !== null &&
        (READABLE_ENTITY_STATUSES as readonly string[]).includes(r.subject_review_status ?? '') &&
        r.subject_merged_into_id === null;
      return {
        ref: ctx.handles.register({ kind: 'itm', id: r.id, label: r.title ?? clip(r.statement, 80) }),
        statement: clip(r.title ? `${r.title}: ${r.statement}` : r.statement, STATEMENT_MAX_CHARS),
        status: r.status,
        severity: r.severity,
        kind: r.risk_kind,
        ...(r.mitigation ? { mitigation: clip(r.mitigation, STATEMENT_MAX_CHARS) } : {}),
        subject: readableSubject
          ? { ref: ctx.handles.register({ kind: 'ent', id: r.subject_id!, label: r.subject_label! }), label: r.subject_label! }
          : null,
        raisedOn: isoDate(r.occurred_at),
        evidence: (evidence.get(r.id) ?? []).map((id) => ctx.handles.register({ kind: 'ev', id })),
      };
    });

    const statusWord = status === 'any' ? '' : `${status} `;
    const scope = subject ? ` for ${subject.label ?? 'entity'}` : '';
    return {
      data: out,
      resultCount: out.length,
      summary: `Listed ${plural(out.length, `${statusWord}risk`, `${statusWord}risks`)}${scope}`,
      truncated: rows.length > limit,
    };
  }
}
