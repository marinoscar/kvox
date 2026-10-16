import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { UserAiKeysService } from '@marinoscar/platform-api/ai';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// Erasing a user's AI keys through the platform (issue #475, epic #472)
// =============================================================================
//
// The Danger Zone's `credentials` step ("delete everything") has to remove every
// AI key the user saved. Those keys live in `user_ai_keys`, which the platform's
// `UserAiKeysService` owns: it deletes the row and writes the `ai_key:delete`
// audit event, so this app does not delete the table itself.
//
// WHY A PURGER IN `platform/ai/` AND NOT THE HOOK CALLING THE SERVICE. The import
// of `@marinoscar/platform-api/ai` is confined to `ai-port/` and `platform/ai/`
// (the `ai-port-boundary` spec), so the user-data module asks this one narrow
// class instead of importing the AI slice.
//
// WHY `ModuleRef` AND NOT A CONSTRUCTOR PARAMETER. The service is provided by the
// AI slice's own sub-module, which `UserDataModule` has no reason to import (and
// which would drag the whole slice into its import list). `get(..., { strict:
// false })` finds it anywhere in the application graph, exactly as the user-data
// slice resolves a domain category's hooks.
// =============================================================================

@Injectable()
export class AiUserKeysPurger {
  private readonly logger = new Logger(AiUserKeysPurger.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The number of keys the user has saved, across providers. Read from the table,
   * not from the service's `list`, which answers nothing while AI or a provider
   * slot is switched off: a key saved earlier is still personal data to erase.
   */
  async count(userId: string): Promise<number> {
    return this.prisma.userAiKey.count({ where: { userId } });
  }

  /** Removes every key the user saved, one call per provider. Returns how many. */
  async removeAll(userId: string): Promise<number> {
    const keys = this.keys();
    const rows = await this.prisma.userAiKey.findMany({
      where: { userId },
      select: { provider: true },
    });

    for (const row of rows) {
      await keys.remove(userId, row.provider);
    }

    this.logger.log(`Removed ${rows.length} platform AI key(s) for user: ${userId}`);

    return rows.length;
  }

  private keys(): UserAiKeysService {
    return this.moduleRef.get(UserAiKeysService, { strict: false });
  }
}
