import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  dataTablesSchema,
  dataTablesPatchSchema,
  navigationSchema,
  navigationPatchSchema,
  notificationsSchema,
  notificationsPatchSchema,
} from '../../common/schemas/user-settings-namespaces.schema';
import {
  userProfileSettingsSchema,
  userProfileSettingsPatchSchema,
} from '../../common/schemas/settings.schema';

// Full replacement (PUT)
export const updateUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  // `imageSource: 'upload'` requires `imageObjectId` to name an avatar the
  // caller uploaded (checked by the service — 400 otherwise). Omitting
  // `imageObjectId` keeps the stored one; `null` clears it.
  profile: userProfileSettingsSchema,
  // Optional namespaces. A PUT states the settings in full, so `null` has no
  // "delete" meaning here — omit the namespace to store nothing for it.
  dataTables: dataTablesSchema.optional(),
  navigation: navigationSchema.optional(),
  notifications: notificationsSchema.optional(),
});

export class UpdateUserSettingsDto extends createZodDto(
  updateUserSettingsSchema,
) {}

// Partial update (PATCH) - JSON Merge Patch style
export const patchUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  // Field-wise merge. Switching `imageSource` away from `upload` keeps
  // `imageObjectId`, so switching back needs no second upload.
  profile: userProfileSettingsPatchSchema.optional(),
  // `dataTables: null` clears the namespace; `dataTables: { jobs: null }`
  // deletes just that entry. Same pattern for `navigation`.
  dataTables: dataTablesPatchSchema.nullable().optional(),
  navigation: navigationPatchSchema.nullable().optional(),
  // `notifications` deletes at three levels (#126):
  //   `notifications: null`                        -> clear the namespace
  //   `notifications: { email: null }`             -> clear one channel
  //   `notifications: { email: { 'k': null } }`    -> delete one event key,
  //      restoring the absent (= registry default) state. This is what the
  //      preferences page sends when a toggle returns to its default; writing
  //      the default value instead would pin the user to it forever.
  notifications: notificationsPatchSchema.nullable().optional(),
});

export class PatchUserSettingsDto extends createZodDto(
  patchUserSettingsSchema,
) {}
