import type { KvoxJob } from '../../ports/index.js';

import type { MentionOutcome, MentionToRank } from '../resolution/resolution.service.js';
import { decide } from '../resolution/resolution.service.js';
import {
  KG_TOPICS_PROMOTE_BATCH_SIZE,
  KgTopicsPromoteHandler,
  cleanTopic,
  conceptKey,
  evidenceDraftOf,
  linkExactName,
  readKgTopicsPromotePayload,
  topicsOf,
} from './kg-topics-promote.handler.js';

const USER = '11111111-1111-4111-8111-111111111111';
const TOPIC = 'tttttttt-tttt-4ttt-8ttt-tttttttttttt'.replace(/t/g, 'a');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const job = (payload: unknown) => ({ id: '99999999-9999-4999-8999-999999999999', payload }) as unknown as KvoxJob;
const noteEvidence = (meetingId: string) => ({
  subjectId: meetingId,
  transcriptId: null,
  segmentId: null,
  segmentRev: null,
  startMs: null,
  endMs: null,
  noteId: uuid(900),
  noteVersion: 1,
  charStart: 0,
  charEnd: 5,
  quote: 'Hello',
});

function outcome(candidateId: string | null, score: number, band: MentionOutcome['band'], exact = false, ambiguous = false): MentionOutcome {
  return {
    candidates: candidateId
      ? [{ entityId: candidateId, label: 'Licensing cost', type: 'Topic', score, signals: exact ? ['alias_exact'] : ['trigram'], arm: exact ? 'alias_exact' : 'trigram' }]
      : [],
    ambiguous,
    band,
  };
}

interface Options {
  meetings: Array<{ id: string; label?: string; props: unknown }>;
  outcomes?: (m: MentionToRank) => MentionOutcome;
  edges?: Array<{ fromId: string; toId: string }>;
  pending?: Array<{ id: string; items: Array<{ kind: string; payload: unknown; resolution: unknown }> }>;
  withoutEvidence?: string[];
}

function build(options: Options) {
  const writes: Array<{ rows: any[]; stats: any }> = [];
  const meetingPages: string[] = [];
  const prisma = {
    kgEntity: {
      findMany: jest.fn(async ({ where, take }: any) => {
        if (where.type === 'Meeting') {
          const after = where.id?.gt as string | undefined;
          meetingPages.push(after ?? '');
          return options.meetings
            .filter((m) => !after || m.id > after)
            .slice(0, take)
            .map((m) => ({ label: 'Weekly sync', ...m }));
        }
        return where.id.in.map((id: string) => ({ id, label: 'Licensing cost' })); // the edges' Topics
      }),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    kgEntityAlias: { findMany: jest.fn(async () => []) },
    kgRelation: {
      findMany: jest.fn(async ({ where }: any) => (options.edges ?? []).filter((e) => where.fromId.in.includes(e.fromId))),
      create: jest.fn(),
      createMany: jest.fn(),
    },
    kgProposal: {
      findMany: jest.fn(async () => (options.pending ?? []).map((p) => ({ id: p.id }))),
      create: jest.fn(),
    },
    kgProposalItem: {
      findMany: jest.fn(async () =>
        (options.pending ?? []).flatMap((p) => p.items.map((i) => ({ proposalId: p.id, ...i }))),
      ),
    },
    kgEvidence: {
      findMany: jest.fn(async ({ where }: any) =>
        where.subjectId.in.filter((id: string) => !(options.withoutEvidence ?? []).includes(id)).map(noteEvidence),
      ),
    },
  };
  const jobs = { registerHandler: jest.fn() };
  const preferences = { get: jest.fn(async () => ({ resolution: { mode: 'precheck_confident', autoLinkThreshold: 0.9, newThreshold: 0.55, adjudication: 'llm' } })) };
  const resolution = {
    embedMentions: jest.fn(async (_u: string, texts: string[]) => ({ vectors: texts.map(() => null), vectorArm: 'ok' })),
    rankMentions: jest.fn(async (_u: string, mentions: MentionToRank[]) =>
      new Map(mentions.map((m) => [m.key, (options.outcomes ?? (() => outcome(null, 0, 'new')))(m)])),
    ),
    adjudicateSafely: jest.fn(async () => ({ verdicts: new Map(), reason: null })),
  };
  const adjudication = {
    buildCandidateDossiers: jest.fn(async (_o: string, ids: string[]) =>
      new Map(ids.map((id) => [id, { entityId: id, label: 'Licensing cost', aliases: [], props: {}, quotes: [], neighbourhood: [] }])),
    ),
  };
  const writer = {
    createDraft: jest.fn(async (_o: string, _k: string, rows: any[], stats: any) => {
      writes.push({ rows, stats });
      return { proposalId: `prop-${writes.length}`, itemIds: [] };
    }),
  };
  const handler = new KgTopicsPromoteHandler(jobs as never, prisma as never, preferences as never, resolution as never, adjudication as never, writer as never);
  return { handler, prisma, resolution, writer, writes, jobs, meetingPages };
}

describe('kg.topics_promote: pure helpers', () => {
  it('cleans topic strings and drops spelling duplicates', () => {
    expect(cleanTopic('  Licensing \n  cost ')).toBe('Licensing cost');
    expect(cleanTopic('   ')).toBeNull();
    expect(cleanTopic(7)).toBeNull();
    expect(topicsOf({ topics: ['Licensing cost', ' licensing  COST ', '???', 4, 'Budget'] }).map((t) => t.label)).toEqual(['Licensing cost', 'Budget']);
    expect(topicsOf({})).toEqual([]);
    expect(topicsOf(null)).toEqual([]);
  });

  it('groups plural and word-order spellings of one new concept', () => {
    expect(conceptKey('licensing costs')).toBe(conceptKey('cost licensing'));
    expect(conceptKey('budget')).not.toBe(conceptKey('hiring'));
  });

  it('turns a citation row into evidence, or null when it has no anchor', () => {
    expect(evidenceDraftOf({ ...noteEvidence('x') })).toMatchObject({ source: 'note', noteId: uuid(900), noteVersion: 1, quote: 'Hello' });
    expect(
      evidenceDraftOf({ ...noteEvidence('x'), noteId: null, noteVersion: null, transcriptId: uuid(1), segmentId: uuid(2), segmentRev: 3, startMs: 0, endMs: 10 }),
    ).toMatchObject({ source: 'segment', segmentId: uuid(2), segmentRev: 3 });
    expect(evidenceDraftOf({ ...noteEvidence('x'), noteId: null, noteVersion: null })).toBeNull();
  });

  it('links an exact name match left in the middle band, unless it is ambiguous or judged different', () => {
    const thresholds = { autoLinkThreshold: 0.9, newThreshold: 0.55 };
    const middle = outcome(TOPIC, 0.82, 'middle', true);
    const asNew = decide(middle, { ...thresholds, mode: 'precheck_confident', adjudication: 'off' } as never, null);
    expect(asNew.resolution.ref).toBeNull();
    expect(asNew.flags).toContain('possible_duplicate');

    const linked = linkExactName(middle, asNew, null);
    expect(linked.resolution).toMatchObject({ ref: TOPIC, score: 0.82, source: 'alias' });
    expect(linked.flags).not.toContain('possible_duplicate');

    expect(linkExactName(outcome(TOPIC, 0.7, 'middle', false), asNew, null).resolution.ref).toBeNull(); // a fuzzy match stays a question
    expect(linkExactName(outcome(TOPIC, 0.82, 'middle', true, true), asNew, null).resolution.ref).toBeNull();
    expect(linkExactName(middle, asNew, { verdict: 'different', rationale: 'no', model: 'm' }).resolution.ref).toBeNull();
  });

  it('reads only a {userId} payload', () => {
    expect(readKgTopicsPromotePayload({ userId: USER })).toEqual({ userId: USER });
    expect(readKgTopicsPromotePayload({})).toBeNull();
    expect(readKgTopicsPromotePayload(null)).toBeNull();
  });
});

describe('kg.topics_promote: the handler', () => {
  it('is server-only, spends the owner key and declares its profile and label', () => {
    const { handler, jobs } = build({ meetings: [] });
    expect(handler.type).toBe('kg.topics_promote');
    expect(handler.label).toBe('Find topics in past meetings');
    expect(handler.profile).toEqual({ maxRuntimeMs: 30 * 60_000, maxAttempts: 3 });
    expect(handler.usesAi).toBe(true);
    expect((handler as any).nodeResultSchema).toBeUndefined();
    expect((handler as any).persistNodeResult).toBeUndefined();
    handler.onModuleInit();
    expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
  });

  it('does nothing for an unreadable payload', async () => {
    const t = build({ meetings: [{ id: uuid(1), props: { topics: ['A'] } }] });
    await t.handler.process(job({}));
    expect(t.prisma.kgEntity.findMany).not.toHaveBeenCalled();
  });

  it('writes one draft proposal per concept, each meeting a DISCUSSED row with its own evidence', async () => {
    const t = build({
      meetings: [
        { id: uuid(1), props: { topics: ['Licensing cost', 'Hiring plan'] } },
        { id: uuid(2), props: { topics: ['Licensing  cost', 'Budget'] } },
        { id: uuid(3), props: { topics: ['Licensing costs', 'Hiring plan'] } },
      ],
    });
    await t.handler.process(job({ userId: USER }));

    // Licensing cost (+ its plural spelling), Hiring plan, Budget.
    expect(t.writes).toHaveLength(3);
    const licensing = t.writes.find((w) => w.rows[0].payload.label === 'Licensing cost')!;
    expect(licensing.rows[0]).toMatchObject({
      kind: 'entity',
      payload: { ref: 'topic', type: 'Topic', aliases: ['Licensing costs'] },
      resolution: { ref: null },
    });
    expect(licensing.rows.slice(1).map((r) => r.payload.from)).toEqual([{ entityId: uuid(1) }, { entityId: uuid(2) }, { entityId: uuid(3) }]);
    expect(licensing.rows[1]).toMatchObject({ kind: 'relation', payload: { type: 'DISCUSSED', to: { ref: 'topic' } }, evidence: [{ source: 'note', noteId: uuid(900) }] });
    expect(licensing.stats).toMatchObject({ phase: 'ready', source: 'topics_promote', meetings: 3 });
    // Never the graph directly.
    expect(t.prisma.kgEntity.create).not.toHaveBeenCalled();
    expect(t.prisma.kgRelation.create).not.toHaveBeenCalled();
    expect(t.prisma.kgRelation.createMany).not.toHaveBeenCalled();
  });

  it('maps a string onto an existing Topic and groups two strings that land on it', async () => {
    const t = build({
      meetings: [
        { id: uuid(1), props: { topics: ['Licence costs'] } },
        { id: uuid(2), props: { topics: ['Software licensing spend'] } },
      ],
      outcomes: () => outcome(TOPIC, 0.95, 'link'),
    });
    await t.handler.process(job({ userId: USER }));

    expect(t.writes).toHaveLength(1);
    expect(t.writes[0].rows[0].resolution).toMatchObject({ ref: TOPIC, score: 0.95 });
    expect(t.writes[0].rows).toHaveLength(3);
  });

  it('links a string that is exactly an existing Topic even with adjudication off', async () => {
    const t = build({
      meetings: [{ id: uuid(1), props: { topics: ['Licensing cost'] } }],
      outcomes: () => outcome(TOPIC, 0.82, 'middle', true),
    });
    await t.handler.process(job({ userId: USER }));
    expect(t.writes[0].rows[0].resolution).toMatchObject({ ref: TOPIC });
  });

  it('skips pairs that already have a DISCUSSED edge, or sit in a pending proposal', async () => {
    const t = build({
      meetings: [
        { id: uuid(1), props: { topics: ['Licensing cost', 'Budget'] } },
        { id: uuid(2), props: { topics: ['Licensing cost', 'Budget'] } },
      ],
      edges: [{ fromId: uuid(1), toId: TOPIC }], // meeting 1 already discussed "Licensing cost" (the Topic's label)
      pending: [
        {
          id: 'p1',
          items: [
            { kind: 'entity', payload: { label: 'Budget', aliases: [] }, resolution: { ref: null } },
            { kind: 'relation', payload: { from: { entityId: uuid(2) } }, resolution: null },
          ],
        },
      ],
    });
    await t.handler.process(job({ userId: USER }));

    // Licensing cost: only meeting 2 left. Budget: meeting 1 left (2 is pending).
    const byLabel = Object.fromEntries(t.writes.map((w) => [w.rows[0].payload.label, w.rows.slice(1).map((r) => r.payload.from.entityId)]));
    expect(byLabel).toEqual({ 'Licensing cost': [uuid(2)], Budget: [uuid(1)] });
  });

  it('creates nothing when every pair is known (a re-run)', async () => {
    const t = build({
      meetings: [{ id: uuid(1), props: { topics: ['Licensing cost'] } }],
      edges: [{ fromId: uuid(1), toId: TOPIC }],
    });
    await t.handler.process(job({ userId: USER }));
    expect(t.writes).toHaveLength(0);
    expect(t.resolution.rankMentions).not.toHaveBeenCalled(); // and spent no key
  });

  it('skips a linked pair whose meeting already discusses the matched Topic', async () => {
    const t = build({
      meetings: [{ id: uuid(1), props: { topics: ['Licence costs'] } }],
      edges: [{ fromId: uuid(1), toId: TOPIC }],
      outcomes: () => outcome(TOPIC, 0.95, 'link'),
    });
    await t.handler.process(job({ userId: USER }));
    expect(t.writes).toHaveLength(0);
  });

  it('skips a meeting with no citation, and a topic with no cited meeting', async () => {
    const t = build({
      meetings: [
        { id: uuid(1), props: { topics: ['Licensing cost'] } },
        { id: uuid(2), props: { topics: ['Licensing cost', 'Budget'] } },
      ],
      withoutEvidence: [uuid(1)],
    });
    await t.handler.process(job({ userId: USER }));
    const byLabel = Object.fromEntries(t.writes.map((w) => [w.rows[0].payload.label, w.rows.length]));
    expect(byLabel).toEqual({ 'Licensing cost': 2, Budget: 2 });
  });

  it('sends the middle band to adjudication and keeps the flag when it is unavailable', async () => {
    const t = build({
      meetings: [{ id: uuid(1), props: { topics: ['Licence costs'] } }],
      outcomes: () => outcome(TOPIC, 0.7, 'middle'),
    });
    t.resolution.adjudicateSafely.mockResolvedValue({ verdicts: null, reason: 'ai_key_missing' } as never);
    await t.handler.process(job({ userId: USER }));
    expect(t.resolution.adjudicateSafely).toHaveBeenCalledTimes(1);
    expect(t.writes[0].rows[0].flags).toContain('possible_duplicate');
    expect(t.writes[0].rows[0].resolution.ref).toBeNull();
  });

  it('reads meetings in keyset batches', async () => {
    const meetings = Array.from({ length: KG_TOPICS_PROMOTE_BATCH_SIZE + 5 }, (_, i) => ({ id: uuid(i + 1), props: { topics: ['Budget'] } }));
    const t = build({ meetings });
    await t.handler.process(job({ userId: USER }));
    expect(t.meetingPages).toEqual(['', uuid(KG_TOPICS_PROMOTE_BATCH_SIZE)]);
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0].rows).toHaveLength(1 + KG_TOPICS_PROMOTE_BATCH_SIZE + 5);
    // The topic row cites at most three of its meetings.
    expect(t.writes[0].rows[0].evidence).toHaveLength(3);
  });
});
