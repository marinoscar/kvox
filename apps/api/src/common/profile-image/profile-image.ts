import {
  PROFILE_IMAGE_SOURCES,
  type ProfileImageSource,
  type UserProfileSettingsValue,
} from '../schemas/settings.schema';

// =============================================================================
// Profile image (#367) — pure helpers shared by settings, auth and users
// =============================================================================
//
// Pure functions with no Nest dependencies on purpose: `AuthService`,
// `UsersService` and `UserSettingsService` all need them, and none of those
// should have to import a module (and its providers) to answer "which URL
// represents this user?".

/** `storage_objects.metadata.purpose` stamped on every uploaded avatar. */
export const AVATAR_PURPOSE = 'avatar';

/** Hard ceiling on an uploaded avatar, in bytes. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Storage key prefix for a user's avatars. Only the profile-image upload
 * endpoint writes under it, so a key outside this prefix is never treated as
 * an avatar — even if its metadata was edited to say `purpose: 'avatar'`
 * through the generic storage metadata endpoint.
 */
export function avatarKeyPrefix(userId: string): string {
  return `avatars/${userId}/`;
}

/** Same-origin URL at which an uploaded avatar is served publicly. */
export function avatarUrl(userId: string, objectId: string): string {
  return `/api/users/${userId}/avatar/${objectId}`;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** The subset of a `storage_objects` row needed to judge an avatar. */
export interface AvatarCandidate {
  uploadedById: string | null;
  storageKey: string;
  status: string;
  mimeType: string;
  metadata: unknown;
}

/**
 * Whether `object` is a usable avatar belonging to `userId`: owned by them,
 * written by the avatar upload path (key prefix + purpose), `ready`, and of a
 * validated image type.
 */
export function isAvatarObjectFor(
  object: AvatarCandidate | null | undefined,
  userId: string,
): boolean {
  if (!object) return false;
  const metadata =
    object.metadata && typeof object.metadata === 'object'
      ? (object.metadata as Record<string, unknown>)
      : {};
  return (
    object.uploadedById === userId &&
    object.storageKey.startsWith(avatarKeyPrefix(userId)) &&
    metadata.purpose === AVATAR_PURPOSE &&
    object.status === 'ready' &&
    AVATAR_MIME_TYPES.includes(object.mimeType as AvatarMimeType)
  );
}

// -----------------------------------------------------------------------------
// Settings normalisation
// -----------------------------------------------------------------------------

/**
 * Normalised `profile` — `imageObjectId` is always present (`null` when none).
 */
export type NormalizedProfileSettings = UserProfileSettingsValue & {
  imageObjectId: string | null;
};

/**
 * Normalise a stored `profile` value into the #367 shape.
 *
 * Rows written before #367 carry `useProviderImage` (and an unused
 * `customImageUrl`) instead of `imageSource`. They are translated here, on
 * read, rather than by a data migration: `useProviderImage === false` becomes
 * `none`, anything else `provider`. The legacy keys are dropped, so the first
 * write after this ships stores the new shape.
 */
export function normalizeProfileSettings(raw: unknown): NormalizedProfileSettings {
  const profile =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const imageSource: ProfileImageSource = PROFILE_IMAGE_SOURCES.includes(
    profile.imageSource as ProfileImageSource,
  )
    ? (profile.imageSource as ProfileImageSource)
    : profile.useProviderImage === false
      ? 'none'
      : 'provider';

  const normalized: NormalizedProfileSettings = {
    imageSource,
    imageObjectId: isUuid(profile.imageObjectId) ? profile.imageObjectId : null,
  };

  if (typeof profile.displayName === 'string') {
    normalized.displayName = profile.displayName;
  }

  return normalized;
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

export interface ProfileImageUser {
  id: string;
  providerProfileImageUrl: string | null;
}

/**
 * The single rule for "which picture represents this user":
 *
 *  - `none`     → `null`
 *  - `provider` → the provider picture, or `null`
 *  - `upload`   → the same-origin avatar URL, or `null` without an object id
 *
 * `users.profile_image_url` is deliberately NOT consulted: nothing writes it.
 * Accepts a raw stored `profile` (or nothing, for a user without a settings
 * row) and normalises it first.
 */
export function resolveProfileImageUrl(
  user: ProfileImageUser,
  rawProfile: unknown,
): string | null {
  const profile = normalizeProfileSettings(rawProfile);
  switch (profile.imageSource) {
    case 'none':
      return null;
    case 'upload':
      return profile.imageObjectId
        ? avatarUrl(user.id, profile.imageObjectId)
        : null;
    case 'provider':
    default:
      return user.providerProfileImageUrl ?? null;
  }
}

// -----------------------------------------------------------------------------
// Image type detection (magic bytes)
// -----------------------------------------------------------------------------

export const AVATAR_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

export interface DetectedImageType {
  mimeType: AvatarMimeType;
  extension: 'jpg' | 'png' | 'gif' | 'webp';
}

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => buffer[offset + i] === byte);
}

/**
 * Identify an image by its leading bytes. The client's declared MIME type and
 * filename are never consulted — they are whatever the uploader says they are.
 * Returns `null` for anything that is not JPEG, PNG, GIF or WebP (SVG, which is
 * text and can carry script, is rejected by construction).
 */
export function detectImageType(buffer: Buffer): DetectedImageType | null {
  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  // GIF: "GIF87a" / "GIF89a"
  if (
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  // WebP: "RIFF" <4-byte size> "WEBP"
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}
