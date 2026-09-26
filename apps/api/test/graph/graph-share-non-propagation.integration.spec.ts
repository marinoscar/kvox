import request from 'supertest';
import { NotFoundException } from '@nestjs/common';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { GraphAccessService } from '../../src/graph/access/graph-access.service';
import { TranscriptAccessService } from '../../src/transcripts/transcript-access.service';

// =============================================================================
// A transcript share never exposes the graph derived from it (#357, §12)
// =============================================================================
//
// The graph is the OWNER's curated reading of what they saw, not the
// conversation itself. So a share of transcript T — viewer or editor — gives
// the recipient T, and nothing of the owner's graph, even the entity whose
// evidence cites T's own segment.
//
// This is the test that PROVES it rather than states it. Driven through the
// real `AppModule` (guards, `TranscriptAccessService`, `GraphAccessService`,
// the real share-revoke route), with only `PrismaService` replaced by small
// in-memory stores for transcripts, shares and the graph rows. Each case
// first shows the share is real — B genuinely has T — and then that every
// graph surface still answers B with the byte-identical 404 a stranger gets,
// and that the graph routes never even look a share up.
// =============================================================================

const TRANSCRIPT_ID = '10101010-1010-4010-8010-101010101010';
const SEGMENT_ID = '20202020-2020-4020-8020-202020202020';
const ENTITY_ID = '30303030-3030-4030-8030-303030303030';
const EVIDENCE_ID = '40404040-4040-4040-8040-404040404040';

type Row = Record<string, any>;

describe('Graph share non-propagation (integration)', () => {
  let context: TestContext;
  let transcripts: Row[];
  let shares: Row[];
  let entities: Row[];
  let evidence: Row[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  function seed(ownerId: string) {
    const now = new Date('2026-09-01T00:00:00.000Z');
    transcripts = [{ id: TRANSCRIPT_ID, ownerId, title: 'Call', deletedAt: null, createdAt: now, updatedAt: now }];
    entities = [
      {
        id: ENTITY_ID,
        ownerId,
        type: 'Person',
        label: 'Sarah Chen',
        props: {},
        reviewStatus: 'accepted',
        mergedIntoId: null,
        occurredAt: null,
        ontologyVersion: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
    ];
    // E's evidence cites T's own segment — the closest the graph gets to T.
    evidence = [
      {
        id: EVIDENCE_ID,
        ownerId,
        subjectKind: 'entity',
        subjectId: ENTITY_ID,
        transcriptId: TRANSCRIPT_ID,
        segmentId: SEGMENT_ID,
        quote: 'Sarah joined Acme',
        createdAt: now,
      },
    ];
  }

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    transcripts = [];
    shares = [];
    entities = [];
    evidence = [];

    prismaMock.transcript.findUnique.mockImplementation(async ({ where }: { where: Row }) =>
      transcripts.find((t) => t.id === where.id) ?? null,
    );
    prismaMock.transcriptShare.findUnique.mockImplementation(async ({ where }: { where: Row }) => {
      const key = where.transcriptId_userId;
      return shares.find((s) => s.transcriptId === key.transcriptId && s.userId === key.userId) ?? null;
    });
    prismaMock.transcriptShare.deleteMany.mockImplementation(async ({ where }: { where: Row }) => {
      const before = shares.length;
      shares = shares.filter((s) => !(s.transcriptId === where.transcriptId && s.userId === where.userId));
      return { count: before - shares.length };
    });
    prismaMock.kgEntity.findUnique.mockImplementation(async ({ where }: { where: Row }) =>
      entities.find((e) => e.id === where.id) ?? null,
    );
    prismaMock.kgEvidence.findUnique.mockImplementation(async ({ where }: { where: Row }) =>
      evidence.find((e) => e.id === where.id) ?? null,
    );
  });

  /** Every graph write the mocked client exposes — none may ever be called here. */
  function expectNoGraphWrites(): void {
    for (const model of ['kgEntity', 'kgEntityAlias', 'kgEvidence', 'kgRelation', 'kgItem', 'kgMention']) {
      for (const op of ['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']) {
        expect([model, op, prismaMock[model][op].mock.calls.length]).toEqual([model, op, 0]);
      }
    }
    expect(prismaMock.job.create).not.toHaveBeenCalled();
  }

  describe.each(['viewer', 'editor'] as const)('with a %s share of the transcript', (role) => {
    it('gives B the transcript, and nothing of A\'s graph — every surface is the stranger\'s 404', async () => {
      const a = await createMockTestUser(context, { roleName: 'viewer' });
      const b = await createMockTestUser(context, { roleName: 'viewer' });
      seed(a.id);
      shares.push({ transcriptId: TRANSCRIPT_ID, userId: b.id, role });

      // The share is real: B can read T (and, as an editor, edit it).
      const transcriptAccess = context.module.get(TranscriptAccessService);
      await expect(transcriptAccess.require(b.id, TRANSCRIPT_ID, 'view')).resolves.toMatchObject({ role });
      if (role === 'editor') {
        await expect(
          transcriptAccess.require(b.id, TRANSCRIPT_ID, 'edit', ['transcripts:write']),
        ).resolves.toMatchObject({ role: 'editor' });
      }

      const shareLookupsBefore = prismaMock.transcriptShare.findUnique.mock.calls.length;
      const server = context.app.getHttpServer();

      // PATCH the entity whose evidence cites B's shared transcript: 404.
      const patch = await request(server)
        .patch(`/api/graph/entities/${ENTITY_ID}`)
        .set(authHeader(b.accessToken))
        .send({ label: 'Hijacked' })
        .expect(404);
      // Forget it: 404.
      const forget = await request(server)
        .post(`/api/graph/entities/${ENTITY_ID}/forget`)
        .set(authHeader(b.accessToken))
        .send({ confirmation: 'FORGET' })
        .expect(404);
      // A stranger on a missing id: the byte-identical 404.
      const missing = await request(server)
        .post('/api/graph/entities/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/forget')
        .set(authHeader(b.accessToken))
        .send({ confirmation: 'FORGET' })
        .expect(404);

      expect(patch.body.message).toBe('Entity not found');
      expect(forget.body.message).toBe('Entity not found');
      expect(missing.body.message).toBe(forget.body.message);

      // The service itself, for view — and for the evidence row citing T.
      const graphAccess = context.module.get(GraphAccessService);
      await expect(graphAccess.require(b.id, 'entity', ENTITY_ID, 'view')).rejects.toBeInstanceOf(NotFoundException);
      await expect(graphAccess.require(b.id, 'entity', ENTITY_ID, 'view')).rejects.toThrow('Entity not found');
      await expect(graphAccess.require(b.id, 'evidence', EVIDENCE_ID, 'view')).rejects.toThrow('Evidence not found');

      // No graph path even LOOKED at the share table: there is no sharing path to fall back to.
      expect(prismaMock.transcriptShare.findUnique.mock.calls.length).toBe(shareLookupsBefore);

      // A still owns E (sanity: the 404 is about B, not a broken fixture).
      await expect(graphAccess.require(a.id, 'entity', ENTITY_ID, 'view')).resolves.toMatchObject({ id: ENTITY_ID });

      expectNoGraphWrites();
    });

    it("revoking the share changes nothing on A's graph", async () => {
      const a = await createMockTestUser(context, { roleName: 'viewer' });
      const b = await createMockTestUser(context, { roleName: 'viewer' });
      seed(a.id);
      shares.push({ transcriptId: TRANSCRIPT_ID, userId: b.id, role });
      const graphBefore = JSON.stringify({ entities, evidence });

      await request(context.app.getHttpServer())
        .delete(`/api/transcripts/${TRANSCRIPT_ID}/shares/${b.id}`)
        .set(authHeader(a.accessToken))
        .expect(204);

      expect(shares).toHaveLength(0);
      expect(JSON.stringify({ entities, evidence })).toBe(graphBefore);
      expectNoGraphWrites();

      // A's graph is still A's; B is still a stranger to it.
      const graphAccess = context.module.get(GraphAccessService);
      await expect(graphAccess.require(a.id, 'entity', ENTITY_ID, 'view')).resolves.toMatchObject({ id: ENTITY_ID });
      await expect(graphAccess.require(b.id, 'entity', ENTITY_ID, 'view')).rejects.toThrow('Entity not found');
    });
  });
});
