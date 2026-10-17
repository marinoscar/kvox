// =============================================================================
// AskMessagesService (issue #378, epic #348; docs/specs/ontology.md §21.3)
// =============================================================================
//
// `POST /api/ask/conversations/:id/messages`: one question in, one queued
// `ask.respond` turn out. Nothing here calls a provider — the answer is
// written by the job into the assistant row's durable buffer, and the stream
// (#379) is a view over that row (CLAUDE.md Notes rule 1).
//
// Order of checks, each with its status:
//
//   1. `AskAccessService.requireConversation` → 404 (missing and foreign are
//      byte-identical);
//   2. `GraphAiRunResolver.resolve(user, 'ask.respond', model)` (the AI port's `resolveTask`) → 409
//      `graph_disabled` / `ai_not_configured` / `ai_key_missing` /
//      `model_lacks_capability` (the task requires `toolCalling`; a
//      model this deployment does not permit answers the same 409) — the bodies the retired task
//      resolver answered with, so a client maps one set of reasons across every
//      connected-knowledge route;
//   3. ONE transaction: the user message, the `pending` assistant message, the
//      `ask.respond` job (`enqueueWithin`) and the assistant row's `job_id`,
//      the derived title, and the conversation's `updated_at`. A second
//      running turn violates `ask_messages_one_running_turn_uniq_idx` → 409
//      `ask_turn_running` — decided by the index at insert, never by a lookup
//      first, which could not close the race two tabs open.
//
// ⚠ THE JOB IS ENQUEUED INSIDE THE TRANSACTION, not after it (a deliberate
// tightening of the issue's "after commit"): a `pending` assistant row whose
// enqueue failed after commit would hold the partial unique index forever and
// 409 every later question in the conversation. In one transaction there is
// either a pending turn WITH its job, or neither. The job row is invisible to
// the claim query until commit, so it cannot run ahead of its own row.
// =============================================================================

import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';

import { GraphAiRunResolver, isUniqueViolation } from '../graph/index.js';
import { KVOX_JOBS, KVOX_PRISMA, type KvoxJobsPort } from '../ports/index.js';
import { AskAccessService } from './ask-access.service.js';
import { ASK_DERIVED_TITLE_MAX_CHARS, ASK_RESPOND_PRIORITY } from './ask-limits.js';
import { toAskMessage } from './ask-message.mapper.js';
import type { KvoxAskDb } from './data/ask-db.js';
import type { PostAskMessage, PostAskMessageResponse } from './dto/ask-messages.dto.js';
import { ASK_MESSAGE_SUBJECT, ASK_RESPOND_JOB_TYPE, type AskRespondPayload } from './job-types.js';

/**
 * The Ask-specific 409 reason (#376's `ASK_CONFLICT_REASONS`).
 *
 * @stability experimental
 */
export const ASK_TURN_RUNNING = 'ask_turn_running';

/** The title a conversation takes from its first question: whitespace collapsed, at most 80 characters. */
export function deriveTitle(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= ASK_DERIVED_TITLE_MAX_CHARS) return text;
  return `${text.slice(0, ASK_DERIVED_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * AskMessagesService: wiring the slice registers itself; a host configures it through `AskModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class AskMessagesService {
  private readonly logger = new Logger(AskMessagesService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxAskDb,
    private readonly access: AskAccessService,
    private readonly resolver: GraphAiRunResolver,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
  ) {}

  async post(userId: string, conversationId: string, dto: PostAskMessage): Promise<PostAskMessageResponse> {
    const conversation = await this.access.requireConversation(userId, conversationId);

    // Every 409 here is the product's own refusal for the Ask task (`graph_disabled`,
    // `ai_not_configured`, `ai_key_missing`, `model_lacks_capability`), built before any row is
    // written. The resolver's answer is what the job will be re-validated against.
    const resolution = await this.resolver.resolve(userId, 'ask.respond', dto.model ?? null);

    // Two distinct instants: both rows would otherwise share the
    // transaction's `now()`, and the conversation orders by
    // `(created_at, id)` — a random id could put the answer before its question.
    const askedAt = new Date();
    const answerAt = new Date(askedAt.getTime() + 1);

    const { userMessage, assistantMessage } = await this.prisma.$transaction(async (tx) => {
      const userRow = await tx.askMessage.create({
        data: { conversationId, role: 'user', status: 'complete', content: dto.content, createdAt: askedAt },
      });

      let assistantRow;
      try {
        assistantRow = await tx.askMessage.create({
          data: {
            conversationId,
            role: 'assistant',
            status: 'pending',
            model: resolution.model,
            provider: resolution.providerId,
            createdAt: answerAt,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            message: 'This conversation is still answering your previous question. Wait for it to finish, then ask again.',
            details: { reason: ASK_TURN_RUNNING },
          });
        }
        throw err;
      }

      const payload: AskRespondPayload = {
        assistantMessageId: assistantRow.id,
        conversationId,
        userId,
        model: resolution.model,
        providerId: resolution.providerId,
        reasoningEffort: resolution.reasoningEffort,
      };
      // An AI job on the asker's own key; it touches no stored object, so the host files it under
      // no organization.
      const job = await this.jobs.enqueueWithin(tx, {
        type: ASK_RESPOND_JOB_TYPE,
        reason: 'upload',
        subjectType: ASK_MESSAGE_SUBJECT,
        subjectId: assistantRow.id,
        priority: ASK_RESPOND_PRIORITY,
        payload: payload as unknown as Record<string, unknown>,
      });
      const withJob = await tx.askMessage.update({ where: { id: assistantRow.id }, data: { jobId: job.id } });

      if (conversation.title === null) {
        // `title: null` in the WHERE: a rename that landed since the read wins.
        await tx.askConversation.updateMany({
          where: { id: conversationId, ownerId: userId, title: null },
          data: { title: deriveTitle(dto.content) },
        });
      }
      await tx.askConversation.updateMany({
        where: { id: conversationId, ownerId: userId },
        data: { updatedAt: new Date() },
      });

      return { userMessage: userRow, assistantMessage: withJob };
    });

    this.logger.log({
      msg: 'ask turn queued',
      conversationId,
      messageId: assistantMessage.id,
      jobId: assistantMessage.jobId,
      model: resolution.model,
      source: resolution.source,
    });

    return { userMessage: toAskMessage(userMessage), assistantMessage: toAskMessage(assistantMessage) };
  }
}
