import { Injectable } from '@nestjs/common';
import type { z } from 'zod';

import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { KVOX_AI_POLICY } from './ai-policy';

// =============================================================================
// KvoxAiSettings: the typed reader of the extended `ai` namespace (issue #475)
// =============================================================================
//
// One place a feature reads the fields this app adds to the platform's `ai`
// namespace (`graphEnabled`, `requestTimeoutMs`, `maxInputTokens`,
// `maxOutputTokens`, `reasoningEffort`, `maxDocumentBytes`, `taskModels`,
// `defaultModel`). It replaces every read of the retired `AiSettingsService`.
//
// It READS ONLY: a write goes through `AiTasksService.update` (versioned and
// audited by the platform settings service). It never returns a key; the
// namespace has no such field.
// =============================================================================

/** The value of the extended `ai` namespace. */
export type KvoxAiPolicyValue = z.output<typeof KVOX_AI_POLICY.storedSchema>;

@Injectable()
export class KvoxAiSettings {
  constructor(private readonly settings: SystemSettingsService) {}

  /** The whole extended namespace, salvaged field by field to its defaults when damaged. */
  get(): Promise<KvoxAiPolicyValue> {
    return this.settings.getNamespace(KVOX_AI_POLICY);
  }

  /** `ai.graphEnabled`: the connected-knowledge spending switch. */
  async graphEnabled(): Promise<boolean> {
    return (await this.get()).graphEnabled === true;
  }

  /** `ai.requestTimeoutMs`: the backstop for a wedged connection. */
  async requestTimeoutMs(): Promise<number> {
    return (await this.get()).requestTimeoutMs;
  }
}
