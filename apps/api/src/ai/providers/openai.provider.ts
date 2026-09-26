import { Inject, Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';

import {
  AiAuthError,
  AiBudgetError,
  AiInputError,
  AiRefusedError,
  AiStructuredOutputError,
  parseRetryAfterMs,
  RateLimitError,
} from '../ai-errors';
import {
  modelKnowledgeOf,
  resolveAllowedModel,
  type AiResolvedModel,
} from '../ai-model-resolution';
import { AiProviderRegistry } from '../ai-provider.registry';
import {
  aiProvidersSchema,
  type AiProvidersValue,
} from '../ai-settings.schema';
import { assertStrictJsonSchema } from '../structured/strict-json-schema';
import { EMBEDDING_DIMENSIONS } from './ai-provider.interface';
import type {
  AiConnectionTest,
  AiDelta,
  AiDiscoveredModel,
  AiEmbedRequest,
  AiEmbedResult,
  AiEmbeddingCapability,
  AiFinishReason,
  AiGenerateRequest,
  AiListModelsOptions,
  AiModelDescriptor,
  AiProvider,
  AiProviderCapabilities,
  AiProviderContext,
  AiProviderFieldDescriptor,
  AiStructuredRequest,
  AiStructuredResult,
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
 * ⚠ THIS IS NOT AN ALLOW-LIST. What a user may actually generate with is
 * `ai.providers.openai.allowedModels`; this list only says which ids this
 * application has VERIFIED numbers for. The deployment's policy decides what is
 * permitted.
 *
 * ⚠ NOR IS IT THE ONLY WAY A MODEL BECOMES BUDGETABLE ANY MORE (#97). It used
 * to be: a policy entry naming an id absent from this array could not be
 * budgeted, so `AiConfigService` dropped it and the settings page refused the
 * save. Since #97 an absent id falls through to
 * {@link deriveOpenAiModelDescriptor} (a dated snapshot of a family listed
 * here) and then to {@link OPENAI_DEFAULT_MODEL_LIMITS}. This array is now rank
 * 2 of four in `ai-model-resolution.ts`'s precedence — still the most
 * authoritative answer short of an administrator typing one, and still the only
 * one that makes a model report `source: 'catalogue'`.
 *
 * ⚠ EVERY ENTRY HERE IS ALSO A FAMILY PREFIX. The derivation matches dated
 * snapshots against these ids on a hyphen boundary, so adding `gpt-5.4-mini`
 * teaches this build `gpt-5.4-mini-2026-03-17` at the same time — and removing
 * an entry silently reduces a whole family of ids to the conservative floor.
 *
 * ⚠ RE-VERIFY THE NUMBERS. See the file header: a context window that has grown
 * on the vendor's side makes this application refuse work it could do, and one
 * that has shrunk makes it submit a prompt the vendor rejects.
 *
 * ⚠ `structuredOutput: true` ON EVERY ENTRY (#358): each of these seven models
 * supports `response_format: { type: 'json_schema', strict: true }` per
 * OpenAI's Structured Outputs documentation as of 2026-09. Re-verify with the
 * numbers. A catalogued model the vendor does NOT support strict mode for must
 * say `false` here — a false positive fails a paid extraction — and a dated
 * snapshot inherits whatever its family says, through
 * {@link deriveOpenAiModelDescriptor}.
 */
const MODELS: AiModelDescriptor[] = [
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    structuredOutput: true,
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    structuredOutput: true,
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    structuredOutput: true,
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    structuredOutput: true,
  },
  // ---------------------------------------------------------------------------
  // The GPT-5.4 family — the REASONING models (#87)
  // ---------------------------------------------------------------------------
  //
  // ⚠ THE FOUR GPT-4 ENTRIES ABOVE STAY. This catalogue is not an allow-list
  // (see the doc comment): it is what this build knows how to BUDGET against,
  // and removing an entry a deployment already names in `allowedModels` would
  // strand that policy. #97 changes the SYMPTOM of that mistake without making
  // it any less of one: the model no longer vanishes from the picker, it is
  // silently demoted to the 128k/16k floor — so a 1,050k model quietly starts
  // refusing prompts that used to fit, with `source: 'default'` as the only
  // trace. Harder to notice than disappearing, not easier.
  //
  // ⚠ THEIR OUTPUT CEILING IS SHARED WITH THEIR THINKING. A reasoning model
  // spends tokens deliberating before it writes anything, those tokens are
  // BILLED AND COUNTED AS OUTPUT, and they come out of the same
  // `max_completion_tokens` the visible answer does. So `maxOutputTokens` here
  // is not "how long the answer may be" the way it is for GPT-4 — it is the
  // thinking and the answer together. See `ai.reasoningEffort` in
  // `../ai-settings.schema.ts` for what that means for a deployment's policy
  // ceiling, which is the number that actually binds.
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    structuredOutput: true,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    structuredOutput: true,
  },
  {
    id: 'gpt-5.4-nano',
    label: 'GPT-5.4 nano',
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    structuredOutput: true,
  },
];

/**
 * The conservative floor for an OpenAI chat model this build cannot place (#97)
 * — the last rank of `ai-model-resolution.ts`'s precedence.
 *
 * WHY THESE TWO NUMBERS. 128,000 input tokens and 16,384 output tokens are what
 * the SMALLEST modern OpenAI chat model offers: every entry in MODELS above
 * meets or exceeds both, and `gpt-4o` — the oldest model this build still
 * catalogues — meets them exactly. So an id this file has never seen is either a
 * member of one of those families (in which case the derivation above answered
 * and this is never read) or something newer, and OpenAI has not shipped a chat
 * model BELOW its 2024 flagship since.
 *
 * ⚠ IT IS A LOWER BOUND, NOT A GUESS AT THE MODEL'S REAL SIZE, and the
 * asymmetry is the entire justification for it existing. Under-estimating
 * refuses a prompt that would have fit — visible, recoverable, and fixed by an
 * administrator typing the real number into the policy entry, which still
 * outranks everything here. Over-estimating submits a prompt the vendor rejects
 * AFTER billing the user for the attempt, which nobody can undo and which the
 * user, not the deployment, pays for. docs/specs/notes.md §3.3's rule against
 * guessing is a rule against the second mistake; this is the first.
 *
 * ⚠ RE-VERIFY IT WITH THE MODELS. If OpenAI ever ships a small chat model with
 * a 32k window, this number starts submitting prompts that do not fit — and
 * unlike a stale MODELS entry, nothing names the model it got wrong. Lower it
 * before adding such a model to the catalogue, not after.
 */
export const OPENAI_DEFAULT_MODEL_LIMITS = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_384,
} as const;

/**
 * The conservative capability floor for an OpenAI model id this build cannot
 * place (#358). See `capabilities.defaultModelFeatures`.
 */
export const OPENAI_DEFAULT_MODEL_FEATURES = {
  structuredOutput: false,
} as const;

/**
 * One trailing dated-snapshot suffix, in the three shapes OpenAI has used (#97).
 *
 * `-2026-03-17` (current), `-20260317` (used by some gateways and by Azure
 * deployments) and `-0806` (the short form on `gpt-4o-2024-08-06`'s
 * predecessors). ANCHORED AND STRIPPED AT MOST ONCE: repeating the strip would
 * eat a meaningful trailing number from an id like `o3-mini-2025-01-31` twice
 * over and, more importantly, turn any future `-<n>` variant suffix into a
 * silent truncation of the family name.
 *
 * THE LONGER ALTERNATIVES COME FIRST, because a regex alternation is ordered:
 * `\d{4}` would otherwise match the tail of `-20260317` and leave `-2026`
 * behind, which matches nothing.
 */
const SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;

/**
 * Place an unrecognised OpenAI model id in a known family (#97).
 *
 * EXPORTED AND PURE, for the reason `looksLikeChatModel` and `parseSseData` are:
 * a rule about ids a vendor invents on its own schedule is one that has to be
 * assertable directly, with no Nest container and no network. It is reachable
 * through the provider instance as `deriveModelDescriptor`, which is what
 * `resolveAllowedModel` actually calls.
 *
 * THE TWO STEPS, AND WHY EACH:
 *
 *   1. STRIP ONE DATED SNAPSHOT SUFFIX. Real vendor lists are mostly dated
 *      snapshots of models this build already knows — `gpt-4o-2024-08-06` IS
 *      `gpt-4o` — and before #97 that one difference was enough to make a model
 *      unpermittable without hand-typing two numbers.
 *
 *   2. LONGEST-PREFIX MATCH AGAINST `MODELS`, ON A HYPHEN BOUNDARY ONLY.
 *      LONGEST, because `gpt-5.4-mini-2026-03-17` must resolve to
 *      `gpt-5.4-mini` (400k/128k) and NEVER to `gpt-5.4` (1,050k): the shorter
 *      prefix also matches, and taking it would hand a 400k model a 1,050k
 *      window — the over-estimate that bills the user for a rejected prompt.
 *      BOUNDARY, because a prefix that ends mid-segment is not a family
 *      relationship at all: `gpt-4.1` must not claim `gpt-4.10-turbo` if OpenAI
 *      ever spells one that way.
 *
 * Returns the family's FULL numbers — see `AiProvider.deriveModelDescriptor`
 * for why reducing them "to be safe" would undo the point — with `id` set to the
 * FAMILY (it becomes `derivedFrom`) and `label` to the raw requested id (never
 * the family's human name, which would claim a descriptor this build lacks).
 *
 * `null` when nothing matches, so the conservative floor applies.
 */
export function deriveOpenAiModelDescriptor(
  id: string,
): AiModelDescriptor | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) return null;

  const base = trimmed.replace(SNAPSHOT_SUFFIX, '');

  let best: AiModelDescriptor | null = null;

  for (const model of MODELS) {
    const matches = base === model.id || base.startsWith(`${model.id}-`);
    if (!matches) continue;
    if (best === null || model.id.length > best.id.length) best = model;
  }

  if (!best) return null;

  return {
    id: best.id,
    label: trimmed,
    contextWindowTokens: best.contextWindowTokens,
    maxOutputTokens: best.maxOutputTokens,
    // The family's capability, like its numbers (#358): a dated snapshot of a
    // strict-schema model is a strict-schema model.
    structuredOutput: best.structuredOutput,
  };
}

/**
 * Substrings in a model id that mean "this is not a chat model" (#78).
 *
 * ⚠ A CONVENIENCE OVER AN UNSTRUCTURED VENDOR LIST, AND NOTHING MORE. OpenAI's
 * `GET /models` returns one flat array with no `capability` field of any kind:
 * embeddings, text-to-speech voices, Whisper, moderation endpoints, image
 * models and chat models all arrive as bare ids, and an administrator opening a
 * model dropdown does not want to scroll past `text-embedding-3-small` to find
 * `gpt-4o`. This list is how that dropdown stays short.
 *
 * ⚠ IT MUST NEVER BE THE THING THAT MAKES A MODEL UNUSABLE. Filtering here
 * removes an id from a SUGGESTION LIST; it does not remove it from the policy,
 * and `aiAllowedModelSchema` accepts any id an administrator types by hand —
 * `POST/PUT /api/ai-settings` never consults this list. That separation is
 * deliberate and load-bearing: a heuristic over ids a vendor invents on its own
 * schedule WILL be wrong eventually (a chat model named after an audio feature,
 * a gateway exposing something in a private namespace), and the cost of being
 * wrong has to be "you type six characters", never "this deployment cannot use
 * a model that works".
 *
 * A MISS IS CHEAP IN BOTH DIRECTIONS, which is why the list is short and
 * literal rather than clever: a false negative shows one extra row; a false
 * positive hides a row an administrator can still type — and since #97 one they
 * can also simply ask for, with `?includeAll=true` on
 * `GET /api/ai-settings/models` (see {@link AiListModelsOptions}). That escape
 * hatch is what makes this filter FULLY non-blocking rather than merely
 * non-binding: the cost of a false positive is now one checkbox instead of
 * knowing the exact id by heart.
 */
const NON_CHAT_MODEL_MARKERS = [
  'embedding',
  'whisper',
  'tts',
  'dall-e',
  'moderation',
  'audio',
  'image',
  'realtime',
  'transcribe',
  'speech',
  'rerank',
  'guard',
];

/**
 * One entry of `GET /models`, as far as this file reads it.
 *
 * ⚠ `id` IS THE ONLY FIELD THIS BUILD RELIES ON, deliberately. The vendor's
 * list carries `created` and `owned_by` and no context window, no output
 * ceiling and no display name — see {@link AiDiscoveredModel} for why those
 * two absences are the reason discovery returns its own type rather than an
 * `AiModelDescriptor`. An OpenAI-COMPATIBLE gateway is only obliged to get `id`
 * right, and several get nothing else right, so reading more would be reading
 * fiction.
 */
interface OpenAiModelListEntry {
  id?: unknown;
}

/** The `GET /models` envelope. `data` is the array; everything else is ignored. */
interface OpenAiModelListResponse {
  data?: unknown;
}

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

/** `json_schema.name`'s documented pattern (#358). Checked before any request. */
const SCHEMA_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Most characters of a model's refusal text quoted into an `AiRefusedError`. */
const REFUSAL_QUOTE_LIMIT = 300;

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

/**
 * One item of `POST /embeddings`, as far as this file reads it (#183).
 *
 * ⚠ `index` IS NOT DECORATION AND IS NOT OPTIONAL TO READ. The vendor documents
 * the response as an array of objects each carrying its own position, which is
 * the API telling you in as many words that the array order is not the
 * contract. See {@link OpenAiProvider.embed} for what reading it positionally
 * would cost, and why the cost is invisible.
 */
interface OpenAiEmbeddingEntry {
  index?: unknown;
  embedding?: unknown;
}

/** The `POST /embeddings` envelope (#183). */
interface OpenAiEmbeddingResponse {
  data?: unknown;
  /** The model the vendor says actually ran — a gateway may substitute one. */
  model?: unknown;
  usage?: { prompt_tokens?: unknown } | null;
}

/** One frame of OpenAI's `stream: true` response, as far as this file reads it. */
interface OpenAiStreamChunk {
  choices?: Array<{
    /**
     * `refusal` (#358): under Structured Outputs a model that declines streams
     * its explanation here INSTEAD of `content`, so a refusal is not an empty
     * answer that fails `JSON.parse` — it is its own signal.
     */
    delta?: { content?: unknown; refusal?: unknown };
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

/**
 * Sort weight for {@link AiDiscoveredModel.source}. Lower sorts first.
 *
 * Verified numbers, then an inference from a family, then the floor — the same
 * order as the resolution precedence, so the dialog reads top to bottom as
 * "most certain first".
 */
const DISCOVERY_SOURCE_RANK: Record<AiDiscoveredModel['source'], number> = {
  catalogue: 0,
  derived: 1,
  default: 2,
};

/**
 * Project a resolution onto the three sources the DISCOVERY wire type admits.
 *
 * TWO CASES THE WIRE TYPE CANNOT SPELL, and both are handled here rather than
 * with a `!`:
 *
 *   • `'explicit'` — unreachable, because discovery resolves a bare `{ id }`
 *     with no administrator override behind it. Folded onto `'catalogue'`,
 *     which is the strongest source a client can be shown and is what an
 *     explicit number would be standing in for.
 *   • `null` — unreachable while this provider declares `defaultModelLimits`,
 *     since the floor answers everything. Reported as `'default'` alongside the
 *     `null` numbers it comes with, which is the only honest label for "nothing
 *     better than the floor, and not even that".
 *
 * Written as a total function so that removing the floor one day degrades this
 * list gracefully instead of throwing inside a settings page.
 */
function discoverySource(
  resolved: AiResolvedModel | null,
): AiDiscoveredModel['source'] {
  if (!resolved) return 'default';
  return resolved.source === 'explicit' ? 'catalogue' : resolved.source;
}

function containsAny(haystack: string, needles: string[]): boolean {
  const lowered = haystack.toLowerCase();
  return needles.some((needle) => lowered.includes(needle));
}

/**
 * Is this id plausibly a chat model? See {@link NON_CHAT_MODEL_MARKERS} for the
 * standing warning that this is a convenience, never a gate.
 *
 * EXPORTED SO IT CAN BE ASSERTED DIRECTLY, because a heuristic nobody can test
 * in isolation is a heuristic that quietly rots as the marker list grows.
 */
export function looksLikeChatModel(id: string): boolean {
  return !containsAny(id, NON_CHAT_MODEL_MARKERS);
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
    // #97: the last rank of the resolution chain, so no OpenAI chat model is
    // ever un-permittable for want of two numbers. See the constant for why a
    // floor is honest where a guess is not.
    defaultModelLimits: OPENAI_DEFAULT_MODEL_LIMITS,
    // #358: an id this build cannot place could be any gateway model, so the
    // floor claims no structured-output support. A false negative is
    // recoverable (pick a catalogued model); a false positive fails a paid
    // extraction.
    defaultModelFeatures: OPENAI_DEFAULT_MODEL_FEATURES,
    // TRUE, AND `listModels` BELOW IS WHAT MAKES THAT LEGAL (#78) — the
    // registry refuses this provider at boot if the two disagree. `GET /models`
    // is the one route every OpenAI-compatible gateway implements, which is a
    // large part of why discovery is worth having at all: an enterprise proxy
    // or a self-hosted vLLM answers it with ITS OWN model list, so the admin
    // dropdown describes the endpoint this deployment actually calls rather
    // than OpenAI's public catalogue.
    modelDiscovery: true,
  };

  /**
   * This provider's embedding endpoint (#183, epic #165).
   *
   * ⚠ PRESENT, AND `embed` BELOW IS WHAT MAKES THAT LEGAL — the registry
   * refuses this provider at boot if the two disagree, exactly as it does for
   * `capabilities.modelDiscovery`/`listModels`.
   *
   * ⚠ `text-embedding-3-small` OUTPUTS 1536 DIMENSIONS NATIVELY. That is the
   * whole reason it is the model named here, and it is not the same fact as
   * "1536 is obtainable from it". OpenAI also accepts a `dimensions` request
   * parameter that truncates a wider model's output (Matryoshka representation
   * learning, which trains a model so that its leading components remain a
   * usable embedding on their own) — so `text-embedding-3-large` could be asked
   * for 1536 numbers instead of 3072. THIS FILE DELIBERATELY DOES NOT DO THAT.
   * Truncation of that kind is a property of how one vendor trained one family
   * of models; it is not available on other vendors, and an OpenAI-compatible
   * gateway in front of some other model will either ignore the parameter or
   * refuse it. Relying on it would make the {@link EMBEDDING_DIMENSIONS}
   * contract depend on a vendor feature rather than on a declared property of
   * the model, and the failure mode of "ignored the parameter" is the worst
   * available one: a 3072-wide vector arriving where 1536 was promised, which
   * the validation below turns into a loud error only because the width is
   * asserted rather than assumed. Native width, declared here, refused by the
   * registry on mismatch.
   *
   * ⚠ `maxInputTokens: 8191` IS THE VENDOR'S DOCUMENTED PER-INPUT CEILING —
   * per input, not per batch: 128 inputs of that length is a legal request.
   * Re-verify it with the same care as MODELS; see the file header.
   *
   * ⚠ `maxBatchSize: 128` IS A DELIBERATELY CONSERVATIVE CHOICE AND IS *NOT* A
   * VENDOR MAXIMUM. OpenAI accepts considerably larger batches. The number is
   * picked to bound the blast radius of one failed request: the batch is the
   * retry unit, so a timeout or a 500 at the end of a batch re-does at most 128
   * inputs rather than thousands, and a rate-limited indexer backs off in
   * increments small enough that progress survives. Raising it is a
   * throughput-versus-rework trade with no correctness component — which is
   * precisely why it should not be raised by someone assuming it is the
   * vendor's limit.
   */
  readonly embedding: AiEmbeddingCapability = {
    model: 'text-embedding-3-small',
    dimensions: EMBEDDING_DIMENSIONS,
    maxInputTokens: 8191,
    maxBatchSize: 128,
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
        "Models users of this deployment may generate with. This is the deployment's only lever over which vendor models its content reaches — the key and the bill are each user's own. An empty list permits nothing. Load the live list from the provider, or type an id by hand: token limits for a model this build does not recognise are detected from the model's family or from a conservative default, and can be overridden per model if the vendor publishes better numbers.",
      required: false,
      // `[]` STILL, and still a `string-list`: an entry may now be an object
      // (#78), but a bare id remains a legal way to write one and is what the
      // normalising schema turns into `{ id }`. A descriptor type of its own
      // would have to be understood by every provider's form; describing the
      // simple case and letting the model dialog handle the rest costs nothing
      // and keeps `AiProviderFieldDescriptor` a closed union.
      defaultValue: [],
    },
    {
      key: 'defaultModel',
      label: 'Default model',
      type: 'text',
      helpText:
        'The model offered first. It should be one of the permitted models above; if it is not, clients fall back to the first permitted one.',
      required: true,
      // #87: the same value `DEFAULT_SYSTEM_SETTINGS.ai` now carries. These two
      // are the same decision written in two places — a form that prefilled
      // `gpt-4o` while a fresh row said `gpt-5.4-mini` would look like a bug in
      // whichever one the administrator noticed second.
      defaultValue: 'gpt-5.4-mini',
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
  // Model discovery (#78)
  // ---------------------------------------------------------------------------

  /**
   * `GET {baseUrl}/models` — the same route `testConnection` probes, read for
   * its CONTENT rather than for its status code.
   *
   * WHY THIS IS WORTH A VENDOR CALL AT ALL. Before it, an administrator
   * configured `allowedModels` by typing model ids into a textarea, with this
   * build's four-entry `MODELS` catalogue as the only validation — so adopting
   * a model the vendor shipped last week required a release of this
   * application, and a typo produced a policy that saved cleanly and offered
   * nobody anything. The vendor's own list is the authority on what exists;
   * `MODELS` remains the authority on what can be BUDGETED, and `known` is the
   * join.
   *
   * ⚠ THROWS ON REFUSAL, unlike `testConnection` two methods up. The contract
   * difference is stated on `AiProvider.listModels`: a probe's failure IS its
   * answer, whereas a list has no partial form, so the decision of whether a
   * refusal is a 200 diagnosis belongs to the caller. `AiSettingsService
   * .discoverModels` is that caller and does exactly that. Errors go through
   * the SAME `assertOk` the generation path uses, so a revoked key produces one
   * `AiAuthError` with one sentence whichever route noticed first.
   *
   * ⚠ `ctx` IS NEVER LOGGED, in this method or anywhere near it. The key is an
   * individual person's, and the only variables permitted in a log line here
   * are counts.
   *
   * ⚠ THE TWO TOKEN NUMBERS COME FROM `resolveAllowedModel`, NOT FROM A LOCAL
   * LOOKUP (#97). They used to be `catalogue.get(id)?.contextWindowTokens ??
   * null`, which was a second, shorter copy of a precedence that has since
   * grown two more ranks. Routing a bare `{ id }` entry through the shared
   * resolver means the number this dialog shows is the number the save path
   * validates and the number the token budget will subtract from — by
   * construction rather than by two files being kept in step.
   */
  async listModels(
    ctx: AiProviderContext<OpenAiSettings>,
    opts?: AiListModelsOptions,
  ): Promise<AiDiscoveredModel[]> {
    const response = await this.fetchImpl(
      `${this.baseUrl(ctx.settings)}/models`,
      {
        method: 'GET',
        headers: this.authHeaders(ctx.apiKey),
        // The PROBE budget, not the generation one: this is a metadata read
        // that either answers promptly or is not going to, and an administrator
        // is watching a spinner. `ai.requestTimeoutMs` is minutes long because
        // a streamed completion legitimately runs for minutes; nothing about
        // that reasoning applies to a list of strings.
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );

    await this.assertOk(response, 'list the models this API key can reach');

    let payload: OpenAiModelListResponse;
    try {
      payload = (await response.json()) as OpenAiModelListResponse;
    } catch {
      // A 2xx whose body is not JSON is a gateway problem, not a credential
      // one, and it is worth another attempt — so a plain Error rather than one
      // of the terminal domain classes. The message deliberately carries
      // nothing from the body: this is the one place an HTML error page from an
      // intercepting proxy would otherwise be echoed back to a settings page.
      throw new Error(
        'The provider answered the model list request with a body this application could not read as JSON. That is usually a proxy or gateway in front of the API rather than the API itself.',
      );
    }

    const entries = Array.isArray(payload.data)
      ? (payload.data as OpenAiModelListEntry[])
      : [];

    const catalogue = new Map(MODELS.map((model) => [model.id, model]));

    const discovered = entries
      .map((entry) => asString(entry?.id))
      .filter((id): id is string => id !== null)
      // Deduplicated because a gateway aggregating several upstreams can list
      // the same id twice, and a duplicated row in a dropdown reads as a bug in
      // this application.
      .filter((id, index, all) => all.indexOf(id) === index)
      // ⚠ SKIPPED ENTIRELY WHEN THE CALLER ASKED FOR EVERYTHING (#97). See
      // `NON_CHAT_MODEL_MARKERS`: this filter is a convenience over a flat
      // vendor list, and an administrator who knows better must be able to say
      // so without knowing the id by heart.
      .filter((id) => opts?.includeAll === true || looksLikeChatModel(id))
      .map((id): AiDiscoveredModel => {
        const descriptor = catalogue.get(id);
        // ⚠ THE SHARED RESOLVER, WITH A BARE `{ id }` ENTRY — no policy entry
        // exists at discovery time, so the `explicit` rank is unreachable and
        // what comes back is the catalogue, the family derivation, or the
        // floor, exactly as the save path will compute it.
        const resolved = resolveAllowedModel({ id }, modelKnowledgeOf(this));

        return {
          id,
          // The catalogue's human name when this build has one; the raw id
          // otherwise. NEVER a prettified guess — a label this application
          // invented for a model it knows nothing about would look exactly like
          // one it can budget for, which is the distinction `known` exists to
          // make. A DERIVED family's label is not borrowed either, for the same
          // reason; `derivedFrom` carries that relationship instead.
          label: descriptor?.label ?? id,
          // UNCHANGED, AND STILL AN EXACT CATALOGUE HIT (#97). Widening it to
          // "resolvable" would have made a derived or floored model claim
          // verified numbers on a wire field clients already branch on.
          known: descriptor !== undefined,
          // No longer `null` for everything this build has not heard of: the
          // resolver answers from the family or the floor. Still `null` rather
          // than a made-up number in the one case where nothing can answer.
          contextWindowTokens: resolved?.contextWindowTokens ?? null,
          maxOutputTokens: resolved?.maxOutputTokens ?? null,
          source: discoverySource(resolved),
          derivedFrom: resolved?.derivedFrom ?? null,
        };
      });

    // KNOWN FIRST, THEN BY HOW WELL THIS BUILD KNOWS THE NUMBERS, THEN
    // ALPHABETICALLY. The models an administrator can permit with one click and
    // no doubt belong at the top; below them, a model whose window was derived
    // from its family is a better offer than one that fell back to the
    // conservative floor, because the floor may well be an under-estimate the
    // administrator would rather correct. Within a group the order is flat and
    // alphabetical, because a vendor's own ordering (creation date, in OpenAI's
    // case) is meaningless to the person reading it.
    discovered.sort((a, b) => {
      if (a.known !== b.known) return a.known ? -1 : 1;
      const bySource =
        DISCOVERY_SOURCE_RANK[a.source] - DISCOVERY_SOURCE_RANK[b.source];
      if (bySource !== 0) return bySource;
      return a.id.localeCompare(b.id);
    });

    this.logger.debug(
      `Discovered ${discovered.length} model(s) from the provider's model list.`,
    );

    return discovered;
  }

  /**
   * See {@link deriveOpenAiModelDescriptor} — the whole rule, kept as a module
   * function so it is testable without a container.
   *
   * PRESENT ON THE INSTANCE BECAUSE `resolveAllowedModel` REACHES IT THROUGH THE
   * PROVIDER, via `modelKnowledgeOf`. A caller holding only an `AiProvider` must
   * never have to know which concrete class it got, or to import one vendor's
   * module to resolve another vendor's model.
   */
  deriveModelDescriptor(id: string): AiModelDescriptor | null {
    return deriveOpenAiModelDescriptor(id);
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
    const body = {
      model: request.model,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: request.maxOutputTokens,
      // ⚠ SPREAD, SO THE KEY IS ABSENT AND NOT `'none'` — see
      // `reasoningEffortBody` for why absent is the only correct shape at
      // the default, and for why the parameter is the FLAT
      // `reasoning_effort` string rather than Responses API's
      // `reasoning: { effort }`.
      ...this.reasoningEffortBody(request.reasoningEffort),
      // Spread for the same reason: absent at the default, so a gateway
      // that rejects unknown parameters never sees `response_format` on
      // an ordinary prose request. JSON mode is `json_object` (not
      // `json_schema`) — the caller validates the shape itself (#328).
      ...(request.responseFormat === 'json'
        ? { response_format: { type: 'json_object' } }
        : {}),
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userContent },
      ],
    };

    let finishReason: AiFinishReason | null = null;
    let usage: AiUsage | null = null;
    let completionText = '';

    for await (const chunk of this.streamChatCompletion(
      ctx,
      body,
      `generate with model "${request.model}"`,
      request.timeoutMs,
    )) {
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
  // Structured output (#358)
  // ---------------------------------------------------------------------------

  /**
   * `POST {baseUrl}/chat/completions` with
   * `response_format: { type: 'json_schema', json_schema: { strict: true } }`,
   * streamed, accumulated, and parsed into ONE JSON value.
   *
   * STREAMED EVEN THOUGH NOTHING IS YIELDED, because the whole error, timeout
   * and mid-stream-error machinery is stream-based and lives in
   * `streamChatCompletion` — one parser for every call shape.
   *
   * THE END-OF-STREAM DECISIONS, IN ORDER, and why that order:
   *
   *   1. No finish reason → a plain (retryable) `Error`: the socket died, the
   *      same rule `generate` follows.
   *   2. Refusal text, or `content_filter` → `AiRefusedError`. Checked before
   *      `length` because a model that refused and then ran out of room still
   *      refused — "truncated" would send somebody to raise a ceiling.
   *   3. `length` → `AiStructuredOutputError('truncated')`, EVEN IF THE PARTIAL
   *      TEXT PARSES. A cut-off object that happens to be valid JSON silently
   *      drops whatever came after the cut.
   *   4. Unparseable content → `AiStructuredOutputError('invalid_json')` —
   *      under strict decoding, a gateway that ignored `response_format`.
   *   5. Otherwise the parsed value, `finishReason: 'stop'`.
   *
   * ⚠ NOTHING HERE LOGS THE PROMPT, THE SCHEMA OR THE OUTPUT. The one `warn`
   * (for `invalid_json`) names the model and the content's LENGTH only — the
   * content is derived from a user's private conversation.
   */
  async generateStructured<T = unknown>(
    ctx: AiProviderContext<OpenAiSettings>,
    request: AiStructuredRequest,
  ): Promise<AiStructuredResult<T>> {
    // Pre-flight: both are programming errors in the CALLER's code, refused
    // before any byte is sent (and before the user's account is metered).
    assertStrictJsonSchema(request.schema);

    if (!SCHEMA_NAME_PATTERN.test(request.schemaName)) {
      throw new Error(
        `Structured-output schemaName ${JSON.stringify(request.schemaName)} must match ${SCHEMA_NAME_PATTERN.source}; the vendor refuses any other name.`,
      );
    }

    const body = {
      model: request.model,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: request.maxOutputTokens,
      // Spread — absent, never `'none'`. See `reasoningEffortBody`.
      ...this.reasoningEffortBody(request.reasoningEffort),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          strict: true,
          schema: request.schema,
        },
      },
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userContent },
      ],
    };

    let finishReason: AiFinishReason | null = null;
    let usage: AiUsage | null = null;
    let content = '';
    let refusal = '';

    for await (const chunk of this.streamChatCompletion(
      ctx,
      body,
      `generate structured output with model "${request.model}"`,
      request.timeoutMs,
    )) {
      const choice = chunk.choices?.[0];

      const text = choice?.delta?.content;
      if (typeof text === 'string') content += text;

      const refused = choice?.delta?.refusal;
      if (typeof refused === 'string') refusal += refused;

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
      throw new Error(
        'The provider closed the structured-output stream without a finish reason; the response was truncated.',
      );
    }

    if (refusal.trim().length > 0 || finishReason === 'content_filter') {
      const quoted = refusal.trim();
      throw new AiRefusedError(
        'The provider declined to produce this structured answer. Rewording the instructions or the source, or choosing a different model, is the only thing that changes the answer.',
        quoted.length > 0
          ? quoted.slice(0, REFUSAL_QUOTE_LIMIT)
          : 'finish_reason: content_filter',
        this.id,
      );
    }

    if (finishReason === 'length') {
      throw new AiStructuredOutputError(
        `The structured answer from model "${request.model}" was cut off at the ${request.maxOutputTokens}-token output ceiling before the JSON object was complete.`,
        'truncated',
        this.id,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      this.logger.warn(
        `Structured output from model "${request.model}" was not valid JSON (${content.length} characters).`,
      );
      throw new AiStructuredOutputError(
        `The provider finished normally but the structured answer from model "${request.model}" is not valid JSON. Something between this application and the model (usually a gateway) ignored the requested response format.`,
        'invalid_json',
        this.id,
      );
    }

    return {
      value,
      usage:
        usage ?? {
          // Never zero — see `generate`. The schema travels with the prompt,
          // so it is counted as prompt.
          promptTokens: this.countTokens(
            `${request.systemPrompt}\n${request.userContent}\n${JSON.stringify(request.schema)}`,
            request.model,
          ),
          completionTokens: this.countTokens(content, request.model),
        },
      finishReason: 'stop',
    };
  }

  /**
   * The streaming core every `/chat/completions` call shape shares (#358).
   *
   * `POST {baseUrl}/chat/completions` with `body`, then yield each parsed
   * stream frame. It owns everything that is about the WIRE rather than about
   * what a caller does with the frames: the injected `fetchImpl`, `assertOk`'s
   * HTTP taxonomy, the no-body error, the `[DONE]` sentinel, skipping
   * unparseable frames, and classifying a mid-stream error frame. `generate`
   * and `generateStructured` (and #359's tool calling) each consume it and
   * decide what the frames MEAN — one parser for every call shape, so a
   * framing fix or a gateway quirk is handled once.
   *
   * `label` completes the sentence "…when trying to <label>" in `assertOk`'s
   * messages. `timeoutMs` arms an `AbortSignal` when positive.
   *
   * ⚠ `ctx` REACHES ONLY `authHeaders`. Nothing here logs it, the body, or a
   * frame's content.
   */
  private async *streamChatCompletion(
    ctx: AiProviderContext<OpenAiSettings>,
    body: Record<string, unknown>,
    label: string,
    timeoutMs?: number,
  ): AsyncGenerator<OpenAiStreamChunk> {
    const response = await this.fetchImpl(
      `${this.baseUrl(ctx.settings)}/chat/completions`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(ctx.apiKey),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal:
          timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      },
    );

    await this.assertOk(response, label);

    if (!response.body) {
      // A 2xx with no body is either a vendor incident or an API change; both
      // deserve another attempt before the work is written off, so this is a
      // plain (retryable) Error.
      throw new Error(
        'The provider accepted the completion request but returned no response body to stream.',
      );
    }

    for await (const data of parseSseData(response.body)) {
      // The vendor's end-of-stream sentinel. Not JSON, and parsing it as JSON
      // is the classic way this loop throws on a perfectly healthy stream.
      if (data === '[DONE]') return;

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

      yield chunk;
    }
  }

  // ---------------------------------------------------------------------------
  // Embeddings (#183)
  // ---------------------------------------------------------------------------

  /**
   * `POST {baseUrl}/embeddings` — one batch in, one vector per input out.
   *
   * ONE HTTP PATH, NOT A SECOND ONE. The base URL, the `authorization` header,
   * the timeout handling and every error mapping are the SAME `baseUrl`,
   * `authHeaders`, `AbortSignal.timeout` and `assertOk` the generation and
   * discovery paths use — including the injected `fetchImpl`, which is what
   * lets every case below be asserted offline with no vendor account and no
   * charge to anybody's card. A second fetch path here would mean a revoked key
   * producing one sentence during generation and a different one during
   * indexing, and a gateway quirk fixed in one place and not the other.
   *
   * ⚠ THE VECTORS ARE PLACED BY THE PROVIDER'S OWN `index`, NEVER BY RESPONSE
   * POSITION. This is the reason most of the body below exists. The vendor
   * returns an `index` per item precisely because the array order is not
   * promised; reading it positionally would pass every test written against a
   * well-behaved fixture and then, one day, attach every chunk's vector to the
   * WRONG CHUNK. That corruption raises no error, fails no constraint and is
   * undetectable after the fact — the widths are right, the counts are right,
   * the job succeeds, and semantic search confidently returns the wrong
   * passages for as long as the index lives. Three checks make it
   * unrepresentable instead: every index must be a position in THIS batch, no
   * index may arrive twice, and every position must end up filled. Together
   * those three mean the only response this method accepts is a complete
   * permutation of the batch it sent — so a short, duplicated or transposed
   * answer is a thrown error rather than a silent lie.
   *
   * ⚠ AN EMPTY OR OVER-LARGE BATCH IS REFUSED HERE, BEFORE ANY REQUEST. Both
   * are `AiInputError` (terminal — retrying sends the same illegal batch), and
   * both are things this provider already knows the answer to: spending a round
   * trip to be told a ceiling we declared ourselves is paying for an answer we
   * are holding.
   *
   * ⚠ `ctx.apiKey` IS THE CALLING USER'S OWN. Nothing in this method logs it,
   * and nothing in this method logs `ctx`. Indexing runs unattended and at
   * volume, which makes a temporary log line here the most expensive one in the
   * module.
   */
  async embed(
    ctx: AiProviderContext<OpenAiSettings>,
    request: AiEmbedRequest,
  ): Promise<AiEmbedResult> {
    const { inputs } = request;

    if (inputs.length === 0) {
      throw new AiInputError(
        'An embedding request must carry at least one input; this one carried none. Sending it would spend a request on a batch with no work in it.',
        undefined,
        this.id,
      );
    }

    if (inputs.length > this.embedding.maxBatchSize) {
      throw new AiInputError(
        `An embedding request may carry at most ${this.embedding.maxBatchSize} inputs; this one carried ${inputs.length}. Split the batch — the ceiling is declared on this provider's embedding capability so a caller can size against it rather than discover it from a refusal.`,
        undefined,
        this.id,
      );
    }

    const response = await this.fetchImpl(
      `${this.baseUrl(ctx.settings)}/embeddings`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(ctx.apiKey),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.embedding.model,
          // The batch, in order. What comes back is re-ordered by `index`
          // below; this array is the only thing that defines what "input 3"
          // means.
          input: inputs,
          // ⚠ EXPLICIT, NOT DEFAULTED. The alternative encoding is base64, and
          // some gateways make it their default; asking for `float` means the
          // parser below reads numbers rather than silently receiving a string
          // where an array was expected.
          encoding_format: 'float',
        }),
        // The same shape `generate` uses: the caller's timeout when it gave
        // one, none otherwise. Deliberately not the PROBE budget — a full batch
        // is real work, not a metadata read.
        signal:
          request.timeoutMs && request.timeoutMs > 0
            ? AbortSignal.timeout(request.timeoutMs)
            : undefined,
      },
    );

    await this.assertOk(
      response,
      `embed ${inputs.length} input(s) with model "${this.embedding.model}"`,
    );

    let payload: OpenAiEmbeddingResponse;
    try {
      payload = (await response.json()) as OpenAiEmbeddingResponse;
    } catch {
      // A 2xx whose body is not JSON is a gateway problem, not a credential
      // one, and is worth another attempt — so a plain (retryable) Error. The
      // message carries nothing from the body, for the reason `listModels`
      // states: an intercepting proxy's HTML error page must not be echoed on.
      throw new Error(
        'The provider answered the embedding request with a body this application could not read as JSON. That is usually a proxy or gateway in front of the API rather than the API itself.',
      );
    }

    if (!Array.isArray(payload.data)) {
      throw new Error(
        'The provider answered the embedding request with a JSON body carrying no `data` array. The response does not match the embeddings API this build calls.',
      );
    }

    const entries = payload.data as OpenAiEmbeddingEntry[];

    // Sparse on purpose: a hole here is an input the provider never answered
    // for, and the completeness check below is what turns that into an error
    // rather than an `undefined` handed to a caller that will store it.
    const vectors: Array<number[] | undefined> = new Array<number[] | undefined>(
      inputs.length,
    );

    for (const entry of entries) {
      const index = asFiniteNumber(entry?.index);

      if (index === null || !Number.isInteger(index) || index < 0 || index >= inputs.length) {
        throw new Error(
          `The provider returned an embedding whose index (${String(entry?.index)}) is not a position in the ${inputs.length}-input batch this request sent. Placing it by response position instead would attach a vector to the wrong text.`,
        );
      }

      if (vectors[index] !== undefined) {
        throw new Error(
          `The provider returned two embeddings for index ${index} of a ${inputs.length}-input batch. One of them belongs to an input this response then has no vector for.`,
        );
      }

      const vector = entry?.embedding;

      if (!Array.isArray(vector) || vector.length !== this.embedding.dimensions) {
        throw new Error(
          `The provider returned an embedding of width ${Array.isArray(vector) ? vector.length : typeof vector} for index ${index}; this application stores vectors of exactly ${this.embedding.dimensions} components and can store nothing else.`,
        );
      }

      for (const component of vector) {
        if (typeof component !== 'number' || !Number.isFinite(component)) {
          // A NaN or an Infinity poisons every distance computed against this
          // vector, and does it quietly — a similarity search does not fail on
          // one, it just stops ranking meaningfully.
          throw new Error(
            `The provider returned an embedding for index ${index} containing a value that is not a finite number.`,
          );
        }
      }

      vectors[index] = vector as number[];
    }

    const missing = vectors.findIndex((vector) => vector === undefined);
    if (missing !== -1) {
      throw new Error(
        `The provider returned no embedding for input ${missing} of ${inputs.length}. A partial batch is refused rather than stored, because the alternative is a gap nothing downstream can tell from a vector.`,
      );
    }

    return {
      vectors: vectors as number[][],
      // `null` when the provider said nothing — never 0. See the interface: a
      // zero would read as "this batch was free", the one wrong answer about
      // somebody's own bill.
      promptTokens: asFiniteNumber(payload.usage?.prompt_tokens),
      // What the provider says RAN, falling back to what was asked for only
      // when it named nothing. A gateway that substituted a model is exactly
      // the provenance a stored vector needs to record.
      model: asString(payload.model) ?? this.embedding.model,
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
   * The `reasoning_effort` fragment of a completion body, or nothing (#87).
   *
   * ⚠ `reasoning_effort: '<value>'`, FLAT — this is the CHAT COMPLETIONS
   * spelling, and it is the single easiest thing to get wrong here. The nested
   * `reasoning: { effort }` object belongs to the RESPONSES API, a different
   * endpoint with a different body; sent to `/chat/completions` it is at best
   * ignored (so the deployment pays for a setting that does nothing and nobody
   * can tell) and at worst rejected as an unknown parameter. The whole point of
   * this method existing rather than being one more line in the body literal is
   * that the shape has a comment attached to it.
   *
   * ⚠ `'none'` AND `undefined` BOTH SEND NOTHING, deliberately. `'none'` is the
   * vendor's own default, so omitting the key is behaviourally identical to
   * sending it — and omitting it is strictly safer, because
   * `providers.openai.baseUrl` is a setting precisely so an OpenAI-COMPATIBLE
   * gateway can be used, and many of them predate `reasoning_effort` and reject
   * a body carrying an unknown key. A deployment that has not opted in
   * therefore puts byte-for-byte the request on the wire it put there before
   * this feature existed.
   */
  private reasoningEffortBody(
    effort: AiGenerateRequest['reasoningEffort'],
  ): { reasoning_effort?: string } {
    if (effort === undefined || effort === 'none') return {};

    return { reasoning_effort: effort };
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
   * error frame in `streamChatCompletion`. Deliberately shared: the same refusal reported
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
