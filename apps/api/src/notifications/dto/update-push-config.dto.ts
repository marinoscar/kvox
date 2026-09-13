import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { vapidSubjectSchema } from '../push-config.schema';

// =============================================================================
// PUT /api/admin/push-config — request body (issue #355)
// =============================================================================
//
// A full replace of the two fields an admin actually controls day to day:
// whether Web Push is on, and the contact subject. NEITHER KEY is settable
// here — `publicKey` is server-derived (from `generate`/`rotate`) and the
// private key never travels through this DTO at all. This endpoint FLIPS THE
// SWITCH; it does not manufacture keys — see `PushConfigService.update`,
// which 409s if `enabled: true` is requested with no keys generated yet.
//
// `subject: null` is a real, persisted state ("use the generic fallback"),
// not an empty box to be stripped — unlike `email-settings`'s optional
// fields, there is no "leave it as it was" submission here: this is `PUT`
// (full replace), so every call states both fields explicitly.
// =============================================================================

export const updatePushConfigSchema = z.object({
  enabled: z.boolean(),
  subject: vapidSubjectSchema.nullable(),
});

/** The parsed PUT body. */
export type UpdatePushConfigInput = z.infer<typeof updatePushConfigSchema>;

export class UpdatePushConfigDto extends createZodDto(
  updatePushConfigSchema,
) {}
