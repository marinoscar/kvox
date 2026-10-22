import { expectNoUuid, makeCtx, seedEntity, uid } from '../testing/ask-tool-fakes.js';
import { ListRisksTool } from './list-risks.tool.js';

// =============================================================================
// `list_risks` (#664): the owner-scoped SQL built from the arguments, defaults,
// the work-domain gate, handles (an unreadable subject hidden), evidence refs,
// truncation and a uuid-free result. Ordering (severity, then recency) against
// real rows is in test/ask/ask-tools.db.spec.ts.
// =============================================================================

const PROJECT = uid(2);
const R1 = uid(3);
const R2 = uid(4);

const row = (over: Record<string, unknown> = {}) => ({
  id: R1,
  title: null,
  statement: 'Licence budget is not approved yet',
  status: 'open',
  severity: 'high',
  risk_kind: 'blocker',
  mitigation: 'Escalate to the CFO',
  occurred_at: new Date('2026-09-10T00:00:00Z'),
  subject_id: PROJECT,
  subject_label: 'Copilot rollout',
  subject_review_status: 'accepted',
  subject_merged_into_id: null,
  ...over,
});

function build(rows?: object[], schemaHasRisk = true) {
  const prisma = {
    $queryRaw: jest.fn(
      async () =>
        rows ?? [
          row(),
          row({
            id: R2,
            severity: null,
            risk_kind: null,
            mitigation: null,
            occurred_at: null,
            subject_review_status: 'merged',
            subject_merged_into_id: PROJECT,
          }),
        ],
    ),
    kgEvidence: {
      findMany: jest.fn(async () => [
        { id: uid(20), subjectId: R1 },
        { id: uid(21), subjectId: R1 },
        { id: uid(22), subjectId: R1 },
        { id: uid(23), subjectId: R2 },
      ]),
    },
  };
  const ontology = {
    effectiveSchemaFor: jest.fn(async () => ({ entityType: (k: string) => (schemaHasRisk && k === 'Risk' ? { key: 'Risk' } : undefined) })),
  };
  return { tool: new ListRisksTool(prisma as never, ontology as never), prisma };
}

type Sql = { strings: string[]; values: unknown[] };
const sqlOf = (prisma: { $queryRaw: jest.Mock }) => prisma.$queryRaw.mock.calls[0][0] as Sql;
const flat = (q: Sql) => q.strings.join('?').replace(/\s+/g, ' ');

describe('ListRisksTool', () => {
  it('defaults to every open risk of the owner, highest severity then newest', async () => {
    const { tool, prisma } = build();
    const ctx = makeCtx();
    await tool.run(ctx, tool.input.parse({ subject: null, status: null, severity: null, limit: null }));
    const q = sqlOf(prisma);
    const text = flat(q);
    expect(text).toContain("i.kind = 'risk'");
    expect(text).toContain('i.status =');
    expect(q.values).toContain('open');
    expect(q.values).toContain(ctx.user.id);
    expect(q.values).toContain(16);
    expect(text).not.toContain('i.subject_id =');
    expect(text).toContain(
      "ORDER BY CASE i.props->>'severity' WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC, i.occurred_at DESC NULLS LAST, i.id ASC",
    );
  });

  it('filters by subject, status and severity; "any" drops the status filter', async () => {
    const { tool, prisma } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, PROJECT, 'Copilot rollout');
    await tool.run(ctx, tool.input.parse({ subject: h, status: 'any', severity: 'high', limit: 5 }));
    const q = sqlOf(prisma);
    expect(flat(q)).toContain("i.props->>'severity' =");
    expect(flat(q)).toContain('i.subject_id =');
    expect(flat(q)).not.toContain('i.status =');
    expect(q.values).toEqual(expect.arrayContaining(['high', PROJECT, 6]));
  });

  it('maps rows to handles, hides an unreadable subject and caps evidence', async () => {
    const { tool } = build();
    const ctx = makeCtx();
    const out = await tool.run(ctx, tool.input.parse({}));
    const data = out.data as {
      subject: { ref: string; label: string } | null;
      evidence: string[];
      severity: string | null;
      mitigation?: string;
      raisedOn: string | null;
    }[];
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ severity: 'high', mitigation: 'Escalate to the CFO', raisedOn: '2026-09-10', subject: { label: 'Copilot rollout' } });
    expect(data[0].evidence).toHaveLength(2);
    expect(data[1].subject).toBeNull();
    expect(data[1]).not.toHaveProperty('mitigation');
    expect(out.summary).toBe('Listed 2 open risks');
    expect(out.truncated).toBe(false);
    expectNoUuid(JSON.stringify(out.data));
  });

  it('reports truncation when more than the limit match', async () => {
    const { tool } = build([row(), row({ id: R2 })]);
    const out = await tool.run(makeCtx(), tool.input.parse({ limit: 1 }));
    expect(out.resultCount).toBe(1);
    expect(out.truncated).toBe(true);
  });

  it('lists nothing, and does not query, when the work domain is off', async () => {
    const { tool, prisma } = build(undefined, false);
    const out = await tool.run(makeCtx(), tool.input.parse({}));
    expect(out.data).toEqual([]);
    expect(out.resultCount).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
