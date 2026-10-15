// =============================================================================
// Ask conversations in the Danger Zone (issue #376, epic #348; declared here by
// issue #460)
// =============================================================================
//
// The `ask` user-data category: what `GET /api/user-data/summary` reports as
// `askConversations` and what `user.data.purge` deletes first. It used to be a
// `case 'ask'` in `user-data/job-types.ts`, a count in `UserDataService` and a
// private method of `UserDataPurgeHandler`; those three now live here, and
// `kvox.manifest.ts` registers `ASK_USER_DATA_CATEGORY` with the user-data
// category registry. `AskUserDataHooks` is provided by `AskModule`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { auditUserData } from '../user-data/user-data.support';

@Injectable()
export class AskUserDataHooks {
  private readonly logger = new Logger(AskUserDataHooks.name);

  constructor(private readonly prisma: PrismaService) {}

  /** `askConversations` in `GET /api/user-data/summary`. */
  async summarize(userId: string): Promise<{ count: number }> {
    // #376: saved Ask conversations (their messages go with them).
    const count = await this.prisma.askConversation.count({ where: { ownerId: userId } });

    return { count };
  }

  /**
   * Delete every one of the user's saved Ask conversations (#376, epic #348).
   *
   * INLINE rather than a job of its own: it is one indexed `DELETE` on
   * `ask_conversations (owner_id, …)` inside this already-queued job, and every
   * message goes with its conversation through the `conversation_id` Cascade —
   * a turn still streaming included (`ask.respond` returns normally when its
   * row is gone). Counts only in the audit, never content.
   */
  async purge(userId: string): Promise<void> {
    // #376: Ask conversations go first — inline, one indexed DELETE. Nothing
    // else depends on the order: a message carries no FK into `kg_*` besides
    // the conversation's SetNull scope.
    const { count } = await this.prisma.askConversation.deleteMany({ where: { ownerId: userId } });

    await auditUserData(this.prisma, userId, 'user_data:ask_conversations_deleted', { count });

    this.logger.warn(`User ${userId}: ${count} Ask conversation(s) deleted`);
  }
}
