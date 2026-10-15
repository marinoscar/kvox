import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { composeUserSettingsResponseSchema } from '@marinoscar/platform-api/settings';

import '../../registry';

/**
 * Body of `POST` and `DELETE /api/user-settings/profile-image` (#367), inside
 * the global `{ data }` envelope: the updated settings plus the picture that
 * now represents the user (same resolution as `GET /api/auth/me`).
 */
export const profileImageResponseSchema = z.object({
  // The platform's composed `GET /api/user-settings` response (every registered
  // namespace), built after `../../registry` registered them (#466).
  settings: composeUserSettingsResponseSchema(),
  // Same-origin path (`/api/users/<id>/avatar/<objectId>`), provider URL, or null.
  profileImageUrl: z.string().nullable(),
});

export class ProfileImageResponseDto extends createZodDto(
  profileImageResponseSchema,
) {}
