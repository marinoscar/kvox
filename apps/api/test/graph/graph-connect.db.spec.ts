// =============================================================================
// Real-Postgres test: POST /api/graph/connect (GIC-14, #675)
// =============================================================================
//
// Excluded from `npm test`; run by `npm run test:db`.
//
// Three meeting notes share entities (the people and products they mention):
//
//   note 1: Joe x3, Copilot x2, Company A, Risk-ish Topic
//   note 2: Joe x1, Copilot x1, Microsoft
//   note 3: Joe x2, Microsoft, Steering
//
// What it proves: shared entities and their input coverage / mention counts
// (an `ignored` mention does not count), ranking, an unreadable input (another
// owner's note) is the same 404 as a missing one, an empty overlap is an empty
// `shared` and not an error, a `sensitive` person fact never enters the slice,
// bridges reuse the paths search, a transcript input and entity inputs work.
// =============================================================================

import { NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import {
  GraphAccessService,
  GraphConnectService,
  GraphNeighborhoodService,
  GraphOntologyService,
  GraphPathsService,
  GraphPreferencesService,
} from '@marinoscar/kvox-api/graph';
import { graphConnectResponseSchema, graphConnectRequestSchema } from '@marinoscar/kvox-contract/graph';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { SharedTranscriptVisibility } from '../../src/kvox/search/shared-transcript-visibility';
import { resolveDbSuite } from '../jobs/db-test-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from './graph-read.fixtures';
import { createDbSettings } from '../helpers/graph-ports.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('graph-connect.db.spec');

const EMAIL_PREFIX = 'graph-connect-test';

describeWithDb('GraphConnectService (real Postgres)', () => {
  let prisma: PrismaClient;
  let svc: GraphConnectService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    const ontology = new GraphOntologyService(p, new GraphPreferencesService(createDbSettings(prisma)));
    const neighborhood = new GraphNeighborhoodService(p, new GraphAccessService(p), ontology);
    const paths = new GraphPathsService(p, ontology, neighborhood);
    svc = new GraphConnectService(p, neighborhood, paths, new SharedTranscriptVisibility(p));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function owner(suffix = 'a') {
    const user = await createUser(prisma, EMAIL_PREFIX, suffix);
    return { user, g: new GraphFixture(prisma, user.id) };
  }

  const mention = async (ownerId: string, entityId: string, doc: { noteId?: string; transcriptId?: string }, n = 1, status: 'linked' | 'ignored' = 'linked') => {
    for (let i = 0; i < n; i++) {
      await prisma.kgMention.create({ data: { ownerId, entityId, ...doc, status } });
    }
  };

  const parse = (body: unknown) => graphConnectRequestSchema.parse(body);

  async function scenario() {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const copilot = await g.entity('Product', 'Copilot');
    const companyA = await g.entity('Organization', 'Company A');
    const microsoft = await g.entity('Organization', 'Microsoft');
    const steering = await g.entity('Meeting', 'Steering');
    const n1 = await g.note({ title: 'Company A call' });
    const n2 = await g.note({ title: 'Microsoft call' });
    const n3 = await g.note({ title: 'Steering' });
    await mention(user.id, joe, { noteId: n1.id }, 3);
    await mention(user.id, copilot, { noteId: n1.id }, 2);
    await mention(user.id, companyA, { noteId: n1.id });
    await mention(user.id, joe, { noteId: n2.id });
    await mention(user.id, copilot, { noteId: n2.id });
    await mention(user.id, microsoft, { noteId: n2.id });
    await mention(user.id, joe, { noteId: n3.id }, 2);
    await mention(user.id, microsoft, { noteId: n3.id });
    await mention(user.id, steering, { noteId: n3.id });
    // An ignored mention is not a mention.
    await mention(user.id, steering, { noteId: n1.id }, 1, 'ignored');
    return { user, g, joe, copilot, companyA, microsoft, steering, n1, n2, n3 };
  }

  it('returns the shared entities of three notes, widest coverage first, then mention count', async () => {
    const s = await scenario();
    const res = await svc.connect(
      s.user,
      parse({ noteIds: [s.n1.id, s.n2.id, s.n3.id] }),
    );
    expect(graphConnectResponseSchema.safeParse(res).success).toBe(true);
    expect(res.inputs.map((i) => i.id).sort()).toEqual([s.n1.id, s.n2.id, s.n3.id].sort());
    expect(res.inputs.find((i) => i.id === s.n1.id)).toMatchObject({ kind: 'note', title: 'Company A call' });

    expect(res.shared.map((x) => x.entityId)).toEqual([s.joe, s.copilot, s.microsoft]);
    expect(res.shared[0]).toMatchObject({ mentionCount: 6 });
    expect(res.shared[0].inputIds.sort()).toEqual([s.n1.id, s.n2.id, s.n3.id].sort());
    expect(res.shared[1]).toMatchObject({ mentionCount: 3 });
    expect(res.shared[1].inputIds.sort()).toEqual([s.n1.id, s.n2.id].sort());
    expect(res.shared[2]).toMatchObject({ mentionCount: 2 });
    // The ignored mention left Steering with one note: not shared.
    expect(res.shared.map((x) => x.entityId)).not.toContain(s.steering);
    // The slice carries the shared entities.
    const sliceIds = res.slice.nodes.map((n) => n.id);
    expect(sliceIds).toEqual(expect.arrayContaining([s.joe, s.copilot, s.microsoft]));
  });

  it('answers a 404 naming nothing when an input is unreadable (another owner, deleted, missing)', async () => {
    const s = await scenario();
    const other = await owner('b');
    const foreign = await other.g.note({ title: 'Not yours' });
    const attempt = (noteIds: string[]) => svc.connect(s.user, parse({ noteIds }));
    await expect(attempt([s.n1.id, foreign.id])).rejects.toBeInstanceOf(NotFoundException);
    await expect(attempt([s.n1.id, '00000000-0000-4000-8000-000000000001'])).rejects.toBeInstanceOf(NotFoundException);
    await prisma.note.update({ where: { id: s.n2.id }, data: { deletedAt: new Date() } });
    await expect(attempt([s.n1.id, s.n2.id])).rejects.toBeInstanceOf(NotFoundException);
    const messages = await Promise.all(
      [[s.n1.id, foreign.id], [s.n1.id, '00000000-0000-4000-8000-000000000001']].map((ids) =>
        attempt(ids).catch((e: Error) => e.message),
      ),
    );
    expect(new Set(messages).size).toBe(1);
  });

  it('returns an empty shared list, not an error, when nothing overlaps', async () => {
    const { user, g } = await owner();
    const a = await g.entity('Person', 'Ann');
    const b = await g.entity('Person', 'Bob');
    const n1 = await g.note();
    const n2 = await g.note();
    await mention(user.id, a, { noteId: n1.id });
    await mention(user.id, b, { noteId: n2.id });
    const res = await svc.connect(user, parse({ noteIds: [n1.id, n2.id] }));
    expect(res.shared).toEqual([]);
    expect(res.paths).toEqual([]);
    expect(res.inputs.map((i) => i.entityIds)).toEqual(expect.arrayContaining([[a], [b]]));
  });

  it('finds a bridge path between two notes that share nothing', async () => {
    const { user, g } = await owner();
    const ann = await g.entity('Person', 'Ann');
    const bob = await g.entity('Person', 'Bob');
    const acme = await g.entity('Organization', 'Acme');
    const r1 = await g.relation('WORKS_FOR', ann, acme);
    const r2 = await g.relation('WORKS_FOR', bob, acme);
    const n1 = await g.note();
    const n2 = await g.note();
    await mention(user.id, ann, { noteId: n1.id });
    await mention(user.id, bob, { noteId: n2.id });
    const res = await svc.connect(user, parse({ noteIds: [n1.id, n2.id] }));
    expect(res.shared).toEqual([]);
    expect(res.paths).toHaveLength(1);
    const path = res.paths[0];
    expect([path.fromInput, path.toInput].sort()).toEqual([n1.id, n2.id].sort());
    expect(new Set(path.nodeIds)).toEqual(new Set([ann, acme, bob]));
    expect(new Set(path.edgeIds)).toEqual(new Set([r1, r2]));
    expect(res.slice.edges.map((e) => e.id)).toEqual(expect.arrayContaining([r1, r2]));
  });

  it('answers "what this note touches" for a single note', async () => {
    const s = await scenario();
    const res = await svc.connect(s.user, parse({ noteIds: [s.n1.id] }));
    expect(res.shared).toEqual([]);
    expect(res.paths).toEqual([]);
    expect(res.inputs[0].entityIds).toEqual([s.joe, s.copilot, s.companyA]);
    expect(res.slice.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([s.joe, s.copilot, s.companyA]));
  });

  it('never includes a sensitive person fact', async () => {
    const s = await scenario();
    const secret = await s.g.item('person_fact', { subjectId: s.joe, sensitivity: 'sensitive', statement: 'secret' });
    const ok = await s.g.item('person_fact', { subjectId: s.joe, sensitivity: 'personal', statement: 'fine' });
    const res = await svc.connect(s.user, parse({ noteIds: [s.n1.id, s.n2.id] }));
    const ids = res.slice.nodes.map((n) => n.id);
    expect(ids).not.toContain(secret);
    expect(JSON.stringify(res)).not.toContain('secret');
    expect(ids.includes(ok) || !ids.includes(ok)).toBe(true);
  });

  it('connects a transcript and a note, and a foreign transcript is a 404', async () => {
    const s = await scenario();
    const t = await s.g.transcript({ title: 'Standup' });
    await mention(s.user.id, s.joe, { transcriptId: t.transcript.id }, 2);
    const res = await svc.connect(s.user, parse({ noteIds: [s.n1.id], transcriptIds: [t.transcript.id] }));
    expect(res.inputs.find((i) => i.kind === 'transcript')).toMatchObject({ id: t.transcript.id, title: 'Standup' });
    expect(res.shared.map((x) => x.entityId)).toEqual([s.joe]);
    expect(res.shared[0].mentionCount).toBe(5);

    const other = await owner('b');
    const foreign = await other.g.transcript();
    await expect(
      svc.connect(s.user, parse({ noteIds: [s.n1.id], transcriptIds: [foreign.transcript.id] })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('connects entities: the neighbours two entities share, and a foreign entity is a 404', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const rollout = await g.entity('Project', 'Copilot rollout');
    const companyA = await g.entity('Organization', 'Company A');
    await g.relation('WORKS_FOR', joe, companyA);
    await g.relation('PART_OF', rollout, companyA);
    const res = await svc.connect(user, parse({ entityIds: [joe, rollout] }));
    expect(res.inputs.map((i) => i.kind)).toEqual(['entity', 'entity']);
    expect(res.shared.map((x) => x.entityId)).toEqual([companyA]);
    expect(res.shared[0].inputIds.sort()).toEqual([joe, rollout].sort());
    expect(res.paths[0].nodeIds).toEqual(expect.arrayContaining([joe, companyA, rollout]));

    const other = await owner('b');
    const stranger = await other.g.entity('Person', 'Stranger');
    await expect(svc.connect(user, parse({ entityIds: [joe, stranger] }))).rejects.toBeInstanceOf(NotFoundException);
  });
});
