import { createZodDto } from 'nestjs-zod';

import { composeUserSettingsResponseSchema } from '../registry';

// =============================================================================
// GET /api/user-settings response (issue #459)
// =============================================================================
//
// COMPOSED from the user settings namespace registry: `theme`, `profile`
// (always present; `imageObjectId` is `null` when no avatar has been uploaded),
// then every namespace's documented response branch, then `updatedAt` and
// `version`.
//
// A namespace is emitted ONLY when the user has stored something for it, and
// ABSENT HERE IS INFORMATION, NOT AN OMISSION: it tells the client the user has
// expressed no opinion, so every control derives its state from the registry
// default rather than from a defaulted local object (#126). For `onboarding`
// (#272, #271) the absent key is how a client knows this user has never been
// onboarded and the welcome dialog is due, so the service omits the key rather
// than emitting `{}`. For `graph` (#369) absent means every default; the client
// resolves them itself.
//
// ⚠ Composed at import time: `kvox.manifest` must have run first.
// =============================================================================

export const userSettingsResponseSchema = composeUserSettingsResponseSchema();

export class UserSettingsResponseDto extends createZodDto(
  userSettingsResponseSchema,
) {}
