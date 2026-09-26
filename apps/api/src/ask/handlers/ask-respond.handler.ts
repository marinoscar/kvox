// =============================================================================
// `ask.respond` (issue #378, epic #348; docs/specs/ontology.md §11, §20, §21.3)
// =============================================================================
//
// One assistant turn of the read-only graph agent: a tool-calling loop over
// `AiProvider.chat()` (#359) with the `AskToolset` (#377), on the asking
// user's OWN AI key, writing the answer into `ask_messages.content` as it is
// generated. A turn takes several model calls and tool executions — tens of
// seconds — so under CLAUDE.md's "Every Long-Running Activity Is a Queue Job"
// it is a job, and the SSE stream (#379) is a VIEW over the row this writes
// (Notes rule 1): the turn completes identically whether anyone is watching.
//
//   load → re-resolve the model → key → user → `streaming` → history within
//   the input budget → register the per-user throttle key → loop:
//     call (`toolChoice: 'auto'`, or `'none'` once a cap is hit) →
//       tool calls? execute each (≤ 4), record each in `tool_calls` → again
//       else → the answer ends the loop
//   → validate + map citations → `complete` with `finish_reason` and tokens.
//
// -----------------------------------------------------------------------------
// `profile: { maxRuntimeMs: 5 min, maxAttempts: 1 }` — ONE ATTEMPT (Notes rule 2)
// -----------------------------------------------------------------------------
//
// A retry would bill the user's key a second time and, a completion being
// non-deterministic, show a DIFFERENT answer than the one they watched fail.
// Retry is a person asking again. Priority −10: somebody is watching.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, PERMANENTLY
// -----------------------------------------------------------------------------
//
// No `nodeResultSchema`/`persistNodeResult`: every call spends the user's own
// long-lived provider key, and no vendor offers a job-scoped sub-key a
// `nodeSecretBroker` could mint — `note.generate`'s reason exactly. It also
// reads the owner's graph through a dozen owner-scoped queries mid-loop.
//
// -----------------------------------------------------------------------------
// THE BUFFER IS APPEND-ONLY
// -----------------------------------------------------------------------------
//
// A connected reader addresses `content` by UTF-16 offset (#379), so every
// write's `content` starts with the previous one. That is why text a model
// emits BEFORE a tool call in the same call is held and discarded
// (`answer-hold.ts`), why invalid citation markers stay in the text (and are
// flagged in `citations`), and why a 429 after text was flushed FAILS the turn
// instead of deferring it: a restart would rewrite the buffer under a reader.
// Every write is `WHERE id = $id AND status = 'streaming'`, so a deleted
// conversation (the row cascades away) stops the loop with no orphan write.
//
// -----------------------------------------------------------------------------
// OUTCOMES — all failures keep any streamed text
// -----------------------------------------------------------------------------
//
//   row gone / not `pending`            → return (idempotent, at-least-once)
//   resolver 409/400 at run time        → `failed` (`auth` for a missing key,
//                                          else `other`), return
//   `AiAuthError`                       → `failed`/`auth`, return
//   `AiRefusedError` / `content_filter` → `failed`/`refusal`, return
//   `AiBudgetError`                     → `failed`/`budget`, return
//   call timeout                        → `failed`/`timeout`, return
//   `AiInputError`                      → `failed`/`other`, return
//   `RateLimitError`, nothing flushed   → back to `pending`, RETHROWN (the
//                                          queue defers without an attempt)
//   `RateLimitError`, text flushed      → `failed`/`rate_limit`, return
//   anything else                       → `failed`/`other`, RETHROWN
//
// PRIVACY (§14/§15): the model only ever sees tool results, which carry
// handles, never ids, and never a `sensitive` PersonFact (enforced in every
// tool, #377). The handler never imports a write service — read-only end to end.
//
// ⚠ Logged per turn: `{ messageId, steps, toolCalls, citations,
// invalidCitations, promptTokens, completionTokens, ms }` — numbers only,
// never the question, the answer, a tool argument or a result.
// =============================================================================

import { HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Prisma, type AskErrorClass, type AskFinishReason, type Job } from '@prisma/client';

import { AiAuthError, AiBudgetError, AiInputError, AiRefusedError } from '../../ai/ai-errors';
import { AiTaskModelResolver, type AiModelResolution } from '../../ai/ai-task-model-resolver.service';
import {
  createProviderContext,
  type AiChatMessage,
  type AiChatRequest,
  type AiProviderContext,
  type AiToolCall,
  type AiUsage,
} from '../../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import { toRequestUser, type AuthenticatedUser, type RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { resolveServiceName } from '../../common/otel/service-name';
import { READABLE_ENTITY_STATUSES } from '../../graph/read/readable';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { StreamFlusher } from '../../notes/generation/stream-flusher';
import { budgetRefusalMessage, computeTokenBudget } from '../../notes/generation/token-budget';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { PrismaService } from '../../prisma/prisma.service';
import { fitToBudget, messageTokens, MESSAGE_OVERHEAD_TOKENS, selectHistory, type AskHistoryRow } from '../ask-history';
import {
  ASK_CALL_TIMEOUT_MS,
  ASK_HISTORY_MESSAGES,
  ASK_MAX_OUTPUT_TOKENS,
  ASK_MAX_TOOL_CALLS_PER_STEP,
  ASK_MAX_TOOL_STEPS,
  ASK_RESPOND_MAX_RUNTIME_MS,
  ASK_TOOL_RESULT_MAX_TOKENS,
  ASK_WALL_CLOCK_SOFT_MS,
} from '../ask-limits';
import { ASK_FORCED_ANSWER_LINE, buildAskSystemPrompt, type AskPromptScope } from '../ask-prompt';
import { AnswerHold } from '../answer-hold';
import { citationSourceRequest, loadCitationSources, mapCitations, parseCitationMarkers } from '../citations';
import type { AskCitation, AskToolCall } from '../dto/ask.dto';
import { ASK_RESPOND_JOB_TYPE, readAskRespondPayload, type AskRespondPayload } from '../job-types';
import type { AskToolContext } from '../tools/ask-tool';
import { ASK_TOOL_ARGUMENTS_MAX_CHARS, AskToolset, type AskToolExecution } from '../tools/ask-toolset';

const tracer = trace.getTracer(resolveServiceName());

/**
 * Input tokens that must remain before a call may request tools: room for the
 * most one step can add (every call's arguments and its result at the cap),
 * so the forced final call always fits.
 */
export const ASK_STEP_RESERVE_TOKENS = ASK_MAX_TOOL_CALLS_PER_STEP * (ASK_TOOL_RESULT_MAX_TOKENS + 400 + 2 * MESSAGE_OVERHEAD_TOKENS);

/** The `ok: false` answer an extra tool call in one step gets, without running. */
export const TOO_MANY_TOOL_CALLS_ERROR = `Too many tool calls in one step. At most ${ASK_MAX_TOOL_CALLS_PER_STEP} run per step; call the rest in your next step if you still need them.`;

/** How many earlier rows are read to build the history (turns, failed ones, the current pair). */
const HISTORY_READ_ROWS = ASK_HISTORY_MESSAGES * 2 + 8;

/** A terminal, already-classified outcome: the turn is `failed`, the job returns. */
export class AskTurnFailure extends Error {
  constructor(
    readonly errorClass: AskErrorClass,
    message: string,
  ) {
    super(message);
    this.name = 'AskTurnFailure';
  }
}

/** The assistant row is gone (conversation deleted) or no longer `streaming`: stop, write nothing. */
class AskTurnGone extends Error {
  constructor() {
    super('The assistant message is gone or no longer streaming');
    this.name = 'AskTurnGone';
  }
}

/** Which class a thrown value fails the turn with. Total; never throws. */
export function classifyAskError(error: unknown): AskErrorClass {
  if (error instanceof AskTurnFailure) return error.errorClass;
  if (error instanceof AiAuthError) return 'auth';
  if (error instanceof AiRefusedError) return 'refusal';
  if (error instanceof AiBudgetError) return 'budget';
  if (isTimeout(error)) return 'timeout';
  return 'other';
}

/** A domain outcome the job returns from; everything else is rethrown as a bug. */
function isDomainFailure(error: unknown): boolean {
  return (
    error instanceof AskTurnFailure ||
    error instanceof AiAuthError ||
    error instanceof AiRefusedError ||
    error instanceof AiBudgetError ||
    error instanceof AiInputError ||
    isTimeout(error)
  );
}

/** `AbortSignal.timeout()` rejects with a `TimeoutError` DOMException (an `AbortError` on older runtimes). */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Mutable per-turn state the failure path needs. */
interface TurnState {
  messageId: string;
  flusher: StreamFlusher;
  /** Characters of `content` known to be in the row. */
  flushedChars: number;
  toolCalls: AskToolCall[];
  promptTokens: number;
  completionTokens: number;
  steps: number;
}

@Injectable()
export class AskRespondHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(AskRespondHandler.name);

  readonly type = ASK_RESPOND_JOB_TYPE;

  /** See the header. Two numbers, and deliberately only two. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: ASK_RESPOND_MAX_RUNTIME_MS, maxAttempts: 1 };

  /** The wall clock, milliseconds. A seam for the caps' tests. */
  clock: () => number = () => Date.now();

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly resolver: AiTaskModelResolver,
    private readonly credentials: UserAiCredentialsService,
    private readonly throttle: ProviderThrottleService,
    private readonly toolset: AskToolset,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    // No `registerProviderKey` here: the bucket is PER USER, known only once a
    // job runs — registered in `process`, immediately before the first call.
  }

  async process(job: Job): Promise<void> {
    const payload = readAskRespondPayload(job.payload);
    if (!payload) {
      this.logger.warn(`${ASK_RESPOND_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }

    const row = await this.prisma.askMessage.findFirst({
      where: {
        id: payload.assistantMessageId,
        conversationId: payload.conversationId,
        role: 'assistant',
        conversation: { ownerId: payload.userId },
      },
      include: { conversation: true },
    });
    if (!row) {
      this.logger.log(`${ASK_RESPOND_JOB_TYPE} message ${payload.assistantMessageId} is gone; job ${job.id} is a no-op`);
      return;
    }
    if (row.status !== 'pending') {
      this.logger.log(`${ASK_RESPOND_JOB_TYPE} message ${row.id} is already ${row.status}; job ${job.id} is a no-op`);
      return;
    }

    const state: TurnState = {
      messageId: row.id,
      flusher: new StreamFlusher({ now: () => this.clock() }),
      flushedChars: 0,
      toolCalls: [],
      promptTokens: 0,
      completionTokens: 0,
      steps: 0,
    };

    await tracer.startActiveSpan(ASK_RESPOND_JOB_TYPE, async (span) => {
      try {
        await this.respond(payload, row, state);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.name : 'error' });
        await this.settleFailure(error, state);
      } finally {
        span.setAttribute('steps', state.steps);
        span.setAttribute('tool_calls', state.toolCalls.length);
        span.setAttribute('tokens', state.promptTokens + state.completionTokens);
        span.end();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Failure
  // ---------------------------------------------------------------------------

  /** Maps a thrown value to the row's outcome, and rethrows exactly what the queue must see. */
  private async settleFailure(error: unknown, state: TurnState): Promise<void> {
    if (error instanceof AskTurnGone) {
      this.logger.log(`${ASK_RESPOND_JOB_TYPE} message ${state.messageId} vanished mid-turn; stopped`);
      return;
    }

    if (error instanceof RateLimitError) {
      if (state.flushedChars === 0) {
        // Nothing visible yet: an invisible deferral. Back to `pending` so the
        // queue's re-run starts clean; the throw defers without an attempt.
        await this.prisma.askMessage.updateMany({
          where: { id: state.messageId, status: 'streaming' },
          data: { status: 'pending', toolCalls: [], content: '' },
        });
        throw error;
      }
      await this.markFailedSafely(state, 'rate_limit');
      return;
    }

    const errorClass = classifyAskError(error);
    await this.markFailedSafely(state, errorClass);
    if (!isDomainFailure(error)) throw error;
  }

  private async markFailedSafely(state: TurnState, errorClass: AskErrorClass): Promise<void> {
    try {
      await this.prisma.askMessage.updateMany({
        where: { id: state.messageId, status: { in: ['pending', 'streaming'] } },
        data: {
          status: 'failed',
          errorClass,
          // `flusher.content` always starts with what was flushed, so this is an append.
          content: state.flusher.content,
          toolCalls: state.toolCalls as unknown as Prisma.InputJsonValue,
          promptTokens: state.promptTokens || null,
          completionTokens: state.completionTokens || null,
        },
      });
      this.logger.log({
        msg: 'ask turn failed',
        messageId: state.messageId,
        errorClass,
        steps: state.steps,
        toolCalls: state.toolCalls.length,
      });
    } catch (writeError) {
      // Never mask the original failure with the write's.
      this.logger.error({
        msg: 'ask turn failure could not be recorded',
        messageId: state.messageId,
        error: writeError instanceof Error ? writeError.name : 'error',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // The turn
  // ---------------------------------------------------------------------------

  private async respond(
    payload: AskRespondPayload,
    row: { id: string; createdAt: Date; conversation: { id: string; scopeEntityId: string | null } },
    state: TurnState,
  ): Promise<void> {
    const started = this.clock();
    const { userId } = payload;

    // 1. The model, RE-VALIDATED against today's policy (an administrator may
    //    have narrowed it since the request).
    const resolution = await this.resolveModel(userId, payload.model);
    const provider = resolution.provider;
    if (typeof provider.chat !== 'function') {
      throw new AskTurnFailure('other', `The "${provider.id}" provider cannot call tools, which Ask needs.`);
    }
    const settings = provider.settingsSchema.safeParse(
      (resolution.policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );
    if (!settings.success) {
      throw new AskTurnFailure('other', `This deployment's configuration for provider "${provider.id}" is invalid.`);
    }

    // 2. The user's own key, as late as possible and never stored.
    const apiKey = await this.credentials.getSecret(userId, provider.id);
    if (!apiKey) {
      throw new AskTurnFailure('auth', `No ${provider.label} API key is saved for your account.`);
    }

    // 3. The asker, with their CURRENT permissions — the tools authorise with them.
    const user = await this.loadUser(userId);

    // 4. `pending → streaming`, recording the model actually used (spec §20).
    const claimed = await this.prisma.askMessage.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'streaming', model: resolution.model, provider: resolution.providerId },
    });
    if (claimed.count === 0) throw new AskTurnGone();

    // 5. Tool context, with the scope entity pre-registered as `ent1`.
    const toolCtx = await this.toolset.createContext(user, {
      scopeEntityId: row.conversation.scopeEntityId,
      now: new Date(this.clock()),
      countTokens: resolution.countTokens,
    });
    const scope = await this.registerScope(userId, row.conversation.scopeEntityId, toolCtx);

    // 6. History within the input budget — refused, never truncated, when the
    //    question alone does not fit (Notes rule 4).
    const definitions = this.toolset.definitions();
    const toolDefinitionTokens = resolution.countTokens(JSON.stringify(definitions));
    const budget = computeTokenBudget({
      contextWindowTokens: resolution.descriptor.contextWindowTokens,
      modelMaxOutputTokens: resolution.descriptor.maxOutputTokens,
      policyMaxOutputTokens: Math.min(resolution.policy.maxOutputTokens, ASK_MAX_OUTPUT_TOKENS),
      policyMaxInputTokens: resolution.policy.maxInputTokens,
    });
    const { question, history } = await this.loadHistory(row);
    const fit = fitToBudget({
      system: buildAskSystemPrompt({ now: toolCtx.now, scope }),
      history,
      question,
      availableTokens: budget.availableInputTokens,
      reservedTokens: toolDefinitionTokens,
      countTokens: resolution.countTokens,
    });
    if (!fit.ok) {
      throw new AiBudgetError(
        budgetRefusalMessage({
          promptTokens: fit.requiredTokens,
          availableInputTokens: budget.availableInputTokens,
          model: resolution.model,
        }),
        fit.requiredTokens,
        budget.availableInputTokens,
        provider.id,
      );
    }

    // 7. THE PER-USER BUCKET, immediately before the first call (Notes rule 3).
    this.throttle.registerProviderKey(this.type, aiProviderThrottleKey(userId));

    const ctx = createProviderContext(apiKey, settings.data as never);
    const outcome = await this.loop({
      ctx,
      resolution,
      messages: fit.messages,
      toolCtx,
      state,
      started,
      availableInputTokens: budget.availableInputTokens,
      toolDefinitionTokens,
      maxOutputTokens: budget.maxOutputTokens,
    });

    // 8. Citations, checked against THIS turn's handles.
    const content = state.flusher.content;
    if (content.trim().length === 0) {
      throw new AskTurnFailure('refusal', `${provider.label} returned no answer.`);
    }
    const markers = parseCitationMarkers(content);
    const sources = await loadCitationSources(this.prisma, userId, citationSourceRequest(markers, toolCtx.handles));
    const citations = mapCitations(markers, toolCtx.handles, sources);

    // 9. Complete — the row and the conversation's `updated_at`, together.
    await this.complete(state, row.conversation.id, content, citations, outcome);

    this.logger.log({
      msg: 'ask turn complete',
      messageId: row.id,
      steps: state.steps,
      toolCalls: state.toolCalls.length,
      citations: citations.length,
      invalidCitations: citations.filter((c) => !c.valid).length,
      promptTokens: state.promptTokens,
      completionTokens: state.completionTokens,
      finishReason: outcome,
      droppedHistory: fit.droppedHistory,
      ms: this.clock() - started,
    });
  }

  /**
   * The tool-calling loop. Returns the finish reason; the answer is in
   * `state.flusher` (and flushed as it went).
   */
  private async loop(args: {
    ctx: AiProviderContext<never>;
    resolution: AiModelResolution;
    messages: AiChatMessage[];
    toolCtx: AskToolContext;
    state: TurnState;
    started: number;
    availableInputTokens: number;
    toolDefinitionTokens: number;
    maxOutputTokens: number;
  }): Promise<AskFinishReason> {
    const { resolution, state, toolCtx } = args;
    const provider = resolution.provider;
    const messages = [...args.messages];
    const definitions = this.toolset.definitions();
    const timeoutMs = Math.min(ASK_CALL_TIMEOUT_MS, resolution.policy.requestTimeoutMs);

    for (;;) {
      const used = messageTokens(messages, resolution.countTokens) + args.toolDefinitionTokens;
      const forced: AskFinishReason | null =
        state.steps >= ASK_MAX_TOOL_STEPS
          ? 'step_cap'
          : this.clock() - args.started >= ASK_WALL_CLOCK_SOFT_MS
            ? 'time_cap'
            : args.availableInputTokens - used < ASK_STEP_RESERVE_TOKENS
              ? 'token_cap'
              : null;

      const request: AiChatRequest = {
        model: resolution.model,
        messages: forced ? [...messages, { role: 'system', content: ASK_FORCED_ANSWER_LINE }] : messages,
        tools: definitions,
        toolChoice: forced ? 'none' : 'auto',
        maxOutputTokens: args.maxOutputTokens,
        timeoutMs,
        reasoningEffort: resolution.reasoningEffort,
      };

      const hold = new AnswerHold();
      const calls: AiToolCall[] = [];
      let finishReason: string | null = null;
      let firstEmit = true;
      const emit = async (text: string) => {
        if (!text) return;
        // A later call's answer continues an earlier one's on a new paragraph.
        const content = state.flusher.content;
        const joined = firstEmit && content.length > 0 && !/\s$/.test(content) ? `\n\n${text}` : text;
        firstEmit = false;
        state.flusher.append(joined);
        if (state.flusher.shouldFlush()) await this.flush(state);
      };

      for await (const event of provider.chat!(args.ctx, request)) {
        if (event.kind === 'delta') {
          await emit(hold.delta(event.text));
        } else if (event.kind === 'tool_call') {
          if (forced) {
            // `toolChoice: 'none'` was ignored; the turn is out of tool budget either way.
            this.logger.warn({ msg: 'ask tool call ignored after the cap', messageId: state.messageId });
            continue;
          }
          hold.toolCall();
          if (hold.lateToolCall) {
            this.logger.warn({ msg: 'ask tool call after the answer started; streamed text kept', messageId: state.messageId });
          }
          calls.push({ id: event.id, name: event.name, argumentsJson: event.argumentsJson });
        } else {
          addUsage(state, event.usage);
          finishReason = event.finishReason;
        }
      }
      await emit(hold.end());

      if (calls.length > 0) {
        await this.runToolStep(messages, hold.text, calls, toolCtx, state);
        state.steps += 1;
        continue;
      }

      await this.flush(state);
      if (finishReason === 'content_filter') {
        throw new AiRefusedError(`${provider.label} declined to finish this answer.`, undefined, provider.id);
      }
      if (finishReason === 'length') return 'token_cap';
      return forced ?? 'stop';
    }
  }

  /** Execute one step's calls in order, recording each immediately (so the stream can show it). */
  private async runToolStep(
    messages: AiChatMessage[],
    preamble: string,
    calls: AiToolCall[],
    toolCtx: AskToolContext,
    state: TurnState,
  ): Promise<void> {
    // The preamble goes back to the MODEL as its own words, never into `content`.
    messages.push({ role: 'assistant', content: preamble.trim() ? preamble : null, toolCalls: calls });
    for (const [i, call] of calls.entries()) {
      const startedAt = this.clock();
      const execution: AskToolExecution =
        i < ASK_MAX_TOOL_CALLS_PER_STEP
          ? await this.toolset.execute(toolCtx, call.name, call.argumentsJson)
          : { ok: false, error: TOO_MANY_TOOL_CALLS_ERROR, json: JSON.stringify({ error: TOO_MANY_TOOL_CALLS_ERROR }) };
      messages.push({ role: 'tool', toolCallId: call.id, content: execution.json });

      state.toolCalls.push({
        index: state.toolCalls.length,
        name: call.name.slice(0, 64),
        arguments: recordedArguments(call.argumentsJson),
        summary: execution.ok ? execution.result.summary : `Could not run ${call.name.slice(0, 64)}`,
        resultCount: execution.ok ? execution.result.resultCount : 0,
        durationMs: Math.max(0, Math.round(this.clock() - startedAt)),
        error: execution.ok ? null : execution.error,
      });
      const written = await this.prisma.askMessage.updateMany({
        where: { id: state.messageId, status: 'streaming' },
        data: { toolCalls: state.toolCalls as unknown as Prisma.InputJsonValue },
      });
      if (written.count === 0) throw new AskTurnGone();
    }
  }

  /** Write the buffer if it grew. Append-only: the new content extends the old. */
  private async flush(state: TurnState): Promise<void> {
    const content = state.flusher.content;
    if (content.length === state.flushedChars) {
      state.flusher.commit();
      return;
    }
    const written = await this.prisma.askMessage.updateMany({
      where: { id: state.messageId, status: 'streaming' },
      data: { content },
    });
    if (written.count === 0) throw new AskTurnGone();
    state.flushedChars = content.length;
    state.flusher.commit();
  }

  private async complete(
    state: TurnState,
    conversationId: string,
    content: string,
    citations: AskCitation[],
    finishReason: AskFinishReason,
  ): Promise<void> {
    const [written] = await this.prisma.$transaction([
      this.prisma.askMessage.updateMany({
        where: { id: state.messageId, status: 'streaming' },
        data: {
          status: 'complete',
          content,
          citations: citations as unknown as Prisma.InputJsonValue,
          toolCalls: state.toolCalls as unknown as Prisma.InputJsonValue,
          finishReason,
          promptTokens: state.promptTokens,
          completionTokens: state.completionTokens,
          errorClass: null,
        },
      }),
      this.prisma.askConversation.updateMany({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
    ]);
    if (written.count === 0) throw new AskTurnGone();
    state.flushedChars = content.length;
  }

  // ---------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------

  private async resolveModel(userId: string, model: string): Promise<AiModelResolution> {
    try {
      return await this.resolver.resolve(userId, 'graph.agent', model);
    } catch (error) {
      if (error instanceof HttpException) {
        const body = error.getResponse() as { details?: { reason?: string } } | string;
        const reason = typeof body === 'object' ? body.details?.reason : undefined;
        throw new AskTurnFailure(reason === 'ai_key_missing' ? 'auth' : 'other', error.message);
      }
      throw error;
    }
  }

  private async loadUser(userId: string): Promise<RequestUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } } },
    });
    if (!user || !user.isActive) throw new AskTurnFailure('other', 'This account is not active.');
    const requestUser = toRequestUser(user as unknown as AuthenticatedUser);
    if (!requestUser.permissions.includes(PERMISSIONS.GRAPH_READ)) {
      throw new AskTurnFailure('other', 'This account can no longer read its knowledge graph.');
    }
    return requestUser;
  }

  /** The scope entity as `ent1`, when it is still one of the owner's readable entities. */
  private async registerScope(
    ownerId: string,
    scopeEntityId: string | null,
    toolCtx: AskToolContext,
  ): Promise<AskPromptScope | null> {
    if (!scopeEntityId) return null;
    const entity = await this.prisma.kgEntity.findFirst({
      where: {
        id: scopeEntityId,
        ownerId,
        mergedIntoId: null,
        reviewStatus: { in: [...READABLE_ENTITY_STATUSES] },
      },
      select: { id: true, label: true, type: true },
    });
    if (!entity) return null;
    const handle = toolCtx.handles.register({ kind: 'ent', id: entity.id, label: entity.label });
    return { handle, label: entity.label, type: entity.type };
  }

  /** The current question and the replayable history before it. */
  private async loadHistory(row: { id: string; createdAt: Date; conversation: { id: string } }) {
    const recent = await this.prisma.askMessage.findMany({
      where: { conversationId: row.conversation.id, createdAt: { lte: row.createdAt } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HISTORY_READ_ROWS,
      select: { id: true, role: true, status: true, content: true },
    });
    const rows = recent.reverse();
    const at = rows.findIndex((r) => r.id === row.id);
    const before = at >= 0 ? rows.slice(0, at) : rows;
    const questionIndex = findLastIndex(before, (r) => r.role === 'user');
    if (questionIndex < 0 || before[questionIndex].content.trim().length === 0) {
      throw new AskTurnFailure('other', 'This answer has no question to answer.');
    }
    return {
      question: before[questionIndex].content,
      history: selectHistory(before.slice(0, questionIndex) as AskHistoryRow[], ASK_HISTORY_MESSAGES),
    };
  }
}

function addUsage(state: TurnState, usage: AiUsage): void {
  state.promptTokens += usage.promptTokens ?? 0;
  state.completionTokens += usage.completionTokens ?? 0;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i])) return i;
  return -1;
}

/** The arguments as the model sent them, for the tool-call list: an object, or `{}` when they were not one. */
export function recordedArguments(argumentsJson: string): Record<string, unknown> {
  if (typeof argumentsJson !== 'string' || argumentsJson.length > ASK_TOOL_ARGUMENTS_MAX_CHARS) return {};
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
