import { Injectable } from '@nestjs/common';
import type { IdentityProfileImages, UserDefaults } from '@marinoscar/platform-api/identity';
import { DEFAULT_USER_SETTINGS } from '@marinoscar/platform-api/settings';

import { normalizeProfileSettings, resolveProfileImageUrl } from '@marinoscar/platform-api/storage';

/**
 * Identity's `USER_DEFAULTS`: what a new user's `user_settings.value` holds at
 * creation: the settings slice's default document (#466).
 */
@Injectable()
export class KvoxUserDefaults implements UserDefaults {
  userSettings(): Record<string, unknown> {
    // A fresh object per user: the document is stored and later mutated.
    return structuredClone(DEFAULT_USER_SETTINGS) as unknown as Record<string, unknown>;
  }
}

/**
 * Identity's `IDENTITY_PROFILE_IMAGES`: which picture `/api/auth/me` and
 * `/api/users` report, over the storage slice's profile-image helpers
 * (`@marinoscar/platform-api/storage`, issue #367). The picture lives in
 * the user's settings (`profile.imageSource`) and in object storage, neither of
 * which identity owns.
 */
@Injectable()
export class KvoxProfileImages implements IdentityProfileImages {
  resolveImageUrl(
    user: { id: string; providerProfileImageUrl: string | null },
    storedProfile: unknown,
  ): string | null {
    return resolveProfileImageUrl(user, storedProfile);
  }

  hasUploadedImage(storedProfile: unknown): boolean {
    return normalizeProfileSettings(storedProfile).imageObjectId !== null;
  }
}
