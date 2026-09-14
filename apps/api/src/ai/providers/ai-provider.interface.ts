import type { ZodType } from 'zod';

// =============================================================================
// AiProvider (issue #47, epic #45)
// =============================================================================
//
// One interface, N vendors — a DELIBERATE CLONE of
// `transcription/providers/transcription-provider.interface.ts`, which already
// solved exactly these problems (a swappable vendor, an encrypted key, a
// testable fetch seam, a context object that must never leak a credential into
// a log). What is different here is not the shape; it is the stakes and one
// structural simplification:
//
//   • THE KEY IS THE USER'S OWN. Transcription's context carries a credential
//     the deployment configured; this one carries a credential an individual
//     person pasted in, tied to their own billing account. Everything the
//     transcription header says about never logging `ctx` applies here with
//     more force, and `createProviderContext` below is copied verbatim in
//     spirit for that reason.
//
//   • THERE IS NO `submit`/`getStatus`/`fetchResult` SPLIT (docs/specs/notes.md
//     §2.1). Transcription needs one because AssemblyAI runs the job on its own
//     infrastructure and has to be polled. A chat completion is ONE request
//     whose response IS the work, streamed back over the same connection — so
//     `generate` is the only content-producing method, and it is REQUIRED to
//     stream. A provider that can only return a complete response in one shot
//     is not eligible for registration, because there would be nothing for the
//     durable buffer (spec §5) to append incrementally.
//
// -----------------------------------------------------------------------------
// CAPABILITIES ARE DECLARED, NOT PROBED
// -----------------------------------------------------------------------------
//
// `capabilities.models` is a static description a caller can read BEFORE
// spending a request — and before spending the USER'S MONEY. It is what
// `GET /api/ai/config` publishes so a client can show context windows and
// output ceilings on a model picker, and what the §3.3 token budget subtracts
// from. A capability that has to be discovered by trying is a capability the UI
// cannot describe.
//
// -----------------------------------------------------------------------------
// `ctx` CARRIES A SECRET AND MUST NEVER BE LOGGED
// -----------------------------------------------------------------------------
//
// Every method takes an `AiProviderContext` holding the resolved plaintext key.
// It is built at the moment of use from `UserAiCredentialsService.getSecret`,
// passed down, and dropped. Do not store it on an instance field, do not put it
// in an error message, do not `JSON.stringify` it, and do not include it in a
// span attribute or a job payload. The type below carries a compile-time note
// and a `toJSON` that makes an accidental serialisation harmless rather than
// catastrophic.
// =============================================================================

/**
 * One model a provider offers, described well enough to budget against.
 *
 * EVERY FIELD IS REQUIRED, for the reason
 * `TranscriptionProviderCapabilities` states: an optional field reads as
 * "unknown" at every call site, and every call site then has to decide what
 * unknown means — which is how one of them decides wrongly. Here that call site
 * is the token budget (docs/specs/notes.md §3.3), and "unknown context window"
 * has no safe interpretation at all.
 */
export interface AiModelDescriptor {
  /** The provider's own model id, e.g. `gpt-4o`. PERMANENT once notes name it. */
  id: string;
  label: string;
  /** Total context window, in tokens. The §3.3 budget's starting number. */
  contextWindowTokens: number;
  /** Most tokens this model will produce in one completion. */
  maxOutputTokens: number;
}

/**
 * What a provider can do, as a static, publishable description.
 *
 * `streaming` is declared `true` rather than `boolean` ON PURPOSE: it is not a
 * capability a provider may decline. See the header — §5's durable buffer has
 * nothing to append if a provider cannot stream, so a non-streaming provider is
 * not registrable, and the type says so rather than leaving it to a runtime
 * check somebody has to remember to write.
 */
export interface AiProviderCapabilities {
  models: AiModelDescriptor[];
  /** Every registered provider streams. There is no non-streaming path. */
  streaming: true;
}

/**
 * One admin-form field a provider needs configured, described well enough for
 * the settings page to render it without knowing which provider it is.
 *
 * THE FORM IS DATA, NOT A COMPONENT PER PROVIDER — the same promise
 * `ProviderFieldDescriptor` makes for transcription, and the same one
 * `ADMIN_SECTIONS` makes on the navigation axis.
 *
 * ⚠ THE API KEY IS NOT ONE OF THESE, and in this epic it could not be even in
 * principle: these descriptors drive the DEPLOYMENT policy form, and there is
 * no deployment key at all. Each user's key is written through
 * `PUT /api/ai-credentials` into `user_ai_credentials`. A descriptor with
 * `key: 'apiKey'` would put a secret into the settings blob by the back door —
 * see the compile-time proof in `ai-settings.schema.ts`.
 */
export interface AiProviderFieldDescriptor {
  /** Key within this provider's settings object, e.g. `'baseUrl'`. */
  key: string;
  label: string;
  type: 'text' | 'select' | 'number' | 'boolean' | 'string-list';
  /** Required for `type: 'select'`, meaningless otherwise. */
  options?: Array<{ value: string; label: string }>;
  /** One sentence under the control. */
  helpText?: string;
  required: boolean;
  /** What a fresh installation shows before anything is saved. */
  defaultValue?: string | number | boolean | string[] | null;
}

/**
 * The per-call context: the resolved credential and this provider's settings.
 *
 * ⚠ CONTAINS A SECRET — and in this epic, SOMEBODY'S PERSONAL ONE. See the file
 * header. `toJSON` is declared so that the most common accidental leak — a
 * context reaching `JSON.stringify` through a log serialiser, an error's
 * `cause`, or a job payload — produces a marker string rather than the key. It
 * is a backstop, not permission: the rule is still "never log this".
 */
export interface AiProviderContext<TSettings = unknown> {
  /** Plaintext API key, valid for this call only. NEVER log or persist. */
  readonly apiKey: string;
  /** This provider's validated settings — the output of `settingsSchema.parse`. */
  readonly settings: TSettings;
}

/**
 * Build a context whose accidental serialisation is inert.
 *
 * ⚠ THE TWO PROPERTIES BELOW ARE LOAD-BEARING, AND BOTH ARE EASY TO "TIDY AWAY":
 *
 *   1. `toJSON` IS NON-ENUMERABLE. If it were enumerable it would appear in
 *      `Object.keys(ctx)` and, far worse, be COPIED BY A SPREAD — so
 *      `{ ...ctx }` would produce an object carrying both the raw `apiKey` AND
 *      a `toJSON` that claims it is redacted, which serialises to
 *      `[redacted]` while the property sits there in memory for any other
 *      reader. A non-enumerable one is simply absent from the spread, so the
 *      copy has no redaction and no false claim of one. `ai-provider-context
 *      .spec.ts` pins this with an assertion that fails if the descriptor is
 *      made enumerable.
 *
 *   2. THE OBJECT IS FROZEN, so a caller cannot delete `toJSON` or overwrite
 *      `apiKey` on a context it was handed.
 *
 * Copied from `createProviderContext` in
 * `transcription/providers/transcription-provider.interface.ts`. Deliberately a
 * second copy rather than an import: this module must not depend on the
 * transcription module, and "the redaction lives next to the type it redacts"
 * is worth six lines of duplication.
 */
export function createProviderContext<TSettings>(
  apiKey: string,
  settings: TSettings,
): AiProviderContext<TSettings> {
  const ctx = { apiKey, settings };

  Object.defineProperty(ctx, 'toJSON', {
    value: () => ({ apiKey: '[redacted]', settings }),
    enumerable: false,
  });

  return Object.freeze(ctx);
}

/**
 * One request for a completion.
 *
 * `systemPrompt` and `userContent` arrive ALREADY ASSEMBLED — the composition
 * order is `assemblePrompt`'s job (docs/specs/notes.md §3.1, issue #49) and is
 * deliberately not a provider concern: a provider that reordered or re-framed
 * the parts would make two providers produce different prompts from the same
 * note, which is precisely the drift §3.1 fixes the order to prevent.
 */
export interface AiGenerateRequest {
  /** The provider's own model id. Must be permitted by the `ai` policy. */
  model: string;
  /** The system role's content. */
  systemPrompt: string;
  /** The user role's content: optional context, then the source text. */
  userContent: string;
  /** Upper bound on the completion, in tokens. */
  maxOutputTokens: number;
  /**
   * Abandon the request after this many milliseconds.
   *
   * Read from `ai.requestTimeoutMs`. Optional because `testConnection` has its
   * own, much shorter, notion of patience.
   */
  timeoutMs?: number;
}

/** Why the provider stopped producing tokens. */
export type AiFinishReason = 'stop' | 'length' | 'content_filter';

/** What one completion cost, as the provider counted it. */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * One item yielded by `generate`.
 *
 * ⚠ NAMING. Issue #47 calls this type `AiDelta`; docs/specs/notes.md §2.1 calls
 * the identical union `AiGenerateEvent`. The issue is the requirement, so
 * `AiDelta` is the name — and `AiGenerateEvent` is exported as an alias below
 * so the spec's own vocabulary resolves to the same type rather than tempting
 * anybody to declare a second one.
 *
 * A UNION, NOT A BARE STRING. The terminal `done` item is what carries the
 * finish reason and the usage counts, and those are not optional extras: the
 * finish reason is how `length` (the model ran out of room) is told apart from
 * `content_filter` (an `AiRefusedError`), and the usage is what a per-user
 * spend display and `note_generations.promptTokens` are stamped from. A stream
 * of plain strings would have nowhere to put either.
 */
export type AiDelta =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; finishReason: AiFinishReason; usage: AiUsage };

/** docs/specs/notes.md §2.1's name for {@link AiDelta}. The same type. */
export type AiGenerateEvent = AiDelta;

/** The outcome of `testConnection` — always resolved, never thrown. */
export interface AiConnectionTest {
  ok: boolean;
  /** Wall-clock milliseconds the probe took, measured by the provider. */
  latencyMs: number;
  /**
   * A SPECIFIC, ACTIONABLE sentence. "Connection failed" is not one: the whole
   * value of this endpoint is telling a user whether their key is wrong, their
   * account has no credit, or the network is down — three different fixes, and
   * only one of them is something an administrator can help with.
   */
  detail: string;
}

/**
 * A concrete AI vendor.
 *
 * ## `generate` THROWS to fail; `testConnection` NEVER does.
 *
 * `generate` runs inside a queue job, where a thrown error is the documented
 * failure channel and a swallowed one is a job that reports success having done
 * nothing. Throw the narrowest type in `../ai-errors.ts` that is true —
 * `AiAuthError` when the provider refused the key, `AiInputError` when it
 * blamed the request, `AiRefusedError` when it declined to answer,
 * `AiBudgetError` when the prompt does not fit, `RateLimitError` when it
 * throttled — and a plain `Error` for everything else.
 *
 * `testConnection` is the ONE exception and is a probe, not work: it reports a
 * failure as `{ ok: false, detail }`, for exactly the reason
 * `POST /api/transcription-settings/test` returns 200 on a refused probe — a
 * refused probe is a successful diagnosis, and it is the entire point of the
 * call.
 */
export interface AiProvider<TSettings = unknown> {
  /** Stable id, used in settings, credentials and stored notes. PERMANENT. */
  readonly id: string;
  /** Human name for the settings forms. */
  readonly label: string;
  readonly capabilities: AiProviderCapabilities;
  /** Validates this provider's own settings block. Never carries a secret. */
  readonly settingsSchema: ZodType<TSettings>;
  /** Drives the provider-specific half of the admin form. */
  readonly fieldDescriptors: AiProviderFieldDescriptor[];

  /**
   * Probe the credential and the endpoint.
   *
   * NEVER THROWS — see the interface note above. `ctx.apiKey` may be a key the
   * user has typed but NOT SAVED, which is the case this method exists for:
   * proving a key before committing it.
   */
  testConnection(ctx: AiProviderContext<TSettings>): Promise<AiConnectionTest>;

  /**
   * Approximate how many tokens a piece of text costs for a given model.
   *
   * SYNCHRONOUS AND PURE (docs/specs/notes.md §2.1), because the §3.3 budget
   * check runs it inside `POST /api/notes`'s own request handler — an async or
   * network-backed counter there would put a vendor round trip in front of
   * every note creation, and would make the request-time check and the job-time
   * re-check able to disagree for reasons that have nothing to do with the
   * text.
   *
   * APPROXIMATE IS THE CONTRACT, and the 500-token safety margin §3.3 adds is
   * what covers the difference. An exact tokenizer per model would be a large
   * dependency whose tables go stale with every vendor release; being slightly
   * conservative costs a few tokens of headroom and never costs a refused
   * generation that would have fit.
   */
  countTokens(text: string, model: string): number;

  /**
   * Stream one completion.
   *
   * `ctx.apiKey` is the CALLING USER'S OWN decrypted key, resolved immediately
   * before this call and never written anywhere but into this one outbound
   * HTTPS request (docs/specs/notes.md §9).
   *
   * The returned iterable yields zero or more `delta` items and then EXACTLY
   * ONE `done`. A stream that ends without a `done` is a truncated response and
   * the implementation must throw rather than returning quietly — a caller that
   * cannot tell "the model stopped" from "the socket died" would commit a
   * half-written note as finished.
   */
  generate(
    ctx: AiProviderContext<TSettings>,
    request: AiGenerateRequest,
  ): AsyncIterable<AiDelta>;
}

/** The publishable description of one provider. See `registry.describeAll()`. */
export interface AiProviderDescription {
  id: string;
  label: string;
  capabilities: AiProviderCapabilities;
  fieldDescriptors: AiProviderFieldDescriptor[];
}
