// =============================================================================
// `ask.respond` (issue #378, epic #348; docs/specs/ontology.md §11, §20, §21.3; the package slice of issue #497, epic #491)
// =============================================================================
//
// One assistant turn of the read-only graph agent: a tool-calling loop over
// `KVOX_AI.chat` (`delta`, `tool_call`, `step_end`, `done`; the full history every
// call) with the `AskToolset` (#377), on the asking user's OWN AI key (the host
// resolves it per call; this file never sees it), writing the answer
// into `ask_messages.content` as it is generated. A turn takes several model calls and tool executions — tens of
// seconds — so under the root rules' "Every Long-Running Activity Is a Queue Job"
// it is a job, and the SSE stream (#379) is a VIEW over the row this writes
// (Notes rule 1): the turn completes identically whether anyone is watching.
//
//   load → resolve the model (re-checking policy and key) → asker's permissions →
//   `streaming` → history within the input budget → loop:
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
// No `nodeResultSchema`/`persistNodeResult` (the handler declares `usesAi`): every call spends the user's own
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
//   row gone / not `pending`                → return (idempotent, at-least-once)
//   model not ready at run time             → `failed` (`auth` for a missing key, else `other`), return
//   `KvoxAiError` `auth` / `key_missing`    → `failed`/`auth`, return
//   `KvoxAiError` `refusal` / content_filter → `failed`/`refusal`, return
//   `KvoxAiError` `budget`                  → `failed`/`budget`, return
//   `KvoxAiError` `timeout`, call backstop  → `failed`/`timeout`, return
//   `KvoxAiError` `rate_limit`, no text     → back to `pending`, `KvoxRateLimitError` on the ASKER's
//                                              bucket (`aiProviderThrottleKey`) RETHROWN: the queue
//                                              defers without an attempt
//   `KvoxAiError` `rate_limit`, text flushed → `failed`/`rate_limit`, return
//   anything else                           → `failed`/`other`, RETHROWN
//
// PRIVACY (§14/§15): the model only ever sees tool results, which carry
// handles, never ids, and never a `sensitive` PersonFact (enforced in every
// tool, #377). The handler never imports a write service — read-only end to end.
//
// ⚠ Logged per turn: `{ messageId, steps, toolCalls, citations,
// invalidCitations, promptTokens, completionTokens, ms }` — numbers only,
// never the question, the answer, a tool argument or a result.
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { StreamFlusher, aiProviderThrottleKey, budgetRefusalMessage, computeTokenBudget, OUTPUT_RESERVE_TOKENS } from '../../core/index.js';
import {
  GraphAiConflict,
  GraphAiRunResolver,
  READABLE_ENTITY_STATUSES,
  GRAPH_READ_PERMISSION,
  type GraphActor,
  type InputJsonValue,
} from '../../graph/index.js';
import { providerLabelOf } from '../../notes/index.js';
import {
  KVOX_AI,
  KVOX_IDENTITY,
  KVOX_JOBS,
  KVOX_PRISMA,
  KvoxAiBudgetError,
  KvoxAiError,
  KvoxRateLimitError,
  type KvoxAiContext,
  type KvoxAiPort,
  type KvoxAiUsage,
  type KvoxChatMessage,
  type KvoxIdentityPort,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
  type KvoxToolCallRef,
} from '../../ports/index.js';
import { NOTES_READ_PERMISSION } from '../../notes/index.js';
import { TRANSCRIPTS_READ_PERMISSION } from '../../transcripts/index.js';
import { fitToBudget, messageTokens, MESSAGE_OVERHEAD_TOKENS, selectHistory, toolArgumentsText, type AskHistoryRow } from '../ask-history.js';
import {
  ASK_CALL_TIMEOUT_MS,
  ASK_HISTORY_MESSAGES,
  ASK_MAX_OUTPUT_TOKENS,
  ASK_MAX_TOOL_CALLS_PER_STEP,
  ASK_MAX_TOOL_STEPS,
  ASK_RESPOND_MAX_RUNTIME_MS,
  ASK_TOOL_RESULT_MAX_TOKENS,
  ASK_WALL_CLOCK_SOFT_MS,
} from '../ask-limits.js';
import {
  ASK_FORCED_ANSWER_LINE,
  buildAskSystemPrompt,
  type AskPromptScope,
  type AskPromptSelectionItem,
} from '../ask-prompt.js';
import { resolveAskScope } from '../ask-scope.js';
import { ASK_MODULE_OPTIONS, type ResolvedAskOptions } from '../ask.options.js';
import { AnswerHold } from '../answer-hold.js';
import { citationSourceRequest, loadCitationSources, mapCitations, parseCitationMarkers } from '../citations.js';
import type { AskConversationRow, AskErrorClassValue, AskFinishReasonValue, AskMessageDbRow, KvoxAskDb } from '../data/ask-db.js';
import type { AskCitation, AskToolCall } from '../dto/ask.dto.js';
import { ASK_RESPOND_JOB_TYPE, readAskRespondPayload, type AskRespondPayload } from '../job-types.js';
import type { AskToolContext } from '../tools/ask-tool.js';
import { ASK_TOOL_ARGUMENTS_MAX_CHARS, AskToolset, type AskToolExecution } from '../tools/ask-toolset.js';
import { SEARCH_TRANSCRIPT_VISIBILITY, type SearchTranscriptVisibility } from '../../search/index.js';

/**
 * Input tokens that must remain before a call may request tools: room for the
 * most one step can add (every call's arguments and its result at the cap),
 * so the forced final call always fits.
 *
 * @param maxCallsPerStep - the tool calls one step may run (the product's 4, or fewer).
 * @returns the reserve, in tokens.
 */
export function stepReserveTokens(maxCallsPerStep: number): number {
  return maxCallsPerStep * (ASK_TOOL_RESULT_MAX_TOKENS + 400 + 2 * MESSAGE_OVERHEAD_TOKENS);
}

/** The reserve at the product's own step width. */
export const ASK_STEP_RESERVE_TOKENS = stepReserveTokens(ASK_MAX_TOOL_CALLS_PER_STEP);

/**
 * The `ok: false` answer an extra tool call in one step gets, without running.
 *
 * @param maxCallsPerStep - the tool calls one step may run.
 * @returns the sentence the model reads.
 */
export function tooManyToolCallsError(maxCallsPerStep: number): string {
  return `Too many tool calls in one step. At most ${maxCallsPerStep} run per step; call the rest in your next step if you still need them.`;
}

/** The `ok: false` answer an extra tool call in one step gets, at the product's own step width. */
export const TOO_MANY_TOOL_CALLS_ERROR = tooManyToolCallsError(ASK_MAX_TOOL_CALLS_PER_STEP);

/** How many earlier rows are read to build the history (turns, failed ones, the current pair). */
const HISTORY_READ_ROWS = ASK_HISTORY_MESSAGES * 2 + 8;

/** The permissions the tools consult for the asker: the graph itself and the two document types search reaches. */
const ACTOR_PERMISSION_PROBES = [GRAPH_READ_PERMISSION, TRANSCRIPTS_READ_PERMISSION, NOTES_READ_PERMISSION] as const;

/** A terminal, already-classified outcome: the turn is `failed`, the job returns. */
export class AskTurnFailure extends Error {
  constructor(
    readonly errorClass: AskErrorClassValue,
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
export function classifyAskError(error: unknown): AskErrorClassValue {
  if (error instanceof AskTurnFailure) return error.errorClass;
  if (error instanceof KvoxAiError) {
    switch (error.errorClass) {
      case 'auth':
      case 'key_missing':
        return 'auth';
      case 'refusal':
        return 'refusal';
      case 'budget':
        return 'budget';
      case 'timeout':
        return 'timeout';
      default:
        return 'other';
    }
  }
  if (isTimeout(error)) return 'timeout';
  return 'other';
}

/** A domain outcome the job returns from; everything else is rethrown as a bug. */
function isDomainFailure(error: unknown): boolean {
  if (error instanceof AskTurnFailure) return true;
  if (error instanceof KvoxAiError) {
    return (
      error.errorClass === 'auth' ||
      error.errorClass === 'key_missing' ||
      error.errorClass === 'refusal' ||
      error.errorClass === 'budget' ||
      error.errorClass === 'timeout' ||
      error.errorClass === 'not_configured' ||
      error.errorClass === 'capability'
    );
  }
  return isTimeout(error);
}

/** `AbortSignal.timeout()` rejects with a `TimeoutError` DOMException (an `AbortError` on older runtimes). */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** A provider rate limit, in either shape the port can raise it. */
function isRateLimit(error: unknown): error is KvoxRateLimitError | KvoxAiError {
  return error instanceof KvoxRateLimitError || (error instanceof KvoxAiError && error.errorClass === 'rate_limit');
}

/** Mutable per-turn state the failure path needs. */
interface TurnState {
  messageId: string;
  /** The asker: a rate limit is deferred on THEIR bucket and nobody else's. */
  userId: string;
  flusher: StreamFlusher;
  /** Characters of `content` known to be in the row. */
  flushedChars: number;
  toolCalls: AskToolCall[];
  promptTokens: number;
  completionTokens: number;
  steps: number;
}

/**
 * `ask.respond`: wiring the slice registers itself; a host configures it through `AskModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class AskRespondHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(AskRespondHandler.name);

  readonly type = ASK_RESPOND_JOB_TYPE;

  readonly label = 'Ask answer';

  /** Every call spends the asker's own provider key, so the job can never be offered to a worker node. */
  readonly usesAi = true;

  /** See the header. Two numbers, and deliberately only two. */
  readonly profile: KvoxJobProfile = { maxRuntimeMs: ASK_RESPOND_MAX_RUNTIME_MS, maxAttempts: 1 };

  /** The wall clock, milliseconds. A seam for the caps' tests. */
  clock: () => number = () => Date.now();

  private readonly maxSteps: number;

  private readonly maxCallsPerStep: number;

  private readonly softClockMs: number;

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxAskDb,
    @Inject(KVOX_AI) private readonly ai: KvoxAiPort,
    @Inject(KVOX_IDENTITY) private readonly identity: KvoxIdentityPort,
    private readonly resolver: GraphAiRunResolver,
    private readonly toolset: AskToolset,
    @Inject(SEARCH_TRANSCRIPT_VISIBILITY) private readonly visibility: SearchTranscriptVisibility,
    @Inject(ASK_MODULE_OPTIONS) options?: ResolvedAskOptions,
  ) {
    this.maxSteps = options?.limits.maxSteps ?? ASK_MAX_TOOL_STEPS;
    this.maxCallsPerStep = options?.limits.maxCallsPerStep ?? ASK_MAX_TOOL_CALLS_PER_STEP;
    this.softClockMs = options?.limits.softClockMs ?? ASK_WALL_CLOCK_SOFT_MS;
  }

  onModuleInit(): void {
    this.jobs.registerHandler(this);
    // No throttle key here: the bucket is PER USER, known only once a job runs. A provider rate
    // limit is raised as a `KvoxRateLimitError` on `aiProviderThrottleKey(userId)` (`settleFailure`),
    // which the host's job port registers with its throttle.
  }

  async process(job: KvoxJob): Promise<void> {
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
      userId: payload.userId,
      flusher: new StreamFlusher({ now: () => this.clock() }),
      flushedChars: 0,
      toolCalls: [],
      promptTokens: 0,
      completionTokens: 0,
      steps: 0,
    };

    try {
      await this.respond(payload, row as AskMessageDbRow & { conversation: AskConversationRow }, state, job.id);
    } catch (error) {
      await this.settleFailure(error, state);
    }
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

    if (isRateLimit(error)) {
      if (state.flushedChars === 0) {
        // Nothing visible yet: an invisible deferral. Back to `pending` so the
        // queue's re-run starts clean; the throw defers without an attempt, against
        // THIS asker's bucket.
        await this.prisma.askMessage.updateMany({
          where: { id: state.messageId, status: 'streaming' },
          data: { status: 'pending', toolCalls: [], content: '' },
        });
        throw error instanceof KvoxRateLimitError
          ? error
          : new KvoxRateLimitError(aiProviderThrottleKey(state.userId), error.retryAfterMs, error.message);
      }
      await this.markFailedSafely(state, 'rate_limit');
      return;
    }

    const errorClass = classifyAskError(error);
    await this.markFailedSafely(state, errorClass);
    if (!isDomainFailure(error)) throw error;
  }

  private async markFailedSafely(state: TurnState, errorClass: AskErrorClassValue): Promise<void> {
    try {
      await this.prisma.askMessage.updateMany({
        where: { id: state.messageId, status: { in: ['pending', 'streaming'] } },
        data: {
          status: 'failed',
          errorClass,
          // `flusher.content` always starts with what was flushed, so this is an append.
          content: state.flusher.content,
          toolCalls: state.toolCalls as unknown as InputJsonValue,
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
    jobId: string,
  ): Promise<void> {
    const started = this.clock();
    const { userId } = payload;

    // 1. The model and the user's key, RE-VALIDATED against today's policy (an
    //    administrator may have narrowed it, or the user removed the key, since
    //    the request). The key itself never reaches this file: the host resolves it per call.
    const run = await this.resolveRun(userId, payload.model);
    const { target, model, providerId } = run;
    const providerLabel = providerLabelOf(providerId);
    const countTokens = run.countTokens;
    const callContext: KvoxAiContext = { userId, orgId: null, feature: 'ask.respond', jobId };
    if (!(await this.ai.capabilities(callContext)).toolCalling) {
      throw new AskTurnFailure('other', `The model "${model}" cannot call tools, which Ask needs.`);
    }

    // 3. The asker, with their CURRENT permissions: the tools authorise with them.
    const actor = await this.loadActor(userId);

    // 4. `pending -> streaming`, recording the model actually used (spec §20).
    const claimed = await this.prisma.askMessage.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'streaming', model, provider: providerId },
    });
    if (claimed.count === 0) throw new AskTurnGone();

    // 5. Tool context, with the scope entity pre-registered as `ent1`.
    const toolCtx = await this.toolset.createContext(actor, {
      scopeEntityId: row.conversation.scopeEntityId,
      now: new Date(this.clock()),
      countTokens,
    });
    const scope = await this.registerScope(userId, row.conversation.scopeEntityId, toolCtx);
    const selection = await this.registerSelection(userId, payload.scope, toolCtx);

    // 6. History within the input budget: refused, never truncated, when the
    //    question alone does not fit (Notes rule 4).
    const definitions = this.toolset.definitions();
    const toolDefinitionTokens = countTokens(JSON.stringify(definitions));
    // #436: the model's own limits, the deployment's optional caps, Ask's own
    // answer clamp as a TASK bound (headroom for the effort this turn sends is
    // added on top of it, bounded by the model's maximum).
    const budget = computeTokenBudget({
      contextWindowTokens: run.modelLimits.contextWindowTokens,
      modelMaxOutputTokens:
        run.modelLimits.maxOutputTokens || Math.min(run.modelLimits.contextWindowTokens, OUTPUT_RESERVE_TOKENS),
      policyMaxOutputTokens: run.policy.maxOutputTokens,
      policyMaxInputTokens: run.policy.maxInputTokens,
      taskMaxOutputTokens: ASK_MAX_OUTPUT_TOKENS,
      reasoningEffort: run.reasoningEffort,
    });
    const { question, history } = await this.loadHistory(row);
    const fit = fitToBudget({
      system: buildAskSystemPrompt({ now: toolCtx.now, scope, selection }),
      history,
      question,
      availableTokens: budget.availableInputTokens,
      reservedTokens: toolDefinitionTokens,
      countTokens,
    });
    if (!fit.ok) {
      throw new KvoxAiBudgetError(
        fit.requiredTokens,
        budget.availableInputTokens,
        budgetRefusalMessage({
          promptTokens: fit.requiredTokens,
          availableInputTokens: budget.availableInputTokens,
          model,
        }),
      );
    }

    // 7. THE PER-USER BUCKET is `aiProviderThrottleKey(userId)`: a provider 429 is raised as a
    //    `KvoxRateLimitError` on it (`settleFailure`), so the queue defers THIS user only.
    const outcome = await this.loop({
      callContext,
      target: { ...target, maxOutputTokens: budget.maxOutputTokens, reasoningEffort: run.reasoningEffort },
      providerId,
      providerLabel,
      countTokens,
      messages: fit.messages,
      toolCtx,
      state,
      started,
      availableInputTokens: budget.availableInputTokens,
      toolDefinitionTokens,
    });

    // 8. Citations, checked against THIS turn's handles.
    const content = state.flusher.content;
    if (content.trim().length === 0) {
      throw new AskTurnFailure('refusal', `${providerLabel} returned no answer.`);
    }
    const markers = parseCitationMarkers(content);
    const sources = await loadCitationSources(this.visibility, userId, citationSourceRequest(markers, toolCtx.handles));
    const citations = mapCitations(markers, toolCtx.handles, sources);

    // 9. Complete: the row and the conversation's `updated_at`, together.
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

  /** The run Ask would make for this user now, or the failure the row records. */
  private async resolveRun(userId: string, requested: string) {
    try {
      return await this.resolver.resolve(userId, 'ask.respond', requested);
    } catch (error) {
      if (error instanceof GraphAiConflict) throw notReadyFailure(error, requested);
      throw error;
    }
  }

  /**
   * The tool-calling loop. Returns the finish reason; the answer is in
   * `state.flusher` (and flushed as it went).
   */
  private async loop(args: {
    callContext: KvoxAiContext;
    target: Parameters<KvoxAiPort['chat']>[1]['target'];
    providerId: string;
    providerLabel: string;
    countTokens: (text: string) => number;
    messages: KvoxChatMessage[];
    toolCtx: AskToolContext;
    state: TurnState;
    started: number;
    availableInputTokens: number;
    toolDefinitionTokens: number;
  }): Promise<AskFinishReasonValue> {
    const { state, toolCtx } = args;
    const messages = [...args.messages];
    const definitions = this.toolset.definitions();
    const stepReserve = stepReserveTokens(this.maxCallsPerStep);

    for (;;) {
      const used = messageTokens(messages, args.countTokens) + args.toolDefinitionTokens;
      const forced: AskFinishReasonValue | null =
        state.steps >= this.maxSteps
          ? 'step_cap'
          : this.clock() - args.started >= this.softClockMs
            ? 'time_cap'
            : args.availableInputTokens - used < stepReserve
              ? 'token_cap'
              : null;

      const hold = new AnswerHold();
      const calls: KvoxToolCallRef[] = [];
      let finishReason: 'stop' | 'length' | 'content_filter' = 'stop';
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

      // The per-call backstop; the host's adapter combines it with its own timeout.
      const callContext: KvoxAiContext = { ...args.callContext, signal: AbortSignal.timeout(ASK_CALL_TIMEOUT_MS) };
      const history: KvoxChatMessage[] = forced ? [...messages, { role: 'system', content: ASK_FORCED_ANSWER_LINE }] : messages;

      for await (const event of this.ai.chat(callContext, {
        target: args.target,
        messages: history,
        tools: definitions,
        toolChoice: forced ? 'none' : 'auto',
      })) {
        if (event.type === 'delta') {
          await emit(hold.delta(event.text));
        } else if (event.type === 'tool_call') {
          if (forced) {
            // `toolChoice: 'none'` was ignored; the turn is out of tool budget either way.
            this.logger.warn({ msg: 'ask tool call ignored after the cap', messageId: state.messageId });
            continue;
          }
          hold.toolCall();
          if (hold.lateToolCall) {
            this.logger.warn({ msg: 'ask tool call after the answer started; streamed text kept', messageId: state.messageId });
          }
          calls.push({ id: event.id, name: event.name, arguments: event.arguments });
        } else if (event.type === 'done') {
          addUsage(state, event.usage);
          finishReason = event.finishReason ?? 'stop';
        }
        // `step_end` carries nothing: the step is counted below, once its calls have run.
      }
      await emit(hold.end());

      if (calls.length > 0) {
        await this.runToolStep(messages, hold.text, calls, toolCtx, state);
        state.steps += 1;
        continue;
      }

      await this.flush(state);
      if (finishReason === 'content_filter') {
        throw new KvoxAiError('refusal', `${args.providerLabel} declined to finish this answer.`);
      }
      if (finishReason === 'length') return 'token_cap';
      return forced ?? 'stop';
    }
  }

  /** Execute one step's calls in order, recording each immediately (so the stream can show it). */
  private async runToolStep(
    messages: KvoxChatMessage[],
    preamble: string,
    calls: KvoxToolCallRef[],
    toolCtx: AskToolContext,
    state: TurnState,
  ): Promise<void> {
    // The preamble goes back to the MODEL as its own words, never into `content`.
    messages.push({ role: 'assistant', content: preamble.trim() ? preamble : null, toolCalls: calls });
    const tooMany = tooManyToolCallsError(this.maxCallsPerStep);
    for (const [i, call] of calls.entries()) {
      const startedAt = this.clock();
      const argumentsJson = toolArgumentsText(call.arguments);
      const execution: AskToolExecution =
        i < this.maxCallsPerStep
          ? await this.toolset.execute(toolCtx, call.name, argumentsJson)
          : { ok: false, error: tooMany, json: JSON.stringify({ error: tooMany }) };
      messages.push({ role: 'tool', toolCallId: call.id, content: execution.json });

      state.toolCalls.push({
        index: state.toolCalls.length,
        name: call.name.slice(0, 64),
        arguments: recordedArguments(argumentsJson),
        summary: execution.ok ? execution.result.summary : `Could not run ${call.name.slice(0, 64)}`,
        resultCount: execution.ok ? execution.result.resultCount : 0,
        durationMs: Math.max(0, Math.round(this.clock() - startedAt)),
        error: execution.ok ? null : execution.error,
      });
      const written = await this.prisma.askMessage.updateMany({
        where: { id: state.messageId, status: 'streaming' },
        data: { toolCalls: state.toolCalls as unknown as InputJsonValue },
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
    finishReason: AskFinishReasonValue,
  ): Promise<void> {
    const [written] = await this.prisma.$transaction([
      this.prisma.askMessage.updateMany({
        where: { id: state.messageId, status: 'streaming' },
        data: {
          status: 'complete',
          content,
          citations: citations as unknown as InputJsonValue,
          toolCalls: state.toolCalls as unknown as InputJsonValue,
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

  /**
   * The asker with their CURRENT permissions: the tools authorise with them. An inactive account
   * holds none, so it fails here with the same answer as a user who lost `graph:read`.
   */
  private async loadActor(userId: string): Promise<GraphActor> {
    const held = await Promise.all(
      ACTOR_PERMISSION_PROBES.map(async (permission) =>
        (await this.identity.hasPermission(userId, permission)) ? permission : null,
      ),
    );
    const permissions = held.filter((permission): permission is (typeof ACTOR_PERMISSION_PROBES)[number] => permission !== null);
    if (!permissions.includes(GRAPH_READ_PERMISSION)) {
      throw new AskTurnFailure('other', 'This account can no longer read its knowledge graph.');
    }
    return { id: userId, permissions };
  }

  /**
   * The graph selection of this question (GIC-17), as handles. The ids are re-checked against today's
   * data (readable by the owner, never a sensitive PersonFact); one that vanished is dropped, not an
   * error. Evidence ids register the SUBJECT they support, never the quote: the agent reads it itself.
   */
  private async registerSelection(
    ownerId: string,
    scope: AskRespondPayload['scope'],
    toolCtx: AskToolContext,
  ): Promise<AskPromptSelectionItem[]> {
    if (!scope || ((scope.entityIds?.length ?? 0) === 0 && (scope.evidenceIds?.length ?? 0) === 0)) return [];
    const resolved = await resolveAskScope(this.prisma, ownerId, scope, toolCtx.personalFactsAllowed);
    return resolved.subjects.map((subject) => ({
      handle: toolCtx.handles.register({ kind: subject.kind, id: subject.id, label: subject.label }),
      label: subject.label,
      type: subject.type,
    }));
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

function addUsage(state: TurnState, usage: KvoxAiUsage): void {
  state.promptTokens += usage.inputTokens ?? 0;
  state.completionTokens += usage.outputTokens ?? 0;
}

/** Why the model cannot be used for this turn right now, as the failure the row records. */
function notReadyFailure(conflict: GraphAiConflict, requested: string): AskTurnFailure {
  switch (conflict.reason) {
    case 'ai_key_missing':
      return new AskTurnFailure('auth', `No ${providerLabelOf(null)} API key is saved for your account.`);
    case 'graph_disabled':
      return new AskTurnFailure('other', 'Connected knowledge is switched off for this deployment.');
    case 'model_lacks_capability':
      return new AskTurnFailure('other', `The model "${requested}" cannot call tools, which Ask needs.`);
    default:
      return new AskTurnFailure('other', 'AI features are not available for this deployment right now.');
  }
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
