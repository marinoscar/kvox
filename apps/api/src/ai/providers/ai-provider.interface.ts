import type { ZodType } from 'zod';

import type { AiReasoningEffort } from '../ai-settings.schema';

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
  /**
   * The conservative floor for a chat model this provider has never heard of
   * (#97) — the LAST rank of `ai-model-resolution.ts`'s precedence.
   *
   * WHY A FLOOR IS ALLOWED TO EXIST AT ALL, when {@link AiModelDescriptor}'s
   * own comment says an unknown context window has no safe interpretation. It
   * has no safe interpretation as a GUESS AT THE TRUTH, which is what that
   * comment is about; it has a perfectly safe interpretation as a LOWER BOUND.
   * The two mistakes are not symmetric: a number below the truth refuses a
   * prompt that would have fit, which an administrator can see and correct by
   * typing the real number, while a number above it submits a prompt the vendor
   * rejects after billing the user, which nobody can undo. So this must be the
   * smallest window every chat model from this vendor is known to meet, and it
   * must be re-verified with the same care as `models` — see `MODELS` in
   * `openai.provider.ts`.
   *
   * ⚠ OPTIONAL, AND "PRESENCE IS THE DECLARATION" (the `JobHandler` convention).
   * A provider whose model range is too wide for any honest floor simply omits
   * it, and ids it cannot otherwise resolve stay unresolvable — reported through
   * `missingModelNumbers` as they always were. That is a legitimate posture, not
   * a gap to be filled with a number somebody made up.
   */
  defaultModelLimits?: { contextWindowTokens: number; maxOutputTokens: number };
  /**
   * Whether {@link AiProvider.listModels} is implemented (#78).
   *
   * ⚠ DECLARING IT TRUE WITHOUT THE METHOD IS REFUSED AT BOOT by
   * `AiProviderRegistry.register`, the same one-line check
   * `TranscriptionProviderRegistry` makes for `capabilities.cancel` and for the
   * same argument: an advertised capability with no method is a `TypeError` in
   * the path LEAST LIKELY TO HAVE BEEN EXERCISED — here, an administrator
   * pressing "load models from the provider" on a settings page that is opened
   * once a quarter. One line at registration turns that into a boot failure
   * naming the provider, where the fix is obvious.
   *
   * `boolean` RATHER THAN THE LITERAL `true` that `streaming` uses, and the
   * difference is real: streaming is not a capability a provider may decline
   * (§5's durable buffer has nothing to append without it), whereas discovery
   * genuinely is optional. A vendor with no list endpoint, or a gateway that
   * refuses one, is a perfectly registrable provider whose admin form simply
   * falls back to typing model ids by hand.
   */
  modelDiscovery: boolean;
}

/**
 * One model a provider's LIVE API reports, as {@link AiProvider.listModels}
 * returns it (#78, widened by #97).
 *
 * ⚠ NOT AN {@link AiModelDescriptor}, AND THE DIFFERENCE IS STILL THE POINT. A
 * descriptor promises `contextWindowTokens` and `maxOutputTokens` because the
 * §3.3 token budget cannot run without them; a vendor's `GET /models` response
 * carries NEITHER for any provider this build talks to. The two facts stay
 * apart: the vendor says what EXISTS, this application says what can be
 * BUDGETED.
 *
 * WHAT #97 CHANGED. The two numbers used to be `null` for every id absent from
 * the build catalogue, because the only alternative on offer was inventing
 * them. They are now filled by the SAME resolution chain the save path and the
 * generation path use (`resolveAllowedModel`) — a family derivation, then the
 * provider's conservative floor — so they are null only when nothing at all can
 * answer. `source` says which rank answered, so a client never has to present
 * an inference as a verified number.
 *
 * ⚠ `known` IS UNCHANGED AND STILL MEANS "EXACT BUILD-CATALOGUE HIT". It is on
 * the wire and clients branch on it; redefining it to mean "resolvable" would
 * have made every model look verified. `source === 'catalogue'` is the same
 * fact stated in the new vocabulary, and the two can never disagree because
 * both are derived from one resolution.
 */
export interface AiDiscoveredModel {
  /** The provider's own model id, exactly as its API spelled it. */
  id: string;
  /** A display name. Falls back to the id when the vendor offers nothing better. */
  label: string;
  /** True when this build carries a descriptor for it and can budget against it. */
  known: boolean;
  /**
   * The effective context window: the catalogue's, the family's, or the
   * provider's floor. `null` only when this provider can answer none of those.
   */
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  /**
   * Which rank of the resolution chain supplied the numbers above (#97) — the
   * WEAKEST of the two, per {@link AiModelLimitSource}'s own rule.
   *
   * `'explicit'` is deliberately absent from this union: discovery resolves a
   * bare id with no policy entry behind it, so the administrator-override rank
   * is unreachable here by construction.
   */
  source: 'catalogue' | 'derived' | 'default';
  /**
   * The catalogue id the numbers were derived from, when `source` is
   * `'derived'`; null otherwise. Lets the dialog say WHICH model was assumed.
   */
  derivedFrom: string | null;
}

/**
 * Options for {@link AiProvider.listModels} (#97).
 *
 * ⚠ `includeAll` EXISTS BECAUSE THE CHAT-MODEL FILTER MUST NEVER BE THE THING
 * THAT MAKES A MODEL UNREACHABLE. The filter is a convenience over a flat
 * vendor list with no capability field (see `NON_CHAT_MODEL_MARKERS` in
 * `openai.provider.ts`), and a heuristic over ids a vendor invents on its own
 * schedule will eventually be wrong. Before this flag the only escape was
 * typing the id by hand, which is exactly the "you must know the answer to ask
 * the question" state #97 removes everywhere else; now the dialog can offer
 * "show every model the provider listed" and the filter costs nothing when it
 * is wrong.
 */
export interface AiListModelsOptions {
  /** Skip the plausible-chat-model filter and return the vendor's whole list. */
  includeAll?: boolean;
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
  /**
   * How hard a reasoning model may think before it answers (#87).
   *
   * Read from `ai.reasoningEffort`. OPTIONAL, AND SAFE TO IGNORE — a provider
   * whose vendor has no such notion simply drops it, which is why this is a
   * request field rather than a method on {@link AiProvider}: a capability
   * every implementation must declare an opinion about is a capability the next
   * provider has to write a line of code to say "no" to.
   *
   * ⚠ WHATEVER A PROVIDER DOES WITH IT, IT MUST NOT CHANGE
   * {@link AiGenerateRequest.maxOutputTokens}. Reasoning tokens are billed and
   * counted as output and come out of that same ceiling — so a provider that
   * "helpfully" raised the ceiling to make room for thinking would be spending
   * a user's own money on a decision the deployment's policy did not take. See
   * `ai.reasoningEffort` in `../ai-settings.schema.ts`.
   */
  reasoningEffort?: AiReasoningEffort;
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
   * Ask the provider's own API which models this credential can reach (#78).
   *
   * OPTIONAL, AND PRESENT EXACTLY WHEN `capabilities.modelDiscovery` IS TRUE —
   * "presence is the declaration", the same rule `JobHandler`'s
   * `nodeResultSchema`/`persistNodeResult` pair follows, except that here one
   * of the two halves is a boolean a caller reads before spending a request, so
   * the registry enforces the agreement at boot instead of the type system
   * doing it. Implement both or neither.
   *
   * ⚠ IT SPENDS A REAL VENDOR CALL ON THE CALLER'S OWN ACCOUNT. `ctx.apiKey` is
   * an individual person's key — there is no deployment key in this epic — so
   * the route above this is gated on `system_settings:write` rather than
   * `:read` for the same reason `POST /api/ai-settings/test` is: looking is not
   * probing.
   *
   * THROWS on refusal, unlike `testConnection`. This method has an answer to
   * give (a list) and no way to give a partial one, so the caller — not the
   * provider — decides whether a refusal is a 200 diagnosis or a failure; see
   * `AiSettingsService.discoverModels`, which turns a throw into
   * `{ ok: false, detail, models: [] }`. Throw the narrowest type in
   * `../ai-errors.ts` that is true, exactly as `generate` does.
   *
   * ⚠ IT MUST FILL `contextWindowTokens`/`maxOutputTokens`/`source` THROUGH
   * `resolveAllowedModel` (#97), never with a second copy of the precedence
   * written here. A provider that resolved discovery differently from the way
   * the settings save and the token budget resolve would show an administrator
   * a number in the dialog and use a different one an hour later, with nothing
   * anywhere to explain the difference.
   */
  listModels?(
    ctx: AiProviderContext<TSettings>,
    opts?: AiListModelsOptions,
  ): Promise<AiDiscoveredModel[]>;

  /**
   * Place a model id this build has no descriptor for in a KNOWN FAMILY (#97).
   *
   * OPTIONAL, AND "PRESENCE IS THE DECLARATION" — the same convention
   * `capabilities.defaultModelLimits` and `JobHandler.nodeResultSchema` follow.
   * A provider that cannot tell families apart from ids simply omits it, and
   * resolution falls straight through to the floor.
   *
   * ⚠ THE RETURNED DESCRIPTOR DESCRIBES THE FAMILY, NOT THE REQUESTED MODEL.
   * Its `id` is the CATALOGUE id the numbers came from — that is what becomes
   * `AiResolvedModel.derivedFrom` and what lets a client say which model was
   * assumed — and its `label` must be the RAW REQUESTED ID, never the family's
   * human name: printing "GPT-5.4 mini" beside `gpt-5.4-mini-2026-03-17` claims
   * a descriptor this build does not have. Return `null` when nothing matches,
   * so the floor applies.
   *
   * ⚠ RETURN THE FAMILY'S FULL NUMBERS, NOT REDUCED ONES. A dated snapshot of
   * `gpt-5.4-mini` has that model's whole window; shaving it "to be safe" would
   * refuse prompts that fit and would quietly undo the performance point of
   * deriving at all.
   *
   * SYNCHRONOUS AND PURE, for exactly the reason {@link AiProvider.countTokens}
   * is: it runs inside the §3.3 budget check in `POST /api/notes`'s own request
   * handler and inside a queue job, so a network call or a read of mutable
   * state here would put a round trip in front of every note creation and let
   * the request-time and job-time answers disagree for reasons that have
   * nothing to do with the model.
   */
  deriveModelDescriptor?(id: string): AiModelDescriptor | null;

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
