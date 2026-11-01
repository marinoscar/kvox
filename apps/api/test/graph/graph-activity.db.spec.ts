// =============================================================================
// Real-Postgres test: GET /api/graph/activity (GIC-15, #676)
// =============================================================================
//
// Bucket counts are asserted against REAL kg_evidence rows (the fixture writes
// one accepted evidence row per entity / relation / item): the time of a
// citation is its note's `created_at` or its transcript's `recorded_at`,
// falling back to the row's own `created_at`. Excluded from `npm test`; run by
// `npm run test:db`.
// =============================================================================

import { NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import {
  GraphAccessService,
  GraphActivityService,
  GraphNeighborhoodService,
  GraphOntologyService,
  GraphPreferencesService,
} from '@marinoscar/kvox-api/graph';
import { graphActivityResponseSchema, type GraphActivityQuery } from '@marinoscar/kvox-contract/graph';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from './graph-read.fixtures';
import { createDbSettings } from '../helpers/graph-ports.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('graph-activity.db.spec');

const EMAIL_PREFIX = 'graph-activity-test';

describeWithDb('GraphActivityService (real Postgres)', () => {
  let prisma: PrismaClient;
  let svc: GraphActivityService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const asService = prisma as unknown as PrismaService;
    const ontology = new GraphOntologyService(asService, new GraphPreferencesService(createDbSettings(prisma)));
    const neighborhood = new GraphNeighborhoodService(asService, new GraphAccessService(asService), ontology);
    svc = new GraphActivityService(asService, neighborhood);
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

  const activity = async (userId: string, ids: string[], q: Partial<GraphActivityQuery> = {}, timeZone?: string) => {
    const res = await svc.activity({ id: userId }, { ids, bucket: 'month', ...q } as GraphActivityQuery, timeZone ? { timeZone } : {});
    expect(graphActivityResponseSchema.safeParse(JSON.parse(JSON.stringify(res))).success).toBe(true);
    return res;
  };

  /** Dates the entity's own fixture evidence row (created now) to `at`. */
  const dateEvidence = (subjectId: string, at: string) =>
    prisma.$executeRaw`UPDATE kg_evidence SET created_at = ${at}::timestamptz WHERE subject_id = ${subjectId}::uuid`;

  it('buckets entity and relation evidence by month, stacked by type, and per entity', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const proj = await g.entity('Project', 'Product X');
    const rel = await g.relation('INVOLVED_IN', joe, proj);
    await dateEvidence(joe, '2026-01-10T12:00:00Z');
    await dateEvidence(proj, '2026-02-03T12:00:00Z');
    await dateEvidence(rel, '2026-02-20T12:00:00Z');
    // A second citation of Joe, dated by its NOTE (the meeting date wins over created_at).
    const note = await g.note();
    await prisma.$executeRaw`UPDATE notes SET created_at = '2026-02-14T00:00:00Z'::timestamptz WHERE id = ${note.id}::uuid`;
    await g.evidence('entity', joe, { noteId: note.id, noteVersion: 1 });

    const res = await activity(user.id, [joe, proj]);
    expect(res.bucket).toBe('month');
    expect(res.series).toEqual([
      { start: '2026-01-01', total: 1, byType: { Person: 1 } },
      // Feb: proj entity (Project), Joe's note citation (Person), the relation counts for BOTH ends.
      { start: '2026-02-01', total: 4, byType: { Person: 2, Project: 2 } },
    ]);
    expect(res.byEntity[joe]).toEqual([
      { start: '2026-01-01', count: 1 },
      { start: '2026-02-01', count: 2 },
    ]);
    expect(res.byEntity[proj]).toEqual([{ start: '2026-02-01', count: 2 }]);
    expect(res.series.every((b) => b.total === Object.values(b.byType).reduce((a, n) => a + n, 0))).toBe(true);
  });

  it('counts a relation only when both ends are requested', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const proj = await g.entity('Project', 'Product X');
    const rel = await g.relation('INVOLVED_IN', joe, proj);
    await dateEvidence(joe, '2026-03-05T00:00:00Z');
    await dateEvidence(proj, '2026-03-05T00:00:00Z');
    await dateEvidence(rel, '2026-03-05T00:00:00Z');
    const one = await activity(user.id, [joe]);
    expect(one.series).toEqual([{ start: '2026-03-01', total: 1, byType: { Person: 1 } }]);
  });

  it('uses weeks starting Monday and honours from (inclusive) and to (exclusive)', async () => {
    const { user, g } = await owner();
    const a = await g.entity('Person', 'A');
    await dateEvidence(a, '2026-03-04T10:00:00Z'); // Wednesday; week of Mon 2026-03-02
    const week = await activity(user.id, [a], { bucket: 'week' });
    expect(week.series).toEqual([{ start: '2026-03-02', total: 1, byType: { Person: 1 } }]);
    expect((await activity(user.id, [a], { from: '2026-03-04' })).series).toHaveLength(1);
    expect((await activity(user.id, [a], { from: '2026-03-05' })).series).toHaveLength(0);
    expect((await activity(user.id, [a], { to: '2026-03-04T10:00:00Z' })).series).toHaveLength(0);
    expect((await activity(user.id, [a], { to: '2026-03-04T10:00:01Z' })).series).toHaveLength(1);
  });

  // ⚠ NOT RUN where this was written (no Postgres in that environment): run with `npm run test:db`.
  describe('time zone (buckets are days of the REQUESTER zone)', () => {
    it('buckets an evening-local instant into the local month, and echoes the zone', async () => {
      const { user, g } = await owner();
      const a = await g.entity('Person', 'A');
      // 2026-11-01T03:30Z is still 22:30 on Oct 31 in Chicago (CDT, UTC-5): October there, November in UTC and Tokyo.
      await dateEvidence(a, '2026-11-01T03:30:00Z');
      const chicago = await activity(user.id, [a], {}, 'America/Chicago');
      expect(chicago.timeZone).toBe('America/Chicago');
      expect(chicago.series).toEqual([{ start: '2026-10-01', total: 1, byType: { Person: 1 } }]);
      expect((await activity(user.id, [a], {}, 'Asia/Tokyo')).series[0]!.start).toBe('2026-11-01');
      const utc = await activity(user.id, [a]);
      expect(utc.timeZone).toBe('UTC');
      expect(utc.series[0]!.start).toBe('2026-11-01');
    });

    it('starts weeks on Monday LOCAL: a Sunday-evening Chicago instant is Monday in UTC but belongs to the week before', async () => {
      const { user, g } = await owner();
      const a = await g.entity('Person', 'A');
      // Mon 2026-03-09T03:00Z is Sun 2026-03-08 22:00 CDT in Chicago (DST began that morning at 08:00Z).
      await dateEvidence(a, '2026-03-09T03:00:00Z');
      expect((await activity(user.id, [a], { bucket: 'week' }, 'America/Chicago')).series[0]!.start).toBe('2026-03-02');
      expect((await activity(user.id, [a], { bucket: 'week' })).series[0]!.start).toBe('2026-03-09');
    });

    it('is correct across a DST change: the same wall-clock evening lands in the same bucket either side of the switch', async () => {
      const { user, g } = await owner();
      const before = await g.entity('Person', 'Before');
      const after = await g.entity('Person', 'After');
      // Chicago springs forward on 2026-03-08. 22:30 local on the 7th is 04:30Z on the 8th (CST, UTC-6); 22:30 local on
      // the 8th is 03:30Z on the 9th (CDT, UTC-5). Both are the late evening of the same Mon-Sun week (2026-03-02) in Chicago; in UTC they would straddle two weeks.
      await dateEvidence(before, '2026-03-08T04:30:00Z');
      await dateEvidence(after, '2026-03-09T03:30:00Z');
      const res = await activity(user.id, [before, after], { bucket: 'week' }, 'America/Chicago');
      expect(res.series).toEqual([{ start: '2026-03-02', total: 2, byType: { Person: 2 } }]);
    });

    it('reads a bare from/to day as local midnight in the zone', async () => {
      const { user, g } = await owner();
      const a = await g.entity('Person', 'A');
      // 2026-10-26T04:30Z is 23:30 on the 25th in Chicago.
      await dateEvidence(a, '2026-10-26T04:30:00Z');
      expect((await activity(user.id, [a], { from: '2026-10-26' }, 'America/Chicago')).series).toHaveLength(0);
      expect((await activity(user.id, [a], { from: '2026-10-26' })).series).toHaveLength(1);
      expect((await activity(user.id, [a], { to: '2026-10-26' }, 'America/Chicago')).series).toHaveLength(1);
    });

    it('falls back to UTC for a zone Postgres does not know', async () => {
      const { user, g } = await owner();
      const a = await g.entity('Person', 'A');
      await dateEvidence(a, '2026-11-01T03:30:00Z');
      const res = await activity(user.id, [a], {}, 'Mars/Olympus_Mons');
      expect(res.timeZone).toBe('UTC');
      expect(res.series[0]!.start).toBe('2026-11-01');
    });
  });

  it('excludes sensitive person facts and unreadable relations; a readable item counts as its kind', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const proj = await g.entity('Project', 'Product X');
    const sensitive = await g.item('person_fact', { sensitivity: 'sensitive', subjectId: joe });
    const decision = await g.item('decision', { subjectId: joe });
    const rejected = await g.relation('INVOLVED_IN', joe, proj, { reviewStatus: 'rejected' });
    for (const id of [joe, proj, decision, rejected]) await dateEvidence(id, '2026-04-01T00:00:00Z');

    // Naming the sensitive fact is the shared 404, never a count.
    await expect(activity(user.id, [joe, sensitive])).rejects.toBeInstanceOf(NotFoundException);
    const res = await activity(user.id, [joe, proj, decision]);
    expect(res.series).toEqual([{ start: '2026-04-01', total: 3, byType: { Person: 1, Project: 1, decision: 1 } }]);
  });

  it('answers 404 for another owner id or an unreadable (merged) entity', async () => {
    const a = await owner('a');
    const b = await owner('b');
    const mine = await a.g.entity('Person', 'Mine');
    const theirs = await b.g.entity('Person', 'Theirs');
    await expect(activity(a.user.id, [mine, theirs])).rejects.toBeInstanceOf(NotFoundException);
    const merged = await a.g.entity('Person', 'Dup', { reviewStatus: 'merged', mergedIntoId: mine });
    await expect(activity(a.user.id, [merged])).rejects.toBeInstanceOf(NotFoundException);
  });
});
