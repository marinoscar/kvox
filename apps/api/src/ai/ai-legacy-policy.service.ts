// =============================================================================
// PLATFORM-ADOPTION-SHIM(#477): the old `ai` policy, read and written beside the platform
// =============================================================================
//
// Until #474 moves the data and #477 deletes this module, the OLD AI code
// (`AiSettingsService`, `AiConfigService`, `AiTaskModelResolver`, the graph, notes
// and search callers) still reads the `ai` namespace in the shape this app stored
// before #473: `provider`, `providers.openai.{baseUrl, allowedModels, defaultModel}`,
// plus the fields #473 kept (`enabled`, `taskModels`, `graphEnabled`, the limits).
//
// The platform now OWNS the `ai` namespace (its own shape, plus this app's
// extension), and its reads SALVAGE a stored value into that shape: the legacy
// `provider` and `providers.openai.allowedModels` are not part of it and read back
// as nothing. So the old code reads and writes the SAME `global` row, the SAME `ai`
// key, directly:
//
//   • `getAiPolicy()` parses the raw `ai` block with the legacy schema, field by
//     field (a damaged field degrades to its default; the rest survive), exactly
//     as the registry's `readNamespace` did for the old declaration;
//   • `patchSettings()` merges the legacy fields over the raw block (every key the
//     platform owns is carried forward untouched), bumps the row `version`,
//     enforces `If-Match` and writes the same `system_settings:patch` audit event
//     the platform service writes.
//
// The platform's own writes carry the legacy keys forward too (the platform
// service restores every unknown key when it saves), so the two sides coexist on
// one row until #474 migrates the data.
//
// The shape of this file is `getAiPolicy` / `patchSettings` on purpose: they are the
// two `SystemSettingsService` methods the old service called, so its unit specs
// (which hand it a mock with those names) are unchanged.
// =============================================================================

import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import {
  systemAiSchema,
  type SystemAiPatchValue,
  type SystemAiValue,
} from './ai-settings.schema';

/** The legacy `ai` block of a fresh deployment (the old namespace's defaults, verbatim). */
export const LEGACY_AI_DEFAULTS: SystemAiValue = {
  enabled: false,
  provider: 'openai',
  providers: {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      allowedModels: [],
      defaultModel: 'gpt-5.4-mini',
    },
  },
  maxInputTokens: null,
  maxOutputTokens: null,
  requestTimeoutMs: 600_000,
  reasoningEffort: 'none',
  maxDocumentBytes: 26_214_400,
  taskModels: {},
  graphEnabled: false,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The legacy policy out of whatever is stored under `ai`: every field that parses
 * is kept, every field that does not (or is absent) takes its default.
 */
export function readLegacyAiPolicy(stored: unknown): SystemAiValue {
  const source = asRecord(stored) ?? {};
  const whole = systemAiSchema.safeParse({
    ...LEGACY_AI_DEFAULTS,
    ...source,
    providers: {
      openai: {
        ...LEGACY_AI_DEFAULTS.providers.openai,
        ...(asRecord(asRecord(source.providers)?.openai) ?? {}),
      },
    },
  });
  if (whole.success) return whole.data;

  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(systemAiSchema.shape)) {
    const candidate = key in source ? source[key] : undefined;
    const parsed = candidate === undefined ? undefined : schema.safeParse(candidate);
    out[key] = parsed?.success
      ? parsed.data
      : structuredClone(LEGACY_AI_DEFAULTS[key as keyof SystemAiValue]);
  }
  return out as unknown as SystemAiValue;
}

/**
 * The `ai` PATCH merge, field by field (the old namespace's `merge`, moved here by
 * #473).
 *
 * `provider`, `maxInputTokens` and `maxOutputTokens` test `!== undefined`, never
 * `??`: `null` is a VALUE there ("no provider is active", "the selected model's own
 * maximum"). `allowedModels` and `taskModels` REPLACE wholesale when present
 * (RFC 7396's rule for arrays), so `[]` / `{}` clears them.
 */
export function mergeAiSettings(current: SystemAiValue, patch?: SystemAiPatchValue): SystemAiValue {
  return {
    enabled: patch?.enabled ?? current.enabled,
    provider: patch?.provider !== undefined ? patch.provider : current.provider,
    providers: {
      openai: {
        baseUrl: patch?.providers?.openai?.baseUrl ?? current.providers.openai.baseUrl,
        allowedModels: patch?.providers?.openai?.allowedModels ?? current.providers.openai.allowedModels,
        defaultModel: patch?.providers?.openai?.defaultModel ?? current.providers.openai.defaultModel,
      },
    },
    maxInputTokens:
      patch?.maxInputTokens !== undefined ? patch.maxInputTokens : current.maxInputTokens,
    maxOutputTokens:
      patch?.maxOutputTokens !== undefined ? patch.maxOutputTokens : current.maxOutputTokens,
    requestTimeoutMs: patch?.requestTimeoutMs ?? current.requestTimeoutMs,
    reasoningEffort: patch?.reasoningEffort ?? current.reasoningEffort,
    maxDocumentBytes: patch?.maxDocumentBytes ?? current.maxDocumentBytes,
    taskModels: patch?.taskModels ?? current.taskModels,
    graphEnabled: patch?.graphEnabled ?? current.graphEnabled,
  };
}

@Injectable()
export class AiLegacyPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  /** The stored policy in the legacy shape, degraded field by field to defaults. */
  async getAiPolicy(): Promise<SystemAiValue> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
      select: { value: true },
    });
    return readLegacyAiPolicy(asRecord(row?.value)?.ai);
  }

  /**
   * Merges `dto.ai` into the legacy fields of the `ai` block and saves the row.
   * Same contract as `SystemSettingsService.patchSettings` for the `ai` namespace:
   * `If-Match` against the row `version` (409 on a mismatch), `version` bumped, one
   * `system_settings:patch` audit event.
   */
  async patchSettings(
    dto: { ai: SystemAiPatchValue },
    userId: string,
    expectedVersion?: number,
  ): Promise<void> {
    let row = await this.prisma.systemSettings.findUnique({ where: { key: 'global' } });
    if (!row) {
      // Never seeded: the platform service creates the default row on a read.
      await this.systemSettings.getSettings();
      row = await this.prisma.systemSettings.findUnique({ where: { key: 'global' } });
    }
    if (!row) throw new ConflictException('The system settings row could not be created');

    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw new ConflictException(
        `Settings version mismatch. Expected ${expectedVersion}, found ${row.version}`,
      );
    }

    const root = asRecord(row.value) ?? {};
    const storedAi = asRecord(root.ai) ?? {};
    const merged = mergeAiSettings(readLegacyAiPolicy(storedAi), dto.ai);

    // Every key the platform owns (`keyPolicy`, `defaults`, `limits`, the other
    // provider slots, `defaultModel`, ...) is carried forward; only the legacy
    // fields are replaced.
    const storedOpenAi = asRecord(asRecord(storedAi.providers)?.openai) ?? {};
    const nextAi = {
      ...storedAi,
      ...merged,
      providers: {
        ...(asRecord(storedAi.providers) ?? {}),
        openai: { ...storedOpenAi, ...merged.providers.openai },
      },
    };
    const value = { ...root, ai: nextAi } as unknown as Prisma.InputJsonValue;

    const saved = await this.prisma.systemSettings.update({
      where: { key: 'global' },
      data: { value, updatedByUserId: userId, version: { increment: 1 } },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'system_settings:patch',
        targetType: 'system_settings',
        targetId: saved.id,
        meta: { changes: dto, resultingValue: value } as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
