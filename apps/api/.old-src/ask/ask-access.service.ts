// =============================================================================
// AskAccessService (issue #376, epic #348; docs/specs/ontology.md §12, §21)
// =============================================================================
//
// The only code path that authorises an Ask conversation or message. Every
// lookup is `WHERE id = $id AND owner_id = $user` — a missing id and another
// user's id answer the SAME 404 with the SAME byte-identical message, the
// `NoteAccessService`/`GraphAccessService` posture: a conversation derives
// from somebody's private recordings, and the existence of a specific id is
// itself something a stranger has no business learning. There is no sharing
// path and no `ask:read_any`, for any role.
//
// `requireMessage` joins through the conversation, so `ask.respond` (#378) and
// the SSE stream (#379) authorise a message by its conversation's owner and
// never by a column of their own.
//
// The service RETURNS THE ROW, so nothing above it needs to query
// `ask_conversations`/`ask_messages` on its own to authorise.
// =============================================================================

import { Injectable, NotFoundException } from '@nestjs/common';
import type { AskConversation, AskMessage } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** Verbatim, for every no-access answer. See the header. */
export const ASK_CONVERSATION_NOT_FOUND = 'Conversation not found';
export const ASK_MESSAGE_NOT_FOUND = 'Message not found';

/** A malformed id would be a Prisma 500 rather than a 404; refuse it as missing. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AskAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own conversation, or a 404. */
  async requireConversation(userId: string, conversationId: string): Promise<AskConversation> {
    if (typeof conversationId !== 'string' || !UUID_PATTERN.test(conversationId)) {
      throw new NotFoundException(ASK_CONVERSATION_NOT_FOUND);
    }
    const row = await this.prisma.askConversation.findFirst({
      where: { id: conversationId, ownerId: userId },
    });
    if (!row) throw new NotFoundException(ASK_CONVERSATION_NOT_FOUND);
    return row;
  }

  /** A message in one of the caller's own conversations, with that conversation, or a 404. */
  async requireMessage(
    userId: string,
    messageId: string,
  ): Promise<AskMessage & { conversation: AskConversation }> {
    if (typeof messageId !== 'string' || !UUID_PATTERN.test(messageId)) {
      throw new NotFoundException(ASK_MESSAGE_NOT_FOUND);
    }
    const row = await this.prisma.askMessage.findFirst({
      where: { id: messageId, conversation: { ownerId: userId } },
      include: { conversation: true },
    });
    if (!row) throw new NotFoundException(ASK_MESSAGE_NOT_FOUND);
    return row;
  }
}
