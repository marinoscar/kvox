import { createZodDto } from 'nestjs-zod';

import { composeSystemSettingsResponseSchema } from '../registry';

// =============================================================================
// GET /api/system-settings response (issue #459)
// =============================================================================
//
// COMPOSED from the system settings namespace registry: the derived `security`
// block first, every namespace's documented `responseSchema` in registration
// order, then the audit fields and the version. The OpenAPI-visible contract is
// therefore declared beside each namespace, not restated here. Published from
// the day a namespace exists rather than the day something reads it: a block
// the response omits is a block no client can echo back in a PUT, which would
// leave `replaceSettings` carrying it forward blind forever. Kept in step with
// the stored schema by `common/schemas/settings-parity.spec.ts`.
//
// ⚠ Composed at import time: `kvox.manifest` must have run first (the composer
// throws on an empty registry).
// =============================================================================

export const systemSettingsResponseSchema = composeSystemSettingsResponseSchema();

export class SystemSettingsResponseDto extends createZodDto(
  systemSettingsResponseSchema,
) {}
