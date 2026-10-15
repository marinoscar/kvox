import { Injectable } from '@nestjs/common';
import type {
  NormalizedProfileSettings,
  SettingsProfileImages,
} from '@marinoscar/platform-api/settings';

import {
  isAvatarObjectFor,
  normalizeProfileSettings,
} from '../../common/profile-image/profile-image';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The settings slice's `SETTINGS_PROFILE_IMAGES` port: how a stored `profile` is
 * normalised and whether a referenced picture is a usable uploaded avatar
 * (issue #466).
 *
 * PLATFORM-ADOPTION-SHIM(#469): wraps this app's `common/profile-image` helpers
 * until the storage slice's `ProfileImageModule` owns the upload route and the
 * avatar check.
 */
@Injectable()
export class SettingsProfileImagesAdapter implements SettingsProfileImages {
  constructor(private readonly prisma: PrismaService) {}

  normalize(stored: unknown): NormalizedProfileSettings {
    return normalizeProfileSettings(stored);
  }

  async isUploadedAvatar(userId: string, objectId: string): Promise<boolean> {
    const object = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      select: {
        uploadedById: true,
        storageKey: true,
        status: true,
        mimeType: true,
        metadata: true,
      },
    });
    return isAvatarObjectFor(object, userId);
  }
}
