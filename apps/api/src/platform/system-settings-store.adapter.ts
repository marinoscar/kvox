import { Injectable } from '@nestjs/common';
import type {
  SystemSettingsSnapshot,
  SystemSettingsStore,
} from '@marinoscar/platform-api/core';

import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

/**
 * The platform's `SYSTEM_SETTINGS_STORE` over this app's CURRENT
 * `SystemSettingsService` (PLATFORM-ADOPTION-SHIM(#466)).
 *
 * #466 moves the settings slice into the platform; until then a packaged slice
 * that reads or patches a settings namespace goes through this app's service, which
 * keeps its validation, `If-Match` check and audit trail. #466 deletes this
 * file.
 */
@Injectable()
export class SystemSettingsStoreAdapter implements SystemSettingsStore {
  constructor(private readonly settings: SystemSettingsService) {}

  async read(namespace: string): Promise<SystemSettingsSnapshot> {
    const current = (await this.settings.getSettings()) as unknown as Record<string, unknown> & {
      version: number;
    };

    return { value: current[namespace], version: current.version };
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
