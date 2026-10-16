// =============================================================================
// The telemetry slice's settings store (issue #471, epic #467)
// =============================================================================
//
// Telemetry reads and writes two things in `system_settings`:
//
//   * the `telemetry` NAMESPACE of the main row (`global`): read through
//     `SystemSettingsService`, written through its `patchSettings` so the write
//     keeps the settings slice's validation, `If-Match` re-check and audit row;
//   * its own KEYED ROW (`telemetry_connection`, the stored GreptimeDB host,
//     port, database and user; never a password): read raw so telemetry can
//     validate it itself, written through the `SystemSettingsRowStore`, which
//     validates, versions and audits the write.
//
// `readFeatureFlag` answers the five booleans `get_app_context` reports to the
// assistant. An explicit allowlist: the settings are never serialised wholesale.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { SystemSettingsRowStore, SystemSettingsService } from '@marinoscar/platform-api/settings';
import type {
  TelemetryFeatureFlag,
  TelemetrySettings,
  TelemetrySettingsProvenance,
  TelemetrySettingsRow,
  TelemetrySettingsStore,
} from '@marinoscar/platform-api/telemetry';

import { PrismaService } from '../../prisma/prisma.service';

/** The main `system_settings` row, as `settings.config.ts` configures it. */
const MAIN_ROW_KEY = 'global';

type FlagSource = Record<string, unknown> | undefined;

function asRecord(value: unknown): FlagSource {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

@Injectable()
export class TelemetrySettingsStoreAdapter implements TelemetrySettingsStore {
  constructor(
    private readonly settings: SystemSettingsService,
    private readonly rows: SystemSettingsRowStore,
    private readonly prisma: PrismaService,
  ) {}

  async getTelemetryPolicy(): Promise<TelemetrySettings> {
    return this.settings.getNamespace('telemetry');
  }

  async replaceTelemetryPolicy(
    next: TelemetrySettings,
    actorUserId: string,
    expectedVersion?: number,
  ): Promise<void> {
    // The full namespace as a patch: the merge replaces field by field, and an
    // explicit `null` clears `instanceId`, `assistant.provider` and `assistant.modelId`.
    await this.settings.patchSettings({ telemetry: next } as never, actorUserId, expectedVersion);
  }

  async readPolicyProvenance(): Promise<TelemetrySettingsProvenance | null> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: MAIN_ROW_KEY },
      select: {
        version: true,
        updatedAt: true,
        updatedByUser: { select: { id: true, email: true } },
      },
    });
    if (!row) return null;
    return {
      version: row.version,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedByUser
        ? { id: row.updatedByUser.id, email: row.updatedByUser.email }
        : null,
    };
  }

  async readRow(key: string): Promise<TelemetrySettingsRow | null> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key },
      select: {
        value: true,
        version: true,
        updatedAt: true,
        updatedByUser: { select: { id: true, email: true } },
      },
    });
    if (!row) return null;
    return {
      value: row.value,
      version: row.version,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedByUser
        ? { id: row.updatedByUser.id, email: row.updatedByUser.email }
        : null,
    };
  }

  async writeRow(key: string, value: unknown, actorUserId: string): Promise<void> {
    await this.rows.write(key, value, { actorId: actorUserId, schema: z.unknown() });
  }

  async deleteRow(key: string): Promise<void> {
    await this.prisma.systemSettings.deleteMany({ where: { key } });
  }

  async readFeatureFlag(flag: TelemetryFeatureFlag): Promise<boolean> {
    switch (flag) {
      case 'ai':
        return this.enabled('ai');
      case 'maintenanceMode':
        return this.enabled('maintenance');
      case 'databaseBackup':
        return this.enabled('databaseBackup');
      case 'browserNotifications': {
        const notifications = asRecord(await this.settings.readNamespaceValue('notifications'));
        const channels = asRecord(notifications?.channels);
        const browser = asRecord(channels?.browser);
        return (browser?.enabled ?? notifications?.browserEnabled) === true;
      }
      case 'nodeJobSecretBroker': {
        const nodes = asRecord(await this.settings.readNamespaceValue('nodes'));
        return nodes?.jobSecretBrokerEnabled === true;
      }
    }
  }

  private async enabled(namespace: string): Promise<boolean> {
    return asRecord(await this.settings.readNamespaceValue(namespace))?.enabled === true;
  }
}
