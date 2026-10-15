import { createZodDto } from 'nestjs-zod';

import type {
  TypedObjectSchema,
  UserProfileSettingsPatchValue,
} from '../../common/schemas/settings.schema';
import type { UserSettingsValue } from '../../common/types/settings.types';
import {
  composePatchUserSettingsSchema,
  composeUpdateUserSettingsSchema,
  markUserSettingsRequestBodiesComposed,
  type UserSettingsNamespaces,
} from '../registry';

// =============================================================================
// User settings request bodies (issue #459)
// =============================================================================
//
// COMPOSED from the user settings namespace registry (`settings/registry/`):
// `theme` and `profile` are core fields, and every registered namespace
// contributes its own PUT and PATCH branch (`putSchema ?? schema`,
// `wirePatchSchema ?? patchSchema`), declared beside the module that owns it.
//
// PUT states the settings in full, so `null` has no "delete" meaning there:
// omit a namespace to store nothing for it. PATCH is JSON Merge Patch style:
// each namespace's outer `.nullable()` lets `{ "dataTables": null }` clear the
// whole namespace, and each namespace's own patch schema defines the deletes
// below that (`dataTables: { jobs: null }`, `notifications: { email: null }`,
// `onboarding: { dismissedAt: null }`, `graph: { resolution: null }`, ...). The
// merge itself is the namespace's `merge` hook, run by `UserSettingsService`.
//
// `profile.imageSource: 'upload'` requires `imageObjectId` to name an avatar
// the caller uploaded (checked by the service: 400 otherwise). Omitting
// `imageObjectId` keeps the stored one; `null` clears it. A PATCH merges
// field-wise, and switching `imageSource` away from `upload` keeps
// `imageObjectId`, so switching back needs no second upload.
//
// ⚠ Composed at import time: `kvox.manifest` must have run first (the composers
// throw on an empty registry). `markUserSettingsRequestBodiesComposed()` then
// makes a namespace registered later a loud error, not a silent strip on every
// write.
// =============================================================================

/** The PUT body: the settings in full. */
export type UpdateUserSettingsBody = UserSettingsValue;

/**
 * The PATCH body. A namespace's patch shape belongs to its declaration, and the
 * service hands it straight to that namespace's `merge`, so it is `unknown`
 * here.
 */
export type PatchUserSettingsBody = {
  theme?: UserSettingsValue['theme'];
  profile?: UserProfileSettingsPatchValue;
} & { [K in keyof UserSettingsNamespaces]?: unknown };

// Full replacement (PUT)
export const updateUserSettingsSchema =
  composeUpdateUserSettingsSchema() as unknown as TypedObjectSchema<UpdateUserSettingsBody>;

// Partial update (PATCH) - JSON Merge Patch style
export const patchUserSettingsSchema =
  composePatchUserSettingsSchema() as unknown as TypedObjectSchema<PatchUserSettingsBody>;

markUserSettingsRequestBodiesComposed();

export class UpdateUserSettingsDto extends createZodDto(
  updateUserSettingsSchema,
) {}

export class PatchUserSettingsDto extends createZodDto(
  patchUserSettingsSchema,
) {}
