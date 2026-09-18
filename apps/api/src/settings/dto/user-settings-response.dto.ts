import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  dataTablesSchema,
  navigationSchema,
  notificationsSchema,
  onboardingSchema,
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
  // Absent here is INFORMATION too, and the epic's entry point (#272, #271):
  // no `onboarding` key at all is how a client knows this user has never been
  // onboarded and the welcome dialog is due. An emitted `{}` would say the
  // opposite of nothing, so the service omits the key rather than emitting it
  // empty — see `mergeOnboarding`.
  onboarding: onboardingSchema.optional(),
  updatedAt: z.iso.datetime(),
  version: z.number(),
});

export class UserSettingsResponseDto extends createZodDto(
  userSettingsResponseSchema,
) {}
