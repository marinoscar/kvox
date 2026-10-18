import { randomUUID } from 'node:crypto';

import { computeEffectiveSchema } from '@marinoscar/kvox-contract/ontology';

import { GraphInvariantError, GraphWriteService, type KvoxGraphTx } from '../src/graph/index.js';
import { internals } from '../src/graph/testing/index.js';
import type { KvoxObjectStorePort } from '../src/ports/index.js';
import { createTestDb, type TestDb } from './host/db.js';

// =============================================================================
// The no-orphans rule on a real PostgreSQL (issue #496, epic #491)
// =============================================================================
//
// The graph's central invariant, proved against the test host's migrated database with no platform:
//
//   • `GraphWriteService` refuses an accepted row that carries no evidence BEFORE any SQL
//     (`GraphInvariantError`), so the common mistake never reaches the database;
//   • the deferred `kg_assert_has_evidence` trigger refuses it at COMMIT when a writer routes around the
//     service, and a row with evidence committed in the same transaction passes;
//   • a row inserted as `unreviewed` is not held to the rule (it is not graph yet).
// =============================================================================

describe('the no-orphans invariant (real PostgreSQL)', () => {
  let db: TestDb;
  let write: GraphWriteService;
  let ownerId: string;
  const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });

  beforeAll(async () => {
    db = await createTestDb();
    // Nothing here cites a note or a transcript through the service, so the validator's collaborators are never asked.
    write = new GraphWriteService(
      new internals.EvidenceValidator({ describe: async () => new Map() } as unknown as KvoxObjectStorePort, { rolesFor: async () => new Map() } as never, db.prisma as never),
    );
    const user = await db.prisma.user.create({ data: { email: `graph-write-${randomUUID()}@example.test` } });
    ownerId = user.id;
  });

  afterAll(async () => {
    await db.dispose();
  });

  it('the service refuses an accepted entity with no evidence before any SQL', async () => {
    const attempt = db.prisma.$transaction((tx) =>
      write.createEntity(
        tx as unknown as KvoxGraphTx,
        { ownerId, type: 'Person', label: 'Sarah Chen', reviewStatus: 'accepted', evidence: [] } as never,
        schema,
      ),
    );

    await expect(attempt).rejects.toBeInstanceOf(GraphInvariantError);
    expect(await db.prisma.kgEntity.count({ where: { ownerId } })).toBe(0);
  });

  it('the deferred trigger refuses an accepted row inserted without evidence, at COMMIT', async () => {
    const attempt = db.prisma.$transaction(async (tx) => {
      await tx.kgEntity.create({
        data: { ownerId, type: 'Person', label: 'Orphan', reviewStatus: 'accepted', ontologyVersion: '1.0.0', props: {} },
      });
    });

    await expect(attempt).rejects.toThrow(/evidence/i);
    expect(await db.prisma.kgEntity.count({ where: { ownerId, label: 'Orphan' } })).toBe(0);
  });

  it('commits the same row when its evidence is written in the same transaction', async () => {
    const id = randomUUID();

    await db.prisma.$transaction(async (tx) => {
      await tx.kgEntity.create({
        data: { id, ownerId, type: 'Person', label: 'Cited', reviewStatus: 'accepted', ontologyVersion: '1.0.0', props: {} },
      });
      await tx.kgEvidence.create({
        data: { ownerId, subjectKind: 'entity', subjectId: id, quote: 'a cited sentence', sourceIri: 'https://example.test/source' },
      });
    });

    expect(await db.prisma.kgEntity.count({ where: { id } })).toBe(1);
  });

  it('does not hold an unreviewed row to the rule', async () => {
    const created = await db.prisma.kgEntity.create({
      data: { ownerId, type: 'Person', label: 'Pending', reviewStatus: 'unreviewed', ontologyVersion: '1.0.0', props: {} },
    });

    expect(created.reviewStatus).toBe('unreviewed');
  });
});
