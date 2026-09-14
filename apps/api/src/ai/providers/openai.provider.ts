import { Inject, Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';

import {
  AiAuthError,
  AiBudgetError,
  AiInputError,
  AiRefusedError,
  parseRetryAfterMs,
  RateLimitError,
} from '../ai-errors';
import { AiProviderRegistry } from '../ai-provider.registry';
import {
  aiProvidersSchema,
  type AiProvidersValue,
} from '../ai-settings.schema';
import type {
  AiConnectionTest,
  AiDelta,
  AiFinishReason,
  AiGenerateRequest,
  AiModelDescriptor,
  AiProvider,
  AiProviderCapabilities,
  AiProviderContext,
  AiProviderFieldDescriptor,
  AiUsage,
} from './ai-provider.interface';

// =============================================================================
// OpenAI provider (issue #47, epic #45)
// =============================================================================
//
// ⚠ RE-VERIFY BEFORE THIS EPIC IS DECLARED FINAL — the identical caveat
// `assemblyai.provider.ts` carries, for the identical reason, and
// docs/specs/notes.md §2.4 states it explicitly. Every vendor-specific constant
// below (the `/chat/completions` path, the `stream`/`stream_options` parameter
// names, the SSE frame shape, the `finish_reason` vocabulary, the error-body
// fields, and every context-window number in MODELS) was written against
// OpenAI's published Chat Completions API as understood in 2026-09. Vendors
// change all of these without changing a version number. The fixtures under
// `../__fixtures__/openai/` pin the SHAPE this file expects, so a change there
// shows up as a failing parse test rather than as a silent mis-read in
// production.
//
// -----------------------------------------------------------------------------
// NODE'S BUILT-IN `fetch`, INJECTED
// -----------------------------------------------------------------------------
//
// No SDK and no new dependency, exactly as `AssemblyAiProvider` argues: the
// vendor's API is two REST calls here, and an SDK would add a supply-chain
// surface, its own retry policy fighting the queue's, and its own error shapes
// for `../ai-errors.ts` to re-derive the answer from. `fetch` arrives through
// the constructor under `OPENAI_FETCH`, so a test replaces it with a function
// instead of monkey-patching a global — which is what lets every error-mapping
// case and the whole SSE parser be asserted deterministically and offline.
//
// -----------------------------------------------------------------------------
// THE KEY GOES IN `authorization: Bearer <key>` AND NOWHERE ELSE
// -----------------------------------------------------------------------------
//
// `authHeaders` is the one place it is written, and it never logs its argument.
// Every key this provider sees belongs to an INDIVIDUAL USER, so a leak here is
// a personal credential, not a deployment one.
// =============================================================================

/**
 * DI token for the `fetch` implementation.
 *
 * A TOKEN RATHER THAN A BARE DEFAULT PARAMETER, because `emitDecoratorMetadata`
 * records `Function` as the parameter's type and Nest then tries to resolve a
 * provider called `Function` — which fails at boot with a message that names
 * neither `fetch` nor this file. `@Optional() @Inject(...)` tells the container
 * to skip it, at which point TypeScript's own default parameter applies.
 * Mirrors `ASSEMBLYAI_FETCH` exactly.
 */
export const OPENAI_FETCH = Symbol('OPENAI_FETCH');

/** The `fetch` shape this provider needs. Injected so tests replace it. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

/**
 * The subset of `Response` this provider reads.
 *
 * `body` is typed as the two shapes a streaming response actually arrives in:
 * Node's `fetch` gives a WHATWG `ReadableStream` (which exposes `getReader`,
 * and in Node is also async-iterable), while a test fixture is far more
 * naturally an async generator. Supporting both is four lines in
 * `iterateChunks` and removes the only reason a test would otherwise have to
 * construct a real `ReadableStream`.
 */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  body?: ResponseBodyLike | null;
}

export type ResponseBodyLike =
  | AsyncIterable<Uint8Array | string>
  | {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array | string }>;
        releaseLock?(): void;
      };
    };

/** This provider's id. Matches `AI_PROVIDER_IDS`. PERMANENT. */
export const OPENAI_PROVIDER_ID = 'openai';

/**
 * The model catalogue this build knows how to budget against.
 *
 * ⚠ THIS IS NOT AN ALLOW-LIST. What a user may actually generate with is the
 * INTERSECTION of this catalogue and `ai.providers.openai.allowedModels` — the
 * deployment's policy decides what is permitted, and this list only says what
 * this application knows the context window of. A model an operator adds to the
 * policy that is absent here cannot be budgeted (docs/specs/notes.md §3.3 needs
 * `contextWindowTokens`), so `AiConfigService` reports only models present in
 * both, rather than guessing a window and refusing a prompt that would have fit.
 *
 * ⚠ RE-VERIFY THE NUMBERS. See the file header: a context window that has grown
 * on the vendor's side makes this application refuse work it could do, and one
 * that has shrunk makes it submit a prompt the vendor rejects.
 */
const MODELS: AiModelDescriptor[] = [
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
  },
];

/**
 * Average characters per token, for {@link OpenAiProvider.countTokens}.
 *
 * FOUR is the well-known rule of thumb for English prose under a BPE
 * tokenizer. See the `countTokens` doc comment for why an approximation is the
 * contract rather than a shortcut.
 */
const CHARS_PER_TOKEN = 4;

/** How long `testConnection` waits before calling the endpoint unreachable. */
const PROBE_TIMEOUT_MS = 15_000;

/** Bound on any error-body excerpt that reaches a log line or `Job.lastError`. */
const BODY_SNIPPET_LIMIT = 500;

/**
 * Substrings in a provider error body that mean "I declined", not "you asked
 * wrongly".
 *
 * A SUBSTRING MATCH, and deliberately a short list. The alternative — treating
 * every 400 as an input error — would tell a user "this application sent an
 * invalid request" when the truth is "the provider refused to answer that",
 * which sends them to report a bug instead of rephrasing. A miss here is
 * harmless (it degrades to `AiInputError`, also terminal); a false positive
 * would mislabel a genuine parameter bug as a content refusal, which is why
 * nothing vague like `"policy"` alone is on it.
 */
const REFUSAL_MARKERS = [
  'content_policy',
  'content policy',
  'content_filter',
  'safety system',
  'usage policies',
  'request was rejected as a result of our safety',
];

/** Substrings that mean the prompt did not fit. Mapped to `AiBudgetError`. */
const CONTEXT_LENGTH_MARKERS = [
  'context_length_exceeded',
  'maximum context length',
  'reduce the length of the messages',
  'string_above_max_length',
];

/** One frame of OpenAI's `stream: true` response, as far as this file reads it. */
interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: { content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  } | null;
  error?: { message?: unknown; code?: unknown; type?: unknown };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function containsAny(haystack: string, needles: string[]): boolean {
  const lowered = haystack.toLowerCase();
  return needles.some((needle) => lowered.includes(needle));
}

/**
 * Map OpenAI's `finish_reason` onto the three provider-independent ones.
 *
 * `tool_calls`/`function_call` fold into `stop`: this epic sends no tools, so
 * seeing one means the vendor produced something this request never asked for,
 * and treating it as a normal stop is the outcome that neither loses the text
 * already streamed nor invents a failure. An UNRECOGNISED reason also folds
 * into `stop`, with a warning — abandoning a completed generation over a
 * vocabulary the vendor widened would throw away work the user has already paid
 * for.
 */
function mapFinishReason(raw: unknown): AiFinishReason | null {
  switch (raw) {
    case 'stop':
    case 'tool_calls':
    case 'function_call':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return null;
  }
}

/**
 * Read a response body as a sequence of strings, whatever shape it arrived in.
 *
 * See {@link ResponseBodyLike}: Node's `fetch` hands back a WHATWG
 * `ReadableStream` and a fixture is naturally an async generator, and this is
 * the whole cost of accepting both.
 */
async function* iterateChunks(body: ResponseBodyLike): AsyncGenerator<string> {
  const decoder = new TextDecoder();

  if (Symbol.asyncIterator in body) {
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      yield typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    }
    return;
  }

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value === undefined) continue;
      yield typeof value === 'string' ? value : decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Split a server-sent-event byte stream into its `data:` payloads.
 *
 * EXPORTED AND PURE, so the parser is tested against recorded vendor frames
 * with no network, no Nest container and no clock — see `__fixtures__/openai/`.
 *
 * THREE THINGS THIS HANDLES THAT A `split('\n\n')` PER CHUNK DOES NOT, and all
 * three are real: a frame SPLIT ACROSS TWO CHUNKS (the buffer persists between
 * iterations, which is the single most common streaming bug); `\r\n\r\n`
 * separators from a proxy that rewrote the line endings; and a frame carrying
 * SEVERAL `data:` lines, which SSE permits and which are joined with a newline
 * exactly as the specification says.
 */
export async function* parseSseData(
  body: ResponseBodyLike,
): AsyncGenerator<string> {
  let buffer = '';

  for await (const chunk of iterateChunks(body)) {
    buffer += chunk;

    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;

      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        // `.slice(5)` then `.trimStart()`, not `.replace('data: ', '')`: the
        // space after the colon is optional in SSE and a payload that happens
        // to contain "data: " elsewhere must not be rewritten.
        .map((line) => line.slice(5).trimStart())
        .join('\n');

      if (data.length > 0) yield data;
    }
  }

  // A trailing frame with no terminating blank line. Servers do emit one when
  // the connection closes immediately after the last event; dropping it would
  // silently lose the final delta or the usage frame.
  const tail = buffer
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

  if (tail.length > 0) yield tail;
}

type OpenAiSettings = AiProvidersValue['openai'];

/**
 * THE SAME SCHEMA OBJECT the settings namespace uses, never a restatement.
 *
 * Declared at module scope rather than inline on the class so it is evaluated
 * before the class body's property initialiser reads it — a `const` below the
 * class would be in its temporal dead zone at class-definition time and throw a
 * `ReferenceError` at import. Same arrangement as `assemblyAiSettingsSchema`.
 */
const openAiSettingsSchema = aiProvidersSchema.shape.openai;

@Injectable()
export class OpenAiProvider
  implements AiProvider<OpenAiSettings>, OnModuleInit
{
  readonly id = OPENAI_PROVIDER_ID;

  readonly label = 'OpenAI';

  readonly capabilities: AiProviderCapabilities = {
    models: MODELS,
    streaming: true,
  };

  /**
   * ⚠ THIS SCHEMA MUST STAY IDENTICAL TO `aiProvidersSchema.shape.openai`.
   *
   * It is the SAME schema object, imported rather than restated, precisely so
   * the two cannot drift: the settings row and the provider must agree about
   * what a valid OpenAI configuration is, and a second copy is how they stop
   * agreeing.
   */
  readonly settingsSchema = openAiSettingsSchema;

  readonly fieldDescriptors: AiProviderFieldDescriptor[] = [
    {
      key: 'baseUrl',
      label: 'API base URL',
      type: 'text',
      helpText:
        'The API root to call. Change this only to point at an OpenAI-compatible gateway (a corporate proxy, a self-hosted server); the default is OpenAI itself.',
      required: true,
      defaultValue: 'https://api.openai.com/v1',
    },
    {
      key: 'allowedModels',
      label: 'Permitted models',
      type: 'string-list',
      helpText:
        "Model ids users of this deployment may generate with. This is the deployment's only lever over which vendor models its content reaches — the key and the bill are each user's own. An empty list permits nothing.",
      required: false,
      defaultValue: [],
    },
    {
      key: 'defaultModel',
      label: 'Default model',
      type: 'text',
      helpText:
        'The model offered first. It should be one of the permitted models above; if it is not, clients fall back to the first permitted one.',
      required: true,
      defaultValue: 'gpt-4o',
    },
  ];

  private readonly logger = new Logger(OpenAiProvider.name);

  constructor(
    private readonly registry: AiProviderRegistry,
    /**
     * Node's built-in `fetch`, injected so tests replace it.
     *
     * Bound to `globalThis` at construction: an unbound `fetch` reference
     * throws `Illegal invocation` in some runtimes, and the failure looks like
     * a network error rather than like the mistake it is.
     */
    @Optional()
    @Inject(OPENAI_FETCH)
    private readonly fetchImpl: FetchLike = ((input: string, init?: unknown) =>
      globalThis.fetch(input, init as RequestInit)) as unknown as FetchLike,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ---------------------------------------------------------------------------
  // Probe
  // ---------------------------------------------------------------------------

  /**
   * `GET {baseUrl}/models` — the cheapest authenticated read the API offers,
   * and one that costs the user nothing.
   *
   * NEVER THROWS. Every outcome is a `{ ok, latencyMs, detail }`, and the
   * `detail` is written to name the FIX rather than the symptom — which matters
   * more here than anywhere else in this codebase, because the person reading
   * it is an ordinary user looking at their own key, not an administrator. "The
   * key is wrong", "the key is valid but the account has no credit" and "the
   * endpoint is unreachable" are three different fixes and only the last one is
   * anybody else's problem.
   */
  async testConnection(
    ctx: AiProviderContext<OpenAiSettings>,
  ): Promise<AiConnectionTest> {
    const startedAt = Date.now();
    const url = `${this.baseUrl(ctx.settings)}/models`;

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.authHeaders(ctx.apiKey),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startedAt;

      if (response.ok) {
        return {
          ok: true,
          latencyMs,
          detail: `The provider accepted this key in ${latencyMs} ms.`,
        };
      }

      const snippet = await this.safeBodySnippet(response);

      if (response.status === 401) {
        return {
          ok: false,
          latencyMs,
          detail:
            'The provider rejected this API key (HTTP 401). Check that you pasted the whole key and that it has not been revoked in your provider account.',
        };
      }

      if (response.status === 403) {
        return {
          ok: false,
          latencyMs,
          detail:
            'The provider recognised this key but refused the request (HTTP 403). The key is probably restricted to a different project, or lacks permission for this endpoint.',
        };
      }

      if (response.status === 429) {
        return {
          ok: false,
          latencyMs,
          detail:
            'The key is valid but the account is currently rate-limited or out of credit (HTTP 429). Nothing is wrong with the key itself; check the usage and billing pages of your provider account.',
        };
      }

      if (response.status === 404) {
        return {
          ok: false,
          latencyMs,
          detail: `The endpoint returned HTTP 404 for a documented route. The configured API base URL (${this.baseUrl(ctx.settings)}) is probably wrong — an administrator sets that, not you.`,
        };
      }

      return {
        ok: false,
        latencyMs,
        detail: `The provider returned HTTP ${response.status}: ${snippet}`,
      };
    } catch (err) {
      // A TRANSPORT failure, not an API one: DNS, TLS, a refused connection, a
      // proxy in the way, or the probe timeout above. Named distinctly because
      // the fix is a network fix, and reporting it as "invalid key" sends
      // somebody to regenerate a credential that was never the problem.
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        detail:
          `Could not reach ${this.baseUrl(ctx.settings)} — ${err instanceof Error ? err.message : 'network error'}. ` +
          'The request never got an HTTP response, so this is a network or configuration problem rather than a credential one.',
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Token counting
  // ---------------------------------------------------------------------------

  /**
   * An APPROXIMATE token count — see the interface's own doc comment for why
   * approximate is the contract.
   *
   * ⚠ IT ROUNDS UP AND TAKES THE LARGER OF TWO ESTIMATES, ON PURPOSE. A count
   * that is too LOW lets an over-budget prompt through to the vendor, which
   * rejects it after the user has been charged for the attempt; a count that is
   * too HIGH costs a little headroom against a 128k window. Those are not
   * symmetric mistakes, so this errs in the safe direction — and
   * docs/specs/notes.md §3.3's fixed 500-token safety margin sits on top of it
   * for the message framing the vendor adds beyond the literal text.
   *
   * The word-count term matters for text this characters-per-token rule is
   * worst at: heavily punctuated transcript prose, CJK, code blocks. `model` is
   * accepted because the interface promises a per-model answer and a future
   * refinement belongs behind this signature — every model in MODELS shares one
   * tokenizer family today, so it is deliberately unused rather than absent.
   */
  countTokens(text: string, _model: string): number {
    if (text.length === 0) return 0;

    const byChars = Math.ceil(text.length / CHARS_PER_TOKEN);
    const words = text.split(/\s+/).filter((word) => word.length > 0).length;

    return Math.max(byChars, words);
  }

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  /**
   * `POST {baseUrl}/chat/completions` with `stream: true`.
   *
   * AN ASYNC GENERATOR, NOT A PROMISE OF AN ARRAY, and that is the point of the
   * whole method: docs/specs/notes.md §5 appends each delta to a durable buffer
   * as it arrives so a watching client sees text appear, and an implementation
   * that collected the stream and returned it at the end would satisfy the type
   * while destroying the feature.
   *
   * `stream_options: { include_usage: true }` asks the vendor for a final frame
   * carrying the real token counts. When a gateway drops it (an
   * OpenAI-compatible proxy that predates the option), the `done` event falls
   * back to this provider's own `countTokens` estimate rather than reporting
   * zero — a zero would read as "this generation was free", which is the one
   * wrong answer about somebody's own bill.
   *
   * ⚠ A STREAM THAT ENDS WITHOUT A FINISH REASON THROWS. See the interface
   * contract: a caller that could not tell "the model stopped" from "the socket
   * died mid-sentence" would commit a half-written note as finished, and a
   * truncated note that claims to be complete is exactly the unearned
   * confidence this epic exists to prevent.
   */
  async *generate(
    ctx: AiProviderContext<OpenAiSettings>,
    request: AiGenerateRequest,
  ): AsyncIterable<AiDelta> {
    const response = await this.fetchImpl(
      `${this.baseUrl(ctx.settings)}/chat/completions`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(ctx.apiKey),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: request.model,
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: request.maxOutputTokens,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userContent },
          ],
        }),
        signal:
          request.timeoutMs && request.timeoutMs > 0
            ? AbortSignal.timeout(request.timeoutMs)
            : undefined,
      },
    );

    await this.assertOk(response, `generate with model "${request.model}"`);

    if (!response.body) {
      // A 2xx with no body is either a vendor incident or an API change; both
      // deserve another attempt before the work is written off, so this is a
      // plain (retryable) Error.
      throw new Error(
        'The provider accepted the completion request but returned no response body to stream.',
      );
    }

    let finishReason: AiFinishReason | null = null;
    let usage: AiUsage | null = null;
    let completionText = '';

    for await (const data of parseSseData(response.body)) {
      // The vendor's end-of-stream sentinel. Not JSON, and parsing it as JSON
      // is the classic way this loop throws on a perfectly healthy stream.
      if (data === '[DONE]') break;

      let chunk: OpenAiStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAiStreamChunk;
      } catch {
        // A frame this build cannot read. SKIPPED RATHER THAN FATAL: SSE
        // permits comments and keep-alives, and gateways insert their own
        // frames. Abandoning a paid-for generation over one unparseable frame
        // is the worse failure.
        this.logger.debug('Skipping an unparseable OpenAI stream frame.');
        continue;
      }

      // ⚠ A MID-STREAM ERROR FRAME. The request succeeded with a 200 and the
      // failure arrives inside the stream — which is why `assertOk` above is
      // not enough on its own, and why this branch exists at all. It is mapped
      // through the SAME classifier the HTTP path uses, so a content-policy
      // refusal is an `AiRefusedError` whether the vendor reported it at 400 or
      // at token 300.
      if (chunk.error) {
        throw this.classifyErrorBody(
          asString(chunk.error.message) ?? 'The provider reported an error mid-stream.',
          asString(chunk.error.code) ?? asString(chunk.error.type),
        );
      }

      const choice = chunk.choices?.[0];

      const text = choice?.delta?.content;
      if (typeof text === 'string' && text.length > 0) {
        completionText += text;
        yield { kind: 'delta', text };
      }

      const mapped = mapFinishReason(choice?.finish_reason);
      if (mapped !== null) {
        finishReason = mapped;
      } else if (
        choice?.finish_reason !== undefined &&
        choice.finish_reason !== null
      ) {
        this.logger.warn(
          `OpenAI returned an unrecognised finish_reason "${String(choice.finish_reason)}"; treating it as a normal stop.`,
        );
        finishReason = 'stop';
      }

      if (chunk.usage) {
        const promptTokens = asFiniteNumber(chunk.usage.prompt_tokens);
        const completionTokens = asFiniteNumber(chunk.usage.completion_tokens);
        if (promptTokens !== null && completionTokens !== null) {
          usage = { promptTokens, completionTokens };
        }
      }
    }

    if (finishReason === null) {
      // See the method's contract note: an unterminated stream must not be
      // reported as a completed generation. A plain Error, because a dropped
      // connection is exactly the transient class.
      throw new Error(
        'The provider closed the completion stream without a finish reason; the response was truncated.',
      );
    }

    if (finishReason === 'content_filter') {
      // ⚠ A REFUSAL IS A THROW HERE, not a `done` event — docs/specs/notes.md
      // §2.4. `AiDelta` still declares `content_filter` as a finish reason
      // because the type describes what a provider MAY report, and a future
      // provider that filters only part of a response could legitimately finish
      // that way; mapping it to a terminal domain error at THIS provider's
      // boundary means `note.generate` never has to branch on a finish reason
      // to decide whether the note failed.
      throw new AiRefusedError(
        'The provider declined to complete this request because its content filter matched. Rewording the instructions or the source, or choosing a different model, is the only thing that changes the answer.',
        'finish_reason: content_filter',
        this.id,
      );
    }

    yield {
      kind: 'done',
      finishReason,
      usage:
        usage ?? {
          // The estimate fallback. See the method's doc comment: zero would
          // read as "this generation was free".
          promptTokens: this.countTokens(
            `${request.systemPrompt}\n${request.userContent}`,
            request.model,
          ),
          completionTokens: this.countTokens(completionText, request.model),
        },
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** The configured API root, without a trailing slash. */
  private baseUrl(settings: OpenAiSettings): string {
    return settings.baseUrl.replace(/\/+$/, '');
  }

  /**
   * The vendor's auth scheme.
   *
   * NEVER LOGS ITS ARGUMENT, and nothing else in this file may either. The key
   * belongs to an individual user.
   */
  private authHeaders(apiKey: string): Record<string, string> {
    return { authorization: `Bearer ${apiKey}` };
  }

  /**
   * Turn a non-2xx response into the right error from `../ai-errors.ts`.
   *
   * THE MAPPING, AND WHY EACH ONE:
   *
   *   401/403 → `AiAuthError`. Retrying cannot help; the USER must fix or
   *     replace their own key. The message says so, because an application-fault
   *     phrasing sends them to file a bug instead.
   *   429 → `RateLimitError`, honouring `Retry-After` in both RFC 9110 forms via
   *     the queue's own `parseRetryAfterMs`. NOT a new parser: the deferral path
   *     already has one, and a second would be a second thing that can disagree
   *     about what a date means.
   *   400/404/422 → classified from the BODY, because the same status covers
   *     three genuinely different answers: a content-policy refusal
   *     (`AiRefusedError`), a prompt that does not fit (`AiBudgetError`), and an
   *     ordinary bad request such as a retired model id (`AiInputError`).
   *   everything else → a plain `Error`, which the queue treats as retryable.
   *
   * ⚠ THE BODY SNIPPET IS BOUNDED. A vendor error body can be large, and it
   * ends up in `Job.lastError` and in a log line; 500 characters is enough to
   * identify the problem and small enough not to fill a column with HTML.
   */
  private async assertOk(
    response: FetchLikeResponse,
    what: string,
  ): Promise<void> {
    if (response.ok) return;

    if (response.status === 401 || response.status === 403) {
      throw new AiAuthError(
        `The AI provider refused this API key (HTTP ${response.status}) when trying to ${what}. ` +
          'Check the key on your AI key settings page — it may be mistyped, revoked, or restricted to a different project.',
        this.id,
      );
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

      throw new RateLimitError(
        `The AI provider rate-limited the request to ${what} (HTTP 429).`,
        // `?? undefined`, never `?? 0`: `parseRetryAfterMs` returns `null` for
        // "the provider said nothing", and zero would be read downstream as
        // "retry immediately", which is the one thing a throttled caller must
        // not do.
        retryAfterMs ?? undefined,
      );
    }

    const snippet = await this.safeBodySnippet(response);

    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 422
    ) {
      throw this.classifyErrorBody(
        `The AI provider rejected the request to ${what} (HTTP ${response.status}): ${snippet}`,
        snippet,
      );
    }

    // Deliberately includes every 5xx AND any status this method does not name:
    // a 502 from a gateway is transient, and an unexpected 4xx is a bug in this
    // file, which becomes visible in `lastError` rather than silently terminal.
    throw new Error(
      `The AI provider returned HTTP ${response.status} when trying to ${what}: ${snippet}`,
    );
  }

  /**
   * Which terminal class does this error body describe?
   *
   * ONE FUNCTION, TWO CALLERS — the HTTP path (`assertOk`) and the mid-stream
   * error frame in `generate`. Deliberately shared: the same refusal reported
   * at 400 and reported at token 300 must produce the same class, or a user
   * gets a different explanation for the same event depending on how fast the
   * vendor noticed.
   */
  private classifyErrorBody(
    message: string,
    detail: string | null,
  ): AiInputError | AiRefusedError | AiBudgetError {
    const haystack = `${message} ${detail ?? ''}`;

    if (containsAny(haystack, CONTEXT_LENGTH_MARKERS)) {
      // -1/-1: the vendor told us it did not fit but not by how much, and
      // inventing numbers would defeat the whole point of this error carrying
      // them. A caller that has real counts (the §3.3 pre-flight check) throws
      // this class itself with the real figures.
      return new AiBudgetError(
        `The assembled prompt is too long for this model. ${message}`,
        -1,
        -1,
        this.id,
      );
    }

    if (containsAny(haystack, REFUSAL_MARKERS)) {
      return new AiRefusedError(
        `The AI provider declined this request. ${message}`,
        detail ?? undefined,
        this.id,
      );
    }

    return new AiInputError(message, detail ?? undefined, this.id);
  }

  /**
   * A bounded, never-throwing excerpt of an error body.
   *
   * `text()` can itself reject (a truncated response, an aborted stream), and a
   * failure while building an error message must not replace the error being
   * reported with a less useful one.
   */
  private async safeBodySnippet(response: FetchLikeResponse): Promise<string> {
    try {
      const text = await response.text();
      return text.length > BODY_SNIPPET_LIMIT
        ? `${text.slice(0, BODY_SNIPPET_LIMIT)}…`
        : text;
    } catch {
      return '(the response body could not be read)';
    }
  }
}
