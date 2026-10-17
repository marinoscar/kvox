import { Inject, Injectable } from '@nestjs/common';

import { KVOX_PRISMA } from '../../ports/index.js';
import type { KvoxAskDb } from '../data/ask-db.js';

/**
 * The count of rows an account-data deletion removed.
 *
 * @stability experimental
 */
export interface AskUserDataDeletion {
  /** Conversations removed. */
  conversations: number;
  /** Messages removed with them (the foreign key cascades). */
  messages: number;
}

/**
 * AskUserDataService: the Ask slice's side of the host's account-data deletion.
 *
 * Ask owns nothing outside the database (no stored objects, no queued work that outlives a
 * conversation), so deleting an account's Ask data is one inline statement, done FIRST in the
 * deletion order: the conversations and, by the `conversation_id` cascade, every message. A
 * turn still running simply finds its row gone and stops (`AskTurnGone`).
 *
 * The web edition's user-data planner deletes `ask_conversations` itself from the hint in
 * `apps/api/src/kvox/ask/user-data.ts`; a host without a planner calls this.
 *
 * @extensionPoint
 * @stability experimental
 */
@Injectable()
export class AskUserDataService {
  constructor(@Inject(KVOX_PRISMA) private readonly prisma: KvoxAskDb) {}

  /**
   * Deletes every Ask conversation and message the account owns. Idempotent.
   *
   * @param userId - the account.
   * @returns how many conversations and messages went.
   */
  async deleteAll(userId: string): Promise<AskUserDataDeletion> {
    return this.prisma.$transaction(async (tx) => {
      const messages = await tx.askMessage.count({ where: { conversation: { ownerId: userId } } });
      const deleted = await tx.askConversation.deleteMany({ where: { ownerId: userId } });

      return { conversations: deleted.count, messages };
    });
  }
}
