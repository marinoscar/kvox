// =============================================================================
// KvoxMultipartController (issue #469)
// =============================================================================
//
// The two resumable-upload routes the platform's objects API does not have, on
// the same path prefix so the web client keeps one base URL:
//
//   POST /api/storage/objects/:id/upload/parts   sign the next batch of part URLs
//   GET  /api/storage/objects/:id/upload/parts   list the parts the provider holds
//
// WHY THEY EXIST. The platform's init presigns only the first ten parts, so a
// multi-GB upload (hundreds of parts) cannot proceed without a way to ask for
// more; and its provider has no ListParts, so a browser that cannot read the
// `ETag` of a cross-origin PUT has no way to build the `parts` its complete
// call requires. The client lists the parts here, then calls the PLATFORM's
// `POST :id/upload/complete` with exactly that list. Resume uses the same list.
//
// Both routes load the object through `KvoxManagedObjects` (the only app code
// that reads `storage_objects`) in the caller's organization, and answer 404,
// never 403, for an object the caller did not upload.
//
// PART LAYOUT. The platform derives `totalParts = ceil(size / partSize)` from
// the deployment-wide part size, so this controller does too
// (`part-size.ts`). Never change the part size while uploads are in flight.
// =============================================================================

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe, createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentOrg, CurrentUser } from '@marinoscar/platform-api/identity';
import { STORAGE_OPTIONS, STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';
import type { ResolvedStorageModuleOptions, StorageProvider } from '@marinoscar/platform-api/storage';

import { KvoxManagedObjectsService, type StorageObjectRow } from './kvox-managed-objects.service';
import { KvoxS3PartLister } from './kvox-s3-part-lister';
import { S3_MAX_PARTS, resolvePartSize, totalPartsFor } from './part-size';

/** The most part numbers one `POST :id/upload/parts` call may sign. */
export const MAX_PRESIGN_BATCH = 100;

export const presignPartsSchema = z
  .object({
    partNumbers: z
      .array(z.number().int().min(1).max(S3_MAX_PARTS))
      .min(1)
      .max(MAX_PRESIGN_BATCH)
      .describe(`1-${MAX_PRESIGN_BATCH} distinct part numbers (1-based).`),
  })
  .refine((body) => new Set(body.partNumbers).size === body.partNumbers.length, {
    message: 'Part numbers must be distinct',
    path: ['partNumbers'],
  });

export class PresignPartsBodyDto extends createZodDto(presignPartsSchema) {}

const presignedPartSchema = z.object({ partNumber: z.number().int(), url: z.string().url() });

export class PresignedPartDto extends createZodDto(presignedPartSchema) {}

const uploadedPartSchema = z.object({
  partNumber: z.number().int(),
  etag: z.string(),
  size: z.number().int().nonnegative(),
});

export class UploadedPartDto extends createZodDto(uploadedPartSchema) {}

/** Object statuses in which the multipart upload is still open on the provider. */
const ACTIVE_UPLOAD_STATUSES: readonly string[] = ['pending', 'uploading'];

@ApiTags('Storage')
@Controller('storage/objects')
export class KvoxMultipartController {
  private readonly logger = new Logger(KvoxMultipartController.name);

  constructor(
    private readonly managed: KvoxManagedObjectsService,
    private readonly lister: KvoxS3PartLister,
    private readonly config: ConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Optional() @Inject(STORAGE_OPTIONS) private readonly options?: ResolvedStorageModuleOptions,
  ) {}

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: ['storage:write'] })
  @ApiOperation({
    summary: 'Sign more upload part URLs',
    description:
      'Issues signed PUT URLs for a further batch of parts (at most 100) of an in-progress ' +
      'multipart upload. Initialization presigns only the first ten parts, and signed URLs ' +
      'expire, so a large upload asks for batches as it goes. Part numbers are 1-based and ' +
      'must not exceed the upload\'s total part count. Answers 404 for an upload the caller ' +
      'did not start.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'Object ID' })
  @ApiBody({ type: PresignPartsBodyDto })
  @ApiDataResponse(PresignedPartDto, { isArray: true, description: 'Part URLs signed successfully' })
  @ApiResponse({ status: 400, description: 'Upload no longer in progress, or a part number is out of range' })
  @ApiResponse({ status: 404, description: 'Upload not found (or not the caller\'s)' })
  async presignParts(
    @Param('id', ParseUUIDPipe) objectId: string,
    @Body(new ZodValidationPipe(presignPartsSchema)) dto: { partNumbers: number[] },
    @CurrentUser('id') userId: string,
    @CurrentOrg() orgId: string,
  ): Promise<{ data: Array<{ partNumber: number; url: string }> }> {
    const object = await this.openUpload(objectId, userId, orgId);
    const totalParts = totalPartsFor(object.size, resolvePartSize(this.config, this.options));

    for (const partNumber of dto.partNumbers) {
      if (partNumber > totalParts) {
        throw new BadRequestException(
          `Part number ${partNumber} is out of range; this upload has ${totalParts} part(s)`,
        );
      }
    }

    const uploadId = object.s3UploadId as string;
    const parts = await Promise.all(
      dto.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.getSignedUploadUrl(object.storageKey, uploadId, partNumber),
      })),
    );

    this.logger.log(`Signed ${parts.length} part URL(s) for upload ${objectId}`);
    return { data: parts };
  }

  @Get(':id/upload/parts')
  @Auth({ permissions: ['storage:write'] })
  @ApiOperation({
    summary: 'List the parts the storage provider holds',
    description:
      'Reads the uploaded parts back from the storage provider (S3 ListParts), ascending by ' +
      'part number. A browser cannot read the ETag of a cross-origin PUT, so it lists the ' +
      'parts here and passes them to the platform\'s complete call; resuming an upload uses ' +
      'the same list. Answers 501 (`details.reason: list_parts_unsupported`) when the active ' +
      'storage driver is not in the S3 family, and 404 for an upload the caller did not start.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'Object ID' })
  @ApiDataResponse(UploadedPartDto, { isArray: true, description: 'Parts the provider holds' })
  @ApiResponse({ status: 400, description: 'Upload no longer in progress' })
  @ApiResponse({ status: 404, description: 'Upload not found (or not the caller\'s)' })
  @ApiResponse({ status: 501, description: 'The active storage driver cannot list parts' })
  @ApiResponse({ status: 502, description: 'The storage provider could not answer' })
  async listParts(
    @Param('id', ParseUUIDPipe) objectId: string,
    @CurrentUser('id') userId: string,
    @CurrentOrg() orgId: string,
  ): Promise<{ data: Array<{ partNumber: number; etag: string; size: number }> }> {
    const object = await this.openUpload(objectId, userId, orgId);
    const parts = await this.lister.listParts(object.storageKey, object.s3UploadId as string);
    return { data: parts };
  }

  /**
   * The caller's own object with a multipart upload still open. 404 for any
   * other user's object (never 403: no information about its existence), 400
   * for an object whose upload already settled.
   */
  private async openUpload(objectId: string, userId: string, orgId: string): Promise<StorageObjectRow> {
    const object = await this.managed.get(objectId, { orgId });

    if (!object || object.uploadedById !== userId) {
      throw new NotFoundException('Upload not found');
    }

    if (!object.s3UploadId || !ACTIVE_UPLOAD_STATUSES.includes(object.status)) {
      throw new BadRequestException(
        `Upload is no longer in progress (status: ${object.status}); ` +
          'parts can only be signed or listed for a pending or uploading object',
      );
    }

    return object;
  }
}
