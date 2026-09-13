import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  dataTablesSchema,
  navigationSchema,
  notificationsSchema,
} from '../../common/schemas/user-settings-namespaces.schema';
import { profileImageSourceSchema } from '../../common/schemas/settings.schema';

export const userSettingsResponseSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().nullable().optional(),
    imageSource: profileImageSourceSchema,
    // Always present in responses; `null` when no avatar has been uploaded.
    imageObjectId: z.string().uuid().nullable(),
  }),
  // Emitted only when the user has stored something for the namespace; an
  // absent namespace means "client should apply its built-in defaults".
  dataTables: dataTablesSchema.optional(),
  navigation: navigationSchema.optional(),
  // Absent here is INFORMATION, not an omission: it tells the preferences page
  // the user has expressed no opinion, so every control derives its state from
  // the registry default rather than from a defaulted local object (#126).
  notifications: notificationsSchema.optional(),
  updatedAt: z.iso.datetime(),
  version: z.number(),
});

export class UserSettingsResponseDto extends createZodDto(
  userSettingsResponseSchema,
) {}
