import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';

import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import type { StorageProvider } from '../../storage/providers/storage-provider.interface';
import {
  isAvatarObjectFor,
  isUuid,
  normalizeProfileSettings,
} from '../../common/profile-image/profile-image';

export interface OpenedAvatar {
  stream: Readable;
  mimeType: string;
  size: bigint;
}

/**
 * Resolves an avatar request to stored bytes (#367).
 *
 * Two entry points share one lookup: `open` for the public URL and
 * `openStored` for the owner's authenticated settings preview.
 *
 * The URL is public (an `<img>` cannot send a bearer token), so the rule for
 * serving is deliberately narrow: the object must be the avatar that user has
 * CURRENTLY selected. A previously uploaded, replaced, or deselected picture
 * is not served, and every miss — malformed id, unknown user, wrong source,
 * wrong object, missing bytes — is the same 404 so the endpoint is not an
 * oracle for which users or objects exist.
 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
  ) {}

  /**
   * The public route: serves `objectId` only while it is the user's CURRENTLY
   * selected picture (`imageSource: 'upload'` and a matching object id).
   */
  async open(userId: string, objectId: string): Promise<OpenedAvatar> {
    if (!isUuid(userId) || !isUuid(objectId)) {
      throw this.notFound();
    }

    const profile = await this.loadProfile(userId);
    if (profile.imageSource !== 'upload' || profile.imageObjectId !== objectId) {
      throw this.notFound();
    }

    return this.openObject(userId, objectId);
  }

  /**
   * The authenticated preview: serves the caller's stored uploaded picture
   * (`profile.imageObjectId`) WHATEVER source is selected, so the settings UI
   * can preview the picture a user could switch back to. Never reachable by
   * anyone but the owner — `userId` comes from the authenticated principal,
   * not the URL — which is why it may be broader than `open`.
   */
  async openStored(userId: string): Promise<OpenedAvatar> {
    if (!isUuid(userId)) {
      throw this.notFound();
    }

    const { imageObjectId } = await this.loadProfile(userId);
    if (!imageObjectId) {
      throw this.notFound();
    }

    return this.openObject(userId, imageObjectId);
  }

  private async loadProfile(userId: string) {
    const settings = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { value: true },
    });
    return normalizeProfileSettings(
      (settings?.value as { profile?: unknown } | null | undefined)?.profile,
    );
  }

  /**
   * Object lookup, ownership check and download shared by both entry points.
   * Every miss is the same 404.
   */
  private async openObject(
    userId: string,
    objectId: string,
  ): Promise<OpenedAvatar> {
    const object = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });
    if (!object || !isAvatarObjectFor(object, userId)) {
      throw this.notFound();
    }

    try {
      const stream = await this.storageProvider.download(object.storageKey);
      return { stream, mimeType: object.mimeType, size: object.size };
    } catch (error) {
      this.logger.warn(
        `Avatar bytes unavailable for object ${objectId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw this.notFound();
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException('Not found');
  }
}
