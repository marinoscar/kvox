import { Prisma } from '@prisma/client';
import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { AiSettingsService } from '../../src/ai/ai-settings.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { GraphObjectsService } from '../../src/graph/graph-objects.service';
import { attributeOfferResponseSchema, createGraphImportResponseSchema } from '../../src/graph/import/dto/graph-import.dto';
import { GRAPH_IMPORT_MAX_BYTES } from '../../src/graph/import/graph-import.constants';

// =============================================================================
// /api/graph/imports and the attribute-offer routes over the wire (#387)
// =============================================================================
//
// The REAL `AppModule` — guards, multipart parsing, Zod pipes, envelope — with
// `PrismaService` mocked and the storage writer / queue spied. Pins the HTTP
// contract: 401, 403 without graph:write, 400 for an unreadable format or an
// empty file, 413 over 20 MiB, 409 graph_disabled / extraction_running (the
// losing request's file deleted again), 202 `{ proposalId, jobId }`, and the
// offer routes' 404 / 409 / 200.
// =============================================================================

const PROPOSAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OBJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function stripPermission(userId: string, permission: string): void {
  const original = prismaMock.user.findUnique.getMockImplementation();
  prismaMock.user.findUnique.mockImplementation(async (args: never) => {
    const user = (await original?.(args)) as
      | { id: string; userRoles?: Array<{ role: { rolePermissions: Array<{ permission: { name: string } }> } }> }
      | null;
    if (!user || user.id !== userId || !user.userRoles) return user as never;
    return {
      ...user,
      userRoles: user.userRoles.map((userRole) => ({
        ...userRole,
        role: {
          ...userRole.role,
          rolePermissions: userRole.role.rolePermissions.filter((rp) => rp.permission.name !== permission),
        },
      })),
    } as never;
  });
}

const TURTLE = Buffer.from('@prefix kv: <https://x.app/ns#> .\n<https://s.example/a> a kv:Person .\n', 'utf8');

describe('/api/graph/imports (integration)', () => {
  let context: TestContext;
  let put: jest.SpyInstance;
  let remove: jest.SpyInstance;
  let enqueueWithin: jest.SpyInstance;
  let settings: jest.SpyInstance;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    for (const spy of [put, remove, enqueueWithin, settings]) spy?.mockRestore();
    put = jest.spyOn(context.app.get(GraphObjectsService), 'putBuffer').mockResolvedValue({ id: OBJECT } as never);
    remove = jest.spyOn(context.app.get(GraphObjectsService), 'deleteIfPresent').mockResolvedValue(true);
    enqueueWithin = jest.spyOn(context.app.get(JobsService), 'enqueueWithin').mockResolvedValue({ id: JOB } as never);
    settings = jest.spyOn(context.app.get(AiSettingsService), 'get').mockResolvedValue({ graphEnabled: true } as never);
    prismaMock.kgProposal.findFirst.mockResolvedValue(null as never);
    prismaMock.kgProposal.create.mockResolvedValue({ id: PROPOSAL } as never);
    prismaMock.kgProposal.update.mockResolvedValue({ id: PROPOSAL, jobId: JOB } as never);
  });

  const upload = (token: string | undefined, file: Buffer, filename: string, contentType = 'application/octet-stream') => {
    const req = request(context.app.getHttpServer()).post('/api/graph/imports');
    return (token ? req.set(authHeader(token)) : req).attach('file', file, { filename, contentType });
  };

  it('is 401 without a session', async () => {
    await upload(undefined, TURTLE, 'a.ttl').expect(401);
  });

  it('is 403 without graph:write, before anything is stored', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:write');
    await upload(user.accessToken, TURTLE, 'a.ttl').expect(403);
    expect(put).not.toHaveBeenCalled();
  });

  it('stores the file, creates an extracting import proposal and queues kg.import (202)', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const res = await upload(user.accessToken, TURTLE, 'contacts.ttl').expect(202);

    expect(createGraphImportResponseSchema.parse(res.body.data)).toEqual({ proposalId: PROPOSAL, jobId: JOB });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: expect.stringMatching(new RegExp(`^graph/${user.id}/imports/[0-9a-f-]{36}\\.ttl$`)),
        name: 'contacts.ttl',
        mimeType: 'text/turtle',
        ownerId: user.id,
      }),
    );
    expect(prismaMock.kgProposal.create).toHaveBeenCalledWith({
      data: { ownerId: user.id, kind: 'import', status: 'extracting', stats: { filename: 'contacts.ttl', format: 'turtle', bytes: TURTLE.length } },
    });
    expect(enqueueWithin).toHaveBeenCalledTimes(1);
    expect(enqueueWithin.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        type: 'kg.import',
        subjectType: 'kg_proposal',
        subjectId: PROPOSAL,
        payload: { proposalId: PROPOSAL, ownerId: user.id, objectId: OBJECT, format: 'turtle' },
      }),
    );
    expect(prismaMock.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'graph.import_created', targetId: PROPOSAL, meta: { proposalId: PROPOSAL, format: 'turtle', bytes: TURTLE.length } }),
    });
  });

  it.each([
    ['data.jsonld', 'application/octet-stream', 'jsonld'],
    ['data.json', 'application/octet-stream', 'jsonld'],
    ['data.nq', 'application/octet-stream', 'nquads'],
    ['data', 'application/ld+json', 'jsonld'],
    ['data', 'text/turtle; charset=utf-8', 'turtle'],
  ])('reads %s (%s) as %s', async (filename, contentType, format) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await upload(user.accessToken, TURTLE, filename, contentType).expect(202);
    expect(enqueueWithin.mock.calls[0][1]).toEqual(expect.objectContaining({ payload: expect.objectContaining({ format }) }));
  });

  it('is 400 for a format imports do not read, and for an empty file — nothing stored', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await upload(user.accessToken, TURTLE, 'contacts.csv', 'text/csv').expect(400);
    await upload(user.accessToken, Buffer.alloc(0), 'empty.ttl').expect(400);
    expect(put).not.toHaveBeenCalled();
  });

  it('is 413 over 20 MiB', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await upload(user.accessToken, Buffer.alloc(GRAPH_IMPORT_MAX_BYTES + 1, 0x20), 'big.ttl').expect(413);
    expect(put).not.toHaveBeenCalled();
  });

  it('is 409 graph_disabled while connected knowledge is off', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    settings.mockResolvedValue({ graphEnabled: false } as never);
    const res = await upload(user.accessToken, TURTLE, 'a.ttl').expect(409);
    expect(res.body.details).toEqual({ reason: 'graph_disabled' });
    expect(put).not.toHaveBeenCalled();
  });

  it('is 409 extraction_running while another import is being checked', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgProposal.findFirst.mockResolvedValue({ id: 'other' } as never);
    const res = await upload(user.accessToken, TURTLE, 'a.ttl').expect(409);
    expect(res.body.details).toEqual({ reason: 'extraction_running' });
    expect(put).not.toHaveBeenCalled();
  });

  it('maps the one-extracting-import index to 409 and deletes the stored file again', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgProposal.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }) as never,
    );
    const res = await upload(user.accessToken, TURTLE, 'a.ttl').expect(409);
    expect(res.body.details).toEqual({ reason: 'extraction_running' });
    expect(remove).toHaveBeenCalledWith(OBJECT);
  });

  // ---------------------------------------------------------------------------
  // Attribute offers
  // ---------------------------------------------------------------------------

  const offer = { offerId: 'o0123456789ab', iri: 'https://crm.example/ns#employees', label: null, count: 1, subjectTypes: ['Organization'], sampleValues: ['42'], suggestedKind: 'number', status: 'offered' };

  function importProposal(ownerId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: PROPOSAL,
      ownerId,
      kind: 'import',
      status: 'draft',
      stats: { unknownProperties: [offer], importPending: { [offer.offerId]: [{ itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', values: [{ v: '42', d: 'http://www.w3.org/2001/XMLSchema#integer' }] }] } },
      ...overrides,
    };
  }

  const offerRoute = (token: string, action: 'accept' | 'reject', offerId = offer.offerId) =>
    request(context.app.getHttpServer())
      .post(`/api/graph/proposals/${PROPOSAL}/attribute-offers/${offerId}/${action}`)
      .set(authHeader(token))
      .send({});

  it('rejects an offer (200), recording it under the proposal lock', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgProposal.findUnique.mockResolvedValue(importProposal(user.id) as never);
    prismaMock.kgProposal.findUniqueOrThrow.mockResolvedValue(importProposal(user.id) as never);
    prismaMock.$queryRaw.mockResolvedValue([{ status: 'draft' }] as never);

    const res = await offerRoute(user.accessToken, 'reject').expect(200);
    expect(attributeOfferResponseSchema.parse(res.body.data)).toMatchObject({ offer: { status: 'rejected' }, rowsUpdated: 0, valuesDropped: 1 });
    expect(prismaMock.kgProposal.update).toHaveBeenCalledWith({
      where: { id: PROPOSAL },
      data: { stats: expect.objectContaining({ unknownProperties: [{ ...offer, status: 'rejected' }], importPending: {} }) },
    });
  });

  it('is 404 for an unknown offer, another user’s proposal, or a non-import proposal', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgProposal.findUnique.mockResolvedValue(importProposal(user.id) as never);
    await offerRoute(user.accessToken, 'reject', 'onope').expect(404);
    prismaMock.kgProposal.findUnique.mockResolvedValue(importProposal('someone-else') as never);
    await offerRoute(user.accessToken, 'reject').expect(404);
    prismaMock.kgProposal.findUnique.mockResolvedValue(importProposal(user.id, { kind: 'extraction' }) as never);
    await offerRoute(user.accessToken, 'accept').expect(404);
  });

  it('is 409 proposal_not_draft once committed, and offer_decided for a decided offer', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgProposal.findUnique.mockResolvedValue(importProposal(user.id, { status: 'committed' }) as never);
    const committed = await offerRoute(user.accessToken, 'accept').expect(409);
    expect(committed.body.details).toMatchObject({ reason: 'proposal_not_draft' });

    prismaMock.kgProposal.findUnique.mockResolvedValue(
      importProposal(user.id, { stats: { unknownProperties: [{ ...offer, status: 'rejected' }] } }) as never,
    );
    const decided = await offerRoute(user.accessToken, 'accept').expect(409);
    expect(decided.body.details).toEqual({ reason: 'offer_decided', status: 'rejected' });
  });

  it('is 403 on the offer routes without graph:write', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:write');
    prismaMock.kgProposal.findUnique.mockResolvedValue(importProposal(user.id) as never);
    await offerRoute(user.accessToken, 'reject').expect(403);
  });
});
