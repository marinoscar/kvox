// =============================================================================
// Real-Postgres test: the bounded neighbourhood walk and explorer expand (#370)
// =============================================================================
//
// A recursive CTE, `tstzrange` containment and the lazily-evaluated row bound
// are only real against Postgres. Excluded from `npm test`; run by
// `npm run test:db` (CI's Smoke job).
//
// What it proves:
//   - 1 vs 2 hops; a cycle A→B→C→A terminates with each node once;
//   - a 1,000-edge hub truncates to the cap with `truncated: true`, and a
//     neighbourhood that fits reports `truncated: false`;
//   - an item is a leaf: hop 2 never continues through it;
//   - derived (item-column) edges appear once, typed from the registry;
//   - `types` / `relationTypes` filters, unknown keys → 400;
//   - §5.4's worked examples under `as_of` (manager change, promotion);
//   - the SQL as-of predicates agree with #353's `isValidAt()` on a fixture
//     table of ranges and instants (inclusive lower, exclusive upper, infinite
//     bounds, `unknown` rows with `valid IS NULL`);
//   - `sensitive` person facts are never in a slice; expand is all-or-nothing
//     404; another owner's entity is a 404;
//   - the perf fixture: a 2-hop, cap-300 walk on a 10k-entity / 40k-relation
//     owner (p95 logged, asserted < 500 ms — the epic #347 success criterion,
//     measured against CI Postgres rather than a looser CI-flake margin).
// =============================================================================

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { GraphAccessService } from '../../src/graph/access/graph-access.service';
import { GraphOntologyService } from '../../src/graph/ontology/graph-ontology.service';
import { itemValidAt, itemValidAtSql, relationValidAtSql } from '../../src/graph/read/as-of';
import type { GraphSlice } from '../../src/graph/read/dto/graph-read.dto';
import { GraphNeighborhoodService } from '../../src/graph/read/graph-neighborhood.service';
import { fromPgRange, isValidAt } from '../../src/graph/temporal';
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

const { describeWithDb, dbReachable } = resolveDbSuite('graph-neighborhood.db.spec');

const EMAIL_PREFIX = 'graph-nbhd-test';

const ids = (slice: GraphSlice) => slice.nodes.map((n) => n.id).sort();
const depthOf = (slice: GraphSlice, id: string) => slice.nodes.find((n) => n.id === id)?.depth;

describeWithDb('GraphNeighborhoodService (real Postgres)', () => {
  let prisma: PrismaClient;
  let svc: GraphNeighborhoodService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const asService = prisma as unknown as PrismaService;
    svc = new GraphNeighborhoodService(asService, new GraphAccessService(asService), new GraphOntologyService(asService));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // `cleanupGraphFixtures` disables triggers for the delete (see its own header), so the
  // perf fixture's ~50k rows no longer pay a per-row deferred-trigger lookup on teardown;
  // this timeout stays generous only for a slow CI runner, not for that cost.
  afterEach(async () => {
    if (!dbReachable) return;
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function owner(suffix = 'a') {
    const user = await createUser(prisma, EMAIL_PREFIX, suffix);
    return { user, g: new GraphFixture(prisma, user.id) };
  }

  const nbhd = (userId: string, id: string, q: Partial<Parameters<GraphNeighborhoodService['neighborhood']>[2]> = {}) =>
    svc.neighborhood({ id: userId }, id, { hops: 1, limit: 150, ...q } as never);

  // ---------------------------------------------------------------------------
  // Hops, cycles, truncation
  // ---------------------------------------------------------------------------

  it('walks one hop, then two', async () => {
    const { user, g } = await owner();
    const a = await g.entity('Person', 'Ana');
    const b = await g.entity('Person', 'Ben');
    const acme = await g.entity('Organization', 'Acme');
    await g.relation('WORKS_FOR', a, acme, { valid: '[2019-01-01,)', precision: 'year' });
    await g.relation('WORKS_FOR', b, acme, { valid: '[2020-01-01,)', precision: 'year' });

    const one = await nbhd(user.id, a, { hops: 1 });
    expect(ids(one)).toEqual([a, acme].sort());
    expect(depthOf(one, a)).toBe(0);
    expect(depthOf(one, acme)).toBe(1);
    expect(one.edges).toHaveLength(1);
    expect(one.edges[0]).toMatchObject({ type: 'WORKS_FOR', source: a, target: acme, virtual: false });
    expect(one.edges[0].valid).toEqual({ from: '2019-01-01T00:00:00.000Z', to: null, precision: 'year' });
    expect(one.truncated).toBe(false);
    expect(one.seedIds).toEqual([a]);

    const two = await nbhd(user.id, a, { hops: 2 });
    expect(ids(two)).toEqual([a, acme, b].sort());
    expect(depthOf(two, b)).toBe(2);
    // Degree counts readable edges in the WHOLE graph.
    expect(two.nodes.find((n) => n.id === acme)?.degree).toBe(2);
  });

  it('terminates on a cycle A→B→C→A with every node once', async () => {
    const { user, g } = await owner();
    const a = await g.entity('Person', 'A');
    const b = await g.entity('Person', 'B');
    const c = await g.entity('Person', 'C');
    await g.relation('REPORTS_TO', a, b, { valid: '[2020-01-01,)', precision: 'day' });
    await g.relation('REPORTS_TO', b, c, { valid: '[2020-01-01,)', precision: 'day' });
    await g.relation('REPORTS_TO', c, a, { valid: '[2020-01-01,)', precision: 'day' });

    const slice = await nbhd(user.id, a, { hops: 2 });
    expect(slice.nodes).toHaveLength(3);
    expect(new Set(slice.nodes.map((n) => n.id)).size).toBe(3);
    expect(depthOf(slice, a)).toBe(0);
    expect(depthOf(slice, b)).toBe(1);
    expect(depthOf(slice, c)).toBe(1);
    expect(slice.edges).toHaveLength(3);
  });

  it('truncates a 1,000-edge hub to the cap, and says so', async () => {
    const { user, g } = await owner();
    const hub = await g.entity('Organization', 'Hub');
    await bulkStar(prisma, user.id, hub, 1000);

    const capped = await nbhd(user.id, hub, { hops: 2, limit: 300 });
    expect(capped.nodes).toHaveLength(300);
    expect(capped.truncated).toBe(true);
    expect(capped.cap).toBe(300);
    expect(capped.nodes[0].id).toBe(hub);
    // Every returned edge joins two returned nodes.
    const kept = new Set(capped.nodes.map((n) => n.id));
    expect(capped.edges.every((e) => kept.has(e.source) && kept.has(e.target))).toBe(true);

    const small = await nbhd(user.id, hub, { limit: 50 });
    expect(small.nodes).toHaveLength(50);
    expect(small.truncated).toBe(true);
  });

  it('reports truncated exactly when more nodes existed than the limit', async () => {
    const { user, g } = await owner();
    const hub = await g.entity('Organization', 'Hub');
    for (let i = 0; i < 4; i++) {
      await g.relation('DISCUSSED', await g.entity('Person', `P${i}`), hub);
    }
    const fits = await nbhd(user.id, hub, { limit: 5 });
    expect(fits.nodes).toHaveLength(5);
    expect(fits.truncated).toBe(false);

    const over = await nbhd(user.id, hub, { limit: 4 });
    expect(over.nodes).toHaveLength(4);
    expect(over.truncated).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Items and derived edges
  // ---------------------------------------------------------------------------

  it('never walks through an item, and derives item edges once from the registry', async () => {
    const { user, g } = await owner();
    const sarah = await g.entity('Person', 'Sarah');
    const joe = await g.entity('Person', 'Joe');
    const meeting = await g.entity('Meeting', 'Kickoff', { occurredAt: new Date('2026-03-02T00:00:00Z') });
    const commitment = await g.item('commitment', {
      ownerPersonId: sarah,
      counterpartyId: joe,
      meetingId: meeting,
      statement: 'Sarah will send the deck to Joe',
      occurredAt: new Date('2026-03-02T00:00:00Z'),
    });

    const slice = await nbhd(user.id, sarah, { hops: 2 });
    // Sarah → the commitment (depth 1). Joe and the meeting are only reachable
    // THROUGH the commitment, which hop 2 never does.
    expect(ids(slice)).toEqual([sarah, commitment].sort());
    const item = slice.nodes.find((n) => n.id === commitment)!;
    expect(item).toMatchObject({ nodeKind: 'item', type: 'commitment', status: 'open', label: 'Sarah will send the deck to Joe' });
    expect(slice.edges).toEqual([
      expect.objectContaining({
        id: `virt:${commitment}:ASSIGNED_TO`,
        type: 'ASSIGNED_TO',
        source: commitment,
        target: sarah,
        virtual: true,
        valid: null,
      }),
    ]);

    // Expanding FROM the item reaches all three of its column targets — and a
    // commitment's meeting is CREATED_IN, never DECIDED_IN.
    const expanded = await svc.expand({ id: user.id }, { nodeIds: [commitment], cap: 100 } as never);
    expect(ids(expanded)).toEqual([commitment, sarah, joe, meeting].sort());
    expect(expanded.edges.map((e) => e.id).sort()).toEqual(
      [`virt:${commitment}:ASSIGNED_TO`, `virt:${commitment}:CREATED_IN`, `virt:${commitment}:OWED_TO`].sort(),
    );
    expect(new Set(expanded.edges.map((e) => e.id)).size).toBe(expanded.edges.length);
  });

  it('never puts a sensitive person fact in a slice', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const personal = await g.item('person_fact', { subjectId: joe, sensitivity: 'personal', statement: 'Plays chess' });
    const sensitive = await g.item('person_fact', { subjectId: joe, sensitivity: 'sensitive', statement: 'Private matter' });

    const slice = await nbhd(user.id, joe);
    expect(ids(slice)).toEqual([joe, personal].sort());
    expect(slice.nodes.find((n) => n.id === joe)?.degree).toBe(1);

    await expect(svc.expand({ id: user.id }, { nodeIds: [sensitive], cap: 10 } as never)).rejects.toThrow(NotFoundException);
  });

  it('excludes unreviewed, rejected and merged entities from the walk', async () => {
    const { user, g } = await owner();
    const a = await g.entity('Person', 'A');
    const live = await g.entity('Organization', 'Live');
    const unreviewed = await g.entity('Organization', 'Draft', { reviewStatus: 'unreviewed' });
    const merged = await g.entity('Organization', 'Old', { reviewStatus: 'merged', mergedIntoId: live });
    await g.relation('DISCUSSED', a, live);
    await g.relation('DISCUSSED', a, unreviewed);
    await g.relation('DISCUSSED', a, merged);
    await g.relation('DISCUSSED', a, live, { reviewStatus: 'rejected' });

    const slice = await nbhd(user.id, a);
    expect(ids(slice)).toEqual([a, live].sort());
    expect(slice.edges).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------

  it('filters by relation type and by node type, keeping the seed', async () => {
    const { user, g } = await owner();
    const a = await g.entity('Person', 'A');
    const acme = await g.entity('Organization', 'Acme');
    const jane = await g.entity('Person', 'Jane');
    await g.relation('WORKS_FOR', a, acme, { valid: '[2019-01-01,)', precision: 'year' });
    await g.relation('REPORTS_TO', a, jane, { valid: '[2019-01-01,)', precision: 'year' });

    expect(ids(await nbhd(user.id, a, { relationTypes: 'WORKS_FOR' }))).toEqual([a, acme].sort());
    expect(ids(await nbhd(user.id, a, { types: 'Organization' }))).toEqual([a, acme].sort());
    expect(ids(await nbhd(user.id, a, { types: 'Person' }))).toEqual([a, jane].sort());

    await expect(nbhd(user.id, a, { types: 'Spaceship' })).rejects.toThrow(BadRequestException);
    await expect(nbhd(user.id, a, { relationTypes: 'LOVES' })).rejects.toThrow(BadRequestException);
  });

  // ---------------------------------------------------------------------------
  // as_of — docs/specs/ontology.md §5.4's worked examples
  // ---------------------------------------------------------------------------

  it('as_of reads the manager valid then, not the one valid now', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const jane = await g.entity('Person', 'Jane');
    const will = await g.entity('Person', 'Will');
    // The closing rule marks the replaced edge `superseded` and closes its range.
    const toJane = await g.relation('REPORTS_TO', joe, jane, {
      valid: '[2020-01-01,2026-03-01)',
      precision: 'day',
      reviewStatus: 'superseded',
    });
    const toWill = await g.relation('REPORTS_TO', joe, will, { valid: '[2026-03-01,)', precision: 'day' });

    const then = await nbhd(user.id, joe, { as_of: '2024-01-15' });
    expect(ids(then)).toEqual([joe, jane].sort());
    expect(then.edges.map((e) => e.id)).toEqual([toJane]);
    expect(then.asOf).toBe('2024-01-15T00:00:00.000Z');

    const now = await nbhd(user.id, joe, { as_of: '2026-09-01T12:00:00Z' });
    expect(ids(now)).toEqual([joe, will].sort());
    expect(now.edges.map((e) => e.id)).toEqual([toWill]);

    // The exclusive upper bound: on the day of the change, Will — not Jane.
    const onTheDay = await nbhd(user.id, joe, { as_of: '2026-03-01' });
    expect(onTheDay.edges.map((e) => e.id)).toEqual([toWill]);

    await expect(nbhd(user.id, joe, { as_of: '2024-02-30' })).rejects.toThrow(BadRequestException);
  });

  it('as_of reads the role held then (promotion)', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const acme = await g.entity('Organization', 'Acme');
    const engineer = await g.relation('HAS_ROLE', joe, acme, {
      valid: '[2019-01-01,2026-03-01)',
      precision: 'year',
      reviewStatus: 'superseded',
    });
    const staff = await g.relation('HAS_ROLE', joe, acme, { valid: '[2026-03-01,)', precision: 'month' });
    const unknown = await g.relation('WORKS_FOR', joe, acme, { valid: null, precision: 'unknown' });

    const then = await nbhd(user.id, joe, { as_of: '2022-06-01' });
    expect(then.edges.map((e) => e.id).sort()).toEqual([engineer, unknown].sort());
    const later = await nbhd(user.id, joe, { as_of: '2026-04-01' });
    expect(later.edges.map((e) => e.id).sort()).toEqual([staff, unknown].sort());
    // An `unknown` edge is valid at every instant and says so.
    expect(later.edges.find((e) => e.id === unknown)?.valid).toEqual({ from: null, to: null, precision: 'unknown' });
  });

  it('agrees with the temporal engine on every fixture range and instant', async () => {
    const ranges: (string | null)[] = [
      '[2020-01-01T00:00:00.000Z,2026-03-01T00:00:00.000Z)',
      '[2020-01-01T00:00:00.000Z,)',
      '(,2026-03-01T00:00:00.000Z)',
      '(,)',
      '[2024-01-15T00:00:00.000Z,2024-01-16T00:00:00.000Z)',
      null, // `unknown` precision: valid IS NULL
    ];
    const instants = [
      '2019-12-31T23:59:59.999Z',
      '2020-01-01T00:00:00.000Z', // inclusive lower
      '2024-01-15T00:00:00.000Z',
      '2024-01-15T23:59:59.999Z',
      '2024-01-16T00:00:00.000Z', // exclusive upper
      '2026-02-28T23:59:59.999Z',
      '2026-03-01T00:00:00.000Z', // exclusive upper
      '2099-01-01T00:00:00.000Z',
      '1900-01-01T00:00:00.000Z',
    ].map((s) => new Date(s));
    const occurred = [null, new Date('2024-01-15T00:00:00.000Z')];

    let checked = 0;
    for (const literal of ranges) {
      const range = literal === null ? null : fromPgRange(literal);
      for (const at of instants) {
        const [rel] = await prisma.$queryRaw<{ ok: boolean }[]>`
          SELECT ${relationValidAtSql('r', at)} AS ok FROM (SELECT ${literal}::tstzrange AS valid) r`;
        expect({ literal, at, ok: rel.ok }).toEqual({ literal, at, ok: isValidAt(range, at) });
        for (const occurredAt of occurred) {
          const [item] = await prisma.$queryRaw<{ ok: boolean }[]>`
            SELECT ${itemValidAtSql('i', at)} AS ok
            FROM (SELECT ${literal}::tstzrange AS valid, ${occurredAt}::timestamptz AS occurred_at) i`;
          expect({ literal, at, occurredAt, ok: item.ok }).toEqual({
            literal,
            at,
            occurredAt,
            ok: itemValidAt({ valid: range, occurredAt }, at),
          });
          checked++;
        }
      }
    }
    expect(checked).toBe(ranges.length * instants.length * occurred.length);
  });

  // ---------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------

  it("answers 404 for another owner's entity, and expand is all-or-nothing", async () => {
    const { user, g } = await owner('a');
    const { user: other, g: og } = await owner('b');
    const a = await g.entity('Person', 'A');
    const b = await g.entity('Person', 'B');
    const unreviewed = await g.entity('Person', 'Draft', { reviewStatus: 'unreviewed' });
    const foreign = await og.entity('Person', 'Theirs');
    await g.relation('REPORTS_TO', a, b, { valid: '[2020-01-01,)', precision: 'day' });

    await expect(nbhd(other.id, a)).rejects.toThrow(NotFoundException);
    await expect(nbhd(user.id, unreviewed)).rejects.toThrow(NotFoundException);

    const errors = await Promise.all(
      [[a, foreign], [a, unreviewed], [foreign]].map((nodeIds) =>
        svc.expand({ id: user.id }, { nodeIds, cap: 100 } as never).catch((e: unknown) => e),
      ),
    );
    for (const err of errors) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).message).toBe('Entity not found');
    }

    const ok = await svc.expand({ id: user.id }, { nodeIds: [a, b], cap: 100 } as never);
    expect(ok.seedIds).toEqual([a, b]);
    expect(depthOf(ok, a)).toBe(0);
    expect(depthOf(ok, b)).toBe(0);
    expect(ok.edges).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Performance
  // ---------------------------------------------------------------------------

  it('walks 2 hops at cap 300 on a 10k-entity / 40k-relation owner within budget', async () => {
    const { user } = await owner('perf');
    const seed = await bulkRandomGraph(prisma, user.id, 10_000, 4);
    await prisma.$executeRawUnsafe('ANALYZE kg_entities');
    await prisma.$executeRawUnsafe('ANALYZE kg_relations');

    const timings: number[] = [];
    let last: GraphSlice | undefined;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      last = await nbhd(user.id, seed, { hops: 2, limit: 300 });
      timings.push(performance.now() - t0);
    }
    timings.sort((x, y) => x - y);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
    // eslint-disable-next-line no-console
    console.log(`[graph-neighborhood perf] 2-hop cap-300: p50=${timings[10].toFixed(1)}ms p95=${p95.toFixed(1)}ms nodes=${last?.nodes.length}`);
    expect(last!.nodes.length).toBeGreaterThan(10);
    expect(last!.nodes.length).toBeLessThanOrEqual(300);
    // Epic #347's success criterion: p95 < 500ms on CI Postgres for a 2-hop,
    // cap-300 walk over a 10k-entity fixture (measured locally ~44ms).
    expect(p95).toBeLessThan(500);
  }, 180_000);
});
