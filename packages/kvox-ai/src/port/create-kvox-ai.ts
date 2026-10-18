import { z } from 'zod';

import { AiError, type AiResponse, type AiStreamEvent } from '@marinoscar/platform-api/ai';
import {
  KvoxAiError,
  type KvoxAiCapabilities,
  type KvoxAiContext,
  type KvoxAiPort,
  type KvoxAiTarget,
  type KvoxChatEvent as PortChatEvent,
  type KvoxChatMessage as PortChatMessage,
  type KvoxEmbedResult,
  type KvoxStructuredResult,
  type KvoxTextEvent as PortTextEvent,
  type KvoxToolDef,
} from '@marinoscar/kvox-api/ports';

import {
  ReasoningReplayCache,
  createChatMappingState,
  fromPlatformEvent,
  missingToolCalls,
  replayScope,
  toPlatformInput,
  toPlatformToolChoice,
  toPlatformTools,
  toolCallIdsOf,
} from '../chat/index.js';
import { KVOX_EMBEDDING } from '../embedding/index.js';
import { isErrorLike, refusalFor, scrub, toKvoxAiError, type KvoxAiErrorContext } from '../errors/index.js';
import type { KvoxAiFeatureId } from '../features/index.js';
import type {
  KvoxAiModelState,
  KvoxAiRuntime,
  KvoxAiRuntimeCall,
  KvoxAiRuntimeRequest,
  KvoxModelCatalog,
  KvoxStructuredOutputMode,
  KvoxTaskModelSource,
} from '../runtime/index.js';
import {
  buildPromptedRepairInput,
  buildPromptedStructuredInstructions,
  parsePromptedStructuredAnswer,
  promptedJsonSchemaOf,
} from '../structured/index.js';
import { toPlatformReasoningEffort } from '../tasks/index.js';
import { countTokens } from '../tokens/index.js';
import type {
  JsonSchema,
  KvoxAiReadiness,
  KvoxChatEvent,
  KvoxChatMessage,
  KvoxReasoningEffort,
  KvoxToolDefinition,
  KvoxUsage,
} from '../types/index.js';
import { featureOf } from './feature-names.js';
import { createKvoxAiReadiness, reasoningEffortFor, type KvoxAiReadinessReader } from './readiness.js';

// =============================================================================
// createKvoxAi: KvoxAiPort over a host-supplied runtime (issue #579)
// =============================================================================
//
// THE ONE IMPLEMENTATION OF `KvoxAiPort`, for every host. A caller hands it a
// user, a feature and a prompt; the host's `KvoxAiRuntime` makes the provider
// round trip. The web edition's runtime is the platform `AiService.forUser(...)`,
// which runs every gate, resolves the user's own key, records one usage row per
// round trip and traces the call; KVox Desktop's is `createDirectRuntime` over the
// provider adapters. Nothing here ever holds a key, and nothing here logs a prompt.
//
// MERGED FROM TWO WEB CLASSES (#579): `PlatformKvoxAi` (`apps/api/src/ai-port/
// platform-kvox-ai.ts`, the model mechanics over `AiService`) and
// `PlatformKvoxAiAdapter` (`apps/api/src/platform-kvox/ai/`, the port over that
// facade). Every rule of both is kept; the facade between them is gone.
//
// WHAT THIS OWNS, AND WHAT IT DOES NOT.
//   • It decides the reasoning effort (`none` omits the parameter, `xhigh` is
//     clamped to `high`); a target's own effort wins over the policy.
//   • It owns the request timeout (`requestTimeoutMs`, read per call), combined
//     with the caller's signal; the caller's own abort reason is what surfaces.
//   • It translates every failure into a `KvoxAiError` (`errors/`) and adds the
//     structured-output rules below.
//   • It renames the port's features to the registered ids (`featureOf`) and
//     resolves targets through readiness (`readiness.ts`).
//   • It does NOT budget tokens (the caller's `computeTokenBudget`, fed by
//     `resolveTask()` and `countTokens()`), register a throttle key, or pick a
//     model for a call that names none (the host's runtime, through its own target
//     resolver, does).
//
// EVERY ROUND TRIP IS ONE RUNTIME CALL: a structured call is one `create`, an Ask
// step one `stream`, an embeddings batch one `embed`. A host that records usage per
// call (the web edition) therefore records each.
//
// STRUCTURED OUTPUT, and what the platform cannot tell us.
//   • A caller may pass a strict JSON Schema (`jsonSchema`) next to its Zod
//     validator. The request carries Zod, so the JSON Schema is turned into Zod with
//     `z.fromJSONSchema` (the call the platform's own HTTP layer makes) and sent as
//     the constrained schema; the parsed value is then validated AGAIN with the
//     caller's schema, so the caller's validation is unchanged. A JSON Schema Zod
//     cannot round-trip falls back to the caller's schema, `strict: true` kept.
//   • ⚠ THE PLATFORM LOSES THE FINISH REASON ON A BAD STRUCTURED ANSWER. Its
//     adapters parse the text whatever the finish reason was, so a truncated answer
//     arrives as `AI_STRUCTURED_OUTPUT_INVALID` with a "not valid JSON" issue and no
//     `length` marker. Under a strict schema the vendor guarantees well-formed JSON
//     unless it was cut off, so a not-valid-JSON failure of a call that set a
//     `maxOutputTokens` ceiling is reported as `truncated` (the case the extraction
//     retry exists for). A schema mismatch is `invalid_output`. If a later platform
//     release surfaces `finishReason: 'length'` on the response, that is honoured
//     first.
//
// PLATFORM-ADOPTION-SHIM(#475): the truncation heuristic above, until the platform's
// `AI_STRUCTURED_OUTPUT_INVALID` error carries the response's finish reason.
//
// PROMPTED STRUCTURED OUTPUT (#581). A model whose `structuredOutputMode` is
// `prompted` (looked up per call: the task-model state's row, else the catalog,
// else `native`) cannot be held to a schema by its provider. For it the request
// carries NO `structuredOutput`: the JSON Schema goes into the system prompt, the
// text answer is parsed and validated twice (as above), and ONE repair call is
// made when it does not validate (`structured/prompted-structured.ts`). The native
// request is unchanged byte for byte. This is the only retry in the AI stack.
//
// TOOL CALLING IS PER MODEL. `capabilities().toolCalling` is readiness AND the
// resolved model's `toolCalling` flag (the row's, else the catalog's, else true),
// so a host whose model cannot call tools (GitHub Copilot) never offers Ask.
//
// ⚠ A KEY NEVER CROSSES THIS PORT. The context carries a user id; the runtime
// resolves that user's own key per call. `scrub` removes anything shaped like a
// provider key from a message before it leaves, as a backstop.
// ⚠ THE STREAMING METHODS ARE ASYNC GENERATORS. A host that wraps the port in a
// tracing decorator must not await them (that would turn a generator into a
// Promise of one); the web edition traces only the promise methods.
// =============================================================================

/**
 * The request-timeout backstop when the host gives none (or its reader fails):
 * ten minutes, because a streamed completion legitimately runs for minutes.
 *
 * @stability experimental
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/** The platform `AiError` code of a structured answer that is not usable. */
const STRUCTURED_INVALID = 'AI_STRUCTURED_OUTPUT_INVALID';

/**
 * Where `createKvoxAi` reports what is worth an operator's attention. Never a
 * prompt, an answer or a key: the only entry today is a JSON Schema that did not
 * round-trip through Zod (a message and a capped detail).
 *
 * @stability experimental
 */
export interface KvoxAiLogger {
  /**
   * A recoverable problem.
   *
   * @param entry - a structured log entry (`msg` plus non-sensitive fields).
   */
  warn(entry: Record<string, unknown>): void;
}

/**
 * What `createKvoxAi` is built from.
 *
 * @stability experimental
 */
export interface CreateKvoxAiOptions {
  /** One provider round trip per call, and whether a key exists. */
  runtime: KvoxAiRuntime;
  /** The policy, the active provider and its enabled models. */
  taskModels: KvoxTaskModelSource;
  /** Per-model numbers a host knows beyond its task-model state (a row's own numbers win). */
  catalog?: KvoxModelCatalog;
  /**
   * The readiness reader to use. Default: one built over `runtime` and `taskModels`
   * (`createKvoxAiReadiness`). A host that also answers readiness elsewhere passes
   * the same reader, so both answer identically.
   */
  readiness?: KvoxAiReadinessReader;
  /**
   * The request-timeout backstop in milliseconds, or a reader called once per
   * call (the web edition reads `ai.requestTimeoutMs` per call). A reader that
   * fails, or returns nothing, falls back to {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   */
  requestTimeoutMs?: number | (() => number | Promise<number>);
  /**
   * Whether the connected-knowledge features are switched on, for
   * `capabilities()`. Default: the task-model policy's `graphEnabled`.
   */
  graphEnabled?: () => boolean | Promise<boolean>;
  /** Where the one recoverable problem is reported. Default: nowhere. */
  logger?: KvoxAiLogger;
}

/** A `signal` plus what is needed to tell a timeout from a caller abort afterwards. */
interface CallGuard {
  signal: AbortSignal;
  timeoutMs: number;
  callerSignal: AbortSignal | undefined;
  /** True when the backstop fired and the caller did not abort first. */
  timedOut: () => boolean;
}

/** What the failure translator needs to know about the call. */
interface FailureContext extends KvoxAiErrorContext {
  guard: CallGuard;
  /** Set for a structured call: whether it set an output ceiling. */
  structuredCeiling?: boolean;
}

/**
 * Builds the `KvoxAiPort` over a host's runtime and task-model source.
 *
 * @example
 * ```ts
 * const ai = createKvoxAi({
 *   runtime: createDirectRuntime({ adapters: { openai }, keys: async () => ({ apiKey: await keychain.get('openai') }) }),
 *   taskModels: { load: async () => localModelState },
 * });
 * for await (const event of ai.generateText(ctx, { target, system, user })) render(event);
 * ```
 *
 * @param options - the runtime, the task-model source and the optional knobs.
 * @returns the port. It keeps one reasoning-replay cache per instance (an Ask
 *   turn's reasoning between its steps), so a host builds ONE and shares it.
 * @stability experimental
 */
export function createKvoxAi(options: CreateKvoxAiOptions): KvoxAiPort {
  return new KvoxAi(options);
}

class KvoxAi implements KvoxAiPort {
  private readonly runtime: KvoxAiRuntime;
  private readonly taskModels: KvoxTaskModelSource;
  private readonly reader: KvoxAiReadinessReader;
  private readonly logger: KvoxAiLogger | undefined;

  /** Reasoning items between two calls of one Ask turn (never logged, never stored). */
  private readonly reasoningReplay = new ReasoningReplayCache();

  /** Failures this class raised on purpose: they skip the abort and timeout precedence. */
  private readonly own = new WeakSet<object>();

  constructor(private readonly options: CreateKvoxAiOptions) {
    this.runtime = options.runtime;
    this.taskModels = options.taskModels;
    this.logger = options.logger;
    this.reader =
      options.readiness ??
      createKvoxAiReadiness({
        runtime: options.runtime,
        taskModels: options.taskModels,
        ...(options.catalog !== undefined ? { catalog: options.catalog } : {}),
      });
  }

  // ---------------------------------------------------------------------------
  // Capabilities and targets
  // ---------------------------------------------------------------------------

  async capabilities(ctx: KvoxAiContext): Promise<KvoxAiCapabilities> {
    try {
      const feature = featureOf(ctx.feature);
      const [readiness, graphEnabled] = await Promise.all([
        this.reader.readiness(ctx.userId, feature ?? 'note_generate', null),
        this.graphEnabled(ctx.userId),
      ]);
      const reason = capabilityReason(readiness.reason);
      const flags = readiness.ok ? await this.modelFlagsOrNone(ctx.userId, readiness.provider, readiness.model) : {};

      return {
        available: feature !== undefined && readiness.ok,
        ...(reason !== undefined ? { reason } : {}),
        structuredOutput: readiness.ok,
        toolCalling: readiness.ok && (flags.toolCalling ?? true),
        embeddings: { model: KVOX_EMBEDDING.model, dimensions: KVOX_EMBEDDING.dimensions },
        graphEnabled,
      };
    } catch {
      return {
        available: false,
        reason: 'ai_not_configured',
        structuredOutput: false,
        toolCalling: false,
        embeddings: null,
        graphEnabled: false,
      };
    }
  }

  async resolveTask(
    ctx: KvoxAiContext,
    task: string,
    opts?: { model?: string; requireKey?: boolean },
  ): Promise<KvoxAiTarget> {
    const feature = featureOf(task) ?? featureOf(ctx.feature);
    if (feature === undefined) throw unknownFeature(task);

    let readiness: KvoxAiReadiness;
    try {
      readiness = await this.reader.readiness(ctx.userId, feature, opts?.model ?? null);
    } catch (error) {
      throw toKvoxAiError(error, { feature, inJob: ctx.jobId !== undefined });
    }
    // `requireKey: false` is for a caller who only counts tokens (a name-check estimate): a
    // missing key still names the model, which is all it needs.
    const keyOptional = opts?.requireKey === false && readiness.reason === 'ai_key_missing';
    if ((!readiness.ok && !keyOptional) || readiness.provider === null || readiness.model === null) {
      throw refusalFor(readiness);
    }

    const embeds = readiness.contextWindowTokens === null;
    return {
      provider: readiness.provider,
      model: readiness.model,
      reasoningEffort: readiness.reasoningEffort,
      contextWindowTokens: readiness.contextWindowTokens ?? KVOX_EMBEDDING.maxInputTokens,
      // An embeddings model generates nothing.
      maxOutputTokens: embeds ? 0 : (readiness.maxOutputTokens ?? 0),
      source: readiness.source,
    };
  }

  // ---------------------------------------------------------------------------
  // Streamed text
  // ---------------------------------------------------------------------------

  async *generateText(
    ctx: KvoxAiContext,
    req: { target: KvoxAiTarget; system: string; user: string; maxOutputTokens?: number },
  ): AsyncIterable<PortTextEvent> {
    const feature = this.featureFor(ctx);
    const guard = await this.guard(ctx.signal);
    const failure: FailureContext = { feature, inJob: ctx.jobId !== undefined, guard };

    try {
      const effort = await this.effortFor(ctx.userId, feature, req.target.model ?? null, req.target.reasoningEffort);
      const stream = this.runtime.stream(this.call(ctx, feature, req.target, guard.signal), {
        instructions: req.system,
        input: req.user,
        ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(effort !== undefined ? { reasoning: { effort } } : {}),
      });

      let completed = false;
      for await (const event of stream) {
        if (event.type === 'output_text.delta') {
          yield { type: 'delta', text: event.delta };
        } else if (event.type === 'error') {
          throw new AiError(event.code, event.message);
        } else if (event.type === 'response.completed') {
          completed = true;
          const response = event.response;

          if (response.finishReason === 'content_filter') {
            throw new AiError('AI_CONTENT_FILTERED', 'The provider declined to answer this request.');
          }
          if (response.finishReason === 'error') {
            throw new Error('The provider ended the response with an error.');
          }

          yield {
            type: 'done',
            usage: usageOf(response.usage),
            finishReason: response.finishReason === 'length' ? 'length' : 'stop',
          };
        }
      }

      if (!completed) {
        // The same rule the retired provider followed: a stream that ends without a
        // finish reason is a dead socket, never a finished answer.
        throw new Error('The provider closed the stream without finishing the response; the answer was truncated.');
      }
    } catch (err) {
      throw this.fail(err, failure);
    }
  }

  // ---------------------------------------------------------------------------
  // Structured output
  // ---------------------------------------------------------------------------

  async generateStructured<T>(
    ctx: KvoxAiContext,
    req: {
      target: KvoxAiTarget;
      system: string;
      user: string;
      schema: z.ZodType<T>;
      schemaName: string;
      jsonSchema?: Record<string, unknown>;
      maxOutputTokens?: number;
    },
  ): Promise<KvoxStructuredResult<T>> {
    const feature = this.featureFor(ctx);
    const guard = await this.guard(ctx.signal);
    const failure: FailureContext = {
      feature,
      inJob: ctx.jobId !== undefined,
      guard,
      structuredCeiling: req.maxOutputTokens !== undefined,
    };

    try {
      const effort = await this.effortFor(ctx.userId, feature, req.target.model ?? null, req.target.reasoningEffort);
      if ((await this.structuredModeFor(ctx.userId, req.target)) === 'prompted') {
        return await this.promptedStructured(ctx, feature, guard, req, effort);
      }
      const response: AiResponse = await this.runtime.create(this.call(ctx, feature, req.target, guard.signal), {
        instructions: req.system,
        input: req.user,
        structuredOutput: {
          name: req.schemaName,
          schema: this.constrainedSchema(req.jsonSchema, req.schema),
          strict: true,
        },
        ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(effort !== undefined ? { reasoning: { effort } } : {}),
      });

      if (response.finishReason === 'length') {
        throw this.mark(
          new KvoxAiError(
            'truncated',
            scrub(`The structured answer for "${req.schemaName}" was cut off at the output ceiling before the JSON was complete.`),
            undefined,
            usageEstimate(response.usage),
          ),
        );
      }
      if (response.finishReason === 'content_filter') {
        throw new AiError('AI_CONTENT_FILTERED', 'The provider declined to produce this structured answer.');
      }

      // The caller's own validation, unchanged: the vendor was held to the strict JSON
      // Schema, the caller's Zod schema decides what the value must satisfy.
      const checked = req.schema.safeParse(response.parsed);
      if (!checked.success) {
        throw this.mark(
          new KvoxAiError(
            'invalid_output',
            scrub(`The structured answer for "${req.schemaName}" does not match the requested schema.`),
            undefined,
            usageEstimate(response.usage),
          ),
        );
      }

      return { value: checked.data, usage: usageOf(response.usage) };
    } catch (err) {
      throw this.fail(err, failure);
    }
  }

  /**
   * The prompted structured path (see the file header and
   * `structured/prompted-structured.ts`): the schema in the system prompt, the
   * answer parsed and validated twice, and ONE repair call when it does not
   * validate. The usage of a repaired answer is the sum of both calls.
   */
  private async promptedStructured<T>(
    ctx: KvoxAiContext,
    feature: KvoxAiFeatureId,
    guard: CallGuard,
    req: {
      target: KvoxAiTarget;
      system: string;
      user: string;
      schema: z.ZodType<T>;
      schemaName: string;
      jsonSchema?: Record<string, unknown>;
      maxOutputTokens?: number;
    },
    effort: Awaited<ReturnType<KvoxAi['effortFor']>>,
  ): Promise<KvoxStructuredResult<T>> {
    const constrained = this.constrainedSchema(req.jsonSchema, req.schema);
    const schemas: [...z.ZodType[], z.ZodType<T>] = constrained === req.schema ? [req.schema] : [constrained, req.schema];
    const instructions = buildPromptedStructuredInstructions({
      system: req.system,
      schemaName: req.schemaName,
      jsonSchema: promptedJsonSchemaOf(req.schema, req.jsonSchema),
    });
    // The same ceiling and effort as the native request; NO `structuredOutput`.
    const rest: Omit<KvoxAiRuntimeRequest, 'instructions' | 'input'> = {
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(effort !== undefined ? { reasoning: { effort } } : {}),
    };

    const first = await this.runtime.create(this.call(ctx, feature, req.target, guard.signal), {
      instructions,
      input: req.user,
      ...rest,
    });
    this.assertPromptedFinish(first, first.usage, req.schemaName);
    const answer = parsePromptedStructuredAnswer(first.outputText, schemas);
    if (answer.ok) return { value: answer.value, usage: usageOf(first.usage) };

    // The one repair: the same system prompt, one string input.
    const second = await this.runtime.create(this.call(ctx, feature, req.target, guard.signal), {
      instructions,
      input: buildPromptedRepairInput({
        user: req.user,
        schemaName: req.schemaName,
        answer: first.outputText,
        issues: answer.issues,
      }),
      ...rest,
    });
    const usage = addUsage(first.usage, second.usage);
    this.assertPromptedFinish(second, usage, req.schemaName);
    const repaired = parsePromptedStructuredAnswer(second.outputText, schemas);
    if (repaired.ok) return { value: repaired.value, usage: usageOf(usage) };

    throw this.mark(
      repaired.notJson && req.maxOutputTokens !== undefined
        ? new KvoxAiError(
            'truncated',
            scrub(`The structured answer for "${req.schemaName}" was cut off at the output ceiling before the JSON was complete.`),
            undefined,
            usageEstimate(usage),
          )
        : new KvoxAiError(
            'invalid_output',
            scrub(`The structured answer for "${req.schemaName}" does not match the requested schema.`),
            undefined,
            usageEstimate(usage),
          ),
    );
  }

  /** A prompted answer cut off (`truncated`) or filtered (a refusal) is final: no repair. */
  private assertPromptedFinish(
    response: AiResponse,
    usage: { inputTokens?: number; outputTokens?: number },
    schemaName: string,
  ): void {
    if (response.finishReason === 'length') {
      throw this.mark(
        new KvoxAiError(
          'truncated',
          scrub(`The structured answer for "${schemaName}" was cut off at the output ceiling before the JSON was complete.`),
          undefined,
          usageEstimate(usage),
        ),
      );
    }
    if (response.finishReason === 'content_filter') {
      throw new AiError('AI_CONTENT_FILTERED', 'The provider declined to produce this structured answer.');
    }
  }

  /**
   * How the target model is held to a schema: the task-model state's row (when the
   * state's provider is the target's), else the catalog, else `native`.
   */
  private async structuredModeFor(userId: string, target: KvoxAiTarget): Promise<KvoxStructuredOutputMode> {
    const flags = await this.modelFlagsOrNone(userId, target.provider, target.model);
    return flags.structuredOutputMode ?? 'native';
  }

  /**
   * The capability flags of one model: the state's row when the state's provider is
   * `provider` (an absent provider means the state's own), else the catalog's. A
   * failed read answers no flags, so the defaults apply and the call fails, if at
   * all, where it did before.
   */
  private async modelFlagsOrNone(
    userId: string,
    provider: string | null | undefined,
    model: string | null | undefined,
  ): Promise<{ toolCalling?: boolean; structuredOutputMode?: KvoxStructuredOutputMode }> {
    if (typeof model !== 'string' || model.length === 0) return {};
    try {
      const state = await this.taskModels.load(userId);
      const providerId = typeof provider === 'string' && provider.length > 0 ? provider : state.provider;
      if (providerId === null) return {};
      const row = state.provider === providerId ? state.models.find((entry) => entry.id === model) : undefined;
      const known = this.options.catalog?.lookup(providerId, model) ?? null;
      const toolCalling = row?.toolCalling ?? known?.toolCalling;
      const structuredOutputMode = row?.structuredOutputMode ?? known?.structuredOutputMode;
      return {
        ...(toolCalling !== undefined ? { toolCalling } : {}),
        ...(structuredOutputMode !== undefined ? { structuredOutputMode } : {}),
      };
    } catch {
      return {};
    }
  }

  /**
   * The Zod schema the request carries for the vendor to be held to.
   *
   * A JSON Schema is converted with `z.fromJSONSchema`; one Zod cannot read, or
   * cannot write back out as JSON Schema (the provider adapter converts it back for
   * the wire), falls back to the caller's own schema. Both paths keep `strict: true`.
   */
  private constrainedSchema<T>(jsonSchema: JsonSchema | undefined, fallback: z.ZodType<T>): z.ZodType {
    if (jsonSchema === undefined) return fallback;

    try {
      const converted = z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
      // Prove the round trip now (the adapter repeats it on the wire).
      z.toJSONSchema(converted, { unrepresentable: 'throw' });
      return converted;
    } catch (err) {
      this.logger?.warn({
        msg: 'JSON Schema did not round-trip through Zod; using the caller schema',
        detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // Chat (one Ask step)
  // ---------------------------------------------------------------------------

  /**
   * One Ask-loop model call: the whole history, streamed, possibly calling tools
   * (issue #476). The mapping lives in `chat/` (`chat-mapping.ts`); this method owns
   * the guard (timeout, abort), the effort, the failure translation and the step
   * rule of the port: a tool call ends what the step may say, so any text the
   * provider streams after it is held back and dropped, and the step ends with
   * `step_end` then `done`.
   */
  async *chat(
    ctx: KvoxAiContext,
    req: { target: KvoxAiTarget; messages: PortChatMessage[]; tools: KvoxToolDef[]; toolChoice: 'auto' | 'none' },
  ): AsyncIterable<PortChatEvent> {
    const feature = this.featureFor(ctx);
    const guard = await this.guard(ctx.signal);
    const failure: FailureContext = { feature, inJob: ctx.jobId !== undefined, guard };
    const scope = replayScope({ userId: ctx.userId, ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}) });
    const state = createChatMappingState();
    let calledTool = false;

    /** One mapped event in the port's vocabulary. */
    function* toPort(event: KvoxChatEvent): Generator<PortChatEvent> {
      if (event.kind === 'delta') {
        if (!calledTool) yield { type: 'delta', text: event.text };
      } else if (event.kind === 'tool_call') {
        calledTool = true;
        yield { type: 'tool_call', id: event.id, name: event.name, arguments: parseArguments(event.argumentsJson) };
      } else {
        yield { type: 'step_end' };
        yield {
          type: 'done',
          usage: event.usage,
          finishReason:
            event.finishReason === 'length' || event.finishReason === 'content_filter' ? event.finishReason : 'stop',
        };
      }
    }

    try {
      const effort =
        req.target.reasoningEffort !== undefined
          ? toPlatformReasoningEffort(req.target.reasoningEffort)
          : await this.effortFor(ctx.userId, feature, req.target.model ?? null);
      const messages = req.messages.map(toMappingMessage);
      const { instructions, input } = toPlatformInput(
        messages,
        this.reasoningReplay.recall(scope, toolCallIdsOf(messages)),
      );
      const tools = req.tools.length > 0 ? toPlatformTools(req.tools.map(toToolDefinition)) : undefined;

      const stream: AsyncIterable<AiStreamEvent> = this.runtime.stream(
        this.call(ctx, feature, req.target, guard.signal),
        {
          ...(instructions !== undefined ? { instructions } : {}),
          input,
          ...(tools !== undefined ? { tools } : {}),
          ...(tools !== undefined ? { toolChoice: toPlatformToolChoice(req.toolChoice) } : {}),
          maxOutputTokens: req.target.maxOutputTokens,
          ...(effort !== undefined ? { reasoning: { effort } } : {}),
        },
      );

      for await (const event of stream) {
        if (event.type === 'response.completed') {
          for (const call of missingToolCalls(event.response, state)) yield* toPort(call);
        }
        const mapped = fromPlatformEvent(event, state);
        if (mapped !== null) yield* toPort(mapped);
      }

      if (!state.completed) {
        // A stream that ends without a finish reason is a dead socket, never a finished answer.
        throw new Error('The provider closed the stream without finishing the response; the answer was truncated.');
      }
    } catch (err) {
      if (guard.timedOut()) {
        throw new KvoxAiError('timeout', `The AI request timed out after ${guard.timeoutMs} ms.`);
      }
      throw this.fail(err, failure);
    } finally {
      // The reasoning of this response waits for the request that replays its step.
      this.reasoningReplay.remember(scope, state.reasoningByCall);
    }
  }

  // ---------------------------------------------------------------------------
  // Embeddings and the token estimate
  // ---------------------------------------------------------------------------

  async embed(ctx: KvoxAiContext, req: { inputs: string[] }): Promise<KvoxEmbedResult> {
    // An embeddings call names its own feature when the context's is not one (the search indexer).
    const feature = featureOf(ctx.feature) ?? 'search_embed';

    // Refused locally, before a request is spent on the user's own account.
    if (req.inputs.length === 0) {
      throw new KvoxAiError('other', 'An embedding batch must contain at least one text.');
    }
    if (req.inputs.length > KVOX_EMBEDDING.maxBatchSize) {
      throw new KvoxAiError(
        'other',
        `An embedding batch holds at most ${KVOX_EMBEDDING.maxBatchSize} texts; got ${req.inputs.length}.`,
      );
    }
    const embed = this.runtime.embed?.bind(this.runtime);
    if (embed === undefined) {
      throw new KvoxAiError('capability', 'This host offers no embeddings model.');
    }

    const guard = await this.guard(ctx.signal);
    const failure: FailureContext = { feature, inJob: ctx.jobId !== undefined, guard };

    try {
      const result = await embed(
        {
          ...this.scope(ctx),
          feature,
          provider: KVOX_EMBEDDING.provider,
          model: KVOX_EMBEDDING.model,
          signal: guard.signal,
        },
        { input: req.inputs, dimensions: KVOX_EMBEDDING.dimensions },
      );

      // MAKE the contract true, never assume it: a short or reordered batch would
      // store one text's vector against another's chunk, and nothing would ever error.
      if (result.vectors.length !== req.inputs.length) {
        throw this.mark(
          new KvoxAiError(
            'other',
            `The embeddings provider returned ${result.vectors.length} vectors for ${req.inputs.length} texts.`,
          ),
        );
      }
      for (const vector of result.vectors) {
        if (vector.length !== KVOX_EMBEDDING.dimensions || !vector.every((c) => Number.isFinite(c))) {
          throw this.mark(
            new KvoxAiError(
              'other',
              `The embeddings provider returned a ${vector.length}-dimension vector; this app stores exactly ${KVOX_EMBEDDING.dimensions} finite components.`,
            ),
          );
        }
      }

      return { model: result.model ?? KVOX_EMBEDDING.model, dimensions: KVOX_EMBEDDING.dimensions, vectors: result.vectors };
    } catch (err) {
      throw this.fail(err, failure);
    }
  }

  countTokens(target: KvoxAiTarget, text: string): number {
    return countTokens(text, target.model);
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------

  /** The registered feature of a call, or a `capability` refusal for a name nobody registered. */
  private featureFor(ctx: KvoxAiContext): KvoxAiFeatureId {
    const feature = featureOf(ctx.feature);
    if (feature === undefined) throw unknownFeature(ctx.feature);
    return feature;
  }

  /** The user, organization and job a round trip is made for. */
  private scope(ctx: KvoxAiContext): Pick<KvoxAiRuntimeCall, 'userId' | 'orgId' | 'jobId'> {
    return {
      userId: ctx.userId,
      ...(ctx.orgId !== null && ctx.orgId !== undefined ? { orgId: ctx.orgId } : {}),
      ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}),
    };
  }

  /**
   * One runtime call. The model rides along only when the target names one (absent
   * lets a host's own resolver decide); the provider is the target's, for a runtime
   * that must choose it itself (the web runtime leaves it to its resolver).
   */
  private call(ctx: KvoxAiContext, feature: KvoxAiFeatureId, target: KvoxAiTarget, signal: AbortSignal): KvoxAiRuntimeCall {
    return {
      ...this.scope(ctx),
      feature,
      ...(typeof target.provider === 'string' && target.provider.length > 0 ? { provider: target.provider } : {}),
      ...(typeof target.model === 'string' && target.model.length > 0 ? { model: target.model } : {}),
      signal,
    };
  }

  /** `capabilities().graphEnabled`: the host's switch, else the policy's. */
  private async graphEnabled(userId: string): Promise<boolean> {
    if (this.options.graphEnabled !== undefined) return this.options.graphEnabled();
    return (await this.taskModels.load(userId)).policy.graphEnabled === true;
  }

  /** The wire effort of a call (see `reasoningEffortFor`). */
  private effortFor(userId: string, feature: KvoxAiFeatureId, requested: string | null, override?: KvoxReasoningEffort) {
    return reasoningEffortFor({
      feature,
      requested,
      ...(override !== undefined ? { override } : {}),
      state: (): Promise<KvoxAiModelState> => this.taskModels.load(userId),
    });
  }

  /** The request-timeout backstop for one call. */
  private async timeoutMs(): Promise<number> {
    const configured = this.options.requestTimeoutMs;
    try {
      const value = typeof configured === 'function' ? await configured() : configured;
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_REQUEST_TIMEOUT_MS;
    } catch {
      // A settings read that fails must not fail the call: the default backstop applies.
      return DEFAULT_REQUEST_TIMEOUT_MS;
    }
  }

  /** The caller's signal combined with the request-timeout backstop. */
  private async guard(callerSignal: AbortSignal | undefined): Promise<CallGuard> {
    const timeoutMs = await this.timeoutMs();
    const timeout = AbortSignal.timeout(timeoutMs);
    return {
      signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout,
      timeoutMs,
      callerSignal,
      timedOut: () => timeout.aborted && callerSignal?.aborted !== true,
    };
  }

  /** Records a failure this class raised on purpose. */
  private mark(error: KvoxAiError): KvoxAiError {
    this.own.add(error);
    return error;
  }

  /** Every failure leaves through here: abort and timeout first, then the translation. */
  private fail(err: unknown, ctx: FailureContext): KvoxAiError {
    // Raised here on purpose (a truncation, a schema mismatch, a bad embeddings batch).
    if (typeof err === 'object' && err !== null && this.own.has(err)) return err as KvoxAiError;

    if (ctx.guard.callerSignal?.aborted) {
      // The runtime reports a cancellation in its own words; the caller's own abort
      // reason (a `TimeoutError` from its `AbortSignal.timeout`, an `AbortError`) is
      // what its handler checks for, so surface that.
      const reason: unknown = ctx.guard.callerSignal.reason;
      if (isErrorLike(reason)) return toKvoxAiError(reason, ctx);
    }
    if (ctx.guard.timedOut()) {
      return new KvoxAiError('timeout', `The AI request timed out after ${ctx.guard.timeoutMs} ms.`);
    }

    if (AiError.isAiError(err) && err.code === STRUCTURED_INVALID && ctx.structuredCeiling !== undefined) {
      return structuredFailure(err, ctx.structuredCeiling);
    }

    return toKvoxAiError(err, ctx);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The port error for a feature name nobody registered. */
function unknownFeature(name: string): KvoxAiError {
  return new KvoxAiError('capability', `No AI feature is registered as "${scrub(name)}".`);
}

/** `capabilities().reason` for a readiness reason. */
function capabilityReason(reason: KvoxAiReadiness['reason']): KvoxAiCapabilities['reason'] | undefined {
  if (reason === null) return undefined;
  if (reason === 'ai_key_missing') return 'ai_key_missing';
  if (reason === 'graph_disabled') return 'graph_disabled';
  return 'ai_not_configured';
}

/** Absent usage is `null`, never `0` (0 means free). */
function usageOf(usage: { inputTokens?: number; outputTokens?: number } | undefined): KvoxUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
}

/** The usage of two round trips: a count is summed when both reported it, else left out. */
function addUsage(
  a: { inputTokens?: number; outputTokens?: number } | undefined,
  b: { inputTokens?: number; outputTokens?: number } | undefined,
): { inputTokens?: number; outputTokens?: number } {
  const sum = (x: number | undefined, y: number | undefined): number | undefined =>
    x !== undefined && y !== undefined ? x + y : undefined;
  const inputTokens = sum(a?.inputTokens, b?.inputTokens);
  const outputTokens = sum(a?.outputTokens, b?.outputTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/** What a failed structured call consumed: both counts, or `undefined` when either was not reported. */
function usageEstimate(usage: { inputTokens?: number; outputTokens?: number } | undefined): KvoxUsage | undefined {
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

/**
 * `AI_STRUCTURED_OUTPUT_INVALID` of a structured call becomes `truncated` or `invalid_output`.
 *
 * ⚠ SEE THE FILE HEADER: the platform does not say why. An answer that is not valid
 * JSON at all, from a call that set an output ceiling, is read as a truncation (the
 * vendor guarantees well-formed JSON under a strict schema unless it was cut off);
 * a well-formed answer that fails the schema is `invalid_output`.
 */
function structuredFailure(err: AiError, hadCeiling: boolean): KvoxAiError {
  const issues = err.toJSON().details?.issues;
  const notJson =
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.every((issue) => (issue as { code?: unknown }).code === 'invalid_json');

  return notJson && hadCeiling
    ? new KvoxAiError('truncated', 'The structured answer was cut off at the output ceiling before the JSON was complete.')
    : new KvoxAiError('invalid_output', scrub(err.message));
}

/** A port history message in the chat mapping's vocabulary (tool-call arguments as JSON text). */
function toMappingMessage(message: PortChatMessage): KvoxChatMessage {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls !== undefined
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              argumentsJson: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
            })),
          }
        : {}),
    };
  }
  return message;
}

/** A port tool in the chat mapping's vocabulary. */
function toToolDefinition(tool: KvoxToolDef): KvoxToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** The tool call's arguments as the port promises: parsed when they are JSON, else the raw text. */
function parseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
}
