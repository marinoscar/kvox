import { Injectable } from '@nestjs/common';
import type {
  SystemSettingsSnapshot,
  SystemSettingsStore,
} from '@marinoscar/platform-api/core';

import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';

/** The `system_settings` row every system namespace lives in (`SettingsModule.forRoot({ systemRowKey })`). */
const SYSTEM_ROW_KEY = 'global';

/**
 * The platform's `SYSTEM_SETTINGS_STORE` over the platform
 * `SystemSettingsService` (issue #466): a packaged slice that reads or patches a
 * settings namespace goes through the settings slice, which keeps its
 * validation, `If-Match` check and audit trail.
 */
@Injectable()
export class SystemSettingsStoreAdapter implements SystemSettingsStore {
  constructor(
    private readonly settings: SystemSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * READ ONLY: it never creates the `global` row. `getSettings()` would (it
   * inserts the row when it is missing), and a read must not write: the Doctor
   * checks are asserted never to, and a packaged slice reads its namespace on
   * paths (a job, the capability probe) with no caller left to report a failed
   * insert to. A missing row reads as the namespace's defaults at version 0.
   */
  async read(namespace: string): Promise<SystemSettingsSnapshot> {
    const [value, row] = await Promise.all([
      this.settings.readNamespaceValue(namespace),
      this.prisma.systemSettings.findUnique({
        where: { key: SYSTEM_ROW_KEY },
        select: { version: true },
      }),
    ]);

    return { value, version: row?.version ?? 0 };
  }

  async patch(
    namespace: string,
    patch: Record<string, unknown>,
    ctx: { actorUserId: string; ifMatchVersion?: number },
  ): Promise<SystemSettingsSnapshot> {
    const updated = (await this.settings.patchSettings(
      { [namespace]: patch } as never,
      ctx.actorUserId,
      ctx.ifMatchVersion,
    )) as unknown as Record<string, unknown> & { version: number };

    return { value: updated[namespace], version: updated.version };
  }
}
