import { ObjectsService } from '@marinoscar/platform-api/storage';
import { type JobHandler, JobHandlerRegistry } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { FilesPurgeUnmanagedHandler, readFilesPurgePayload } from './files-purge-unmanaged.handler';
import { FILES_PURGE_UNMANAGED_JOB_TYPE } from './job-types';
import { KvoxManagedObjectsService } from './kvox-managed-objects.service';

// =============================================================================
// `files.purge_unmanaged` (issue #480)
// =============================================================================
//
// The properties worth pinning: the permanent type string; server-only; the
// ownership filter is IN THE QUERY (a managed object is never selected); pages
// are walked by an id cursor so a failing object is skipped, not re-read; a
// provider failure is counted, keeps its row and never throws; the job runs in
// the default organization when the delegate enqueue passed none. The same
// guarantees against a real database are in
// `test/user-data/user-data-purge.db.spec.ts`.
// =============================================================================

const USER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('FilesPurgeUnmanagedHandler', () => {
  let handler: FilesPurgeUnmanagedHandler;
  let registry: { register: jest.Mock };
  let managed: { findMany: jest.Mock; resolveOrg: jest.Mock };
  let objects: { delete: jest.Mock };
  let prisma: { auditEvent: { create: jest.Mock } };

  const job = (payload: unknown = { userId: USER_ID }, orgId: string | null = null) =>
    ({ id: 'job-1', payload, orgId }) as never;

  beforeEach(() => {
    registry = { register: jest.fn() };
    managed = {
      findMany: jest.fn().mockResolvedValue([]),
      resolveOrg: jest.fn(async (orgId?: string | null) => orgId ?? ORG_ID),
    };
    objects = { delete: jest.fn().mockResolvedValue(undefined) };
    prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };

    handler = new FilesPurgeUnmanagedHandler(
      registry as unknown as JobHandlerRegistry,
      prisma as unknown as PrismaService,
      managed as unknown as KvoxManagedObjectsService,
      objects as unknown as ObjectsService,
    );
  });

  it('registers itself under the permanent type string', () => {
    handler.onModuleInit();

    expect(handler.type).toBe('files.purge_unmanaged');
    expect(handler.type).toBe(FILES_PURGE_UNMANAGED_JOB_TYPE);
    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.label).toBeTruthy();
  });

  it('is server-only and declares its execution profile', () => {
    const members = handler as unknown as Record<string, unknown>;

    expect(members.nodeResultSchema).toBeUndefined();
    expect(members.persistNodeResult).toBeUndefined();
    expect((handler as JobHandler).profile).toEqual({ maxRuntimeMs: 30 * 60_000, maxAttempts: 3 });
  });

  it('selects only the user’s own objects that NO module manages', async () => {
    await handler.process(job());

    expect(managed.findMany).toHaveBeenCalledTimes(1);

    const [args, scope] = managed.findMany.mock.calls[0];

    expect(args.where).toEqual({ uploadedById: USER_ID, kvoxOwnership: null });
    expect(args.orderBy).toEqual({ id: 'asc' });
    expect(scope).toEqual({ orgId: ORG_ID });
  });

  it('deletes each object through ObjectsService as its uploader, in the job’s organization', async () => {
    managed.findMany
      .mockResolvedValueOnce([{ id: 'o-1' }, { id: 'o-2' }])
      .mockResolvedValueOnce([]);

    await handler.process(job(undefined, ORG_ID));

    expect(managed.resolveOrg).toHaveBeenCalledWith(ORG_ID);
    expect(objects.delete.mock.calls).toEqual([
      ['o-1', USER_ID, ORG_ID],
      ['o-2', USER_ID, ORG_ID],
    ]);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: USER_ID,
        action: 'user_data:files_deleted',
        meta: { count: 2, failed: 0 },
      }),
    });
  });

  it('walks pages by id cursor, so an object that will not delete is skipped, not re-read', async () => {
    managed.findMany
      .mockResolvedValueOnce([{ id: 'o-1' }, { id: 'o-2' }])
      .mockResolvedValueOnce([{ id: 'o-3' }])
      .mockResolvedValueOnce([]);
    objects.delete.mockImplementation(async (id: string) => {
      if (id === 'o-2') throw new Error('provider down');
    });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(managed.findMany.mock.calls[1][0].where).toEqual({
      uploadedById: USER_ID,
      kvoxOwnership: null,
      id: { gt: 'o-2' },
    });
    expect(managed.findMany.mock.calls[2][0].where.id).toEqual({ gt: 'o-3' });
    // o-2 kept its row (ObjectsService.delete threw), o-1 and o-3 went.
    expect(objects.delete).toHaveBeenCalledTimes(3);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ meta: { count: 2, failed: 1 } }),
    });
  });

  it('writes no audit row and deletes nothing when the user has no plain uploads', async () => {
    await handler.process(job());

    expect(objects.delete).not.toHaveBeenCalled();
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['a string', USER_ID],
    ['an array', [USER_ID]],
    ['an object with no user', {}],
    ['an object with a non-uuid user', { userId: 'someone' }],
  ])('returns successfully for a payload that is %s', async (_label, payload) => {
    await expect(handler.process(job(payload))).resolves.toBeUndefined();

    expect(managed.findMany).not.toHaveBeenCalled();
  });

  it('reads the payload totally', () => {
    expect(readFilesPurgePayload({ userId: USER_ID })).toEqual({ userId: USER_ID });
    expect(readFilesPurgePayload({ userId: 7 })).toBeNull();
    expect(readFilesPurgePayload(undefined)).toBeNull();
  });
});
