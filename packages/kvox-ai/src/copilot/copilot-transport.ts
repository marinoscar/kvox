import { AiError } from '@marinoscar/platform-ai-providers';

import {
  copilotErrorFromThrown,
  copilotSignInCancelled,
  copilotSignInExpired,
  copilotSignInFailed,
  redactTokens,
} from './copilot-errors.js';

// =============================================================================
// The Copilot transport: our own structural view of the Copilot SDK (issue #581)
// =============================================================================
//
// The GitHub Copilot adapter never touches `@github/copilot-sdk` directly. It
// talks to a `CopilotTransport`, typed HERE with only the members the adapter
// uses, so:
//
//   • TypeScript never needs the SDK's types (the SDK is an OPTIONAL peer that
//     the web edition never installs);
//   • a test drives the adapter over `createCopilotMockTransport` with no SDK,
//     no network and no sign-in;
//   • the one place the SDK is loaded is `createSdkCopilotTransport` below,
//     lazily, on its first call, with a literal `require` (a top-level import
//     would make the whole `copilot` entry fail to load without the SDK).
//
// The real SDK (v1.0.22) satisfies these shapes: `CopilotClient.getAuthStatus`,
// `.listModels`, `.createSession`, `.deleteSession`, `.stop`, and on a
// `CopilotSession` `.sessionId`, `.on(handler)`, `.send(options)`, `.abort()`,
// `.disconnect()` and `.rpc.tools.getCurrentMetadata()`.
//
// SIGN-IN (#630) uses the SDK's EXPERIMENTAL account RPCs, which live on a
// SESSION (`session.rpc.accounts.login.begin/advance/cancel` and
// `session.rpc.accounts.set({ command: { kind: 'logout' } })`), not on the client.
// So a sign-in or sign-out opens a short-lived, zero-tool session of its own and
// deletes it afterwards. The flow is a browser authorization (OAuth code with
// PKCE and a loopback redirect, run by the runtime): the transport only ever sees
// the authorize URL; the token is exchanged and stored inside the runtime. See
// SPIKE.md for what was verified against SDK 1.0.22 and what was not.
//
// ⚠ NO TOKEN CROSSES THIS FILE. The client is built with `useLoggedInUser: true`
// (the user's own Copilot sign-in, kept by the Copilot runtime) and NEVER with
// `gitHubToken`. Nothing here reads, holds or returns a credential.
// ⚠ `mode: 'empty'`: the SDK's ambient features (the coding agent's tools, its
// skills, its config discovery) are off by default and each session opts into
// nothing (`copilotSessionConfig` in `copilot-adapter.ts`).
// =============================================================================

/**
 * The Copilot runtime's answer to "who is signed in?". Never carries a token.
 *
 * @stability experimental
 */
export interface CopilotAuthStatus {
  /** Whether a GitHub account is signed in to Copilot on this machine. */
  isAuthenticated: boolean;
  /** The signed-in GitHub login, when the runtime reports it. */
  login?: string;
  /** How the runtime is signed in (`user`, `gh-cli`, `env`, ...), when it says. */
  authType?: string;
}

/**
 * What the user must do to finish signing in to GitHub Copilot. Never carries a
 * token: a one-time code (`device`) or an address to open (`browser`).
 *
 * @remarks
 * SDK 1.0.22 only offers a `browser` flow (an OAuth authorization in the user's
 * browser, finished through a loopback redirect the runtime listens on); the
 * `device` shape is part of the contract so a host handles a runtime that
 * switches to the device flow without a code change.
 *
 * @stability experimental
 */
export type CopilotSignInChallenge =
  | {
      /** The user types a code on a verification page. */
      kind: 'device';
      /** The one-time code to type (not a credential). */
      userCode: string;
      /** The page to open and type the code on. */
      verificationUri: string;
      /** When the code stops working, as an ISO 8601 timestamp. */
      expiresAt: string;
    }
  | {
      /** The user finishes in the browser; the runtime receives the result itself. */
      kind: 'browser';
      /** The authorization address to open in the user's browser (https, on github.com). */
      url: string;
    };

/**
 * One model of the Copilot listing, as far as the adapter reads it.
 *
 * @stability experimental
 */
export interface CopilotModelInfo {
  /** The model id (`gpt-5-mini`, `claude-sonnet-4.5`). */
  id: string;
  /** The display name. */
  name?: string;
  /** The model's limits, as the listing reports them. */
  capabilities?: {
    /**
     * What the model supports, when the listing says. The adapter reads only the
     * tool flag (`toolCalls`; `tool_calls` is accepted too): an explicit `false`
     * takes Ask off that model. Absent means "assume tools work".
     */
    supports?: {
      /** Whether the model supports tool calling. */
      toolCalls?: boolean;
      /** The same flag in the runtime's snake_case spelling. */
      tool_calls?: boolean;
    };
    /** Token limits. */
    limits?: {
      /** The most prompt tokens. */
      max_prompt_tokens?: number;
      /** The most output tokens. */
      max_output_tokens?: number;
      /** The whole context window. */
      max_context_window_tokens?: number;
    };
  };
  /** The user's or organization's policy for the model (`enabled`, `disabled`, `unconfigured`). */
  policy?: {
    /** The policy state; `disabled` models are dropped from the listing. */
    state?: string;
  };
}

/**
 * One session event, the subset of the SDK's `SessionEvent` the adapter reads:
 * a `type` and its `data`.
 *
 * @stability experimental
 */
export interface CopilotSessionEvent {
  /** The event type (`assistant.message_delta`, `assistant.usage`, `session.idle`, ...). */
  type: string;
  /** The event's payload. */
  data?: Record<string, unknown>;
}

/**
 * The reasoning effort a Copilot session takes (the subset the platform's efforts
 * map to: `minimal` becomes `low`).
 *
 * @stability experimental
 */
export type CopilotReasoningEffort = 'low' | 'medium' | 'high';

/**
 * What the runtime tells a tool handler about the call it serves.
 *
 * @stability experimental
 */
export interface CopilotToolInvocation {
  /** The runtime's id of this tool call (the one the assistant message's `toolRequests` carries). */
  toolCallId: string;
  /** The tool's name. */
  toolName: string;
  /** Aborted when the runtime completes the request or the session disconnects. */
  signal?: AbortSignal;
}

/**
 * One of the request's own function tools, declared to the session as a CUSTOM
 * tool (the Ask bridge). The handler resolves only when the host's loop has run
 * the tool and supplied its output, so the model's turn waits inside the runtime.
 *
 * @stability experimental
 */
export interface CopilotToolDefinition {
  /** The tool's name, as the model calls it. */
  name: string;
  /** What the tool does, for the model. */
  description: string;
  /** The JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** Always `true`: the tool is the request's own, so no permission prompt is raised for it. */
  skipPermission: true;
  /** Always `never`: the tool is always pre-loaded, never discovered lazily through the runtime's tool search. */
  defer: 'never';
  /**
   * Always `true`: the tool's name may clash with a runtime built-in (Ask's `search`,
   * `timeline`, ...), which would fail session creation. Harmless here: built-ins are off
   * (`mode: 'empty'` plus the `custom:<name>` allowlist), so only this tool answers the name.
   */
  overridesBuiltInTool: true;
  /**
   * Called by the runtime when the model calls the tool.
   *
   * @param args - the arguments the model produced.
   * @param invocation - the call's id, the tool name and a signal.
   * @returns the tool's output as text (resolves when the host's loop supplies it).
   */
  handler: (args: unknown, invocation: CopilotToolInvocation) => Promise<string>;
}

/**
 * What the runtime asks a permission handler. Only the two members the adapter reads.
 *
 * @stability experimental
 */
export interface CopilotPermissionRequest {
  /** The kind of permission (`custom-tool`, `shell`, `write`, `read`, `mcp`, ...). */
  kind?: string;
  /** The tool's name, for a `custom-tool` request. */
  toolName?: string;
}

/**
 * Exactly the session settings the adapter sets, every one of them, typed. Built
 * by `copilotSessionConfig`; a test asserts it.
 *
 * @stability experimental
 */
export interface CopilotSessionConfig {
  /** The model id. */
  model: string;
  /** Always `true`: the adapter reads `assistant.message_delta` events. */
  streaming: true;
  /** The caller's system prompt REPLACES the SDK's own (no SDK prompt text reaches the model). */
  systemMessage: {
    /** Always `replace`. */
    mode: 'replace';
    /** The whole system prompt. */
    content: string;
  };
  /**
   * The allowlist of tools the model may call: EMPTY for a call without tools, else
   * exactly the request's own function tools, source-qualified (`custom:<name>`) so a
   * built-in tool of the same name is never matched. Never a built-in tool.
   */
  availableTools: string[];
  /** The request's own function tools, as custom tools. Absent for a call without tools. */
  tools?: CopilotToolDefinition[];
  /** Always `false`: no skill is loaded. */
  enableSkills: false;
  /** Always `true`: no AGENTS.md, CLAUDE.md or custom instructions are read. */
  skipCustomInstructions: true;
  /** Always `true`: no embedding retrieval over the working directory. */
  skipEmbeddingRetrieval: true;
  /** Always off: no background compaction of the conversation. */
  infiniteSessions: {
    /** Always `false`. */
    enabled: false;
  };
  /** Always `false`: the session is not indexed into the runtime's session store. */
  enableSessionStore: false;
  /** Always `false`: no MCP or skill configuration is discovered from the working directory. */
  enableConfigDiscovery: false;
  /** Always `false`: no extension is requested. */
  requestExtensions: false;
  /** Always `false`: no canvas renderer is requested. */
  requestCanvasRenderer: false;
  /** Always `false`: no MCP app is enabled. */
  enableMcpApps: false;
  /** The transport's working directory: an EMPTY directory, so nothing is discovered in it. */
  workingDirectory: string;
  /** The reasoning effort, when the request asked for one. */
  reasoningEffort?: CopilotReasoningEffort;
  /** Session hooks. */
  hooks: {
    /**
     * SUPPRESSION: the runtime prefixes every prompt with a `<current_datetime>`
     * block; this hook hands back the prompt exactly as the caller wrote it.
     */
    onUserPromptTransformed: (input: { prompt: string; transformedPrompt: string }) => {
      /** The prompt the model receives: the caller's, unchanged. */
      modifiedTransformedPrompt: string;
    };
  };
  /**
   * Every permission request is rejected (no built-in tool may run), except the
   * `custom-tool` request of one of this session's own tools, which is approved.
   */
  onPermissionRequest: (request?: CopilotPermissionRequest) => {
    /** `approve-once` for one of the session's own tools; `reject` for everything else. */
    kind: 'approve-once' | 'reject';
  };
}

/**
 * One live Copilot session, as the adapter drives it.
 *
 * @stability experimental
 */
export interface CopilotSessionHandle {
  /** The runtime's session id (what `deleteSession` removes). */
  readonly sessionId: string;
  /**
   * Subscribes to every event of the session.
   *
   * @param handler - called once per event.
   * @returns the unsubscribe function.
   */
  on(handler: (event: CopilotSessionEvent) => void): () => void;
  /**
   * Sends one user message; resolves once the runtime admits it (the answer
   * arrives as events).
   *
   * @param options - the prompt and, for native structured output, the JSON Schema.
   * @returns the submitted message's id.
   */
  send(options: { prompt: string; responseSchema?: Record<string, unknown> }): Promise<string>;
  /** Aborts the message in flight. */
  abort(): Promise<void>;
  /** Releases the session's in-memory resources (its data stays until `deleteSession`). */
  disconnect(): Promise<void>;
  /**
   * The names of every tool the session's model can currently call, or `null`
   * when the runtime has not built the list. The adapter's security tripwire, listing
   * half: a name that is not one of the request's own function tools is logged as a
   * `warn` (the list is unverified on a real runtime) and does not stop the call; a
   * CALL of such a tool does.
   *
   * @returns the tool names, or `null`.
   */
  currentToolNames(): Promise<string[] | null>;
}

/**
 * What the GitHub Copilot adapter needs from the Copilot runtime. The real one is
 * {@link createSdkCopilotTransport}; tests use `createCopilotMockTransport`.
 *
 * @extensionPoint
 * @stability experimental
 */
export interface CopilotTransport {
  /** The working directory every session runs in (an empty, app-private directory). */
  readonly workingDirectory: string;
  /**
   * Who is signed in.
   *
   * @returns the sign-in status (never a token).
   */
  getAuthStatus(): Promise<CopilotAuthStatus>;
  /**
   * The models the signed-in user may use.
   *
   * @returns the listing.
   */
  listModels(): Promise<CopilotModelInfo[]>;
  /**
   * Creates one session.
   *
   * @param config - the session settings (`copilotSessionConfig`).
   * @returns the live session.
   */
  createSession(config: CopilotSessionConfig): Promise<CopilotSessionHandle>;
  /**
   * Deletes a session's persisted state (its event log holds the prompt).
   *
   * @param sessionId - the session to delete.
   */
  deleteSession(sessionId: string): Promise<void>;
  /**
   * Begins signing in to GitHub Copilot. A second call replaces a flow still in progress.
   *
   * @returns what the user must do (an address to open, or a code to type); never a token.
   */
  startSignIn(): Promise<CopilotSignInChallenge>;
  /**
   * Waits for the sign-in that {@link CopilotTransport.startSignIn} began.
   *
   * @remarks
   * Rejects with an `AiError` (`AI_KEY_REQUIRED`, `details.signInReason`
   * `sign_in_expired` or `sign_in_cancelled`) when the sign-in expires or is
   * cancelled, and cancels the runtime's flow when `signal` aborts.
   *
   * @param signal - aborts the wait and cancels the sign-in.
   * @returns the sign-in status once signed in (never a token).
   */
  waitForSignIn(signal?: AbortSignal): Promise<CopilotAuthStatus>;
  /** Signs the Copilot runtime's stored account out. Resolves when it is done (also when nobody was signed in). */
  signOut(): Promise<void>;
  /** Stops the Copilot runtime, when the transport owns one. */
  stop?(): Promise<void>;
}

/**
 * What {@link createSdkCopilotTransport} is built from.
 *
 * @stability experimental
 */
export interface CreateSdkCopilotTransportOptions {
  /**
   * The Copilot runtime's data directory (`COPILOT_HOME`): an app-private
   * directory, so KVox's sessions never mix with the user's own Copilot CLI ones.
   */
  baseDirectory: string;
  /**
   * The runtime's and every session's working directory: an EMPTY directory, so
   * no AGENTS.md, CLAUDE.md, skill or MCP configuration is discovered.
   */
  workingDirectory: string;
  /** The runtime's log level. Default `none`. */
  logLevel?: 'none' | 'error' | 'warning' | 'info' | 'debug' | 'all';
  /**
   * How long `waitForSignIn` waits for the user before the sign-in expires
   * (`sign_in_expired`) and the runtime's flow is cancelled. Default 10 minutes.
   */
  signInTimeoutMs?: number;
}

/** One step of the SDK's interactive login (`AuthLoginStep`), the members read here. */
interface SdkLoginStep {
  kind: string;
  url?: unknown;
  message?: unknown;
  result?: {
    status?: unknown;
    login?: unknown;
    accounts?: Array<{ selectionId?: unknown }>;
  };
}

/** The members of the SDK's `CopilotSession` the transport calls (structural; the SDK is untyped here). */
interface SdkSession {
  sessionId: string;
  on(handler: (event: CopilotSessionEvent) => void): () => void;
  send(options: { prompt: string; responseSchema?: Record<string, unknown> }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  rpc: {
    tools: {
      initializeAndValidate?: () => Promise<unknown>;
      getCurrentMetadata: () => Promise<{ tools: Array<{ name: string }> | null }>;
    };
    accounts?: {
      login: {
        begin(params: { kind: 'githubDotCom' }): Promise<{ flowId: string; step: SdkLoginStep }>;
        advance(params: { flowId: string; input?: string }): Promise<SdkLoginStep>;
        cancel(params: { flowId: string }): Promise<void>;
      };
      set(params: { command: { kind: 'logout' } }): Promise<{ moreUsers?: unknown }>;
    };
  };
}

/** The members of the SDK's `CopilotClient` the transport calls. */
interface SdkClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getAuthStatus(): Promise<CopilotAuthStatus>;
  listModels(): Promise<CopilotModelInfo[]>;
  createSession(config: object): Promise<SdkSession>;
  deleteSession(sessionId: string): Promise<void>;
}

/** The SDK module's one export the transport uses. */
interface SdkModule {
  CopilotClient: new (options: Record<string, unknown>) => SdkClient;
}

/** The message of a missing SDK. */
const SDK_MISSING = 'The GitHub Copilot SDK is not installed (optional peer @github/copilot-sdk).';

/**
 * Builds the transport over the real GitHub Copilot SDK.
 *
 * @remarks
 * Nothing is loaded at build time: the first call `require`s
 * `@github/copilot-sdk` and builds ONE `CopilotClient` with `mode: 'empty'`,
 * `useLoggedInUser: true` (the user's own Copilot sign-in, never a token we hold),
 * the two directories and `logLevel: 'none'` by default. A missing SDK is
 * `AiError('AI_PROVIDER_UNAVAILABLE')` on that call, never at import time.
 *
 * @example
 * ```ts
 * const transport = createSdkCopilotTransport({
 *   baseDirectory: path.join(appDataDir, 'copilot'),
 *   workingDirectory: await fs.mkdtemp(path.join(os.tmpdir(), 'kvox-copilot-')),
 * });
 * ```
 *
 * @param options - the runtime's data directory, the empty working directory and the log level.
 * @returns the transport.
 * @stability experimental
 */
export function createSdkCopilotTransport(options: CreateSdkCopilotTransportOptions): CopilotTransport {
  if (typeof options?.baseDirectory !== 'string' || options.baseDirectory.length === 0) {
    throw new Error('createSdkCopilotTransport needs a baseDirectory (an app-private Copilot data directory).');
  }
  if (typeof options.workingDirectory !== 'string' || options.workingDirectory.length === 0) {
    throw new Error('createSdkCopilotTransport needs a workingDirectory (an empty directory).');
  }

  let client: SdkClient | undefined;
  let started: Promise<void> | undefined;
  /** The sign-in in progress: its zero-tool session and the runtime's flow id. */
  let flow: { session: SdkSession; flowId: string } | undefined;
  const signInTimeoutMs = options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS;

  /** The one client, built on first use. */
  const clientOf = (): SdkClient => {
    if (client !== undefined) return client;
    client = new (loadSdk().CopilotClient)({
      mode: 'empty',
      baseDirectory: options.baseDirectory,
      workingDirectory: options.workingDirectory,
      useLoggedInUser: true,
      logLevel: options.logLevel ?? 'none',
    });
    return client;
  };

  /** The started client (`getAuthStatus` and `listModels` need a connection). A failed start is retried next time. */
  const ready = async (): Promise<SdkClient> => {
    const c = clientOf();
    started ??= c.start().catch((err: unknown) => {
      started = undefined;
      throw err;
    });
    await started;
    return c;
  };

  /** A zero-tool session for the account RPCs (they live on a session). Deleted by {@link discardSession}. */
  const accountSession = async (): Promise<SdkSession> => {
    const session = await (await ready()).createSession(accountSessionConfig(options.workingDirectory));
    if (session.rpc.accounts === undefined) {
      await discardSession(session);
      throw new AiError('AI_PROVIDER_UNAVAILABLE', 'This GitHub Copilot SDK release has no sign-in API.');
    }
    return session;
  };

  /** Releases an account session and its stored state; never throws. */
  const discardSession = async (session: SdkSession): Promise<void> => {
    try {
      await session.disconnect();
    } catch {
      // Best effort: the session is deleted next.
    }
    try {
      await (await ready()).deleteSession(session.sessionId);
    } catch {
      // Best effort: an account session holds no prompt.
    }
  };

  /** The status after a completed sign-in: the runtime's own answer when it gives one, else the login the flow reported. */
  const signedInStatus = async (flowLogin: string | undefined): Promise<CopilotAuthStatus> => {
    let login = flowLogin;
    let authType: string | undefined;
    try {
      const status = await (await ready()).getAuthStatus();
      if (typeof status.login === 'string') login = status.login;
      if (typeof status.authType === 'string') authType = status.authType;
    } catch {
      // The flow itself said "completed"; the login it reported stands.
    }
    return { isAuthenticated: true, ...(login !== undefined ? { login } : {}), ...(authType !== undefined ? { authType } : {}) };
  };

  /** Ends the flow in progress: tells the runtime to cancel it, then drops its session. Never throws. */
  const endFlow = async (cancel: boolean): Promise<void> => {
    const current = flow;
    flow = undefined;
    if (current === undefined) return;
    if (cancel) {
      try {
        await current.session.rpc.accounts?.login.cancel({ flowId: current.flowId });
      } catch {
        // Already finished or cancelled.
      }
    }
    await discardSession(current.session);
  };

  /** Advances the flow once (blocks until the runtime has a next step). */
  const advance = async (current: { session: SdkSession; flowId: string }, input?: string): Promise<SdkLoginStep> => {
    return current.session.rpc.accounts!.login.advance({
      flowId: current.flowId,
      ...(input !== undefined ? { input } : {}),
    });
  };

  return {
    workingDirectory: options.workingDirectory,
    async getAuthStatus() {
      const status = await (await ready()).getAuthStatus();
      // Only the three fields: the runtime's status message is not ours to pass on.
      return {
        isAuthenticated: status.isAuthenticated === true,
        ...(typeof status.login === 'string' ? { login: status.login } : {}),
        ...(typeof status.authType === 'string' ? { authType: status.authType } : {}),
      };
    },
    async listModels() {
      return (await ready()).listModels();
    },
    async createSession(config) {
      const session = await (await ready()).createSession(config);
      return {
        sessionId: session.sessionId,
        on: (handler) => session.on(handler),
        send: (sendOptions) => session.send(sendOptions),
        abort: () => session.abort(),
        disconnect: () => session.disconnect(),
        async currentToolNames() {
          // Build the tool list first, so a `null` ("not built yet") cannot hide a tool.
          try {
            await session.rpc.tools.initializeAndValidate?.();
          } catch {
            // A runtime without the call (or one that refuses it) still answers the listing below.
          }
          const { tools } = await session.rpc.tools.getCurrentMetadata();
          return tools === null ? null : tools.map((tool) => tool.name);
        },
      };
    },
    async deleteSession(sessionId) {
      await (await ready()).deleteSession(sessionId);
    },
    async startSignIn() {
      await endFlow(true);
      let session: SdkSession | undefined;
      try {
        session = await accountSession();
        const begun = await session.rpc.accounts!.login.begin({ kind: 'githubDotCom' });
        const step = begun.step;
        if (step.kind !== 'open-url') throw signInStepError(step);
        const url = authorizeUrlOf(step.url);
        flow = { session, flowId: begun.flowId };
        return { kind: 'browser', url };
      } catch (err) {
        if (session !== undefined) await discardSession(session);
        throw copilotErrorFromThrown(err);
      }
    },
    async waitForSignIn(signal) {
      const current = flow;
      if (current === undefined) {
        throw copilotSignInFailed('sign_in_not_started', 'No GitHub Copilot sign-in is in progress. Start one first.');
      }
      if (signal?.aborted === true) {
        await endFlow(true);
        throw copilotSignInCancelled();
      }

      let stopped: 'cancelled' | 'expired' | undefined;
      const stop = (why: 'cancelled' | 'expired'): void => {
        if (stopped !== undefined) return;
        stopped = why;
        // The runtime rejects the pending `advance` with "Login cancelled".
        void current.session.rpc.accounts?.login.cancel({ flowId: current.flowId }).catch(() => undefined);
      };
      const onAbort = (): void => stop('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop('expired'), signInTimeoutMs);
      timer.unref?.();

      try {
        // `advance` blocks until the user finishes in the browser (or the flow is cancelled).
        // An `awaiting` step is followed by another `advance`, a beat apart so a runtime that
        // answers at once cannot spin this loop.
        let step = await advance(current);
        for (let turns = 0; turns < MAX_LOGIN_TURNS; turns += 1) {
          if (stopped !== undefined) break;
          if (step.kind === 'awaiting' || step.kind === 'open-url') {
            await pause(AWAITING_PAUSE_MS);
            step = await advance(current);
            continue;
          }
          if (step.kind !== 'completed') throw signInStepError(step);

          const outcome = step.result;
          if (outcome?.status === 'completed') {
            return await signedInStatus(typeof outcome.login === 'string' ? outcome.login : undefined);
          }
          if (outcome?.status === 'needs-account-selection') {
            // The runtime saved the credentials and asks which account to use. One account is no choice.
            const accounts = outcome.accounts ?? [];
            const only = accounts.length === 1 ? accounts[0].selectionId : undefined;
            if (typeof only !== 'string') {
              throw copilotSignInFailed(
                'sign_in_needs_account_selection',
                'GitHub Copilot sign-in needs an account to be chosen; KVox cannot choose one for you.',
              );
            }
            step = await advance(current, only);
            continue;
          }
          // `needs-plaintext-consent` and `declined`: KVox never agrees, on the user's behalf, to
          // keep a GitHub token in a plain file.
          throw copilotSignInFailed(
            outcome?.status === 'needs-plaintext-consent' ? 'sign_in_needs_plaintext_consent' : 'sign_in_failed',
            'GitHub Copilot could not store the sign-in securely on this device, so the sign-in was not completed.',
          );
        }
        if (stopped === undefined) throw copilotSignInFailed('sign_in_failed', 'The GitHub Copilot sign-in did not finish.');
        throw stopped === 'expired' ? copilotSignInExpired() : copilotSignInCancelled();
      } catch (err) {
        if (stopped === 'expired') throw copilotSignInExpired();
        if (stopped === 'cancelled') throw copilotSignInCancelled();
        if (AiError.isAiError(err)) throw err;
        const raw = err instanceof Error ? err.message : '';
        if (/cancel/i.test(raw)) throw copilotSignInCancelled();
        if (/expired|timed?\s?out/i.test(raw)) throw copilotSignInExpired();
        throw copilotErrorFromThrown(err);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // Cancelling a finished flow is refused by the runtime and ignored; an unfinished one is released.
        await endFlow(true);
      }
    },
    async signOut() {
      await endFlow(true);
      const session = await accountSession();
      try {
        // Logs out the active account; repeat while the runtime still holds others.
        for (let i = 0; i < MAX_SIGN_OUTS; i += 1) {
          const result = await session.rpc.accounts!.set({ command: { kind: 'logout' } });
          if (result.moreUsers !== true) break;
        }
      } catch (err) {
        throw copilotErrorFromThrown(err);
      } finally {
        await discardSession(session);
      }
    },
    async stop() {
      if (client === undefined) return;
      const c = client;
      client = undefined;
      started = undefined;
      flow = undefined;
      await c.stop();
    },
  };
}

/** The default wait for the user to finish signing in. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** The pause between `awaiting` steps. */
const AWAITING_PAUSE_MS = 250;

/** The most steps one wait follows before it gives up (a runtime that never settles). */
const MAX_LOGIN_TURNS = 4_000;

/** The most accounts one sign-out removes. */
const MAX_SIGN_OUTS = 10;

/**
 * The settings of a session that only carries account calls: nothing the model could use, nothing discovered.
 * No model: the account RPCs need none.
 */
function accountSessionConfig(workingDirectory: string): object {
  return {
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
    workingDirectory,
    onPermissionRequest: () => ({ kind: 'reject' }),
  };
}

/** The authorize address, or a refusal: only an https address on github.com is handed to a browser. */
function authorizeUrlOf(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'github.com') return url.toString();
    } catch {
      // Falls through to the refusal.
    }
  }
  throw new AiError('AI_PROVIDER_UNAVAILABLE', 'GitHub Copilot returned a sign-in address that is not on github.com; it was not used.');
}

/** The error of a login step that is not a way forward. */
function signInStepError(step: SdkLoginStep): AiError {
  if (step.kind === 'error') return copilotErrorFromThrown(new Error(typeof step.message === 'string' ? step.message : 'the sign-in failed'));
  if (step.kind === 'input-required' || step.kind === 'needs-interaction') {
    return copilotSignInFailed('sign_in_needs_input', 'GitHub Copilot asked for input KVox cannot provide; the sign-in was not completed.');
  }
  return copilotSignInFailed('sign_in_failed', 'The GitHub Copilot sign-in did not finish.');
}

/** A pause that does not hold the process open. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Loads the SDK, or explains that it is missing. */
function loadSdk(): SdkModule {
  try {
    // The ONE place the SDK is loaded: a literal, lazy `require` (the SDK is an
    // optional peer; a static import would break the entry without it).
    return require('@github/copilot-sdk') as SdkModule;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new AiError('AI_PROVIDER_UNAVAILABLE', SDK_MISSING);
    }
    const message = err instanceof Error ? redactTokens(err.message).slice(0, 300) : 'unknown error';
    throw new AiError('AI_PROVIDER_UNAVAILABLE', `The GitHub Copilot SDK could not be loaded: ${message}`);
  }
}
