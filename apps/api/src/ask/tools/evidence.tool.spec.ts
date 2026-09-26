import { expectNoUuid, makeCtx, seedEntity, uid } from '../../../test/ask/ask-tool-fakes';
import { AskToolError } from './ask-tool';
import { EvidenceTool } from './evidence.tool';

// =============================================================================
// `evidence` (#377): subject re-check (owner, readable, sensitivity), the
// owner-scoped `listForSubject` call, the link → `{ ref, quote, source }`
// mapping, `available: false` sources, and a uuid-free result.
// =============================================================================

const ACME = uid(1);
const ITEM = uid(2);
const REL = uid(3);
const T1 = uid(4);
const N1 = uid(5);

const segmentLink = (id: string, available: boolean) => ({
  id,
  subjectKind: 'entity',
  subjectId: ACME,
  quote: `Acme signed ${'x'.repeat(400)}`,
  createdAt: '2026-09-01T00:00:00.000Z',
  source: {
    kind: 'segment',
    transcriptId: T1,
    transcriptTitle: available ? 'Weekly sync' : null,
    segmentId: uid(40),
    segmentRev: 1,
    currentSegmentRev: available ? 1 : null,
    startMs: 61000,
    endMs: 64000,
    textChanged: false,
    available,
    href: available ? `/transcripts/${T1}?t=61000` : null,
  },
});
const noteLink = {
  id: uid(31),
  subjectKind: 'entity',
  subjectId: ACME,
  quote: 'From the notes',
  createdAt: '2026-09-01T00:00:00.000Z',
  source: { kind: 'note', noteId: N1, noteTitle: 'Acme notes', noteVersion: 2, currentNoteVersion: 3, charStart: 0, charEnd: 10, versionChanged: true, available: true, href: `/notes/${N1}?v=2` },
};

function build(opts: { entityCount?: number; item?: object | null; relationCount?: number; rows?: object[] } = {}) {
  const rows = opts.rows ?? [
    { link: segmentLink(uid(30), true), occurredAt: new Date('2026-03-04T10:00:00Z') },
    { link: noteLink, occurredAt: new Date('2026-02-01T10:00:00Z') },
    { link: segmentLink(uid(32), false), occurredAt: null },
  ];
  const evidence = { listForSubject: jest.fn(async (_o: string, _k: string, _s: string, limit: number) => rows.slice(0, limit)) };
  const prisma = {
    kgEntity: { count: jest.fn(async () => opts.entityCount ?? 1) },
    kgItem: { findFirst: jest.fn(async () => (opts.item === undefined ? { kind: 'decision', sensitivity: null } : opts.item)) },
    kgRelation: { count: jest.fn(async () => opts.relationCount ?? 1) },
  };
  return { tool: new EvidenceTool(evidence as never, prisma as never), evidence, prisma };
}

describe('EvidenceTool', () => {
  it('lists quotes for an entity, newest source first, with handles', async () => {
    const { tool, evidence, prisma } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, ACME, 'Acme');
    const res = await tool.run(ctx, tool.input.parse({ subject: h, limit: null }));
    expect(prisma.kgEntity.count).toHaveBeenCalledWith({
      where: { id: ACME, ownerId: ctx.user.id, reviewStatus: { in: ['accepted', 'edited'] }, mergedIntoId: null },
    });
    expect(evidence.listForSubject).toHaveBeenCalledWith(ctx.user.id, 'entity', ACME, 6);
    const data = res.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({
      ref: 'ev1',
      source: { kind: 'transcript', title: 'Weekly sync', at: '2026-03-04', startMs: 61000 },
      available: true,
    });
    expect((data[0].quote as string).length).toBeLessThanOrEqual(300);
    expect(data[1]).toEqual({ ref: 'ev2', quote: 'From the notes', source: { kind: 'note', title: 'Acme notes', at: '2026-02-01', startMs: null }, available: true });
    expect(data[2]).toMatchObject({ ref: 'ev3', source: { kind: 'transcript', title: null, at: null, startMs: null }, available: false });
    expect(ctx.handles.resolve('ev1')).toEqual({ kind: 'ev', id: uid(30), label: 'Weekly sync' });
    expect(res.summary).toBe('Found 3 quotes for Acme');
    expect(res.truncated).toBe(false);
    expectNoUuid(res.data);
  });

  it('flags truncation when more quotes exist', async () => {
    const { tool } = build();
    const ctx = makeCtx();
    const res = await tool.run(ctx, tool.input.parse({ subject: seedEntity(ctx, ACME), limit: 2 }));
    expect((res.data as unknown[]).length).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it('accepts item and relation handles', async () => {
    const { tool, evidence } = build();
    const ctx = makeCtx();
    ctx.handles.register({ kind: 'itm', id: ITEM });
    ctx.handles.register({ kind: 'rel', id: REL });
    await tool.run(ctx, tool.input.parse({ subject: 'itm1' }));
    await tool.run(ctx, tool.input.parse({ subject: 'rel1' }));
    expect(evidence.listForSubject).toHaveBeenCalledWith(ctx.user.id, 'item', ITEM, 6);
    expect(evidence.listForSubject).toHaveBeenCalledWith(ctx.user.id, 'relation', REL, 6);
  });

  it('refuses an evidence or document handle as the subject', async () => {
    const { tool } = build();
    const ctx = makeCtx();
    ctx.handles.register({ kind: 'ev', id: uid(9) });
    await expect(tool.run(ctx, tool.input.parse({ subject: 'ev1' }))).rejects.toThrow(AskToolError);
  });

  it.each([
    ['a sensitive PersonFact', { kind: 'person_fact', sensitivity: 'sensitive' }, true],
    ['a personal PersonFact without the opt-in', { kind: 'person_fact', sensitivity: 'personal' }, false],
    ['an item that is gone', null, true],
  ])('refuses %s', async (_label, item, allowed) => {
    const { tool, evidence } = build({ item });
    const ctx = makeCtx({ personalFactsAllowed: allowed });
    ctx.handles.register({ kind: 'itm', id: ITEM });
    await expect(tool.run(ctx, tool.input.parse({ subject: 'itm1' }))).rejects.toThrow(/itm1 is no longer available/);
    expect(evidence.listForSubject).not.toHaveBeenCalled();
  });

  it('allows a personal PersonFact with the opt-in', async () => {
    const { tool } = build({ item: { kind: 'person_fact', sensitivity: 'personal' } });
    const ctx = makeCtx({ personalFactsAllowed: true });
    ctx.handles.register({ kind: 'itm', id: ITEM });
    await expect(tool.run(ctx, tool.input.parse({ subject: 'itm1' }))).resolves.toBeDefined();
  });

  it('refuses a merged entity', async () => {
    const { tool } = build({ entityCount: 0 });
    const ctx = makeCtx();
    await expect(tool.run(ctx, tool.input.parse({ subject: seedEntity(ctx, ACME) }))).rejects.toThrow(AskToolError);
  });
});
