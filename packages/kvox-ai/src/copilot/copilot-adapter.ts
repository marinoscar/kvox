import { randomUUID } from 'node:crypto';

import {
  AiError,
  isFunctionTool,
  parseStructured,
  toJsonSchema,
  type AiCallContext,
  type AiDiscoveredModel,
  type AiDiscoveredModelMetadata,
  type AiFinishReason,
  type AiInputItem,
  type AiKeyVerification,
  type AiModelCapabilities,
  type AiOutputItem,
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
  CopilotPermissionRequest,
  CopilotReasoningEffort,
  CopilotSignInChallenge,
  CopilotSessionConfig,
  CopilotSessionEvent,
  CopilotSessionHandle,
  CopilotToolDefinition,
  CopilotToolInvocation,
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
// ONE model step: one Copilot session with ONE user message, deleted when the
// call settles. The request becomes a system prompt and a user prompt; the
// session's events become provider-adapter stream events; a failure becomes a
// platform `AiError` (`copilot-errors.ts`).
//
// ONE EXCEPTION, THE TOOL BRIDGE (issue #654). When a request carries function
// tools (the Ask loop), the session declares them as CUSTOM tools whose handlers
// do not run anything: each returns a promise that resolves only when the caller's
// loop supplies the tool's output. The step ends with the model's tool calls and
// the session stays OPEN, held in a registry keyed by the call ids. The next
// request (the loop's full history plus the `function_call_output` items) finds the
// session by those ids, resolves the promises and streams the continuation from
// the same session as the next step. No session found (expired, restarted, edited)
// is never a failure: a fresh session gets the transcript rendered as text. The
// loop, the prompts and the tools stay where they were (kvox-api); the adapter only
// carries a step's tool calls out and a step's tool outputs back in.
//
// WHAT IT IS NOT. It holds NO prompt text, NO retry loop, NO tool loop and no
// KVox rule: those are kvox-ai's (`createKvoxAi`, the prompted structured path)
// and kvox-api's. The one text it writes is the STRUCTURE of a rendered transcript
// (the labels of the lost-session fallback). Where the SDK would add behaviour of
// its own, the adapter SUPPRESSES it, and each suppression is marked so below:
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
// ⚠ NO BUILT-IN TOOLS. The client is `mode: 'empty'`; every session's
// `availableTools` is an allowlist of EXACTLY the request's own function tools
// (`custom:<name>`, so a built-in tool of the same name never matches), empty for a
// call without tools. Every permission request is rejected except the `custom-tool`
// request of one of the session's own tools. Every own tool is declared with
// `overridesBuiltInTool: true`, so a name that clashes with a runtime built-in
// (Ask's `search`, `timeline`, ...) does not fail session creation; it is harmless
// because the built-ins are off (`mode: 'empty'` plus the `custom:<name>` allowlist).
// The session's live tool list is read after it is created: a name there that is not
// one of the request's own tools is only WARNED about (once per name, names only;
// the list is unverified on a real runtime and may carry internal entries). A tool
// CALL for any other tool during the call (`external_tool.requested`,
// `permission.requested` of another kind, `tool.execution_start`, an assistant
// message with tool requests, an MCP tool) aborts it with
// `AI_CAPABILITY_UNSUPPORTED`. A security tripwire, not a feature check.
// ⚠ OUR SYSTEM PROMPT REPLACES THE SDK'S (`systemMessage.mode: 'replace'`).
// ⚠ NO COPILOT TOKEN CROSSES THIS CODE. The transport signs in as the logged-in
// user; `ctx.apiKey` is `AI_KEYLESS_API_KEY` and is ignored. Every message that
// leaves (error, log entry, stream `error` event) is `redactTokens`-ed. Logs
// carry provider, model, duration, token counts and finish reason, never content.
// ⚠ OPT-IN. `createCopilotAdapter` refuses to build unless the host passes the
// user's own opt-in (a setting that defaults to off).
// ⚠ EVERY SESSION IS DELETED (disconnect, then `deleteSession`): in `finally` when
// its step ends without tool calls, on abort and on error, and when a held session
// is not claimed within the idle timeout or is pushed out by a newer one. The
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

/** How long a held session waits for the loop's tool outputs before it is deleted. */
const DEFAULT_HELD_IDLE_TIMEOUT_MS = 120_000;

/** The most sessions held at once; a newer one pushes the oldest out. */
const DEFAULT_MAX_HELD_SESSIONS = 8;

/**
 * After the assistant message that lists a step's tool calls, how long the adapter
 * waits for the step's usage (or the first tool event) before it ends the step anyway.
 */
const DEFAULT_TOOL_BATCH_GRACE_MS = 1_000;

/** The events that mean a HELD session went on without the loop (it can no longer be continued). */
const DIVERGENT_EVENTS = new Set(['session.idle', 'session.error', 'model.call_failure', 'assistant.message', 'assistant.message_delta']);

/**
 * Where the adapter reports what an operator may want: one `info` per call, a
 * `warn` when a cleanup step fails and a `warn` when a session lists a tool that is
 * not the request's own. Never a prompt, an answer, a schema or a token.
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
   * A cleanup step failed (the call's own result is unaffected), or a session's tool
   * list holds a tool that is not the request's own (logged once per tool name; the
   * call goes on).
   *
   * @param entry - `msg`, `provider` and the error `code`, or `msg`, `provider` and
   * `tools` (the redacted, truncated names) for the tool list.
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
  /** The tool bridge's limits (held sessions between a step's tool calls and the next step). */
  bridge?: CopilotBridgeOptions;
}

/**
 * The limits of the tool bridge: the sessions it holds open between the step that
 * calls tools and the step that carries their outputs.
 *
 * @stability experimental
 */
export interface CopilotBridgeOptions {
  /**
   * How long a held session waits for the loop's tool outputs before it is aborted
   * and deleted. Default 120 000 ms (the longest an Ask tool step is expected to take).
   */
  idleTimeoutMs?: number;
  /** The most held sessions at once; a newer one deletes the oldest. Default 8. */
  maxHeldSessions?: number;
  /**
   * After the assistant message that lists a step's tool calls, how long the adapter
   * waits for the step's usage (or a tool event) before it ends the step anyway.
   * Default 1 000 ms.
   */
  batchGraceMs?: number;
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
  /**
   * Whether the model can run the Ask loop (the tool bridge). `true` unless the
   * live model listing said `false` for this model.
   */
  toolCalling: boolean;
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
  /** What kvox-ai needs to know: tool calling (through the bridge), no embeddings, and the model catalog. */
  readonly kvox: {
    /** Always `true`: the tool bridge serves the Ask loop (a model the live listing marks as tool-less is `catalog.lookup(...).toolCalling === false`). */
    readonly toolCalling: true;
    /** Always `false`: the adapter has no embeddings port. */
    readonly embeddings: false;
    /** The model catalog, for `createKvoxAi({ catalog })`. */
    readonly catalog: CopilotKvoxCatalog;
  };
  /**
   * The tool bridge's held sessions: the sessions kept open between a step's tool
   * calls and the next step. A host calls `closeAll` when it shuts down.
   */
  readonly bridge: {
    /**
     * How many sessions are held right now.
     *
     * @returns the count.
     */
    heldSessions(): number;
    /** Aborts and deletes every held session (also stops their idle timers). */
    closeAll(): Promise<void>;
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
 * Builds the frozen session settings of one call. No built-in tool is available:
 * `availableTools` is empty, or exactly the request's own function tools; and the
 * system prompt replaces the SDK's.
 *
 * @example
 * ```ts
 * const config = copilotSessionConfig({ model: 'gpt-5-mini', instructions: 'Be brief.', workingDirectory: '/tmp/empty' });
 * config.availableTools;      // []
 * config.systemMessage.mode;  // 'replace'
 * ```
 *
 * @param input - the model, the whole system prompt, the transport's working directory, the effort and the request's own tools.
 * @returns the session settings.
 * @stability experimental
 */
export function copilotSessionConfig(input: {
  model: string;
  instructions: string;
  workingDirectory: string;
  reasoningEffort?: CopilotReasoningEffort;
  tools?: CopilotToolDefinition[];
}): CopilotSessionConfig {
  const tools = input.tools ?? [];
  const own = new Set(tools.map((tool) => tool.name));
  return {
    model: input.model,
    streaming: true,
    systemMessage: { mode: 'replace', content: input.instructions },
    // Source-qualified: a built-in tool that happens to share a name is not matched.
    availableTools: tools.map((tool) => `custom:${tool.name}`),
    ...(tools.length > 0 ? { tools } : {}),
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
    // Everything is rejected except the custom-tool request of one of the request's own tools.
    onPermissionRequest: (request?: CopilotPermissionRequest) =>
      request?.kind === 'custom-tool' && typeof request.toolName === 'string' && own.has(request.toolName)
        ? { kind: 'approve-once' }
        : { kind: 'reject' },
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

  /** The foreign tool names already warned about (one `warn` per name for the adapter's life). */
  const warnedTools = new Set<string>();

  /** Logs the tools a session lists that are not the request's own: names only, redacted, once per name. */
  const warnListedTools = (names: readonly string[]): void => {
    const fresh = names.filter((name) => !warnedTools.has(name));
    if (fresh.length === 0) return;
    for (const name of fresh) warnedTools.add(name);
    logger?.warn({
      msg: "copilot session lists tools that are not the request's own",
      provider: COPILOT_PROVIDER_ID,
      tools: shownToolNames(fresh),
    });
  };

  /** A cleanup step: bounded, logged without content, never thrown. */
  const cleanup = async (step: string, run: () => Promise<void>): Promise<void> => {
    try {
      await withinDeadline(run(), CLEANUP_DEADLINE_MS);
    } catch (err) {
      logger?.warn({ msg: `copilot session ${step} failed`, provider: COPILOT_PROVIDER_ID, code: copilotErrorFromThrown(err).code });
    }
  };

  // ---------------------------------------------------------------------------
  // The tool bridge: sessions held between a step's tool calls and the next step
  // ---------------------------------------------------------------------------

  const idleTimeoutMs = options.bridge?.idleTimeoutMs ?? DEFAULT_HELD_IDLE_TIMEOUT_MS;
  const maxHeldSessions = Math.max(1, options.bridge?.maxHeldSessions ?? DEFAULT_MAX_HELD_SESSIONS);
  const batchGraceMs = options.bridge?.batchGraceMs ?? DEFAULT_TOOL_BATCH_GRACE_MS;

  /** The held sessions by the id of each of their pending tool calls. */
  const registry = new Map<string, LiveSession>();
  /** The held sessions, oldest first. */
  const held = new Set<LiveSession>();
  /** The model's latest word on tool support per model (`listModels`); absent means "assume it works". */
  const liveToolCalling = new Map<string, boolean>();

  /** Aborts the message in flight, once. */
  const abortLive = async (live: LiveSession): Promise<void> => {
    if (live.aborted) return;
    live.aborted = true;
    await cleanup('abort', () => live.session.abort());
  };

  /** Takes a session out of the registry and stops its timer. */
  const release = (live: LiveSession): void => {
    if (live.timer !== undefined) clearTimeout(live.timer);
    live.timer = undefined;
    held.delete(live);
    for (const id of live.pending) if (registry.get(id) === live) registry.delete(id);
  };

  /**
   * Ends a session for good: aborts what it is doing, lets its tool handlers go, and
   * deletes it (disconnect, then `deleteSession`: the runtime keeps the prompt otherwise).
   */
  const closeLive = (live: LiveSession): Promise<void> => {
    // Closing twice (the idle timer and a failing step, say) waits for the one close.
    live.closing ??= (async () => {
      live.state = 'closed';
      release(live);
      // A turn left before the session went idle (a failure, an abort, a consumer that
      // stopped reading, a held session nobody claimed) is aborted first, so nothing keeps running.
      if (!live.idle) await abortLive(live);
      live.rejectAll(new Error('The Copilot session was closed before the tool output arrived.'));
      live.unsubscribe();
      await cleanup('disconnect', () => live.session.disconnect());
      await cleanup('delete', () => transport.deleteSession(live.session.sessionId));
    })();
    return live.closing;
  };

  /** Keeps a session open after a step that called tools, until the loop's outputs arrive. */
  const park = async (live: LiveSession, ids: string[]): Promise<void> => {
    live.state = 'held';
    live.pending = ids;
    for (const id of ids) registry.set(id, live);
    held.add(live);
    live.timer = setTimeout(() => {
      logger?.info({ msg: 'copilot held session expired', provider: COPILOT_PROVIDER_ID, pendingCalls: ids.length });
      void closeLive(live);
    }, idleTimeoutMs);
    live.timer.unref?.();
    while (held.size > maxHeldSessions) {
      const oldest = held.values().next().value as LiveSession | undefined;
      if (oldest === undefined || oldest === live) break;
      await closeLive(oldest);
    }
  };

  /**
   * The held session this request continues, claimed (`running` again), or `undefined`.
   * A request that cannot continue the session it names (another prompt, model or
   * tools, missing outputs) releases it: the loop has moved on, so nobody will come back.
   */
  const claimHeld = async (plan: CopilotTurnPlan): Promise<LiveSession | undefined> => {
    let candidate: LiveSession | undefined;
    for (const id of plan.outputs.keys()) {
      candidate = registry.get(id);
      if (candidate !== undefined) break;
    }
    if (candidate === undefined) return undefined;
    const usable =
      plan.tools.length > 0 &&
      plan.endsWithOutputs &&
      candidate.state === 'held' &&
      !candidate.diverged &&
      !candidate.idle &&
      candidate.fingerprint === plan.fingerprint &&
      candidate.pending.every((id) => plan.outputs.has(id));
    if (!usable) {
      await closeLive(candidate);
      return undefined;
    }
    release(candidate);
    candidate.state = 'running';
    return candidate;
  };

  /** Opens a session for a plan: created, subscribed, and checked against the tool allowlist. */
  const openLive = async (plan: CopilotTurnPlan, signal: AbortSignal | undefined): Promise<LiveSession> => {
    const holder: { live?: LiveSession } = {};
    const tools: CopilotToolDefinition[] = plan.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      skipPermission: true,
      defer: 'never',
      overridesBuiltInTool: true,
      handler: (args, invocation) => {
        if (holder.live === undefined) return Promise.reject(new Error('The Copilot session is not ready.'));
        return holder.live.handle(args, invocation);
      },
    }));

    let session: CopilotSessionHandle;
    try {
      session = await raced(
        transport.createSession(
          copilotSessionConfig({
            model: plan.model,
            instructions: plan.system,
            workingDirectory: transport.workingDirectory,
            ...(plan.reasoningEffort !== undefined ? { reasoningEffort: plan.reasoningEffort } : {}),
            ...(tools.length > 0 ? { tools } : {}),
          }),
        ),
        signal,
      );
    } catch (err) {
      throw thrownOrAbort(err, signal);
    }

    const live = new LiveSession(session, plan.fingerprint, new Set(plan.tools.map((tool) => tool.name)));
    holder.live = live;
    live.unsubscribe = session.on((event) => {
      live.queue.push(event);
      // A held session that goes on by itself (it went idle, failed, or answered) cannot be continued.
      const nested = typeof event.data?.parentToolCallId === 'string' && event.data.parentToolCallId.length > 0;
      if (live.state === 'held' && !nested && DIVERGENT_EVENTS.has(event.type)) {
        live.diverged = true;
        void closeLive(live);
      }
    });
    return live;
  };

  /**
   * One model step: either a fresh session sent the plan's prompt, or a held session
   * whose tool calls the loop has now answered. Yields `response.created`, the text
   * deltas, `output_item.done` and `response.completed`; throws an `AiError` on
   * failure (or the signal's reason on abort).
   */
  async function* turn(req: AiResponseRequest, ctx: AiCallContext): AsyncGenerator<AiStreamEvent> {
    const signal = ctx.signal;
    const started = Date.now();
    let usage: AiUsage = {};
    let finishReason: AiFinishReason | 'error' = 'error';
    let model = req.model;
    let live: LiveSession | undefined;
    let parked = false;
    let resumed = false;

    try {
      if (signal?.aborted) throw signal.reason;
      const plan = planTurn(req, catalog);
      await assertSignedIn(signal);

      live = await claimHeld(plan);
      resumed = live !== undefined;
      if (live === undefined) {
        const opened = await openLive(plan, signal);
        live = opened;

        // ⚠ THE TRIPWIRE, listing half: a tool the session lists that the request did not declare is
        // only logged (the list is unverified on a real runtime). A CALL of one aborts, in the loop below.
        let tools: string[] | null;
        try {
          tools = await raced(live.session.currentToolNames(), signal);
        } catch (err) {
          throw thrownOrAbort(err, signal);
        }
        warnListedTools((tools ?? []).filter((name) => !opened.ownTools.has(name)));

        try {
          await raced(
            live.session.send({ prompt: plan.prompt, ...(plan.responseSchema !== undefined ? { responseSchema: plan.responseSchema } : {}) }),
            signal,
          );
        } catch (err) {
          throw thrownOrAbort(err, signal);
        }
      } else {
        // The loop ran this session's tools: hand each tool its output, and the runtime's turn goes on.
        live.deliver(plan.outputs);
      }

      const id = `copilot-${randomUUID()}`;
      yield { type: 'response.created', id };

      let text = '';
      let finish: AiFinishReason | null = null;
      let failure: AiError | null = null;
      /** The step's tool calls, by id (from the assistant message's `toolRequests`, else the tool events). */
      const batch = new Map<string, StepToolCall>();
      let batchListed = false;
      let usageSeen = false;
      let toolEventSeen = false;
      /** Whether the step has everything it needs to end as a tool step. */
      const batchReady = (): boolean => batch.size > 0 && batchListed && (usageSeen || toolEventSeen);

      for (;;) {
        const waiting = batch.size > 0 && !batchReady();
        const event = await live.queue.next(signal, waiting ? batchGraceMs : undefined);
        if (event === null) break; // the grace ran out: the step has the calls it is going to get
        const data = event.data ?? {};
        const nested = typeof data.parentToolCallId === 'string' && data.parentToolCallId.length > 0;

        if (TOOL_EVENTS.has(event.type)) {
          const own = ownToolEvent(event, live.ownTools);
          if (own === null) {
            await abortLive(live);
            throw toolsOffered(foreignNameOf(event));
          }
          // A call of an earlier step (its events can arrive after that step ended) is not this step's.
          const callId = toolCallIdOf(event);
          if (callId === '' || !live.answered.has(callId)) {
            toolEventSeen = true;
            if (event.type === 'external_tool.requested' && !batchListed && callId !== '' && !batch.has(callId)) {
              batch.set(callId, { callId, name: own, argumentsJson: argumentsJsonOf(data.arguments) });
            }
          }
        } else if (event.type === 'assistant.message_delta' && !nested) {
          const delta = typeof data.deltaContent === 'string' ? data.deltaContent : '';
          if (delta.length > 0) {
            text += delta;
            yield { type: 'output_text.delta', delta };
          }
        } else if (event.type === 'assistant.message' && !nested) {
          if (Array.isArray(data.toolRequests) && data.toolRequests.length > 0) {
            const requests = toolRequestsOf(data.toolRequests, live.ownTools);
            if (requests === null) {
              await abortLive(live);
              throw toolsOffered(foreignRequestNames(data.toolRequests, live.ownTools));
            }
            batchListed = true;
            for (const request of requests) batch.set(request.callId, request);
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
          usage = addUsage(usage, usageOf(data));
          usageSeen = true;
          if (typeof data.model === 'string' && data.model.length > 0) model = data.model;
          finish = finishOf(data);
          if (finish === 'length') {
            // SUPPRESSION (continuation): the runtime's own "please continue" turn never runs.
            batch.clear();
            await abortLive(live);
            break;
          }
        } else if (event.type === 'model.call_failure') {
          // SUPPRESSION (retries): kvox-ai owns the retry policy.
          failure = copilotErrorFromData(data as CopilotErrorData);
          await abortLive(live);
          break;
        } else if (event.type === 'session.error') {
          failure = copilotErrorFromData(data as CopilotErrorData);
          await abortLive(live);
          break;
        } else if (event.type === 'session.idle') {
          live.idle = true;
          if (data.aborted === true && !live.aborted) {
            failure = new AiError('AI_PROVIDER_UNAVAILABLE', 'GitHub Copilot: the session was aborted before it answered.');
          }
          break;
        }

        if (batchReady()) break;
      }

      if (failure !== null) throw failure;

      const calls = finish === 'content_filter' ? [] : [...batch.values()];
      const toolStep = calls.length > 0;
      finishReason = toolStep ? 'tool_calls' : (finish ?? 'stop');

      const output: AiOutputItem[] = [];
      if (text.length > 0 || !toolStep) output.push({ type: 'message', text });
      if (toolStep) {
        // The calls are registered and the session held BEFORE the caller can see them: the
        // loop may come back with the outputs the moment the last event is yielded.
        for (const call of calls) {
          output.push({ type: 'function_call', callId: call.callId, name: call.name, arguments: call.argumentsJson });
        }
        live.register(calls);
        if (live.idle || live.aborted || live.diverged || live.state !== 'running') {
          // Nothing left to continue: the next step starts from the transcript.
        } else {
          await park(live, calls.map((call) => call.callId));
          parked = true;
        }
      }

      const response: AiResponse = {
        id,
        provider: COPILOT_PROVIDER_ID,
        model,
        output,
        outputText: text,
        ...(!toolStep && plan.structured !== undefined && finishReason === 'stop' ? { parsed: parsedOrThrow(plan.structured, text) } : {}),
        usage,
        finishReason,
      };
      for (const item of output) yield { type: 'output_item.done', item };
      yield { type: 'response.completed', response };
    } catch (err) {
      finishReason = 'error';
      if (signal?.aborted) throw signal.reason;
      throw copilotErrorFromThrown(err);
    } finally {
      if (live !== undefined && !parked) await closeLive(live);
      logger?.info({
        msg: 'copilot call',
        provider: COPILOT_PROVIDER_ID,
        model,
        durationMs: Date.now() - started,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        finishReason,
        ...(resumed ? { resumed: true } : {}),
        ...(parked ? { heldForTools: true } : {}),
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
        toolCalling: liveToolCalling.get(modelId) ?? true,
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
    kvox: { toolCalling: true, embeddings: false, catalog: kvoxCatalog },
    bridge: {
      heldSessions: () => held.size,
      closeAll: async () => {
        await Promise.all([...held].map((live) => closeLive(live)));
      },
    },

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
          // An explicit "no tool calling" in the listing takes Ask off the model; silence means yes.
          const supportsTools = entry.capabilities?.supports?.toolCalls ?? entry.capabilities?.supports?.tool_calls;
          if (typeof supportsTools === 'boolean') liveToolCalling.set(entry.id, supportsTools);
          else liveToolCalling.delete(entry.id);
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
      // `tools` through the bridge, unless the live listing said the model cannot call them.
      return {
        capabilities: [
          'responses',
          'streaming',
          'structured_output',
          ...(liveToolCalling.get(modelId) === false ? [] : (['tools'] as const)),
        ],
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

/** One of the request's own function tools, as the session declares it. */
interface PlanTool {
  /** The tool's name. */
  name: string;
  /** What it does. */
  description: string;
  /** The JSON Schema of its arguments. */
  parameters: Record<string, unknown>;
}

/** One call as a Copilot session takes it. */
interface CopilotTurnPlan {
  /** The model id. */
  model: string;
  /** The whole system prompt. */
  system: string;
  /** The one user message (a rendered transcript when the request carries history). */
  prompt: string;
  /** The JSON Schema of a native structured call. */
  responseSchema?: Record<string, unknown>;
  /** The Zod schema the answer is validated with. */
  structured?: z.ZodTypeAny;
  /** The session's effort, when the request asked for one. */
  reasoningEffort?: CopilotReasoningEffort;
  /** The function tools the session declares (empty without tools, and for `toolChoice: 'none'`). */
  tools: PlanTool[];
  /** What a held session must have been opened with to be continued by this request. */
  fingerprint: string;
  /** The tool outputs the request carries, by call id. */
  outputs: Map<string, string>;
  /** Whether the request's last item is a tool output (the shape of a continuation). */
  endsWithOutputs: boolean;
}

/** The refusal of a request shape a Copilot session cannot take. */
function unsupported(what: string): AiError {
  return new AiError(
    'AI_CAPABILITY_UNSUPPORTED',
    `The Copilot adapter takes a system prompt and one user message; ${what} is not supported.`,
  );
}

/** Tool names for an error detail or a log line: at most 20, token-redacted, at most 80 characters each. */
function shownToolNames(names: readonly string[]): string[] {
  return names.slice(0, 20).map((name) => redactTokens(name).slice(0, 80));
}

/** The tripwire's failure: the model called a tool that is not the request's own. */
function toolsOffered(names: readonly string[] = []): AiError {
  const shown = shownToolNames(names);
  return new AiError(
    'AI_CAPABILITY_UNSUPPORTED',
    "The Copilot session called a tool that is not one of the request's own; the call was stopped (the adapter runs with no built-in tools).",
    shown.length > 0 ? { details: { tools: shown } } : undefined,
  );
}

/** One line of a conversation the request carries. */
type TranscriptEntry =
  | { kind: 'user' | 'assistant'; text: string }
  | { kind: 'call'; callId: string; name: string; argumentsJson: string }
  | { kind: 'output'; callId: string; output: string };

/**
 * A conversation as the single user message of a fresh session: the lost-session
 * fallback. Only structure is added (labels); every word is the conversation's own.
 */
function renderTranscript(entries: readonly TranscriptEntry[], closing: string): string {
  const names = new Map<string, string>();
  for (const entry of entries) if (entry.kind === 'call') names.set(entry.callId, entry.name);
  const blocks = entries.map((entry) => {
    switch (entry.kind) {
      case 'user':
        return `[user]\n${entry.text}`;
      case 'assistant':
        return `[assistant]\n${entry.text}`;
      case 'call':
        return `[assistant called the tool ${entry.name} (call ${entry.callId})]\n${entry.argumentsJson}`;
      case 'output':
        return `[result of the tool ${names.get(entry.callId) ?? 'call'} (call ${entry.callId})]\n${entry.output}`;
    }
  });
  return ['Conversation so far:', ...blocks, closing].join('\n\n');
}

/**
 * The request as one system prompt and one user message, or a refusal. Nothing is
 * added: the system prompt is `instructions` then any system/developer messages,
 * joined by a blank line; the user prompt is the one user message's text parts.
 *
 * A request that carries function tools is a step of a tool loop: it may also carry
 * the history (earlier turns, the model's tool calls and their outputs). That history
 * becomes a rendered transcript in the one user message ({@link renderTranscript}), the
 * fallback when no held session continues it.
 */
function planTurn(req: AiResponseRequest, catalog: readonly CopilotCatalogEntry[]): CopilotTurnPlan {
  const offered = req.tools ?? [];
  if (!offered.every(isFunctionTool)) throw unsupported('a hosted tool');
  if (req.previousResponseId !== undefined) throw unsupported('previousResponseId');
  /** A tool loop's step: history items are allowed. */
  const loop = offered.length > 0;
  if (loop && req.structuredOutput !== undefined) throw unsupported('structured output together with tools');
  // `toolChoice: 'none'` (the forced-answer step) declares nothing: the model answers from the transcript.
  // `required` and a named function cannot be forced (the SDK has no tool choice); they behave as `auto`.
  const declared = loop && req.toolChoice !== 'none' ? offered.filter(isFunctionTool) : [];

  const system: string[] = [];
  if (typeof req.instructions === 'string' && req.instructions.length > 0) system.push(req.instructions);

  const entries: TranscriptEntry[] = [];
  const outputs = new Map<string, string>();
  let endsWithOutputs = false;
  if (typeof req.input === 'string') {
    entries.push({ kind: 'user', text: req.input });
  } else {
    for (const item of req.input) {
      endsWithOutputs = item.type === 'function_call_output';
      if (item.type === 'message') {
        if (item.role === 'assistant' && !loop) throw unsupported('an assistant message');
        const texts = item.content.map((part) => {
          if (part.type !== 'text') throw unsupported(`a ${part.type} part`);
          return part.text;
        });
        const joined = texts.join('');
        if (item.role === 'user') entries.push({ kind: 'user', text: joined });
        else if (item.role === 'assistant') {
          if (joined.length > 0) entries.push({ kind: 'assistant', text: joined });
        } else if (joined.length > 0) system.push(joined);
      } else if (loop && item.type === 'function_call') {
        entries.push({ kind: 'call', callId: item.callId, name: item.name, argumentsJson: item.arguments });
      } else if (loop && item.type === 'function_call_output') {
        entries.push({ kind: 'output', callId: item.callId, output: item.output });
        outputs.set(item.callId, item.output);
      } else if (loop && item.type === 'reasoning') {
        // Opaque provider state of another adapter's step: nothing a Copilot session can use.
      } else {
        throw unsupported(`an input item of type "${(item as AiInputItem).type}"`);
      }
    }
  }

  const users = entries.filter((entry) => entry.kind === 'user');
  if (users.length === 0) throw unsupported('a request without a user message');
  let prompt: string;
  if (!loop) {
    if (users.length !== 1) throw unsupported('more than one user message');
    prompt = (users[0] as { text: string }).text;
  } else if (entries.length === 1) {
    prompt = (users[0] as { text: string }).text;
  } else {
    prompt = renderTranscript(
      entries,
      declared.length > 0
        ? 'Continue as the assistant: answer, or call a tool if you need more information.'
        : 'Continue as the assistant and answer.',
    );
  }

  const tools: PlanTool[] = declared.map((tool) => {
    const { $schema: _schema, ...parameters } = toJsonSchema(tool.parameters);
    return { name: tool.name, description: tool.description, parameters };
  });

  const plan: CopilotTurnPlan = {
    model: req.model,
    system: system.join('\n\n'),
    prompt,
    tools,
    fingerprint: JSON.stringify([req.model, system.join('\n\n'), tools.map((tool) => [tool.name, tool.description, tool.parameters])]),
    outputs,
    endsWithOutputs,
  };

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
// The tool bridge's session
// ---------------------------------------------------------------------------

/** One tool call of a step. */
interface StepToolCall {
  /** The runtime's id of the call (the id the loop answers). */
  callId: string;
  /** The tool's name. */
  name: string;
  /** The arguments as JSON text. */
  argumentsJson: string;
}

/** A tool call whose output the loop has not supplied yet. */
interface PendingCall extends StepToolCall {
  /** Whether the runtime has invoked the tool's handler for it. */
  handled: boolean;
  /** Whether the step listed it. */
  listed: boolean;
  /** Settles with the loop's output. */
  promise: Promise<string>;
  /** Supplies the output. */
  resolve: (output: string) => void;
  /** Lets the handler go without an output. */
  reject: (error: Error) => void;
}

/**
 * One Copilot session of a tool-bridge step: its events, the tool calls waiting for
 * the loop, and what state it is in. The adapter holds it between steps.
 */
class LiveSession {
  /** The session's events, in order. */
  readonly queue = new EventQueue();
  /** `running` while a step reads it, `held` between steps, `closed` once deleted. */
  state: 'running' | 'held' | 'closed' = 'running';
  /** True once `session.idle` was read: the session will do nothing more. */
  idle = false;
  /** True once `abort()` was asked of it. */
  aborted = false;
  /** True when a held session went on by itself and can no longer be continued. */
  diverged = false;
  /** The ids of the calls the loop must answer (while held). */
  pending: string[] = [];
  /** The ids of the calls the loop has answered: late events about them belong to an earlier step. */
  readonly answered = new Set<string>();
  /** The idle timer of a held session. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The close in progress or done. */
  closing: Promise<void> | undefined;
  /** Stops the event subscription. */
  unsubscribe: () => void = () => undefined;

  private readonly calls = new Map<string, PendingCall>();
  private readonly aliases = new Map<string, string>();

  constructor(
    /** The session. */
    readonly session: CopilotSessionHandle,
    /** What it was opened with (model, system prompt, tools). */
    readonly fingerprint: string,
    /** The request's own tool names. */
    readonly ownTools: ReadonlySet<string>,
  ) {}

  /**
   * The runtime's call of one of the session's tools: waits for the loop's output.
   *
   * @param args - the arguments the model produced.
   * @param invocation - the call's id and tool name.
   * @returns the tool's output, once {@link LiveSession.deliver} supplies it.
   */
  handle(args: unknown, invocation: CopilotToolInvocation): Promise<string> {
    const call = this.call({ callId: invocation.toolCallId, name: invocation.toolName, argumentsJson: argumentsJsonOf(args) }, 'handler');
    return call.promise;
  }

  /**
   * Notes the calls the step handed the loop, so each has a promise waiting for its output.
   *
   * @param calls - the step's tool calls.
   */
  register(calls: readonly StepToolCall[]): void {
    for (const call of calls) this.call(call, 'step');
  }

  /**
   * Resolves each waiting call with the loop's output; the runtime's turn goes on.
   *
   * @param outputs - the outputs by call id.
   */
  deliver(outputs: ReadonlyMap<string, string>): void {
    for (const id of this.pending) {
      this.answered.add(id);
      // The record stays: the runtime may invoke the handler only now, and it must find the answer.
      this.calls.get(this.aliases.get(id) ?? id)?.resolve(outputs.get(id) ?? '');
    }
    this.pending = [];
  }

  /**
   * Lets every waiting handler go (the session is closing).
   *
   * @param error - why.
   */
  rejectAll(error: Error): void {
    for (const call of this.calls.values()) call.reject(error);
  }

  /**
   * The record of a call, found by id, else by what it is (a runtime whose
   * invocation id differs from the id its assistant message listed), else new.
   */
  private call(call: StepToolCall, source: 'handler' | 'step'): PendingCall {
    const existing = this.calls.get(this.aliases.get(call.callId) ?? call.callId);
    const found =
      existing ??
      [...this.calls.values()].find(
        (other) =>
          (source === 'handler' ? !other.handled && other.listed : other.handled && !other.listed) &&
          other.name === call.name &&
          other.argumentsJson === call.argumentsJson,
      );
    if (found !== undefined) {
      if (found.callId !== call.callId) this.aliases.set(call.callId, found.callId);
      if (source === 'handler') found.handled = true;
      else found.listed = true;
      return found;
    }
    let resolve!: (output: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A handler the runtime has let go of is not an unhandled rejection.
    promise.catch(() => undefined);
    const created: PendingCall = { ...call, handled: source === 'handler', listed: source === 'step', promise, resolve, reject };
    this.calls.set(call.callId, created);
    return created;
  }
}

/** The arguments of a tool call as JSON text. */
function argumentsJsonOf(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {});
}

/**
 * The calls an assistant message lists, or `null` when any of them is not one of the
 * request's own tools (or is an MCP tool, or has no usable id).
 */
function toolRequestsOf(raw: readonly unknown[], own: ReadonlySet<string>): StepToolCall[] | null {
  const calls: StepToolCall[] = [];
  for (const entry of raw) {
    const request = (entry ?? {}) as { toolCallId?: unknown; name?: unknown; arguments?: unknown; mcpServerName?: unknown };
    if (
      typeof request.toolCallId !== 'string' ||
      request.toolCallId.length === 0 ||
      typeof request.name !== 'string' ||
      !own.has(request.name) ||
      request.mcpServerName !== undefined
    ) {
      return null;
    }
    calls.push({ callId: request.toolCallId, name: request.name, argumentsJson: argumentsJsonOf(request.arguments) });
  }
  return calls;
}

/** The names in a tool-request list that are not the request's own (for the tripwire's message). */
function foreignRequestNames(raw: readonly unknown[], own: ReadonlySet<string>): string[] {
  const names: string[] = [];
  for (const entry of raw) {
    const name = (entry as { name?: unknown } | null)?.name;
    names.push(typeof name === 'string' && !own.has(name) ? name : '(unusable tool request)');
  }
  return names.filter((name) => !own.has(name));
}

/**
 * The tool a tool event is about, when it is one of the request's own (a `custom-tool`
 * permission request, a tool start or an external request); `null` for any other tool.
 */
function ownToolEvent(event: CopilotSessionEvent, own: ReadonlySet<string>): string | null {
  const data = event.data ?? {};
  if (event.type === 'permission.requested') {
    const request = data.permissionRequest as { kind?: unknown; toolName?: unknown } | undefined;
    return request?.kind === 'custom-tool' && typeof request.toolName === 'string' && own.has(request.toolName)
      ? request.toolName
      : null;
  }
  const name = typeof data.toolName === 'string' ? data.toolName : '';
  return own.has(name) && data.mcpServerName === undefined ? name : null;
}

/** The id of the tool call a tool event is about, or `''`. */
function toolCallIdOf(event: CopilotSessionEvent): string {
  const data = event.data ?? {};
  const request = data.permissionRequest as { toolCallId?: unknown } | undefined;
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : request?.toolCallId;
  return typeof id === 'string' ? id : '';
}

/** The tool name(s) a tool event names, for the tripwire's message. */
function foreignNameOf(event: CopilotSessionEvent): string[] {
  const data = event.data ?? {};
  const request = data.permissionRequest as { kind?: unknown; toolName?: unknown } | undefined;
  const name = typeof data.toolName === 'string' ? data.toolName : typeof request?.toolName === 'string' ? request.toolName : '';
  return name.length > 0 ? [name] : typeof request?.kind === 'string' ? [`(${request.kind} permission)`] : [];
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

/** The sum of two usages (an absent count stays absent only when both are). */
function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  const sum = (x: number | undefined, y: number | undefined): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const inputTokens = sum(a.inputTokens, b.inputTokens);
  const outputTokens = sum(a.outputTokens, b.outputTokens);
  const reasoningTokens = sum(a.reasoningTokens, b.reasoningTokens);
  const cachedInputTokens = sum(a.cachedInputTokens, b.cachedInputTokens);
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

  /**
   * The next event.
   *
   * @param signal - rejects with its reason when it aborts.
   * @param timeoutMs - when given, resolves `null` after that long without an event.
   */
  async next(signal: AbortSignal | undefined, timeoutMs?: number): Promise<CopilotSessionEvent | null> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) return item;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        await raced(
          new Promise<void>((resolve) => {
            this.wake = resolve;
            if (timeoutMs !== undefined) {
              timer = setTimeout(() => {
                timedOut = true;
                this.wake = null;
                resolve();
              }, timeoutMs);
              timer.unref?.();
            }
          }),
          signal,
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (timedOut) return this.items.shift() ?? null;
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
