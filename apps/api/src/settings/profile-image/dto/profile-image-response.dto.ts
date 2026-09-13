import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { userSettingsResponseSchema } from '../../dto/user-settings-response.dto';

/**
 * Body of `POST` and `DELETE /api/user-settings/profile-image` (#367), inside
 * the global `{ data }` envelope: the updated settings plus the picture that
 * now represents the user (same resolution as `GET /api/auth/me`).
 */
export const profileImageResponseSchema = z.object({
  settings: userSettingsResponseSchema,
  // Same-origin path (`/api/users/<id>/avatar/<objectId>`), provider URL, or null.
  profileImageUrl: z.string().nullable(),
});

export class ProfileImageResponseDto extends createZodDto(
  profileImageResponseSchema,
) {}
