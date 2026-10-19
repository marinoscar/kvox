import { randomUUID } from 'node:crypto';

import {
  AiError,
  parseStructured,
  toJsonSchema,
  type AiCallContext,
  type AiDiscoveredModel,
  type AiDiscoveredModelMetadata,
  type AiFinishReason,
  type AiKeyVerification,
  type AiModelCapabilities,
  type AiProviderAdapter,
  type AiResponse,
  type AiResponseRequest,
  type AiResponsesPort,
  type AiStreamEvent,
  type AiUsage,
} from '@marinoscar/platform-ai-providers';
import type { z } from 'zod';

import {
  COPILOT_CATALOG,
  copilotCatalogEntry,
  copilotStructuredOutputMode,
  type CopilotCatalogEntry,
} from './copilot-catalog.js';
import {
  COPILOT_SIGN_IN_MESSAGE,
  copilotErrorFromData,
  copilotErrorFromThrown,
  copilotSignInCancelled,
  copilotSignInFailed,
  redactTokens,
  type CopilotErrorData,
} from './copilot-errors.js';
import type {
  CopilotReasoningEffort,
  CopilotSignInChallenge,
  CopilotSessionConfig,
  CopilotSessionEvent,
  CopilotSessionHandle,
  CopilotTransport,
} from './copilot-transport.js';

// =============================================================================
// The GitHub Copilot provider adapter (issue #581, Phase 2)
// =============================================================================
//
// An `AiProviderAdapter` over the GitHub Copilot SDK, so KVox Desktop can run
// its AI features on the user's own Copilot subscription: `createDirectRuntime`
// takes it like any other adapter, and `createKvoxAi` above it is unchanged.
//
// WHAT IT IS: a TRANSLATOR. One `responses.create`/`responses.stream` call is
// ONE Copilot session with ONE user message, deleted when the call settles.
// The request becomes a system prompt and a user prompt; the session's events
// become provider-adapter stream events; a failure becomes a platform `AiError`
// (`copilot-errors.ts`).
//
// WHAT IT IS NOT. It holds NO prompt text, NO retry loop, NO tool loop and no
// KVox rule: those are kvox-ai's (`createKvoxAi`, the prompted structured path)
// and kvox-api's. Where the SDK would add behaviour of its own, the adapter
// SUPPRESSES it, and each suppression is marked so below:
//
//   SUPPRESSION (datetime)     the runtime prefixes each prompt with a
//                              `<current_datetime>` block; the hook hands the
//                              prompt back unchanged.
//   SUPPRESSION (continuation) after a `length` finish the runtime sends its own
//                              "please continue" turn; the adapter aborts at once
//                              and reports `length`.
//   SUPPRESSION (retries)      after a `model.call_failure` the runtime retries;
//                              the adapter aborts and reports the failure (kvox-ai
//                              owns the retry policy). One SDK retry may already
//                              be in flight; its result is discarded.
//
// ⚠ ZERO TOOLS. Every session is created with `availableTools: []` (and the
// client with `mode: 'empty'`), every permission request is rejected, and the
// session's live tool list is read after it is created: a single tool there, or
// a tool event (`external_tool.requested`, `permission.requested`,
// `tool.execution_start`, an assistant message with tool requests) during the
// call, aborts it with `AI_CAPABILITY_UNSUPPORTED`. A security tripwire, not a
// feature check.
// ⚠ OUR SYSTEM PROMPT REPLACES THE SDK'S (`systemMessage.mode: 'replace'`).
// ⚠ NO COPILOT TOKEN CROSSES THIS CODE. The transport signs in as the logged-in
// user; `ctx.apiKey` is `AI_KEYLESS_API_KEY` and is ignored. Every message that
// leaves (error, log entry, stream `error` event) is `redactTokens`-ed. Logs
// carry provider, model, duration, token counts and finish reason, never content.
// ⚠ OPT-IN. `createCopilotAdapter` refuses to build unless the host passes the
// user's own opt-in (a setting that defaults to off).
// ⚠ EVERY SESSION IS DELETED in `finally` (disconnect, then `deleteSession`): the
// runtime otherwise keeps the prompt in `session-state/<id>/events.jsonl`.
// =============================================================================

/**
 * The adapter's provider id. Permanent: stored in settings and usage rows.
 *
 * @stability experimental
 */
export const COPILOT_PROVIDER_ID = 'copilot';

/** The longest the adapter waits for one cleanup step (abort, disconnect, delete). */
const CLEANUP_DEADLINE_MS = 5_000;

/** The events that mean the model reached for a tool. */
const TOOL_EVENTS = new Set(['external_tool.requested', 'permission.requested', 'tool.execution_start']);

/**
 * Where the adapter reports what an operator may want: one `info` per call and a
 * `warn` when a cleanup step fails. Never a prompt, an answer, a schema or a token.
 *
 * @stability experimental
 */
export interface CopilotAdapterLogger {
  /**
   * One call settled.
   *
   * @param entry - `msg`, `provider`, `model`, `durationMs`, the token counts and `finishReason`.
   */
  info(entry: Record<string, unknown>): void;
  /**
   * A cleanup step failed (the call's own result is unaffected).
   *
   * @param entry - `msg`, `provider` and the error `code`.
   */
  warn(entry: Record<string, unknown>): void;
}

/**
 * What `createCopilotAdapter` is built from.
 *
 * @stability experimental
 */
export interface CreateCopilotAdapterOptions {
  /**
   * The user's own opt-in to GitHub Copilot. The host passes its setting, which
   * defaults to OFF; anything but `true` refuses to build the adapter.
   */
  optIn: boolean;
  /** The Copilot runtime: `createSdkCopilotTransport` in a host, `createCopilotMockTransport` in a test. */
  transport: CopilotTransport;
  /** Where the per-call `info` and the cleanup `warn` go. Default: nowhere. */
  logger?: CopilotAdapterLogger;
  /** The fallback model catalog. Default `COPILOT_CATALOG`. */
  catalog?: readonly CopilotCatalogEntry[];
}

/**
 * What one Copilot model can do, in the shape of kvox-ai's `KvoxModelInfo`.
 *
 * @stability experimental
 */
export interface CopilotKvoxModelInfo {
  /** The model id. */
  id: string;
  /** The context window in tokens, from the fallback catalog; `null` when unknown. */
  contextWindow: number | null;
  /** The output ceiling in tokens, from the fallback catalog; `null` when unknown. */
  maxOutputTokens: number | null;
  /** Always `true`: natively or prompted, every Copilot model answers structured calls. */
  structuredOutput: true;
  /** Always `false`: the adapter offers the model no tools. */
  toolCalling: false;
  /** How structured output is held (`copilotStructuredOutputMode`). */
  structuredOutputMode: 'native' | 'prompted';
}

/**
 * The adapter's model catalog, in the shape of kvox-ai's `KvoxModelCatalog`, so a
 * host passes it to `createKvoxAi({ catalog })` as it is.
 *
 * @stability experimental
 */
export interface CopilotKvoxCatalog {
  /**
   * What a Copilot model can do.
   *
   * @param provider - the provider id; anything but `copilot` answers `null`.
   * @param model - the model id; any id answers (the fallback numbers, or `null`).
   * @returns the model's description, or `null` for another provider.
   */
  lookup(provider: string, model: string): CopilotKvoxModelInfo | null;
}

/**
 * The GitHub Copilot adapter: an `AiProviderAdapter` with a `responses` port, plus
 * what kvox-ai reads about it and the sign-in status.
 *
 * @stability experimental
 */
export interface CopilotProviderAdapter extends AiProviderAdapter {
  /** The responses port (always present). */
  readonly responses: AiResponsesPort;
  /** What kvox-ai needs to know: no tool calling, no embeddings, and the model catalog. */
  readonly kvox: {
    /** Always `false`: no Copilot model is offered a tool (so Ask is not offered). */
    readonly toolCalling: false;
    /** Always `false`: the adapter has no embeddings port. */
    readonly embeddings: false;
    /** The model catalog, for `createKvoxAi({ catalog })`. */
    readonly catalog: CopilotKvoxCatalog;
  };
  /**
   * Whether a GitHub account is signed in to Copilot on this machine.
   *
   * @returns the sign-in state and login (never a token).
   */
  authStatus(): Promise<CopilotSignInState>;
  /**
   * Signing in to GitHub Copilot (the SDK's experimental flow, run by the Copilot
   * runtime; no token ever reaches KVox code).
   *
   * @example
   * ```ts
   * const challenge = await copilot.signIn.start();       // { kind: 'browser', url } : open it
   * const { login } = await copilot.signIn.wait(abort.signal); // resolves once the user has finished
   * ```
   */
  readonly signIn: {
    /**
     * Begins a sign-in.
     *
     * @returns what the user must do: an address to open, or a code to type.
     * @throws an `AiError` when the runtime cannot start a sign-in.
     */
    start(): Promise<CopilotSignInChallenge>;
    /**
     * Waits until the user has signed in.
     *
     * @param signal - aborts the wait and cancels the sign-in (rejects as `sign_in_cancelled`).
     * @returns the signed-in state (`signedIn: true` and the login, never a token).
     * @throws `AiError` `AI_KEY_REQUIRED` with `details.signInReason` `sign_in_expired`,
     * `sign_in_cancelled` or `sign_in_failed`; another `AiError` when the runtime fails.
     */
    wait(signal?: AbortSignal): Promise<CopilotSignedInState>;
  };
  /**
   * Signs the Copilot runtime's stored account out. Resolves also when nobody was
   * signed in. A GitHub CLI login or a token in the environment is not the
   * runtime's to remove: check {@link CopilotProviderAdapter.authStatus} afterwards.
   *
   * @throws an `AiError` when the runtime cannot sign out.
   */
  signOut(): Promise<void>;
}

/**
 * The state `signIn.wait` resolves to: signed in, as whom.
 *
 * @stability experimental
 */
export interface CopilotSignedInState extends CopilotSignInState {
  /** Always `true`. */
  signedIn: true;
}

/**
 * Whether, and as whom, the user is signed in to GitHub Copilot.
 *
 * @stability experimental
 */
export interface CopilotSignInState {
  /** Whether a GitHub account is signed in to Copilot on this machine. */
  signedIn: boolean;
  /** The signed-in GitHub login, or `null` when signed out or unreported. */
  login: string | null;
}

/**
 * Builds the frozen session settings of one call. Every built-in tool is off and
 * the system prompt replaces the SDK's.
 *
 * @example
 * ```ts
 * const config = copilotSessionConfig({ model: 'gpt-5-mini', instructions: 'Be brief.', workingDirectory: '/tmp/empty' });
 * config.availableTools;      // []
 * config.systemMessage.mode;  // 'replace'
 * ```
 *
 * @param input - the model, the whole system prompt, the transport's working directory and the effort.
 * @returns the session settings.
 * @stability experimental
 */
export function copilotSessionConfig(input: {
  model: string;
  instructions: string;
  workingDirectory: string;
  reasoningEffort?: CopilotReasoningEffort;
}): CopilotSessionConfig {
  return {
    model: input.model,
    streaming: true,
    systemMessage: { mode: 'replace', content: input.instructions },
    availableTools: [],
    enableSkills: false,
    skipCustomInstructions: true,
    skipEmbeddingRetrieval: true,
    infiniteSessions: { enabled: false },
    enableSessionStore: false,
    enableConfigDiscovery: false,
    requestExtensions: false,
    requestCanvasRenderer: false,
    enableMcpApps: false,
    workingDirectory: input.workingDirectory,
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    // SUPPRESSION (datetime): the prompt reaches the model exactly as written.
    hooks: { onUserPromptTransformed: (hookInput) => ({ modifiedTransformedPrompt: hookInput.prompt }) },
    onPermissionRequest: () => ({ kind: 'reject' }),
  };
}

/**
 * Builds the GitHub Copilot adapter.
 *
 * @remarks
 * `id: 'copilot'`, `displayName: 'GitHub Copilot'`, stateless
 * (`supportsPreviousResponseId: false`), no hosted tools, no file inputs, no
 * embeddings. A request is ONE system prompt (`instructions` plus any `system` or
 * `developer` messages) and ONE user message of text; anything else (tools,
 * `previousResponseId`, assistant or tool items, images, files) is refused with
 * `AI_CAPABILITY_UNSUPPORTED` before a session is created. `maxOutputTokens` and
 * `temperature` are not sent: the SDK has no per-call setting for either on
 * Copilot-hosted models. Structured output is sent as `responseSchema` for a
 * `native` model; a `prompted` model's structured request is refused (kvox-ai
 * never sends one; it uses its prompted path).
 *
 * @example
 * ```ts
 * const copilot = createCopilotAdapter({
 *   optIn: settings.copilotEnabled,     // the user's own opt-in, default off
 *   transport: createSdkCopilotTransport({ baseDirectory, workingDirectory }),
 * });
 * const runtime = createDirectRuntime({
 *   adapters: { copilot },
 *   keys: async () => ({ apiKey: AI_KEYLESS_API_KEY }), // no key: the Copilot sign-in is the runtime's
 * });
 * const ai = createKvoxAi({ runtime, taskModels, catalog: copilot.kvox.catalog });
 * ```
 *
 * @param options - the opt-in, the transport, an optional logger and catalog.
 * @returns the adapter.
 * @throws a plain `Error` when `options.optIn` is not `true`.
 * @stability experimental
 */
export function createCopilotAdapter(options: CreateCopilotAdapterOptions): CopilotProviderAdapter {
  if (options?.optIn !== true) {
    throw new Error(
      'GitHub Copilot is switched off. It runs only after the user opts in (a setting that defaults to off); pass optIn: true once they have.',
    );
  }
  const transport = options.transport;
  const logger = options.logger;
  const catalog = options.catalog ?? COPILOT_CATALOG;

  /** The sign-in check every call makes first. */
  const assertSignedIn = async (signal: AbortSignal | undefined): Promise<void> => {
    let status;
    try {
      status = await raced(transport.getAuthStatus(), signal);
    } catch (err) {
      throw thrownOrAbort(err, signal);
    }
    if (status.isAuthenticated !== true) throw new AiError('AI_KEY_REQUIRED', COPILOT_SIGN_IN_MESSAGE);
  };

  /** A cleanup step: bounded, logged without content, never thrown. */
  const cleanup = async (step: string, run: () => Promise<void>): Promise<void> => {
    try {
      await withinDeadline(run(), CLEANUP_DEADLINE_MS);
    } catch (err) {
      logger?.warn({ msg: `copilot session ${step} failed`, provider: COPILOT_PROVIDER_ID, code: copilotErrorFromThrown(err).code });
    }
  };

  /**
   * One call: one session, one user message. Yields `response.created`, the text
   * deltas, `output_item.done` and `response.completed`; throws an `AiError` on
   * failure (or the signal's reason on abort).
   */
  async function* turn(req: AiResponseRequest, ctx: AiCallContext): AsyncGenerator<AiStreamEvent> {
    const signal = ctx.signal;
    const started = Date.now();
    let usage: AiUsage = {};
    let finishReason: AiFinishReason | 'error' = 'error';
    let model = req.model;

    try {
      if (signal?.aborted) throw signal.reason;
      const plan = planTurn(req, catalog);
      await assertSignedIn(signal);

      let session: CopilotSessionHandle;
      try {
        session = await raced(
          transport.createSession(
            copilotSessionConfig({
              model: req.model,
              instructions: plan.system,
              workingDirectory: transport.workingDirectory,
              ...(plan.reasoningEffort !== undefined ? { reasoningEffort: plan.reasoningEffort } : {}),
            }),
          ),
          signal,
        );
      } catch (err) {
        throw thrownOrAbort(err, signal);
      }

      const queue = new EventQueue();
      const unsubscribe = session.on((event) => queue.push(event));
      let aborted = false;
      let idle = false;
      const abortSession = async (): Promise<void> => {
        if (aborted) return;
        aborted = true;
        await cleanup('abort', () => session.abort());
      };

      try {
        // ⚠ THE TRIPWIRE: a session that offers the model any tool is never used.
        let tools: string[] | null;
        try {
          tools = await raced(session.currentToolNames(), signal);
        } catch (err) {
          throw thrownOrAbort(err, signal);
        }
        if (tools !== null && tools.length > 0) throw toolsOffered();

        try {
          await raced(
            session.send({ prompt: plan.prompt, ...(plan.responseSchema !== undefined ? { responseSchema: plan.responseSchema } : {}) }),
            signal,
          );
        } catch (err) {
          throw thrownOrAbort(err, signal);
        }

        const id = `copilot-${randomUUID()}`;
        yield { type: 'response.created', id };

        let text = '';
        let finish: AiFinishReason | null = null;
        let failure: AiError | null = null;

        for (;;) {
          const event: CopilotSessionEvent = await queue.next(signal);
          const data = event.data ?? {};
          const nested = typeof data.parentToolCallId === 'string' && data.parentToolCallId.length > 0;

          if (TOOL_EVENTS.has(event.type)) {
            await abortSession();
            throw toolsOffered();
          }
          if (event.type === 'assistant.message_delta' && !nested) {
            const delta = typeof data.deltaContent === 'string' ? data.deltaContent : '';
            if (delta.length > 0) {
              text += delta;
              yield { type: 'output_text.delta', delta };
            }
          } else if (event.type === 'assistant.message' && !nested) {
            if (Array.isArray(data.toolRequests) && data.toolRequests.length > 0) {
              await abortSession();
              throw toolsOffered();
            }
            const content = typeof data.content === 'string' ? data.content : '';
            // The streamed text is what was yielded; a final message longer than it
            // contributes only its remainder, so the deltas always add up.
            if (content.startsWith(text) && content.length > text.length) {
              const rest = content.slice(text.length);
              text = content;
              yield { type: 'output_text.delta', delta: rest };
            }
          } else if (event.type === 'assistant.usage' && !nested) {
            usage = usageOf(data);
            if (typeof data.model === 'string' && data.model.length > 0) model = data.model;
            finish = finishOf(data);
            if (finish === 'length') {
              // SUPPRESSION (continuation): the runtime's own "please continue" turn never runs.
              await abortSession();
              break;
            }
          } else if (event.type === 'model.call_failure') {
            // SUPPRESSION (retries): kvox-ai owns the retry policy.
            failure = copilotErrorFromData(data as CopilotErrorData);
            await abortSession();
            break;
          } else if (event.type === 'session.error') {
            failure = copilotErrorFromData(data as CopilotErrorData);
            await abortSession();
            break;
          } else if (event.type === 'session.idle') {
            idle = true;
            if (data.aborted === true && !aborted) {
              failure = new AiError('AI_PROVIDER_UNAVAILABLE', 'GitHub Copilot: the session was aborted before it answered.');
            }
            break;
          }
        }

        if (failure !== null) throw failure;

        finishReason = finish ?? 'stop';
        const response: AiResponse = {
          id,
          provider: COPILOT_PROVIDER_ID,
          model,
          output: [{ type: 'message', text }],
          outputText: text,
          ...(plan.structured !== undefined && finishReason === 'stop' ? { parsed: parsedOrThrow(plan.structured, text) } : {}),
          usage,
          finishReason,
        };
        yield { type: 'output_item.done', item: { type: 'message', text } };
        yield { type: 'response.completed', response };
      } finally {
        // A turn left before the session went idle (a failure, an abort, a consumer
        // that stopped reading) is aborted first, so nothing keeps running.
        if (!idle) await abortSession();
        unsubscribe();
        await cleanup('disconnect', () => session.disconnect());
        await cleanup('delete', () => transport.deleteSession(session.sessionId));
      }
    } catch (err) {
      finishReason = 'error';
      if (signal?.aborted) throw signal.reason;
      throw copilotErrorFromThrown(err);
    } finally {
      logger?.info({
        msg: 'copilot call',
        provider: COPILOT_PROVIDER_ID,
        model,
        durationMs: Date.now() - started,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        finishReason,
      });
    }
  }

  const responses: AiResponsesPort = {
    async create(req, ctx) {
      for await (const event of turn(req, ctx)) {
        if (event.type === 'response.completed') return event.response;
      }
      throw new AiError('AI_PROVIDER_UNAVAILABLE', 'GitHub Copilot: the session ended without an answer.');
    },
    async *stream(req, ctx) {
      // A failure BEFORE `response.created` is thrown; after it, the stream ends with
      // exactly one `error` event (the platform adapters' rule). An abort always throws.
      let created = false;
      try {
        for await (const event of turn(req, ctx)) {
          if (event.type === 'response.created') created = true;
          yield event;
        }
      } catch (err) {
        if (ctx.signal?.aborted || !created || !AiError.isAiError(err)) throw err;
        yield { type: 'error', code: err.code, message: redactTokens(err.message) };
      }
    },
  };

  const kvoxCatalog: CopilotKvoxCatalog = {
    lookup(provider, modelId) {
      if (provider !== COPILOT_PROVIDER_ID) return null;
      const entry = copilotCatalogEntry(modelId, catalog);
      return {
        id: modelId,
        contextWindow: entry?.contextWindow ?? null,
        maxOutputTokens: entry?.maxOutputTokens ?? null,
        structuredOutput: true,
        toolCalling: false,
        structuredOutputMode: copilotStructuredOutputMode(modelId, catalog),
      };
    },
  };

  return {
    id: COPILOT_PROVIDER_ID,
    displayName: 'GitHub Copilot',
    supportsPreviousResponseId: false,
    supportsHostedTools: false,
    responses,
    kvox: { toolCalling: false, embeddings: false, catalog: kvoxCatalog },

    async verifyKey(ctx): Promise<AiKeyVerification> {
      try {
        const status = await raced(transport.getAuthStatus(), ctx.signal);
        return status.isAuthenticated === true ? { ok: true } : { ok: false, code: 'AI_KEY_REQUIRED', detail: 'Sign in to GitHub Copilot.' };
      } catch (err) {
        const mapped = copilotErrorFromThrown(err);
        return { ok: false, code: 'AI_PROVIDER_UNAVAILABLE', detail: redactTokens(mapped.message) };
      }
    },

    async listModels(ctx): Promise<AiDiscoveredModel[]> {
      await assertSignedIn(ctx.signal);
      let listed;
      try {
        listed = await raced(transport.listModels(), ctx.signal);
      } catch (err) {
        throw thrownOrAbort(err, ctx.signal);
      }
      return listed
        .filter((entry) => entry.policy?.state !== 'disabled')
        .map((entry) => {
          const limits = entry.capabilities?.limits;
          const inputTokenLimit = limits?.max_prompt_tokens ?? limits?.max_context_window_tokens;
          const metadata: AiDiscoveredModelMetadata = {
            ...(typeof entry.name === 'string' ? { displayName: entry.name } : {}),
            ...(typeof inputTokenLimit === 'number' ? { inputTokenLimit } : {}),
            ...(typeof limits?.max_output_tokens === 'number' ? { outputTokenLimit: limits.max_output_tokens } : {}),
          };
          return { id: entry.id, ownedBy: 'github-copilot', metadata };
        });
    },

    classifyModel(modelId, metadata): AiModelCapabilities | null {
      const entry = copilotCatalogEntry(modelId, catalog);
      const contextWindow = metadata?.inputTokenLimit ?? entry?.contextWindow;
      const maxOutputTokens = metadata?.outputTokenLimit ?? entry?.maxOutputTokens;
      // Never `tools`: the adapter offers no model a tool.
      return {
        capabilities: ['responses', 'streaming', 'structured_output'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      };
    },

    async authStatus() {
      try {
        const status = await transport.getAuthStatus();
        return { signedIn: status.isAuthenticated === true, login: status.isAuthenticated === true ? (status.login ?? null) : null };
      } catch (err) {
        throw copilotErrorFromThrown(err);
      }
    },

    signIn: {
      async start() {
        try {
          return challengeOf(await transport.startSignIn());
        } catch (err) {
          throw copilotErrorFromThrown(err);
        }
      },
      async wait(signal) {
        if (isAborted(signal)) throw copilotSignInCancelled();
        let status;
        try {
          status = await raced(transport.waitForSignIn(signal), signal);
        } catch (err) {
          if (isAborted(signal)) throw copilotSignInCancelled();
          throw copilotErrorFromThrown(err);
        }
        if (status.isAuthenticated !== true) {
          throw copilotSignInFailed('sign_in_failed', 'The GitHub Copilot sign-in did not finish.');
        }
        // Only the two fields: whatever else a transport hands back stays here.
        return { signedIn: true, login: typeof status.login === 'string' ? redactTokens(status.login).slice(0, 200) : null };
      },
    },

    async signOut() {
      try {
        await transport.signOut();
      } catch (err) {
        throw copilotErrorFromThrown(err);
      }
    },
  };
}

/** Whether the signal has aborted (read fresh: TypeScript narrows a property read once). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The challenge with only its documented fields, strings redacted (a transport's extras never leave). */
function challengeOf(challenge: CopilotSignInChallenge): CopilotSignInChallenge {
  const text = (value: unknown): string => (typeof value === 'string' ? redactTokens(value).slice(0, 2_000) : '');
  if (challenge?.kind === 'device') {
    return {
      kind: 'device',
      userCode: text(challenge.userCode),
      verificationUri: text(challenge.verificationUri),
      expiresAt: text(challenge.expiresAt),
    };
  }
  if (challenge?.kind === 'browser') return { kind: 'browser', url: text(challenge.url) };
  throw new AiError('AI_PROVIDER_UNAVAILABLE', 'GitHub Copilot returned a sign-in this version of KVox cannot show.');
}

// ---------------------------------------------------------------------------
// The request mapping
// ---------------------------------------------------------------------------

/** One call as a Copilot session takes it. */
interface CopilotTurnPlan {
  /** The whole system prompt. */
  system: string;
  /** The one user message. */
  prompt: string;
  /** The JSON Schema of a native structured call. */
  responseSchema?: Record<string, unknown>;
  /** The Zod schema the answer is validated with. */
  structured?: z.ZodTypeAny;
  /** The session's effort, when the request asked for one. */
  reasoningEffort?: CopilotReasoningEffort;
}

/** The refusal of a request shape a Copilot session cannot take. */
function unsupported(what: string): AiError {
  return new AiError(
    'AI_CAPABILITY_UNSUPPORTED',
    `The Copilot adapter takes a system prompt and one user message; ${what} is not supported.`,
  );
}

/** The tripwire's failure. */
function toolsOffered(): AiError {
  return new AiError(
    'AI_CAPABILITY_UNSUPPORTED',
    'The Copilot session offered the model a tool; the call was stopped (the adapter runs with zero tools).',
  );
}

/**
 * The request as one system prompt and one user message, or a refusal. Nothing is
 * added: the system prompt is `instructions` then any system/developer messages,
 * joined by a blank line; the user prompt is the one user message's text parts.
 */
function planTurn(req: AiResponseRequest, catalog: readonly CopilotCatalogEntry[]): CopilotTurnPlan {
  if (req.tools !== undefined && req.tools.length > 0) throw unsupported('a tool');
  if (req.previousResponseId !== undefined) throw unsupported('previousResponseId');

  const system: string[] = [];
  if (typeof req.instructions === 'string' && req.instructions.length > 0) system.push(req.instructions);

  let prompt: string;
  if (typeof req.input === 'string') {
    prompt = req.input;
  } else {
    const users: string[] = [];
    for (const item of req.input) {
      if (item.type !== 'message') throw unsupported(`an input item of type "${item.type}"`);
      if (item.role === 'assistant') throw unsupported('an assistant message');
      const texts = item.content.map((part) => {
        if (part.type !== 'text') throw unsupported(`a ${part.type} part`);
        return part.text;
      });
      if (item.role === 'user') users.push(texts.join(''));
      else if (texts.join('').length > 0) system.push(texts.join(''));
    }
    if (users.length !== 1) throw unsupported(users.length === 0 ? 'a request without a user message' : 'more than one user message');
    prompt = users[0];
  }

  const plan: CopilotTurnPlan = { system: system.join('\n\n'), prompt };

  if (req.structuredOutput !== undefined) {
    if (copilotStructuredOutputMode(req.model, catalog) === 'prompted') {
      // kvox-ai never sends this (it takes its prompted path); a misconfiguration must be loud.
      throw unsupported(`native structured output on "${req.model}" (a prompted model)`);
    }
    plan.responseSchema = toJsonSchema(req.structuredOutput.schema);
    plan.structured = req.structuredOutput.schema;
  }

  const effort = req.reasoning?.effort;
  if (effort !== undefined) plan.reasoningEffort = effort === 'minimal' ? 'low' : effort;

  return plan;
}

// ---------------------------------------------------------------------------
// The event mapping
// ---------------------------------------------------------------------------

/** `assistant.usage` as the platform's usage (absent counts stay absent). */
function usageOf(data: Record<string, unknown>): AiUsage {
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const inputTokens = count(data.inputTokens);
  const outputTokens = count(data.outputTokens);
  const reasoningTokens = count(data.reasoningTokens);
  const cachedInputTokens = count(data.cacheReadTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

/** `assistant.usage`'s finish reason: `stop`, `length` or `content_filter` (anything else is `stop`). */
function finishOf(data: Record<string, unknown>): AiFinishReason {
  if (data.contentFilterTriggered === true) return 'content_filter';
  if (data.finishReason === 'length') return 'length';
  if (data.finishReason === 'content_filter') return 'content_filter';
  return 'stop';
}

/**
 * A native structured answer, parsed and validated by the platform's own helper
 * (`AI_STRUCTURED_OUTPUT_INVALID` with `details.issues`, as every adapter), with the
 * issue messages redacted and capped (a JSON parser quotes the text it choked on).
 */
function parsedOrThrow(schema: z.ZodTypeAny, text: string): unknown {
  try {
    return parseStructured(schema, text);
  } catch (err) {
    if (!AiError.isAiError(err)) throw err;
    const issues = (err.toJSON().details.issues as Array<{ path: unknown; code: unknown; message: unknown }> | undefined) ?? [];
    throw new AiError(err.code, err.message, {
      details: {
        issues: issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: typeof issue.message === 'string' ? redactTokens(issue.message).slice(0, 200) : '',
        })),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/** The session's events, in order, awaited one at a time and raced with the call's signal. */
class EventQueue {
  private readonly items: CopilotSessionEvent[] = [];
  private wake: (() => void) | null = null;

  push(event: CopilotSessionEvent): void {
    this.items.push(event);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async next(signal: AbortSignal | undefined): Promise<CopilotSessionEvent> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) return item;
      await raced(
        new Promise<void>((resolve) => {
          this.wake = resolve;
        }),
        signal,
      );
    }
  }
}

/** `promise`, or the signal's reason as soon as it aborts. */
function raced<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      },
    );
  });
}

/** `promise`, or a rejection after `ms` (a hung runtime must not hold the call). */
function withinDeadline(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** An abort surfaces as the signal's reason; anything else as a mapped `AiError`. */
function thrownOrAbort(err: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return signal.reason;
  return copilotErrorFromThrown(err);
}
