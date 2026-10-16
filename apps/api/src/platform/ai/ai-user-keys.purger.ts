import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { UserAiKeysService } from '@marinoscar/platform-api/ai';

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

  constructor(private readonly moduleRef: ModuleRef) {}

  /** The number of keys the user has saved, across providers. */
  async count(userId: string): Promise<number> {
    const views = await this.keys().list(userId);

    return views.filter((view) => view.configured).length;
  }

  /** Removes every key the user saved, one call per provider. Returns how many. */
  async removeAll(userId: string): Promise<number> {
    const keys = this.keys();
    const views = (await keys.list(userId)).filter((view) => view.configured);

    for (const view of views) {
      await keys.remove(userId, view.provider);
    }

    this.logger.log(`Removed ${views.length} platform AI key(s) for user: ${userId}`);

    return views.length;
  }

  private keys(): UserAiKeysService {
    return this.moduleRef.get(UserAiKeysService, { strict: false });
  }
}
