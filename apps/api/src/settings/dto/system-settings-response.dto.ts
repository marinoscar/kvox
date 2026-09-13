import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const systemSettingsResponseSchema = z.object({
  security: z.object({
    jwtAccessTtlMinutes: z.number(),
    refreshTtlDays: z.number(),
  }),
  // #225, epic #215. Part of the represented resource, which is what makes a
  // PUT that omits it meaningful (and rejected) rather than a client simply not
  // knowing the field exists. Nothing enforces these values yet — that is #226.
  notifications: z.object({
    browserEnabled: z.boolean(),
    disabledEvents: z.array(z.string()),
  }),
  // #256, epic #254 — the operations namespaces. Published from the day they
  // exist rather than the day something reads them: a block the response omits
  // is a block no client can echo back in a PUT, which would leave
  // `replaceSettings` carrying it forward blind forever. Restated here rather
  // than imported for the same reason the request bodies are — this is the
  // OpenAPI-visible contract — and kept in step by
  // `common/schemas/settings-parity.spec.ts`.
  jobs: z.object({
    history: z.object({
      retentionDays: z.number(),
      purgeEnabled: z.boolean(),
    }),
    stuckThresholdMinutes: z.number(),
  }),
  nodes: z.object({
    staleHeartbeatSeconds: z.number(),
    offlineStaleMultiplier: z.number(),
    offlineRetentionDays: z.number(),
    jobSecretBrokerEnabled: z.boolean(),
  }),
  databaseBackup: z.object({
    enabled: z.boolean(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    dayOfWeek: z.number(),
    dayOfMonth: z.number(),
    timeOfDay: z.string(),
    timezone: z.string(),
    retentionCount: z.number(),
    storageProvider: z.string(),
    runStaleMinutes: z.number(),
    compressionLevel: z.number(),
    restoreRollbackMode: z.enum(['retain_database', 'drop_database']),
    oldDatabaseRetentionHours: z.number(),
    nodeOffloadEnabled: z.boolean(),
  }),
  maintenance: z.object({
    enabled: z.boolean(),
    message: z.string(),
    allowAdmins: z.boolean(),
    startedAt: z.string().nullable(),
    startedById: z.string().nullable(),
  }),
  updatedAt: z.iso.datetime(),
  updatedBy: z
    .object({
      id: z.string().uuid(),
      email: z.string().email(),
    })
    .nullable(),
  version: z.number(),
});

export class SystemSettingsResponseDto extends createZodDto(
  systemSettingsResponseSchema,
) {}
