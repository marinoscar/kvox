// =============================================================================
// Real-Postgres test: GET /api/graph/paths (GIC-12, #673)
// =============================================================================
//
// The bidirectional BFS, `tstzrange` as-of filtering, the per-hop row cap and
// the 3 s statement timeout are only real against Postgres. Excluded from
// `npm test`; run by `npm run test:db`.
//
// The reference scenario (the epic's question, "how is Joe connected to the
// Copilot rollout?"), with the relation types that exist in the ontology:
//
//   Joe -ATTENDED-> Copilot rollout                                     1 hop
//   Joe -WORKS_FOR-> Company A <-PART_OF- Copilot program <-PART_OF- Copilot rollout   3 hops
//   Joe -ATTENDED-> Kickoff -PART_OF-> Copilot program <-PART_OF- Copilot rollout      3 hops
//
// What it proves: the shortest path is found, ranking follows evidence, at
// most k DISTINCT paths come back, "no connection" is an empty list and not an
// error, `as_of` / `types` / `relationTypes` are honoured, another owner's id
// is a 404, an item is only ever an endpoint, a sensitive PersonFact is never
// reachable, a 5,000-edge hub completes (and a forced 1 ms budget is a 503
// `graph_query_timeout`), and the p95 on the 20k-entity perf fixture.
// =============================================================================

import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import {
  GraphAccessService,
  GraphNeighborhoodService,
  GraphOntologyService,
  GraphPathsService,
  GraphPreferencesService,
} from '@marinoscar/kvox-api/graph';
import { graphPathsResponseSchema, type GraphPathsResponse } from '@marinoscar/kvox-contract/graph';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import {
  GraphFixture,
  bulkRandomGraph,
  bulkStar,
  cleanupGraphFixtures,
  connectTestPrisma,
  createUser,
} from './graph-read.fixtures';
import { createDbSettings } from '../helpers/graph-ports.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('graph-paths.db.spec');

const EMAIL_PREFIX = 'graph-paths-test';

describeWithDb('GraphPathsService (real Postgres)', () => {
  let prisma: PrismaClient;
  let svc: GraphPathsService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const asService = prisma as unknown as PrismaService;
    const ontology = new GraphOntologyService(asService, new GraphPreferencesService(createDbSettings(prisma)));
    const neighborhood = new GraphNeighborhoodService(asService, new GraphAccessService(asService), ontology);
    svc = new GraphPathsService(asService, ontology, neighborhood);
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

  /** A bulk-loaded fixture has no statistics yet; autovacuum would catch up in production. */
  const analyze = async (): Promise<void> => {
    for (const t of ['kg_entities', 'kg_relations', 'kg_evidence', 'kg_mentions', 'kg_items']) {
      await prisma.$executeRawUnsafe(`ANALYZE ${t}`);
    }
  };

  const find = async (
    userId: string,
    from: string,
    to: string,
    q: Record<string, unknown> = {},
    options?: { timeoutMs?: number },
  ): Promise<GraphPathsResponse> => {
    const res = await svc.paths({ id: userId }, { from, to, k: 3, maxHops: 4, ...q } as never, options);
    // Whatever the service returns is the wire shape.
    expect(graphPathsResponseSchema.safeParse(JSON.parse(JSON.stringify(res))).success).toBe(true);
    return res;
  };

  /** The reference scenario; every relation carries one evidence row (the fixture's). */
  async function scenario(g: GraphFixture, worksForValid = '[2020-01-01,)') {
    const joe = await g.entity('Person', 'Joe');
    const rollout = await g.entity('Meeting', 'Copilot rollout');
    const kickoff = await g.entity('Meeting', 'Kickoff');
    const program = await g.entity('Project', 'Copilot program');
    const companyA = await g.entity('Organization', 'Company A');
    const direct = await g.relation('ATTENDED', joe, rollout);
    const worksFor = await g.relation('WORKS_FOR', joe, companyA, { valid: worksForValid, precision: 'year' });
    const programOf = await g.relation('PART_OF', program, companyA);
    const rolloutOf = await g.relation('PART_OF', rollout, program);
    const attendedKickoff = await g.relation('ATTENDED', joe, kickoff);
    const kickoffOf = await g.relation('PART_OF', kickoff, program);
    return { joe, rollout, kickoff, program, companyA, direct, worksFor, programOf, rolloutOf, attendedKickoff, kickoffOf };
  }

  // ---------------------------------------------------------------------------
  // The reference scenario
  // ---------------------------------------------------------------------------

  it('finds the 1-hop path first and the 3-hop paths after it, as distinct node sets', async () => {
    const { user, g } = await owner();
    const s = await scenario(g);

    const res = await find(user.id, s.joe, s.rollout, { k: 5 });
    expect(res.from).toBe(s.joe);
    expect(res.to).toBe(s.rollout);
    expect(res.asOf).toBeNull();
    expect(res.truncated).toBe(false);

    // Equal evidence everywhere: ties break on fewer hops.
    expect(res.paths.map((p) => p.hops)).toEqual([1, 3, 3]);
    expect(res.paths[0]).toMatchObject({ nodeIds: [s.joe, s.rollout], edgeIds: [s.direct] });
    const three = res.paths.slice(1).map((p) => p.nodeIds.join('>'));
    expect(three).toContain([s.joe, s.companyA, s.program, s.rollout].join('>'));
    expect(three).toContain([s.joe, s.kickoff, s.program, s.rollout].join('>'));
    const viaCompany = res.paths.find((p) => p.nodeIds.includes(s.companyA))!;
    expect(viaCompany.edgeIds).toEqual([s.worksFor, s.programOf, s.rolloutOf]);

    // Distinct node sets, every path starts at from and ends at to.
    expect(new Set(res.paths.map((p) => [...p.nodeIds].sort().join('|'))).size).toBe(res.paths.length);
    for (const p of res.paths) {
      expect(p.nodeIds[0]).toBe(s.joe);
      expect(p.nodeIds[p.nodeIds.length - 1]).toBe(s.rollout);
      expect(p.edgeIds).toHaveLength(p.hops);
      expect(p.nodeIds).toHaveLength(p.hops + 1);
    }
  });

  it('returns the union of the paths as the slice, with true edge directions and evidence', async () => {
    const { user, g } = await owner();
    const s = await scenario(g);

    const res = await find(user.id, s.joe, s.rollout, { k: 5 });
    const nodeIds = res.slice.nodes.map((n) => n.id).sort();
    expect(nodeIds).toEqual([s.joe, s.rollout, s.kickoff, s.program, s.companyA].sort());
    expect(res.slice.seedIds).toEqual([s.joe, s.rollout]);
    expect(res.slice.nodes.find((n) => n.id === s.joe)).toMatchObject({ depth: 0, label: 'Joe', nodeKind: 'entity' });
    expect(res.slice.nodes.find((n) => n.id === s.program)?.depth).toBe(1);

    const edgeIds = res.slice.edges.map((e) => e.id).sort();
    expect(edgeIds).toEqual([s.direct, s.worksFor, s.programOf, s.rolloutOf, s.attendedKickoff, s.kickoffOf].sort());
    // Directed relations keep their stored direction even where the path walked them backwards.
    const programOf = res.slice.edges.find((e) => e.id === s.programOf)!;
    expect(programOf).toMatchObject({ type: 'PART_OF', source: s.program, target: s.companyA });
    const rolloutOf = res.slice.edges.find((e) => e.id === s.rolloutOf)!;
    expect(rolloutOf).toMatchObject({ source: s.rollout, target: s.program });
    expect(res.slice.edges.every((e) => e.evidenceCount === 1)).toBe(true);
    // Every path edge is in the slice and every slice edge joins two slice nodes.
    const have = new Set(nodeIds);
    expect(res.slice.edges.every((e) => have.has(e.source) && have.has(e.target))).toBe(true);
    for (const p of res.paths) for (const id of p.edgeIds) expect(edgeIds).toContain(id);
  });

  it('ranks by evidence: a richly evidenced 3-hop route beats the bare direct edge', async () => {
    const { user, g } = await owner();
    const s = await scenario(g);
    // Company A route: 5 extra evidence rows on each of its edges.
    for (const id of [s.worksFor, s.programOf, s.rolloutOf]) {
      for (let i = 0; i < 5; i++) await g.evidence('relation', id);
    }

    const res = await find(user.id, s.joe, s.rollout, { k: 5 });
    expect(res.paths[0].nodeIds).toEqual([s.joe, s.companyA, s.program, s.rollout]);
    expect(res.paths[0].score).toBeCloseTo(Math.log(7), 3);
    expect(res.paths[0].score).toBeGreaterThan(res.paths[1].score);
    const scores = res.paths.map((p) => p.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(res.slice.edges.find((e) => e.id === s.worksFor)?.evidenceCount).toBe(6);
  });

  it('returns at most k paths, and a single path for k=1', async () => {
    const { user, g } = await owner();
    const s = await scenario(g);
    expect((await find(user.id, s.joe, s.rollout, { k: 1 })).paths).toHaveLength(1);
    expect((await find(user.id, s.joe, s.rollout, { k: 2 })).paths).toHaveLength(2);
    expect((await find(user.id, s.joe, s.rollout, { k: 5 })).paths.length).toBeLessThanOrEqual(5);
  });

  it('counts parallel edges between the same two nodes as one path', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const meeting = await g.entity('Meeting', 'Sync');
    const a = await g.relation('ATTENDED', joe, meeting);
    const b = await g.relation('ATTENDED', joe, meeting);
    await g.evidence('relation', b);

    const res = await find(user.id, joe, meeting, { k: 5 });
    expect(res.paths).toHaveLength(1);
    // The better-evidenced of the two is the one the path uses.
    expect(res.paths[0].edgeIds).toEqual([b]);
    expect([a, b]).toContain(res.paths[0].edgeIds[0]);
  });

  it('answers a symmetric relation from either end, in its stored direction', async () => {
    const { user, g } = await owner();
    const ana = await g.entity('Person', 'Ana');
    const ben = await g.entity('Person', 'Ben');
    const friends = await g.relation('FRIEND_OF', ana, ben);

    for (const [from, to] of [
      [ana, ben],
      [ben, ana],
    ]) {
      const res = await find(user.id, from, to);
      expect(res.paths).toHaveLength(1);
      expect(res.paths[0].hops).toBe(1);
      expect(res.slice.edges).toHaveLength(1);
      expect(res.slice.edges[0]).toMatchObject({ id: friends, source: ana, target: ben });
    }
  });

  // ---------------------------------------------------------------------------
  // No connection, bounds
  // ---------------------------------------------------------------------------

  it('returns an empty list, not an error, when nothing connects the two', async () => {
    const { user, g } = await owner();
    const s = await scenario(g);
    const stranger = await g.entity('Person', 'Stranger');

    const res = await find(user.id, s.joe, stranger);
    expect(res.paths).toEqual([]);
    expect(res.truncated).toBe(false);
    // The endpoints are still in the slice, so the UI can name them.
    expect(res.slice.nodes.map((n) => n.id).sort()).toEqual([s.joe, stranger].sort());
    expect(res.slice.edges).toEqual([]);
  });

  it('honours maxHops: the 3-hop routes need maxHops >= 3', async () => {
    const { user, g } = await owner();
    const s = await scenario(g);
    expect((await find(user.id, s.joe, s.rollout, { k: 5, maxHops: 1 })).paths.map((p) => p.hops)).toEqual([1]);
    expect((await find(user.id, s.joe, s.rollout, { k: 5, maxHops: 2 })).paths.map((p) => p.hops)).toEqual([1]);
    expect((await find(user.id, s.joe, s.rollout, { k: 5, maxHops: 3 })).paths.map((p) => p.hops)).toEqual([1, 3, 3]);
    // A path of 5 edges is found with maxHops=5 and not with 4.
    const chain: string[] = [];
    for (let i = 0; i < 6; i++) chain.push(await g.entity('Person', `Chain ${i}`));
    for (let i = 0; i < 5; i++) await g.relation('FRIEND_OF', chain[i], chain[i + 1]);
    expect((await find(user.id, chain[0], chain[5], { maxHops: 4 })).paths).toEqual([]);
    const five = await find(user.id, chain[0], chain[5], { maxHops: 5 });
    expect(five.paths).toHaveLength(1);
    expect(five.paths[0].nodeIds).toEqual(chain);
  });

  it('terminates on a cycle and never repeats a node', async () => {
    const { user, g } = await owner();
    const [a, b, c, d] = [
      await g.entity('Person', 'A'),
      await g.entity('Person', 'B'),
      await g.entity('Person', 'C'),
      await g.entity('Person', 'D'),
    ];
    await g.relation('FRIEND_OF', a, b);
    await g.relation('FRIEND_OF', b, c);
    await g.relation('FRIEND_OF', c, a);
    await g.relation('FRIEND_OF', c, d);
    const res = await find(user.id, a, d, { k: 5, maxHops: 5 });
    for (const p of res.paths) expect(new Set(p.nodeIds).size).toBe(p.nodeIds.length);
    expect(res.paths.map((p) => p.nodeIds.join('>'))).toEqual([[a, c, d].join('>'), [a, b, c, d].join('>')]);
  });

  // ---------------------------------------------------------------------------
  // as_of, types, relationTypes
  // ---------------------------------------------------------------------------

  it('honours as_of: a closed WORKS_FOR range is a path in 2021 and none in 2023 or now', async () => {
    const { user, g } = await owner();
    const s = await scenario(g, '[2020-01-01,2022-01-01)');

    const now = await find(user.id, s.joe, s.rollout, { k: 5 });
    expect(now.paths.some((p) => p.nodeIds.includes(s.companyA))).toBe(false);

    const during = await find(user.id, s.joe, s.rollout, { k: 5, as_of: '2021-06-01' });
    expect(during.paths.some((p) => p.nodeIds.includes(s.companyA))).toBe(true);
    expect(during.asOf).toBe('2021-06-01T00:00:00.000Z');
    expect(during.slice.asOf).toBe('2021-06-01T00:00:00.000Z');

    const after = await find(user.id, s.joe, s.rollout, { k: 5, as_of: '2023-06-01' });
    expect(after.paths.some((p) => p.nodeIds.includes(s.companyA))).toBe(false);
    expect(after.paths).toHaveLength(2);

    // The range is half-open: the instant it ends is already outside it.
    const boundary = await find(user.id, s.joe, s.rollout, { k: 5, as_of: '2022-01-01' });
    expect(boundary.paths.some((p) => p.nodeIds.includes(s.companyA))).toBe(false);
  });

  it('does not find a superseded or unreviewed relation now', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const meeting = await g.entity('Meeting', 'Sync');
    await g.relation('ATTENDED', joe, meeting, { reviewStatus: 'unreviewed' });
    await g.relation('ATTENDED', joe, meeting, { reviewStatus: 'rejected' });
    expect((await find(user.id, joe, meeting)).paths).toEqual([]);
  });

  it('honours types: excluding Organization removes the route through Company A', async () => {
    const { user, g } = await owner();
    const s = await scenario(g);
    const res = await find(user.id, s.joe, s.rollout, { k: 5, types: 'Person,Meeting,Project' });
    expect(res.paths.map((p) => p.nodeIds.join('>')).sort()).toEqual(
      [[s.joe, s.rollout].join('>'), [s.joe, s.kickoff, s.program, s.rollout].join('>')].sort(),
    );
    // The endpoints are kept even when their own type is not listed.
    const only = await find(user.id, s.joe, s.rollout, { k: 5, types: 'Organization' });
    expect(only.paths.map((p) => p.hops)).toEqual([1]);
  });

  it('honours relationTypes', async () => {
    const { user, g } = await owner();
    const s = await scenario(g);
    const attended = await find(user.id, s.joe, s.rollout, { k: 5, relationTypes: 'ATTENDED' });
    expect(attended.paths).toHaveLength(1);
    expect(attended.paths[0].edgeIds).toEqual([s.direct]);

    const viaCompany = await find(user.id, s.joe, s.rollout, { k: 5, relationTypes: 'WORKS_FOR,PART_OF' });
    expect(viaCompany.paths).toHaveLength(1);
    expect(viaCompany.paths[0].nodeIds).toEqual([s.joe, s.companyA, s.program, s.rollout]);

    await expect(find(user.id, s.joe, s.rollout, { relationTypes: 'NOT_A_RELATION' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(find(user.id, s.joe, s.rollout, { types: 'Spaceship' })).rejects.toBeInstanceOf(BadRequestException);
  });

  // ---------------------------------------------------------------------------
  // Isolation, items, sensitive facts
  // ---------------------------------------------------------------------------

  it("answers another owner's node on either end with the same 404, and an unknown id too", async () => {
    const { user, g } = await owner('a');
    const { g: other } = await owner('b');
    const mine = await g.entity('Person', 'Mine');
    const mine2 = await g.entity('Person', 'Mine 2');
    await g.relation('FRIEND_OF', mine, mine2);
    const theirs = await other.entity('Person', 'Theirs');
    const missing = '00000000-0000-4000-8000-000000000001';

    const errors: unknown[] = [];
    for (const [from, to] of [
      [mine, theirs],
      [theirs, mine],
      [mine, missing],
      [missing, theirs],
    ]) {
      errors.push(await find(user.id, from, to).catch((e: unknown) => e));
    }
    for (const err of errors) expect(err).toBeInstanceOf(NotFoundException);
    expect(new Set(errors.map((e) => (e as Error).message)).size).toBe(1);
    // Its own graph still answers.
    expect((await find(user.id, mine, mine2)).paths).toHaveLength(1);
  });

  it('does not use another owner’s edges even between two of my nodes', async () => {
    const { user, g } = await owner('a');
    const { g: other } = await owner('b');
    const a = await g.entity('Person', 'A');
    const b = await g.entity('Person', 'B');
    // A foreign row that names my entities (it cannot exist through the app; the query must still ignore it).
    await prisma.$transaction(async (tx) => {
      const foreign = await tx.kgRelation.create({
        data: { ownerId: other.ownerId, type: 'FRIEND_OF', fromId: a, toId: b, reviewStatus: 'accepted', ontologyVersion: '1.0.0' },
      });
      await tx.kgEvidence.create({ data: { ownerId: other.ownerId, subjectKind: 'relation', subjectId: foreign.id, quote: 'x' } });
    });
    expect((await find(user.id, a, b)).paths).toEqual([]);
  });

  it('treats an item as an endpoint only: never a stop on the way', async () => {
    const { user, g } = await owner();
    const sarah = await g.entity('Person', 'Sarah');
    const joe = await g.entity('Person', 'Joe');
    const commitment = await g.item('commitment', { ownerPersonId: sarah, counterpartyId: joe, statement: 'Sarah will send the deck to Joe' });

    // Joe - commitment - Sarah is NOT a path from Joe to Sarah.
    expect((await find(user.id, joe, sarah)).paths).toEqual([]);

    // As an endpoint it is: the item to the person it names, with the derived edge in its true direction.
    const res = await find(user.id, commitment, sarah);
    expect(res.paths).toHaveLength(1);
    expect(res.paths[0]).toMatchObject({ nodeIds: [commitment, sarah], hops: 1 });
    expect(res.slice.edges[0]).toMatchObject({ virtual: true, type: 'ASSIGNED_TO', source: commitment, target: sarah });
    expect(res.slice.nodes.find((n) => n.id === commitment)).toMatchObject({ nodeKind: 'item', depth: 0 });

    // And an entity reaches an item endpoint from the other side.
    const back = await find(user.id, joe, commitment);
    expect(back.paths).toHaveLength(1);
    expect(back.paths[0].nodeIds).toEqual([joe, commitment]);

    // Two hops: the item, through the person it names, to someone that person knows.
    const ben = await g.entity('Person', 'Ben');
    await g.relation('FRIEND_OF', sarah, ben);
    const two = await find(user.id, commitment, ben);
    expect(two.paths[0].nodeIds).toEqual([commitment, sarah, ben]);
  });

  it('never reaches or returns a sensitive PersonFact', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const ana = await g.entity('Person', 'Ana');
    await g.relation('FRIEND_OF', joe, ana);
    const secret = await g.item('person_fact', { subjectId: joe, sensitivity: 'sensitive', statement: 'Joe has a health condition' });
    const ordinary = await g.item('person_fact', { subjectId: joe, sensitivity: 'personal', statement: 'Joe likes tea' });

    // As an endpoint: the same 404 as a node that does not exist.
    await expect(find(user.id, joe, secret)).rejects.toBeInstanceOf(NotFoundException);
    await expect(find(user.id, secret, ana)).rejects.toBeInstanceOf(NotFoundException);
    // A non-sensitive fact is an ordinary item endpoint.
    expect((await find(user.id, ordinary, joe)).paths).toHaveLength(1);

    // And it is on no slice.
    for (const to of [ana, ordinary]) {
      const res = await find(user.id, joe, to, { k: 5, maxHops: 5 });
      expect(JSON.stringify(res)).not.toContain(secret);
    }
  });

  // ---------------------------------------------------------------------------
  // Hubs and the timeout
  // ---------------------------------------------------------------------------

  it('completes through a 5,000-degree hub within the budget, marks a capped search truncated, and penalises the hub', async () => {
    const { user, g } = await owner();
    const hub = await g.entity('Organization', 'Mega Corp');
    await bulkStar(prisma, user.id, hub, 5000);
    await analyze();
    const ana = await g.entity('Person', 'Ana');
    const ben = await g.entity('Person', 'Ben');
    const quiet = await g.entity('Meeting', 'Quiet meeting');
    await g.relation('DISCUSSED', ana, hub);
    await g.relation('DISCUSSED', ben, hub);
    const a1 = await g.relation('ATTENDED', ana, quiet);
    const a2 = await g.relation('ATTENDED', ben, quiet);

    // Two hops need no hub expansion at all: both routes are found, and nothing was capped.
    const two = await find(user.id, ana, ben, { k: 5, maxHops: 2 });
    expect(two.truncated).toBe(false);
    expect(two.paths).toHaveLength(2);
    // Equal evidence and length: the route through the quiet meeting outranks the one through the 5,000-edge hub.
    expect(two.paths[0].nodeIds).toEqual([ana, quiet, ben]);
    expect(two.paths[0].edgeIds).toEqual([a1, a2]);
    expect(two.paths[1].nodeIds).toEqual([ana, hub, ben]);
    expect(two.paths[0].score).toBeGreaterThan(two.paths[1].score);

    // Four hops expand the hub: the per-hop cap bites, the answer says so, and it is still correct and fast.
    const t0 = performance.now();
    const four = await find(user.id, ana, ben, { k: 5, maxHops: 4 });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000);
    expect(four.truncated).toBe(true);
    expect(four.paths[0].nodeIds).toEqual([ana, quiet, ben]);
    expect(four.paths.length).toBeGreaterThanOrEqual(2);
    // eslint-disable-next-line no-console
    console.log(`[graph-paths hub] 5,000-degree hub, maxHops=4: ${ms.toFixed(0)}ms truncated=${four.truncated}`);
  }, 120_000);

  it('turns an exceeded statement budget into a 503 graph_query_timeout', async () => {
    const { user, g } = await owner();
    const hub = await g.entity('Organization', 'Mega Corp');
    await bulkStar(prisma, user.id, hub, 5000);
    await analyze();
    const ana = await g.entity('Person', 'Ana');
    const ben = await g.entity('Person', 'Ben');
    await g.relation('DISCUSSED', ana, hub);
    await g.relation('DISCUSSED', ben, hub);

    const err = await find(user.id, ana, ben, { maxHops: 4 }, { timeoutMs: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ details: { reason: 'graph_query_timeout' } });
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Performance
  // ---------------------------------------------------------------------------

  it('answers k=3, maxHops=4 on a 20k-entity / 80k-relation owner with a p95 under 800 ms', async () => {
    const { user } = await owner('perf');
    const seed = await bulkRandomGraph(prisma, user.id, 20_000, 4);
    await analyze();

    // Targets at a KNOWN undirected distance from the seed (2, 3, 4 and 5 hops), so the
    // measurement is a real search that finds paths, not a miss.
    const seen = new Set<string>([seed]);
    let level = [seed];
    const byDistance = new Map<number, string[]>();
    for (let d = 1; d <= 5; d++) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT x.id::text AS id FROM (
          SELECT to_id AS id FROM kg_relations WHERE owner_id = ${user.id}::uuid AND from_id = ANY(${level}::uuid[])
          UNION ALL
          SELECT from_id FROM kg_relations WHERE owner_id = ${user.id}::uuid AND to_id = ANY(${level}::uuid[])
        ) x`;
      level = rows.map((r) => r.id).filter((id) => !seen.has(id));
      for (const id of level) seen.add(id);
      byDistance.set(d, level.sort());
    }
    const pick = (d: number, n: number): string[] => {
      const ids = byDistance.get(d) ?? [];
      return Array.from({ length: n }, (_, i) => ids[Math.floor((i * ids.length) / n)]);
    };
    const targets = [...pick(2, 3), ...pick(3, 3), ...pick(4, 4)].map((id) => ({ id }));
    expect(targets.every((t) => t.id)).toBe(true);

    const timings: number[] = [];
    let connected = 0;
    for (let round = 0; round < 3; round++) {
      for (const t of targets) {
        const t0 = performance.now();
        const res = await find(user.id, seed, t.id, { k: 3, maxHops: 4 });
        timings.push(performance.now() - t0);
        if (res.paths.length > 0) connected++;
      }
    }
    timings.sort((x, y) => x - y);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
    // eslint-disable-next-line no-console
    console.log(
      `[graph-paths perf] k=3 maxHops=4 over ${timings.length} queries (${connected} connected): ` +
        `p50=${timings[Math.floor(timings.length / 2)].toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${timings[timings.length - 1].toFixed(1)}ms`,
    );
    expect(connected).toBe(timings.length);
    // GIC-12: p95 under 800 ms on the 20k-entity fixture.
    expect(p95).toBeLessThan(800);

    // The hardest shape: maxHops=5.
    const t0 = performance.now();
    await find(user.id, seed, pick(5, 1)[0], { k: 5, maxHops: 5 });
    // eslint-disable-next-line no-console
    console.log(`[graph-paths perf] k=5 maxHops=5: ${(performance.now() - t0).toFixed(1)}ms`);
  }, 240_000);
});
