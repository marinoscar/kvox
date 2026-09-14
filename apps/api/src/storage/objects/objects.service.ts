import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Inject } from '@nestjs/common';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { STORAGE_PROVIDER } from '../providers/storage-provider.interface';
import type { StorageProvider } from '../providers/storage-provider.interface';
import {
  InitUploadDto,
  InitUploadResponseDto,
} from './dto/init-upload.dto';
import {
  CompleteUploadDto,
} from './dto/complete-upload.dto';
import {
  ObjectResponseDto,
  UploadStatusResponseDto,
} from './dto/object-response.dto';
import {
  ObjectListQueryDto,
  ObjectListResponseDto,
} from './dto/object-list-query.dto';
import {
  UpdateMetadataDto,
} from './dto/update-metadata.dto';
import {
  DownloadUrlResponseDto,
} from './dto/download-url-response.dto';
import {
  OBJECT_UPLOADED_EVENT,
  ObjectUploadedEvent,
} from '../processing/events/object-uploaded.event';
import {
  PresignPartsDto,
  PresignedPartDto,
} from './dto/presign-parts.dto';
import {
  AUDIO_EXTENSIONS,
  MAX_PARTS,
  MIN_PART_SIZE,
  computePartSize,
  computeTotalParts,
  formatBytes,
  isMimeTypeAllowed,
  resolveMimeType,
} from './upload-constraints';

/**
 * Most part URLs one `POST /:id/upload/parts` call will sign.
 *
 * A cap rather than "all of them" because signing is real work per URL and the
 * response grows without bound otherwise — 10,000 signed URLs is a multi-
 * megabyte JSON body a phone has to parse before it can upload anything. A
 * client asks for the next 100 as it goes, which is also what makes each batch
 * a natural liveness signal for the stale-upload sweep.
 */
const MAX_PRESIGN_BATCH = 100;

/**
 * How many part URLs `initUpload` hands back without being asked.
 *
 * Unchanged from before #21 — it is a useful fast path that lets a small
 * upload finish without a second round trip. What changed is that it is NO
 * LONGER THE CAP: `presignParts` issues the rest.
 */
const INITIAL_PRESIGN_BATCH = 10;

export interface MultipartFile {
  filename: string;
  mimetype: string;
  file: Readable;
}

@Injectable()
export class ObjectsService {
  private readonly logger = new Logger(ObjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Initialize a resumable multipart upload.
   *
   * ⚠ EVERY MEMBER OF `options` IS A SERVICE-LEVEL ARGUMENT ONLY. Not one of
   * them appears in `InitUploadDto`, so not one of them is reachable over
   * HTTP: an in-process caller may set them, a request body may not, and that
   * boundary is the entire reason the object exists.
   *
   * • `managedBy` — a client able to declare its own upload "managed by
   *   transcripts" could mint an object the generic delete endpoint refuses to
   *   remove and the generic list refuses to show — an undeletable, invisible
   *   row, created on request. Only a module calling this service in-process
   *   may claim ownership.
   * • `allowedMimeTypes` — REPLACES `storage.allowedMimeTypes` for this call
   *   alone. The same rule applies for a sharper reason: this is not a flag the
   *   check reads, it IS the check, and a client able to name its own allowlist
   *   has defeated the allowlist. It exists because `storage.allowedMimeTypes`
   *   is the operator's policy for the ARBITRARY user uploads that arrive
   *   through `POST /api/storage/objects*`, and a module accepting one narrow,
   *   purpose-built kind of file is not governed by it — a deployment whose
   *   `.env` predates #21 lists `image/*,application/pdf,video/*`, which
   *   refused every Android `.m4a` recording the transcription provider itself
   *   would have accepted (issue #79). A module passing its own list is what
   *   keeps that operator setting meaning what it says instead of silently
   *   governing a pipeline nobody wrote it for.
   *
   * The 400 below names WHICHEVER list was actually enforced, never the
   * configured one unconditionally: a caller uploading a recording and told to
   * pick one of `image/*, application/pdf` has been sent to fix the wrong
   * thing, in a place they have no access to.
   */
  async initUpload(
    dto: InitUploadDto,
    userId: string,
    options?: { managedBy?: string; allowedMimeTypes?: string[] },
  ): Promise<InitUploadResponseDto> {
    const { name, size } = dto;
    const managedBy = options?.managedBy;

    // -----------------------------------------------------------------------
    // What this deployment allows. Both of these were configured and READ BY
    // NOTHING before #21.
    // -----------------------------------------------------------------------
    const maxFileSize = this.config.get<number>(
      'storage.maxFileSize',
      10737418240,
    );

    if (size > maxFileSize) {
      throw new BadRequestException(
        `File is ${formatBytes(size)}, which exceeds the maximum upload size of ` +
          `${formatBytes(maxFileSize)} (${maxFileSize} bytes)`,
      );
    }

    // A caller's own list WINS OUTRIGHT when it supplies one — see the ⚠
    // above. The `??` sits on `options.allowedMimeTypes` rather than on some
    // merge of the two on purpose: a module's list REPLACES the operator's, it
    // never extends it, so a narrow module list cannot be widened by whatever a
    // deployment happens to permit for generic uploads.
    const allowedMimeTypes =
      options?.allowedMimeTypes ??
      this.config.get<string[]>('storage.allowedMimeTypes', [
        'image/*',
        'application/pdf',
        'video/*',
        'audio/*',
      ]);

    // A browser that reported `application/octet-stream` or nothing at all for
    // a `.m4a` is the ORDINARY case, not an attack; the extension decides.
    const mimeType = resolveMimeType(name, dto.mimeType);

    if (!mimeType || !isMimeTypeAllowed(mimeType, allowedMimeTypes)) {
      const declared = dto.mimeType?.trim()
        ? `"${dto.mimeType}"`
        : 'no content type';

      // `allowedMimeTypes`, NOT `this.config.get(...)`: the message has to name
      // the list this call enforced, or a transcript rejection prints the
      // storage allowlist and sends the user to a setting that had no say.
      throw new BadRequestException(
        `Files of type ${declared} are not accepted. Allowed types: ` +
          `${allowedMimeTypes.join(', ')}. A file with no usable content type is ` +
          `accepted when its extension is one of: ${AUDIO_EXTENSIONS.join(' ')}`,
      );
    }

    if (mimeType !== (dto.mimeType ?? '').trim().toLowerCase()) {
      this.logger.log(
        `Resolved content type for ${name}: ` +
          `${dto.mimeType || '(none)'} -> ${mimeType}`,
      );
    }

    // -----------------------------------------------------------------------
    // How the file is sliced. ADAPTIVE — see `computePartSize`.
    // -----------------------------------------------------------------------
    const configuredPartSize = this.config.get<number>(
      'storage.partSize',
      10485760,
    );

    if (configuredPartSize < MIN_PART_SIZE) {
      throw new BadRequestException(
        `Configured part size ${configuredPartSize} is below the ${MIN_PART_SIZE}-byte ` +
          'minimum every S3-compatible provider enforces',
      );
    }

    const partSize = computePartSize(size, configuredPartSize);
    const totalParts = computeTotalParts(size, partSize);

    if (totalParts > MAX_PARTS) {
      // DEFENSIVE ONLY. `computePartSize` takes `ceil(size / MAX_PARTS)` as a
      // floor, so this cannot trigger for any `size` the caller could send.
      // It stays because the day someone "simplifies" that function, a wrong
      // answer here is a corrupt object rather than an exception.
      throw new BadRequestException(
        `File would need ${totalParts} parts at a ${partSize}-byte part size, ` +
          `above the ${MAX_PARTS}-part limit`,
      );
    }

    // Generate storage key
    const timestamp = Date.now();
    const uuid = randomUUID();
    const extension = extname(name);
    const storageKey = `uploads/${timestamp}/${uuid}${extension}`;

    this.logger.log(
      `Initializing upload for ${name}, ${totalParts} part(s) of ${partSize} bytes`,
    );

    // Initialize multipart upload with storage provider
    const { uploadId } = await this.storageProvider.initMultipartUpload(
      storageKey,
      { mimeType },
    );

    // Create StorageObject record
    const storageObject = await this.prisma.storageObject.create({
      data: {
        name,
        size: BigInt(size),
        mimeType,
        storageKey,
        storageProvider: 's3',
        bucket: this.storageProvider.getBucket(),
        status: 'pending',
        s3UploadId: uploadId,
        partSize,
        managedBy: managedBy ?? null,
        uploadedById: userId,
      },
    });

    // Generate presigned URLs for the first batch. A convenience, not a cap:
    // `POST /:id/upload/parts` issues every later batch.
    const urlBatchSize = Math.min(INITIAL_PRESIGN_BATCH, totalParts);
    const presignedUrls = await Promise.all(
      Array.from({ length: urlBatchSize }, (_, i) => i + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await this.storageProvider.getSignedUploadUrl(
            storageKey,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );

    this.logger.log(
      `Upload initialized: ${storageObject.id}, uploadId: ${uploadId}`,
    );

    return {
      objectId: storageObject.id,
      uploadId,
      partSize,
      totalParts,
      presignedUrls,
    };
  }

  /**
   * Sign a further batch of part URLs for an upload already in progress
   * (issue #21).
   *
   * WHY THIS ENDPOINT HAS TO EXIST: `initUpload` signs the first ten parts and
   * nothing used to sign an eleventh, so a 10 MiB part size capped every
   * upload at 100 MB. Signed URLs also EXPIRE (`storage.signedUrlExpiry`,
   * one hour by default) — a multi-GB upload outlives its own first batch, so
   * even a client that asked for all of them up front would need to come back.
   */
  async presignParts(
    userId: string,
    objectId: string,
    partNumbers: number[],
  ): Promise<PresignedPartDto[]> {
    const object = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });

    if (!object) {
      throw new NotFoundException('Upload not found');
    }

    if (object.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    if (!object.s3UploadId || !this.isUploadActive(object.status)) {
      throw new BadRequestException(
        `Upload is no longer in progress (status: ${object.status}); ` +
          'part URLs can only be issued for a pending or uploading object',
      );
    }

    if (partNumbers.length === 0) {
      throw new BadRequestException('At least one part number is required');
    }

    if (partNumbers.length > MAX_PRESIGN_BATCH) {
      throw new BadRequestException(
        `At most ${MAX_PRESIGN_BATCH} part numbers may be requested per call, ` +
          `received ${partNumbers.length}`,
      );
    }

    const totalParts = this.totalPartsFor(object);
    const seen = new Set<number>();

    for (const partNumber of partNumbers) {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) {
        throw new BadRequestException(
          `Part number ${partNumber} is out of range; this upload has ` +
            `${totalParts} part(s)`,
        );
      }

      if (seen.has(partNumber)) {
        throw new BadRequestException(
          `Part number ${partNumber} was requested more than once`,
        );
      }

      seen.add(partNumber);
    }

    const expiresIn = this.config.get<number>('storage.signedUrlExpiry', 3600);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageProvider.getSignedUploadUrl(
          object.storageKey,
          object.s3UploadId as string,
          partNumber,
          expiresIn,
        ),
      })),
    );

    await this.touchUpload(objectId);

    this.logger.log(
      `Signed ${urls.length} part URL(s) for upload ${objectId}`,
    );

    return urls.map((url) => ({ ...url, expiresAt }));
  }

  /**
   * Get upload status and progress.
   *
   * ⚠ BUILT FROM `provider.listParts`, NOT FROM `storage_object_chunks`.
   * Those rows are written by `completeUpload`, so a status derived from them
   * reported ZERO PROGRESS for the entire life of an upload and then jumped to
   * complete once resuming was pointless — which is to say resume never worked.
   * The provider is the only party that knows what it is holding.
   */
  async getUploadStatus(
    objectId: string,
    userId: string,
  ): Promise<UploadStatusResponseDto> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Check ownership
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    const partSize = this.partSizeFor(storageObject);
    const totalParts = this.totalPartsFor(storageObject);

    let uploadedParts: number[] = [];
    let uploadedBytes = BigInt(0);

    if (storageObject.s3UploadId && this.isUploadActive(storageObject.status)) {
      const parts = await this.storageProvider.listParts(
        storageObject.storageKey,
        storageObject.s3UploadId,
      );

      uploadedParts = parts
        .map((part) => part.partNumber)
        .sort((a, b) => a - b);
      uploadedBytes = parts.reduce(
        (sum, part) => sum + BigInt(part.size),
        BigInt(0),
      );

      // Polling for progress is a client saying "I am still here". The
      // stale-upload sweep measures from `updated_at`, so this is what keeps a
      // paused-but-watched upload alive. Settled objects are deliberately NOT
      // touched: their `updated_at` means "when this object last changed", and
      // a read must not rewrite that.
      await this.touchUpload(objectId);
    } else if (
      storageObject.status === 'processing' ||
      storageObject.status === 'ready'
    ) {
      // The multipart upload is gone because it COMPLETED — every part landed,
      // by definition, and asking the provider would now 404.
      uploadedParts = Array.from({ length: totalParts }, (_, i) => i + 1);
      uploadedBytes = storageObject.size;
    }

    return {
      objectId: storageObject.id,
      status: storageObject.status,
      uploadedParts,
      totalParts,
      partSize,
      uploadedBytes: uploadedBytes.toString(),
      totalBytes: storageObject.size.toString(),
    };
  }

  /**
   * Complete multipart upload.
   *
   * `dto.parts` is OPTIONAL. When it is absent the parts list is read back from
   * the provider — which is the path a browser should take, because reading an
   * ETag response header off a cross-origin PUT requires the bucket to expose
   * it via `Access-Control-Expose-Headers` and a client that mishandles that
   * silently completes with the wrong ETags. The server can always see them.
   */
  async completeUpload(
    objectId: string,
    dto: CompleteUploadDto,
    userId: string,
  ): Promise<ObjectResponseDto> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Check ownership
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    if (!storageObject.s3UploadId) {
      throw new BadRequestException('Upload ID not found');
    }

    const parts = dto.parts?.length
      ? dto.parts
      : await this.partsFromProvider(
          storageObject.storageKey,
          storageObject.s3UploadId,
        );

    this.logger.log(`Completing upload ${objectId} with ${parts.length} parts`);

    // Record chunks in database
    await Promise.all(
      parts.map((part) =>
        this.prisma.storageObjectChunk.upsert({
          where: {
            objectId_partNumber: {
              objectId,
              partNumber: part.partNumber,
            },
          },
          create: {
            objectId,
            partNumber: part.partNumber,
            eTag: part.eTag,
            size: BigInt(0), // We don't know exact part size from client
          },
          update: {
            eTag: part.eTag,
          },
        }),
      ),
    );

    // Complete upload with storage provider
    await this.storageProvider.completeMultipartUpload(
      storageObject.storageKey,
      storageObject.s3UploadId,
      parts,
    );

    // Update status to processing
    const updated = await this.prisma.storageObject.update({
      where: { id: objectId },
      data: { status: 'processing' },
    });

    // Emit event for post-processing
    this.eventEmitter.emit(
      OBJECT_UPLOADED_EVENT,
      new ObjectUploadedEvent(updated),
    );

    // Create audit event
    await this.createAuditEvent(userId, 'storage:upload:complete', objectId, {
      name: updated.name,
      size: updated.size.toString(),
      mimeType: updated.mimeType,
      partsCount: parts.length,
    });

    this.logger.log(`Upload completed: ${objectId}`);

    return this.mapToResponseDto(updated);
  }

  /**
   * Abort multipart upload
   */
  async abortUpload(objectId: string, userId: string): Promise<void> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Check ownership
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    if (!storageObject.s3UploadId) {
      throw new BadRequestException('Upload ID not found');
    }

    this.logger.log(`Aborting upload ${objectId}`);

    // Abort with storage provider
    await this.storageProvider.abortMultipartUpload(
      storageObject.storageKey,
      storageObject.s3UploadId,
    );

    // Delete database records
    await this.prisma.storageObject.delete({
      where: { id: objectId },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'storage:upload:abort', objectId, {
      name: storageObject.name,
      status: storageObject.status,
    });

    this.logger.log(`Upload aborted: ${objectId}`);
  }

  /**
   * Simple upload for smaller files
   */
  async simpleUpload(
    file: MultipartFile,
    userId: string,
  ): Promise<ObjectResponseDto> {
    const { filename, mimetype, file: stream } = file;

    // Generate storage key
    const timestamp = Date.now();
    const uuid = randomUUID();
    const extension = extname(filename);
    const storageKey = `uploads/${timestamp}/${uuid}${extension}`;

    this.logger.log(`Simple upload starting: ${filename}`);

    // Upload to storage
    const result = await this.storageProvider.upload(storageKey, stream, {
      mimeType: mimetype,
    });

    // We don't know the size until after upload for streams
    // Use a default size of 0, should be updated in post-processing
    const storageObject = await this.prisma.storageObject.create({
      data: {
        name: filename,
        size: BigInt(0), // Will be updated by post-processing
        mimeType: mimetype,
        storageKey,
        storageProvider: 's3',
        bucket: result.bucket,
        status: 'processing',
        uploadedById: userId,
      },
    });

    // Emit event for post-processing
    this.eventEmitter.emit(
      OBJECT_UPLOADED_EVENT,
      new ObjectUploadedEvent(storageObject),
    );

    // Create audit event
    await this.createAuditEvent(userId, 'storage:upload:complete', storageObject.id, {
      name: storageObject.name,
      mimeType: storageObject.mimeType,
      uploadType: 'simple',
    });

    this.logger.log(`Simple upload completed: ${storageObject.id}`);

    return this.mapToResponseDto(storageObject);
  }

  /**
   * List user's objects with pagination and filtering
   */
  async list(
    query: ObjectListQueryDto,
    userId: string,
  ): Promise<ObjectListResponseDto> {
    const { page, pageSize, status, sortBy, sortOrder } = query;

    const skip = (page - 1) * pageSize;
    const take = pageSize;

    // ⚠ MANAGED OBJECTS ARE EXCLUDED (#21). A transcript's source audio, its
    // playback rendition and its exports are all `storage_objects` rows owned
    // by the same user, so without this filter one transcript turns into four
    // rows in a generic file list nobody asked for — each of them a file the
    // user cannot meaningfully act on here. The owning module lists its own.
    const where = {
      uploadedById: userId,
      managedBy: null,
      ...(status && { status }),
    };

    // Build orderBy clause
    const orderBy: any = {};
    if (sortBy === 'createdAt') {
      orderBy.createdAt = sortOrder;
    } else if (sortBy === 'name') {
      orderBy.name = sortOrder;
    } else if (sortBy === 'size') {
      orderBy.size = sortOrder;
    }

    const [items, totalItems] = await Promise.all([
      this.prisma.storageObject.findMany({
        where,
        orderBy,
        skip,
        take,
      }),
      this.prisma.storageObject.count({ where }),
    ]);

    const totalPages = Math.ceil(totalItems / pageSize);

    return {
      items: items.map((item) => this.mapToResponseDto(item)),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages,
      },
    };
  }

  /**
   * Get object by ID with ownership check
   */
  async getById(id: string, userId: string): Promise<ObjectResponseDto> {
    const object = await this.getObjectWithAuthCheck(id, userId);
    return this.mapToResponseDto(object);
  }

  /**
   * Get signed download URL for an object
   */
  async getDownloadUrl(
    id: string,
    userId: string,
    expiresIn?: number,
  ): Promise<DownloadUrlResponseDto> {
    const object = await this.getObjectWithAuthCheck(id, userId);

    // Verify status is ready
    if (object.status !== 'ready') {
      throw new BadRequestException(
        `Object is not ready for download. Current status: ${object.status}`,
      );
    }

    const defaultExpiry = this.config.get<number>(
      'storage.signedUrlExpiry',
      3600,
    );
    const expiry = expiresIn || defaultExpiry;

    const url = await this.storageProvider.getSignedDownloadUrl(
      object.storageKey,
      { expiresIn: expiry },
    );

    this.logger.log(`Generated download URL for object ${id}, expires in ${expiry}s`);

    return {
      url,
      expiresIn: expiry,
    };
  }

  /**
   * Delete object from storage and database
   */
  async delete(id: string, userId: string): Promise<void> {
    const object = await this.getObjectWithAuthCheck(id, userId);

    // ⚠ 409, NOT 403 AND NOT A SILENT SUCCESS. The caller genuinely owns these
    // bytes — the refusal is about the object's STATE (something else depends
    // on it), which is what 409 means. Deleting a transcript's source audio
    // through the generic endpoint leaves the transcript pointing at bytes
    // that no longer exist and nothing to repair it from.
    if (object.managedBy) {
      throw new ConflictException(
        `This object is managed by the ${object.managedBy} module and must be ` +
          `deleted through it, not through the generic storage endpoint`,
      );
    }

    this.logger.log(`Deleting object ${id} from storage and database`);

    // Abort an unfinished multipart upload BEFORE the row goes (#101).
    await this.abortActiveMultipartUpload(object);

    // Delete from storage provider
    await this.storageProvider.delete(object.storageKey);

    // Delete from database (cascade deletes chunks)
    await this.prisma.storageObject.delete({
      where: { id },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'storage:object:delete', id, {
      name: object.name,
      size: object.size.toString(),
      mimeType: object.mimeType,
    });

    this.logger.log(`Object deleted: ${id}`);
  }

  /**
   * Update object metadata
   */
  async updateMetadata(
    id: string,
    dto: UpdateMetadataDto,
    userId: string,
  ): Promise<ObjectResponseDto> {
    const object = await this.getObjectWithAuthCheck(id, userId);

    // Merge new metadata with existing
    const existingMetadata = (object.metadata as Record<string, unknown>) || {};
    const mergedMetadata = {
      ...existingMetadata,
      ...dto.metadata,
    };

    // Update in database
    const updated = await this.prisma.storageObject.update({
      where: { id },
      data: { metadata: mergedMetadata as Prisma.InputJsonValue },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'storage:object:metadata:update', id, {
      name: object.name,
      metadataChanges: dto.metadata,
    });

    this.logger.log(`Updated metadata for object ${id}`);

    return this.mapToResponseDto(updated);
  }

  /**
   * Delete an object THE OWNING MODULE is responsible for (issue #21).
   *
   * The in-process counterpart to the 409 in {@link delete}: a managed object
   * still has to be deletable, just not by a client naming it directly. There
   * is no ownership check here because the caller is a module acting on its
   * own row, not a user acting on someone else's — but it MUST name the module
   * it believes owns the object, and a mismatch throws. That turns "the
   * transcripts module deleted an export belonging to some other feature" from
   * a possible bug into an impossible one.
   *
   * ⚠ NOT REACHABLE OVER HTTP, and must not become so. No controller calls it.
   */
  async deleteManagedObject(
    id: string,
    expectedManagedBy: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const object = await this.prisma.storageObject.findUnique({ where: { id } });

    if (!object) {
      throw new NotFoundException('Object not found');
    }

    if (object.managedBy !== expectedManagedBy) {
      throw new ConflictException(
        `Object ${id} is managed by ${object.managedBy ?? 'nobody'}, not by ` +
          `${expectedManagedBy}`,
      );
    }

    this.logger.log(
      `Deleting ${expectedManagedBy}-managed object ${id} from storage and database`,
    );

    // Abort an unfinished multipart upload BEFORE the row goes (#101).
    await this.abortActiveMultipartUpload(object);

    await this.storageProvider.delete(object.storageKey);
    await this.prisma.storageObject.delete({ where: { id } });

    if (actorUserId) {
      await this.createAuditEvent(actorUserId, 'storage:object:delete', id, {
        name: object.name,
        size: object.size.toString(),
        mimeType: object.mimeType,
        managedBy: expectedManagedBy,
      });
    }

    this.logger.log(`Managed object deleted: ${id}`);
  }

  // ===========================================================================
  // Multipart upload helpers (issue #21)
  // ===========================================================================
  //
  // ⚠ A NOTE ON WHAT `managed_by` DOES AND DOES NOT GATE.
  //
  // Only LIST and DELETE change for a managed object. `GET /:id`,
  // `GET /:id/download` and `PATCH /:id/metadata` stay reachable by the
  // object's owner, deliberately: the user owns the bytes, and the download URL
  // is exactly how the owning module's own UI plays back the audio it manages.
  // The two that change are the two where the generic endpoint would otherwise
  // ACT ON BEHALF of a module that knows better — cluttering a file list with
  // rows the user cannot interpret, and destroying a row another feature
  // depends on. Reading your own file is neither.

  /** Is this object still an upload a client can push parts to? */
  private isUploadActive(status: string): boolean {
    return status === 'pending' || status === 'uploading';
  }

  /**
   * Abort the provider-side multipart upload of an object that is still being
   * uploaded, ahead of deleting its row (issue #101).
   *
   * ⚠ ABORT BEFORE DELETE, NEVER AFTER — the same ordering
   * `StorageCleanupHandler.sweep` uses. The row is the only record of
   * `s3UploadId`: an unfinished upload has no object at `storageKey` yet, so
   * `storageProvider.delete` removes nothing, and dropping the row afterwards
   * orphans the upload and every billed part with nothing left able to name
   * them. With this order a failed abort THROWS, the row survives, and the
   * stale-upload sweep (which targets `pending`/`uploading` rows) retries it.
   *
   * An upload the provider no longer knows about — already aborted, completed,
   * or expired by a bucket lifecycle rule — is the outcome an abort exists to
   * reach, so `NoSuchUpload` counts as success rather than wedging the delete
   * forever.
   */
  private async abortActiveMultipartUpload(object: {
    id: string;
    storageKey: string;
    s3UploadId: string | null;
    status: string;
  }): Promise<void> {
    if (!object.s3UploadId || !this.isUploadActive(object.status)) {
      return;
    }

    try {
      await this.storageProvider.abortMultipartUpload(
        object.storageKey,
        object.s3UploadId,
      );
    } catch (error) {
      if (!this.isNoSuchUploadError(error)) {
        throw error;
      }

      this.logger.log(
        `Multipart upload for object ${object.id} is already gone; continuing with delete`,
      );
    }
  }

  /**
   * Did the provider refuse an abort because the upload no longer exists?
   *
   * Matched on the SDK error's `name` and HTTP status rather than
   * `instanceof NoSuchUpload`, so an error from a second copy of the SDK (or a
   * plain object from a mock) is still recognised. The S3 provider rethrows
   * the SDK error unchanged, which is what keeps both fields intact.
   */
  private isNoSuchUploadError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const { name, $metadata } = error as {
      name?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };

    return name === 'NoSuchUpload' || $metadata?.httpStatusCode === 404;
  }

  /**
   * The part size THIS upload uses.
   *
   * Falls back to the configured size only for rows written before `part_size`
   * existed — never as a routine path, because reading the current setting is
   * exactly the bug that made a mid-flight configuration change renumber an
   * upload's parts.
   */
  private partSizeFor(object: { partSize: number | null }): number {
    return (
      object.partSize ?? this.config.get<number>('storage.partSize', 10485760)
    );
  }

  /** Part count derived from the size and part size on the row itself. */
  private totalPartsFor(object: { size: bigint; partSize: number | null }): number {
    return computeTotalParts(Number(object.size), this.partSizeFor(object));
  }

  /**
   * Mark an upload as still alive.
   *
   * An explicit write rather than a reliance on `@updatedAt`, because the
   * operations that prove a client is still there — signing a batch, polling
   * progress — otherwise change no column at all and so touch no timestamp.
   * The stale-upload sweep reads `updated_at`; without this it would be reading
   * the moment the upload STARTED under a different name.
   */
  private async touchUpload(objectId: string): Promise<void> {
    await this.prisma.storageObject.update({
      where: { id: objectId },
      data: { updatedAt: new Date() },
    });
  }

  /**
   * The parts list for a completion the client did not supply one for.
   *
   * Sorted ascending, because `CompleteMultipartUpload` rejects an out-of-order
   * list outright.
   */
  private async partsFromProvider(
    storageKey: string,
    uploadId: string,
  ): Promise<{ partNumber: number; eTag: string }[]> {
    const parts = await this.storageProvider.listParts(storageKey, uploadId);

    if (parts.length === 0) {
      throw new BadRequestException(
        'No uploaded parts found for this upload; upload at least one part ' +
          'before completing it',
      );
    }

    return parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((part) => ({ partNumber: part.partNumber, eTag: part.etag }));
  }

  /**
   * Helper method to get object with ownership check
   * @private
   */
  private async getObjectWithAuthCheck(
    id: string,
    userId: string,
  ): Promise<any> {
    const object = await this.prisma.storageObject.findUnique({
      where: { id },
    });

    if (!object) {
      throw new NotFoundException('Object not found');
    }

    // Check ownership
    if (object.uploadedById !== userId) {
      throw new ForbiddenException('You do not have access to this object');
    }

    return object;
  }

  /**
   * Map Prisma model to response DTO
   */
  private mapToResponseDto(obj: any): ObjectResponseDto {
    return {
      id: obj.id,
      name: obj.name,
      size: obj.size.toString(),
      mimeType: obj.mimeType,
      status: obj.status,
      metadata: obj.metadata as Record<string, unknown> | null,
      createdAt: obj.createdAt.toISOString(),
      updatedAt: obj.updatedAt.toISOString(),
    };
  }

  /**
   * Create audit event for storage operations
   */
  private async createAuditEvent(
    userId: string,
    action: string,
    objectId: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'storage_object',
        targetId: objectId,
        meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
