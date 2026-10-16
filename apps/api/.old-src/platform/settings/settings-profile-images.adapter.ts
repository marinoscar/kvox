import { Injectable } from '@nestjs/common';
import { resolveOrgId } from '@marinoscar/platform-api/identity';
import type {
  NormalizedProfileSettings,
  SettingsProfileImages,
} from '@marinoscar/platform-api/settings';
import { isAvatarObjectFor, normalizeProfileSettings } from '@marinoscar/platform-api/storage';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The settings slice's `SETTINGS_PROFILE_IMAGES` port: how a stored `profile` is
 * normalised and whether a referenced picture is a usable uploaded avatar
 * (issue #466), over the storage slice's profile-image helpers (issue #469).
 *
 * The object is read in the default organization's scope (`runInOrg`): an avatar
 * row is an org row under forced row-level security. This file is a platform
 * binding, one of the two places outside `kvox-objects/` that may name
 * `storageObject` (the tripwire in `test/kvox-objects/storage-boundary.spec.ts`).
 */
@Injectable()
export class SettingsProfileImagesAdapter implements SettingsProfileImages {
  constructor(private readonly prisma: PrismaService) {}

  normalize(stored: unknown): NormalizedProfileSettings {
    return normalizeProfileSettings(stored);
  }

  async isUploadedAvatar(userId: string, objectId: string): Promise<boolean> {
    const orgId = await resolveOrgId(this.prisma, null, 'SETTINGS_PROFILE_IMAGES');
    const object = await this.prisma.runInOrg({ orgId, userId }, (tx) =>
      tx.storageObject.findUnique({
        where: { id: objectId },
        select: {
          uploadedById: true,
          storageKey: true,
          status: true,
          mimeType: true,
          metadata: true,
        },
      }),
    );
    return isAvatarObjectFor(object, userId);
  }
}
