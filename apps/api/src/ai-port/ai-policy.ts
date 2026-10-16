import { AI_SYSTEM_SETTINGS } from '@marinoscar/platform-api/ai';

import { kvoxAiStoredSchema } from '../platform/ai/ai-settings.extension';

// =============================================================================
// The extended `ai` namespace, for typed reads (issue #473)
// =============================================================================
//
// `SystemSettingsService.getNamespace('ai')` is typed by the platform's own
// `SystemAiValue`, which cannot know the fields this app adds (an extension is a
// runtime fold, not a type augmentation). `getNamespace(declaration)` types the
// read from a declaration's `storedSchema` instead, so this object is the
// platform schema widened by the extension's fields. At run time only `key`
// matters: the registered (extended) namespace answers.
// =============================================================================

export const KVOX_AI_POLICY = {
  key: 'ai',
  storedSchema: AI_SYSTEM_SETTINGS.storedSchema.extend(kvoxAiStoredSchema.shape),
} as const;
