import { AiError } from '@marinoscar/platform-ai-providers';

import { redactTokens } from './copilot-errors.js';

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
  /** Always empty: no built-in tool is available to the model. */
  availableTools: string[];
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
  /** Every permission request is rejected (no tool may run). */
  onPermissionRequest: () => {
    /** Always `reject`. */
    kind: 'reject';
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
   * when the runtime has not built the list. The adapter's security tripwire: any
   * name at all aborts the call.
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
  };
}

/** The members of the SDK's `CopilotClient` the transport calls. */
interface SdkClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getAuthStatus(): Promise<CopilotAuthStatus>;
  listModels(): Promise<CopilotModelInfo[]>;
  createSession(config: CopilotSessionConfig): Promise<SdkSession>;
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
    async stop() {
      if (client === undefined) return;
      const c = client;
      client = undefined;
      started = undefined;
      await c.stop();
    },
  };
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
