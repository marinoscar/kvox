// =============================================================================
// KvoxFilesController (issue #469)
// =============================================================================
//
//   GET /api/<app>/files     the caller's plain uploads, minus managed objects
//
// The platform's `GET /api/storage/objects` lists every object the caller
// uploaded, and the objects the app's modules create (a transcript's source audio,
// a note's source document, a graph export) are uploaded in the caller's name,
// so they would show up in a generic "Files" view and invite a delete that
// would orphan the owning record. Every client of this app therefore lists through this
// route: the platform's list query shape (same query, same `{ items, meta }`
// body, same response item), with `id IN (SELECT object_id FROM
// kvox_object_ownership)` excluded.
//
// The platform route still lists managed objects for a caller who hits it
// directly. That discloses only the caller's OWN objects, and a delete through
// it is vetoed (`managed-delete.hook.ts`), so it is documented rather than
// closed (docs/platform-adoption/local-exceptions.md).
//
// The query runs through `KvoxManagedObjects.run`, in the caller's organization.
// =============================================================================

import { Controller, Get, Query } from '@nestjs/common';
import { APP_SLUG } from '@app/shared';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentOrg, CurrentUser } from '@marinoscar/platform-api/identity';
import { ObjectResponseDto } from '@marinoscar/platform-api/storage';
import { objectListQuerySchema } from '@marinoscar/platform-contract/storage';
import type { ObjectListQueryDto, ObjectListResponse } from '@marinoscar/platform-contract/storage';

import { KvoxManagedObjectsService, type StorageObjectRow } from './kvox-managed-objects.service';

/**
 * The `where` of the list: the caller's own objects that no module owns.
 * Exported so the real-Postgres spec exercises the same predicate.
 */
export function unmanagedFilesWhere(userId: string, status?: ObjectListQueryDto['status']) {
  return {
    uploadedById: userId,
    kvoxOwnership: { is: null },
    ...(status ? { status } : {}),
  };
}

/** The `orderBy` of the list, from the query's sort fields. */
export function filesOrderBy(
  sortBy: ObjectListQueryDto['sortBy'],
  sortOrder: ObjectListQueryDto['sortOrder'],
): Record<string, 'asc' | 'desc'> {
  return { [sortBy]: sortOrder };
}

/** One row as the platform's `ObjectResponseDto`. */
export function toObjectResponse(row: StorageObjectRow) {
  return {
    id: row.id,
    name: row.name,
    size: row.size.toString(),
    mimeType: row.mimeType,
    status: row.status,
    metadata: row.metadata as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@ApiTags('Storage')
@Controller(`${APP_SLUG}/files`)
export class KvoxFilesController {
  constructor(private readonly managed: KvoxManagedObjectsService) {}

  @Get()
  @Auth({ permissions: ['storage:read'] })
  @ApiOperation({
    summary: 'List the caller\'s files',
    description:
      'The platform\'s object list, minus objects owned by an app module (transcript sources, ' +
      'note sources, graph exports). Same query and response shape as `GET /api/storage/objects`.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'uploading', 'processing', 'ready', 'failed'],
    description: 'Filter by status',
  })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'name', 'size'], description: 'Sort field (default: createdAt)' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Sort order (default: desc)' })
  @ApiDataResponse(ObjectResponseDto, { pagination: 'nested', description: 'Paginated list of plain uploads' })
  async list(
    @Query(new ZodValidationPipe(objectListQuerySchema)) query: ObjectListQueryDto,
    @CurrentUser('id') userId: string,
    @CurrentOrg() orgId: string,
  ): Promise<{ data: ObjectListResponse }> {
    const { page, pageSize, status, sortBy, sortOrder } = query;
    const where = unmanagedFilesWhere(userId, status);

    // Sequential on purpose: one interactive transaction runs one statement at a time.
    const { items, totalItems } = await this.managed.run({ orgId }, async (tx) => {
      const rows = await tx.storageObject.findMany({
        where,
        orderBy: filesOrderBy(sortBy, sortOrder),
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      return { items: rows, totalItems: await tx.storageObject.count({ where }) };
    });

    return {
      data: {
        items: items.map(toObjectResponse),
        meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
      },
    };
  }
}
