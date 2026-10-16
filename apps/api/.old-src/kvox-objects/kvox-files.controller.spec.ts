import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { APP_SLUG } from '@app/shared';

import {
  KvoxFilesController,
  filesOrderBy,
  toObjectResponse,
  unmanagedFilesWhere,
} from './kvox-files.controller';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '33333333-3333-4333-8333-333333333333';

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id}.m4a`,
    size: BigInt(2048),
    mimeType: 'audio/mp4',
    status: 'ready',
    metadata: null,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    updatedAt: new Date('2026-01-03T03:04:05.000Z'),
    ...overrides,
  };
}

describe('KvoxFilesController', () => {
  let findMany: jest.Mock;
  let count: jest.Mock;
  let run: jest.Mock;
  let controller: KvoxFilesController;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([row('a'), row('b', { metadata: { purpose: 'x' } })]);
    count = jest.fn().mockResolvedValue(45);
    run = jest.fn(async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ storageObject: { findMany, count } }),
    );
    controller = new KvoxFilesController({ run } as never);
  });

  it('is mounted at kvox/files', () => {
    expect(Reflect.getMetadata(PATH_METADATA, KvoxFilesController)).toBe(`${APP_SLUG}/files`);
  });

  it('lists the caller\'s unmanaged objects in their organization with the platform response shape', async () => {
    const result = await controller.list(
      { page: 2, pageSize: 20, status: 'ready', sortBy: 'name', sortOrder: 'asc' },
      USER,
      ORG,
    );

    expect(run).toHaveBeenCalledWith({ orgId: ORG }, expect.any(Function));
    expect(findMany).toHaveBeenCalledWith({
      where: { uploadedById: USER, kvoxOwnership: { is: null }, status: 'ready' },
      orderBy: { name: 'asc' },
      skip: 20,
      take: 20,
    });
    expect(count).toHaveBeenCalledWith({ where: { uploadedById: USER, kvoxOwnership: { is: null }, status: 'ready' } });
    expect(result.data.meta).toEqual({ page: 2, pageSize: 20, totalItems: 45, totalPages: 3 });
    expect(result.data.items[0]).toEqual({
      id: 'a',
      name: 'a.m4a',
      size: '2048',
      mimeType: 'audio/mp4',
      status: 'ready',
      metadata: null,
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-03T03:04:05.000Z',
    });
    expect(result.data.items[1]?.metadata).toEqual({ purpose: 'x' });
  });

  it('omits the status filter when none is given', async () => {
    await controller.list({ page: 1, pageSize: 20, sortBy: 'createdAt', sortOrder: 'desc' }, USER, ORG);
    expect(findMany.mock.calls[0][0].where).toEqual({ uploadedById: USER, kvoxOwnership: { is: null } });
  });

  it('exposes the predicate helpers', () => {
    expect(unmanagedFilesWhere(USER)).toEqual({ uploadedById: USER, kvoxOwnership: { is: null } });
    expect(filesOrderBy('size', 'desc')).toEqual({ size: 'desc' });
    expect(toObjectResponse(row('z') as never).id).toBe('z');
  });
});
