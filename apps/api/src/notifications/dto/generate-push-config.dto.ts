import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { vapidSubjectSchema } from '../push-config.schema';

// =============================================================================
// POST /api/admin/push-config/generate — request body (issue #355)
// =============================================================================
//
// First-time key generation. No confirmation literal here — unlike `rotate`
// and `remove`, generating a first key pair on an unconfigured deployment
// destroys nothing: it is refused outright (409) if keys already exist (see
// `PushConfigService.generate`), so there is no destructive default this
// route could be tricked into by a replay. `subject` is optional: an admin
// who wants the generic fallback simply omits it.
// =============================================================================

export const generatePushConfigSchema = z.object({
  /**
   * Optional VAPID subject to store alongside the newly generated key pair.
   * Omitted or `null` means "use the generic fallback" — see
   * `DEFAULT_VAPID_SUBJECT` in `../push-config.schema.ts`.
   */
  subject: vapidSubjectSchema.nullable().optional(),
});

export type GeneratePushConfigInput = z.infer<typeof generatePushConfigSchema>;

export class GeneratePushConfigDto extends createZodDto(
  generatePushConfigSchema,
) {}
