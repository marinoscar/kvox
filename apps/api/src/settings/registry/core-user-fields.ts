// =============================================================================
// Core user-settings fields: `theme` and `profile` (issue #459)
// =============================================================================
//
// `theme` and `profile` are not namespaces: every user document carries them,
// so the composers (`compose.ts`) place them ahead of the registered optional
// namespaces. They are DEFINED HERE (moved verbatim from
// `common/schemas/settings.schema.ts`, which re-exports them) so the composers
// can import them without importing `settings.schema.ts`, which composes its
// own schemas from the registry and would otherwise form an import cycle.
//
// Imports nothing but zod.
// =============================================================================

import { z } from 'zod';

/** `theme` as stored, patched, put and returned. */
export const themePreferenceSchema = z.enum(['light', 'dark', 'system']);

/**
 * Which picture represents the user (#367).
 *
 *  - `none`     — no picture; clients render initials.
 *  - `provider` — the OAuth provider's picture (`users.provider_profile_image_url`).
 *  - `upload`   — the avatar the user uploaded, `profile.imageObjectId`.
 */
export const PROFILE_IMAGE_SOURCES = ['none', 'provider', 'upload'] as const;

export const profileImageSourceSchema = z.enum(PROFILE_IMAGE_SOURCES);

export type ProfileImageSource = z.infer<typeof profileImageSourceSchema>;

/**
 * `profile` as stored. `imageObjectId` is nullable (no avatar uploaded, or it
 * was removed) and optional only so a PUT body may omit it — the service then
 * keeps the stored id rather than orphaning the uploaded object. Whether the id
 * names an avatar the caller owns is checked by `UserSettingsService`, not
 * here: it needs the database.
 */
export const userProfileSettingsSchema = z.object({
  displayName: z.string().max(100).optional(),
  imageSource: profileImageSourceSchema,
  imageObjectId: z.string().uuid().nullable().optional(),
});

export type UserProfileSettingsValue = z.infer<typeof userProfileSettingsSchema>;

export const userProfileSettingsPatchSchema = z.object({
  displayName: z.string().max(100).optional(),
  imageSource: profileImageSourceSchema.optional(),
  // `null` clears the reference; absent leaves it alone.
  imageObjectId: z.string().uuid().nullable().optional(),
});

export type UserProfileSettingsPatchValue = z.infer<
  typeof userProfileSettingsPatchSchema
>;

/**
 * `profile` as returned by `GET /api/user-settings`: the normalised form
 * (`normalizeProfileSettings`), where `imageObjectId` is always present.
 */
export const userProfileResponseSchema = z.object({
  displayName: z.string().nullable().optional(),
  imageSource: profileImageSourceSchema,
  // Always present in responses; `null` when no avatar has been uploaded.
  imageObjectId: z.string().uuid().nullable(),
});
