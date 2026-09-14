/**
 * The AI API, as the web app sees it — issue #55, epic #45.
 *
 * Shaped after `services/transcription.ts`: `services/api.ts` stays the
 * transport (the `ApiService` instance, the refresh dance, the maintenance
 * recogniser), and this module holds the calls next to the types they produce.
 *
 * THREE CONTROLLERS, ONE MODULE, because they are one feature from the client's
 * point of view and splitting them would make the "which of these three answers
 * `keyConfigured`?" question harder rather than easier:
 *
 *   `/api/ai/config`       the capability probe every AI surface gates on
 *   `/api/ai-credentials`  the CALLER'S OWN key — theirs, billed to them
 *   `/api/ai-settings`     the deployment's POLICY — admin only, no key
 *
 * =============================================================================
 * THE KEY TRAVELS ONE WAY, AND ONLY ONE
 * =============================================================================
 *
 * `apiKey` exists on exactly two REQUEST types below (`SaveAiCredentialInput`,
 * `TestAiCredentialInput`) and on NO response type. The API never returns key
 * material — `AiCredentialStatus.hint` is a mask such as `••••a1b2`, derived on
 * write by code that already held the plaintext — and nothing in this module,
 * or in any component built on it, should ever grow a field that could hold the
 * real value.
 *
 * BLANK PRESERVES. Omitting `apiKey` (or sending it empty) on a save keeps the
 * stored key: the form renders that box empty because the value is unreadable
 * by design, so an empty submission cannot be allowed to mean "erase it".
 * Erasing is `removeAiCredential`, from a distinct control.
 *
 * =============================================================================
 * THERE IS NO DEPLOYMENT KEY, SO THE ADMIN TYPES HAVE NOWHERE TO PUT ONE
 * =============================================================================
 *
 * Unlike `TranscriptionSettingsAdminView`, `AiSettingsAdminView` carries no
 * `keyStatuses` array and `UpdateAiSettingsInput` carries no write-only
 * `apiKey`. That is the API's own shape (`apps/api/src/ai/ai-settings.schema.ts`
 * carries a compile-time proof of it), and it is the whole reason the admin page
 * has no key field: every AI key in this application belongs to an individual
 * user and is billed to them.
 *
 * =============================================================================
 * #78 WIDENED THE MODEL POLICY, AND ADDED THE ONE EXCEPTION TO THE RULE ABOVE
 * =============================================================================
 *
 * `allowedModels` used to be `string[]`, resolved against a four-entry
 * catalogue compiled into the API — so the deployment's model policy was a
 * SUBSET of an array shipped in a release, and adopting a model the vendor
 * shipped last week required one. Since #78 an entry may carry its own context
 * window and output ceiling ({@link AiAllowedModel}), and
 * {@link discoverAiModels} asks the vendor what actually exists.
 *
 * ⚠ THAT ONE CALL IS THE ONLY PLACE IN THIS MODULE WHERE A KEY IS SPENT
 * WITHOUT APPEARING IN A TYPE. `GET /api/ai-settings/models` has no request
 * body at all; the API authenticates it with the CALLING ADMINISTRATOR'S own
 * stored key, because there is no deployment key to use. So the one-way rule
 * above still holds — no key travels through this module — but the COST does:
 * the call bills a real request to the person who clicked it, which is why it
 * hangs off an explicit button and never off a mount effect, and why a caller
 * with no key of their own gets a 409 rather than an empty list.
 */

import { api, ApiError } from './api';

// =============================================================================
// GET /api/ai/config — the capability probe
// =============================================================================

/**
 * Where a model's two token numbers came from (#97).
 *
 * ⚠ THIS IS THE FIELD THAT REPLACED "THE ADMINISTRATOR TYPES THEM". Until #97 a
 * model the build catalogue did not carry had `null` for both numbers and could
 * not be permitted until somebody looked them up in the vendor's documentation
 * and typed them — per model, for every dated snapshot the vendor ships. The API
 * now always resolves a pair, and this says how honestly it knows them:
 *
 *   `'catalogue'`  an exact hit in the build catalogue. The numbers are the ones
 *                  this release was written against.
 *   `'derived'`    a dated snapshot (`gpt-5.4-mini-2026-03-17`) resolved to its
 *                  family's real limits. `derivedFrom` names the catalogue id
 *                  the numbers were taken from, so the inference is auditable
 *                  rather than magic.
 *   `'default'`    nothing matched, so a deliberately CONSERVATIVE floor was
 *                  applied. The model is fully usable; the only consequence of
 *                  the floor being lower than the vendor's real window is that a
 *                  very large source is refused by docs/specs/notes.md §3.3's
 *                  budget with a message naming the numbers. An administrator
 *                  who knows better overrides it.
 *
 * ⚠ THERE IS NO `'custom'` MEMBER, AND THERE MUST NOT BE ONE. An administrator's
 * own override is not something the server infers — it is the entry's own
 * `contextWindowTokens`/`maxOutputTokens`, which the client can see directly.
 * Adding a fourth member would create two spellings of "the admin typed it" that
 * could disagree, and only one of them would be checked.
 */
export type AiModelLimitSource = 'catalogue' | 'derived' | 'default';

/** One model this deployment permits, already narrowed by its own token policy. */
export interface AiConfigModel {
  id: string;
  label: string;
  /** The model's own context window, already narrowed by deployment policy. */
  contextWindowTokens: number;
  /** The model's own output ceiling, already narrowed by deployment policy. */
  maxOutputTokens: number;
  /** How the two numbers above were arrived at (#97). See {@link AiModelLimitSource}. */
  source: AiModelLimitSource;
  /** The catalogue id the numbers were taken from when `source` is `'derived'`. */
  derivedFrom: string | null;
}

/**
 * `GET /api/ai/config` — readable by any account holding `notes:read`, which is
 * seeded to all three roles.
 *
 * ⚠ `keyConfigured` IS THE SINGLE BOOLEAN EVERY AI SURFACE IN EPIC #45 GATES
 * ON. It describes the CALLER, not the deployment, and it is deliberately
 * independent of `available`: a user can save and verify a key before an
 * administrator finishes enabling the feature, and an enabled deployment still
 * does nothing for a user who has no key. Folding the two together would leave
 * the UI unable to tell "your administrator has not turned this on" from "you
 * have not pasted a key" — two different sentences with two different fixes.
 */
export interface AiConfig {
  available: boolean;
  provider: string | null;
  /** Human name of the active provider, for the "this is sent to …" disclosure. */
  providerLabel: string | null;
  models: AiConfigModel[];
  defaultModel: string | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Whether **the calling user** has saved a key for the active provider. */
  keyConfigured: boolean;
}

// =============================================================================
// /api/ai-credentials — the caller's own key
// =============================================================================

/**
 * The masked view of one stored key.
 *
 * ⚠ EVERY FIELD IS NON-SECRET BY CONSTRUCTION. There is no field here able to
 * hold the key, and the API's presentation query does not select the ciphertext
 * column at all.
 */
export interface AiCredentialStatus {
  provider: string;
  configured: boolean;
  /** A mask such as `••••a1b2`, or `null` when nothing is stored. NEVER the key. */
  hint: string | null;
  /** The user's own non-secret note for this key. */
  label: string | null;
  lastUsedAt: string | null;
  updatedAt: string | null;
}

/** `GET /api/ai-credentials` — every key the caller has stored, masked. */
export interface AiCredentialList {
  credentials: AiCredentialStatus[];
}

/** `PUT /api/ai-credentials` — save or replace the CALLER'S OWN key. */
export interface SaveAiCredentialInput {
  provider: string;
  /**
   * WRITE-ONLY. Omit or send empty to keep the stored key. There is no way to
   * erase a key through this call — see `removeAiCredential`.
   */
  apiKey?: string | null;
  /** An optional, non-secret note. `null` clears it; absent leaves it alone. */
  label?: string | null;
}

/**
 * `POST /api/ai-credentials/test` — the probe body.
 *
 * `apiKey` IS OPTIONAL AND THAT IS THE POINT: proving a key BEFORE saving it is
 * the one workflow that turns a mistyped key into a ten-second problem instead
 * of a failed generation twenty minutes later. Absent falls back to the stored
 * key, which is how "is the key I saved last month still valid?" is asked.
 */
export interface TestAiCredentialInput {
  provider: string;
  /** The key to probe. **Does not need to have been saved** — that is the point. */
  apiKey?: string | null;
}

/** The outcome of a probe. `ok: false` arrives as a **200**, not an exception. */
export interface AiConnectionTest {
  ok: boolean;
  latencyMs: number;
  /** A specific, actionable sentence — which of three different fixes applies. */
  detail: string;
}

// =============================================================================
// /api/ai-settings — the deployment's policy (admin)
// =============================================================================

/** One model a provider offers, as the admin catalogue publishes it. */
export interface AiModelDescriptor {
  id: string;
  label: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface AiProviderCapabilities {
  models: AiModelDescriptor[];
  /** Always true — every registered provider streams. */
  streaming: true;
  /**
   * Whether this provider implements `GET /api/ai-settings/models` (#78).
   *
   * ⚠ THIS IS THE ONLY THING THE ADMIN PAGE MAY GATE THE "LOAD MODELS" BUTTON
   * ON. It is `boolean`, not the literal `true` that `streaming` is, and the
   * difference is real rather than stylistic: streaming is not a capability a
   * provider may decline (§5's durable buffer has nothing to append without
   * it), whereas discovery genuinely is optional — a vendor with no list
   * endpoint, or a gateway that refuses one, is a perfectly registrable
   * provider whose admin form simply falls back to typing model ids by hand.
   *
   * The API refuses at boot to register a provider that declares this `true`
   * with no `listModels`, so a client may trust it without a second check.
   */
  modelDiscovery: boolean;
}

/** One admin-form field a provider needs — the API describes its own form. */
export interface AiProviderFieldDescriptor {
  key: string;
  label: string;
  type: 'text' | 'select' | 'number' | 'boolean' | 'string-list';
  options?: Array<{ value: string; label: string }>;
  helpText?: string;
  required: boolean;
  defaultValue?: string | number | boolean | string[] | null;
}

export interface AiProviderDescription {
  id: string;
  label: string;
  capabilities: AiProviderCapabilities;
  fieldDescriptors: AiProviderFieldDescriptor[];
}

/**
 * Providers this build can be configured to use.
 *
 * Mirrors `AI_PROVIDER_IDS` in `ai-settings.schema.ts`. A UNION RATHER THAN
 * `string` because it is a `z.enum` on the wire: the page's provider `Select`
 * writes straight into `UpdateAiSettingsInput.provider`, and a widened type
 * there would let a typo compile into a 400 nobody discovers until save.
 */
export type AiProviderId = 'openai';

/**
 * One entry of a provider's `allowedModels` list (#78).
 *
 * ⚠ ALWAYS AN OBJECT ON THE WAY BACK, EVEN THOUGH A BARE STRING IS ACCEPTED ON
 * THE WAY IN. `aiAllowedModelEntrySchema` is a union with a normalising
 * transform, so a legacy stored `"gpt-4o"` reads back as `{ id: 'gpt-4o' }`
 * with the three optional fields simply absent. That is why this client type is
 * NOT a union: every consumer here sees objects only, and the one place the
 * string form could still matter — a request body — is served by sending
 * objects unconditionally. A `typeof entry === 'string'` branch anywhere in
 * `apps/web` would be dead code that looks load-bearing.
 *
 * ⚠ THE TWO NUMBERS OVERRIDE WHATEVER THE API RESOLVED, they do not supplement
 * it — and since #97 they are the ONLY reason to send either. `resolveAllowedModel`
 * (`apps/api/src/ai/ai-model-resolution.ts`) takes the entry's own number first,
 * then an exact catalogue descriptor, then a dated-snapshot match against the
 * catalogue, then a conservative floor. That last step is what removed the
 * "unresolvable model" state this type used to have to protect against: a bare
 * `{ id }` now always resolves, so an entry carrying neither number is a normal,
 * complete, offerable policy entry rather than a half-finished one.
 *
 * ⚠ SO BOTH NUMBERS ARE OPTIONAL IN THE SAME BREATH OR NEITHER IS. A half-filled
 * pair is still not useful — the §3.3 budget subtracts the output allowance from
 * the window — but the missing half now falls back to the resolved value rather
 * than to nothing, so a lone override is merely partial, not fatal. What the
 * editor must NOT do any more is demand either one: that demand was issue #97.
 *
 * ⚠ NO SECRET-BEARING FIELD MAY BE ADDED HERE. A per-model `apiKey` ("this one
 * model is on a different account") is the deployment-wide fallback credential
 * docs/specs/notes.md §9 rejected, one level deeper; `ai-settings.schema.ts`
 * carries a compile-time proof against it and this type must not drift past it.
 */
export interface AiAllowedModel {
  /** The provider's own model id. The only required field. */
  id: string;
  /** What a model picker shows. Falls back to the catalogue's label, then the id. */
  label?: string;
  /** Total context window, in tokens. 1,024–10,000,000 — see {@link AI_MODEL_BOUNDS}. */
  contextWindowTokens?: number;
  /** Most tokens one completion may produce. 64–1,000,000. */
  maxOutputTokens?: number;
}

/**
 * A permitted-model entry **as the API hands it back** (#97).
 *
 * ⚠ A SEPARATE TYPE FROM {@link AiAllowedModel} ON PURPOSE, AND THE DIRECTION IS
 * THE WHOLE POINT: `source` and `derivedFrom` travel one way only. They describe
 * what the API RESOLVED for this entry — they are not policy, nothing accepts
 * them on a write, and echoing them back on the next `PUT` would be sending the
 * server its own inference as though an administrator had chosen it. Keeping the
 * read shape structurally assignable to the write shape (it merely adds fields)
 * is what lets the page load into `AiAllowedModel`-shaped drafts without a cast,
 * while `toAllowedModels` still builds the request from the four fields above
 * and nothing else.
 *
 * ⚠ THE TWO NUMBERS HERE REMAIN THE **STORED OVERRIDE**, not the resolved pair.
 * Absent means "no override" — which is now the ordinary state, since the API
 * resolves a pair for every id. A client must therefore never seed an override
 * field from a resolved number it obtained elsewhere: doing so would freeze
 * today's inference into the saved policy and quietly outlive the release that
 * corrects it. `GET /api/ai/config` is where the RESOLVED pair is published
 * ({@link AiConfigModel}), because that is the surface that has to budget.
 */
export interface AiAllowedModelView extends AiAllowedModel {
  /** How the API resolved this entry's limits (#97). Absent on an older API. */
  source?: AiModelLimitSource;
  /** The catalogue id the numbers came from when `source` is `'derived'`. */
  derivedFrom?: string | null;
}

/**
 * Bounds on the two per-model numbers, mirrored from `aiAllowedModelSchema`.
 *
 * HERE RATHER THAN IN THE PAGE because both the permitted-model rows and the
 * discovery dialog collect the same two numbers, and two copies of a bound is
 * how one of them quietly stops matching the API. Validating client-side
 * PREVENTS a 400 rather than reporting one — the schema still enforces it, so
 * this is a courtesy, never the guarantee.
 */
export const AI_MODEL_BOUNDS = {
  contextWindowTokens: { min: 1_024, max: 10_000_000 },
  maxOutputTokens: { min: 64, max: 1_000_000 },
} as const;

/** Most entries `allowedModels` accepts — `z.array(...).max(50)`. */
export const AI_ALLOWED_MODELS_MAX = 50;

/**
 * How hard a reasoning-capable model is asked to think before it answers (#87).
 *
 * Mirrors the API's `z.enum`, and a union here for the same reason `AiProviderId`
 * is one: the admin page's `Select` writes straight into
 * {@link UpdateAiSettingsInput}, so a typo should be a compile error rather than
 * a 400 discovered on save.
 *
 * ⚠ `'none'` IS A VALUE, NOT AN ABSENCE. It is the stored default, and it means
 * the API omits `reasoning_effort` from the provider request entirely — so the
 * vendor applies its own default. There is deliberately no `null` here: "send
 * nothing" already has a spelling, and two ways to say it is how one of them
 * stops being handled.
 *
 * ⚠ THE COST OF RAISING THIS LANDS ON `maxOutputTokens`, NOT ON A BUDGET OF ITS
 * OWN. Reasoning tokens are billed and counted as OUTPUT tokens, drawn from the
 * same completion ceiling the visible answer is drawn from — which is why the
 * admin control for this field sits in the Limits section beside
 * {@link AiSettings.maxOutputTokens} rather than beside the provider choice, and
 * why its helper text names that field explicitly. A generation that spends its
 * whole ceiling thinking comes back truncated, not as an error.
 */
export type AiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * The stored AI policy.
 *
 * ⚠ NO FIELD HERE CAN HOLD AN API KEY, and that is the API's shape rather than
 * this module's editorial choice — see the file header.
 */
export interface AiSettings {
  enabled: boolean;
  /**
   * The active provider, or `null` when none has been chosen (#78).
   *
   * ⚠ AN AXIS SEPARATE FROM `enabled`, field for field with
   * `TranscriptionSettings.provider` and for its reason: an administrator can
   * switch AI off for an incident without losing the vendor choice, and can
   * switch vendors without touching the master switch. `null` is a PERSISTED
   * FACT ("nobody has chosen one"), not an absent key — which is why the page's
   * `Select` carries an explicit "None" option rather than an empty value that
   * would be indistinguishable from "not loaded yet".
   */
  provider: AiProviderId | null;
  providers: {
    openai: {
      baseUrl: string;
      /** Normalised to objects on read, whatever was stored. See {@link AiAllowedModelView}. */
      allowedModels: AiAllowedModelView[];
      defaultModel: string;
    };
  };
  maxInputTokens: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  /** Ceiling on one uploaded note source document, in bytes. An AI policy, not a storage one. */
  maxDocumentBytes: number;
  /**
   * How hard a reasoning-capable model thinks before answering (#87).
   *
   * Defaults to `'none'`, which omits the parameter from the provider request.
   * See {@link AiReasoningEffort} for why raising it is a change to the output
   * budget rather than a free quality dial.
   */
  reasoningEffort: AiReasoningEffort;
}

/** `GET /api/ai-settings`, and the body every write returns. */
export interface AiSettingsAdminView {
  settings: AiSettings;
  /** Every registered provider, with its models and form fields. */
  providers: AiProviderDescription[];
  /**
   * Model ids the policy permits that this deployment cannot budget for.
   *
   * ⚠ SINCE #97 THIS IS ALMOST ALWAYS EMPTY, AND A NON-EMPTY VALUE MEANS
   * SOMETHING DIFFERENT THAN IT USED TO. #78 made it "unresolvable" rather than
   * "absent from the build catalogue"; #97 then gave the API a resolution path
   * that always terminates — exact catalogue hit, dated-snapshot match, or a
   * conservative floor — so an ordinary entry can no longer land here however
   * exotic its id is. What remains is the case where there is no provider to
   * resolve AGAINST at all: no vendor is registered or active, so there is no
   * catalogue to match and no floor to apply.
   *
   * ⚠ THE FIELD IS KEPT RATHER THAN REMOVED, and so is the page's block for it:
   * it is the API's own answer to "why is this permitted model never offered?",
   * and a client that stopped rendering it would leave that question with no
   * answer anywhere. What had to change is the SENTENCE — telling an
   * administrator that "this build does not know these models" is now simply
   * untrue, and sends them to look up numbers that would not help.
   */
  unknownModels: string[];
  /** Bumped on every write. Pass back as `If-Match` on the next PUT. */
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/** `PUT /api/ai-settings` — a partial update. One level deep, like the API's PATCH schema. */
export interface UpdateAiSettingsInput {
  enabled?: boolean;
  /**
   * ⚠ `null` IS A VALUE HERE, NOT AN ABSENCE. `provider: null` means "no vendor
   * is active"; omitting the key means "leave the stored vendor alone". The
   * API's merge tells the two apart with `!== undefined` rather than `??`
   * precisely so the first is not silently the second — so a client that sent
   * `undefined` meaning "clear it" would find the change quietly discarded.
   */
  provider?: AiProviderId | null;
  providers?: {
    openai?: {
      baseUrl?: string;
      /**
       * REPLACES wholesale — a merging list could never express "stop
       * permitting this model".
       *
       * The API also accepts a bare id per entry, for ever, because every
       * deployment that saved a policy before #78 has bare strings stored.
       * ⚠ THIS CLIENT NEVERTHELESS ALWAYS SENDS OBJECTS: the string form exists
       * so old *stored* data stays readable, not as a shorthand worth using,
       * and a client that mixed the two would drop the numbers an administrator
       * typed for exactly the models that need them.
       */
      allowedModels?: AiAllowedModel[];
      defaultModel?: string;
    };
  };
  maxInputTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  maxDocumentBytes?: number;
  reasoningEffort?: AiReasoningEffort;
}

/** `POST /api/ai-settings/test` — probe a base URL, with no credential. */
export interface TestAiReachabilityInput {
  /** A URL to probe instead of the stored one, for proving one before saving it. */
  baseUrl?: string | null;
}

/**
 * The outcome of the reachability probe.
 *
 * ⚠ A 401/403 FROM THE PROVIDER COUNTS AS `ok: true`. An unauthenticated
 * request to a working API root is supposed to be refused, and that refusal is
 * what proves the endpoint exists and speaks the protocol.
 */
export interface AiReachabilityTest {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

// =============================================================================
// GET /api/ai-settings/models — live model discovery (#78)
// =============================================================================

/**
 * One model the provider's own API reported.
 *
 * ⚠ NOT AN {@link AiModelDescriptor}, AND THE DIFFERENCE IS THE POINT. A
 * descriptor PROMISES both numbers because the §3.3 token budget cannot run
 * without them; a vendor's `GET /models` response carries NEITHER for any
 * provider this build talks to. So the vendor says what EXISTS and the API says
 * what can be BUDGETED — but since #97 it always has an answer for the second
 * question, and {@link source} is how good that answer is.
 *
 * ⚠ `known` NO LONGER DECIDES WHETHER A MODEL CAN BE PERMITTED. It narrowed to
 * exactly what its name says: an EXACT build-catalogue hit. It is not the same
 * question as "does this have usable numbers" any more — a dated snapshot is
 * `known: false`, `source: 'derived'` and carries its family's real limits — so
 * a client branching on `known` to demand input from an administrator is
 * implementing issue #97's bug. Branch on {@link source} to describe where the
 * numbers came from; never to gate the permit.
 *
 * ⚠ BOTH NUMBERS ARE `number | null` FOR THE SHAPE'S SAKE, NOT BECAUSE THEY GO
 * MISSING. The API populates them for every model it returns; `null` survives in
 * the type as the one honest reading of a future provider whose resolution ever
 * declines to answer, and a client must render such a row without numbers rather
 * than printing `null` or inventing a zero.
 */
export interface AiDiscoveredModel {
  /** The provider's own model id, exactly as its API spelled it. */
  id: string;
  /** A display name. Falls back to the id — never a prettified guess. */
  label: string;
  /** An EXACT build-catalogue hit. Descriptive only — see the type's header. */
  known: boolean;
  /** The resolved context window. Essentially always populated since #97. */
  contextWindowTokens: number | null;
  /** The resolved output ceiling. Essentially always populated since #97. */
  maxOutputTokens: number | null;
  /** How the two numbers above were arrived at. See {@link AiModelLimitSource}. */
  source: AiModelLimitSource;
  /** The catalogue id the numbers were taken from when `source` is `'derived'`. */
  derivedFrom: string | null;
}

/**
 * What `GET /api/ai-settings/models` answers.
 *
 * ⚠ `ok: false` ARRIVES AS A **200**, not an exception — the same convention
 * `testAiCredential` and `testAiReachability` follow. A vendor refusing a key
 * is a SUCCESSFUL DIAGNOSIS, and `detail` is the whole value of the call: it
 * distinguishes "the key is wrong", "the account has no credit" and "the
 * endpoint is unreachable", three fixes that look identical from a failed
 * generation an hour later. Show it verbatim either way.
 *
 * `models` is EMPTY whenever `ok` is false — never partial, so a client need
 * not decide whether a short list is a truncation.
 */
export interface AiModelDiscovery {
  ok: boolean;
  detail: string;
  /** Known models first, then alphabetically. Empty when `ok` is false. */
  models: AiDiscoveredModel[];
}

/**
 * The machine-readable `details.reason` a discovery 409 carries.
 *
 * One member today, and a union anyway so a future reason is a compile error at
 * every `switch` rather than a silently unhandled string.
 */
export type AiDiscoveryConflictReason = 'ai_key_missing';

/**
 * Read the reason out of a discovery 409 — the ONE place this client does.
 *
 * ⚠ THE REASON IS NESTED UNDER `details`, NOT A TOP-LEVEL `code`. The API's
 * global exception filter DERIVES `code` from the HTTP status and overwrites
 * whatever an exception supplied, so `err.code` here is `CONFLICT` and carries
 * no information. A page reading `err.code === 'ai_key_missing'` would compile,
 * never match, and silently degrade the one 409 with a specific fix into a
 * generic red box. Modelled on `noteConflictReason` in `services/notes.ts`,
 * which exists for the identical reason.
 */
export function aiDiscoveryConflictReason(
  err: unknown,
): AiDiscoveryConflictReason | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;

  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;

  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? (reason as AiDiscoveryConflictReason) : null;
}

// =============================================================================
// Calls
// =============================================================================

const CREDENTIALS_BASE = '/ai-credentials';
const SETTINGS_BASE = '/ai-settings';

/** `GET /api/ai/config` — `notes:read`, seeded to every role. */
export async function getAiConfig(): Promise<AiConfig> {
  return api.get<AiConfig>('/ai/config');
}

/** `GET /api/ai-credentials` — the caller's own keys, masked. Never a secret. */
export async function getAiCredentials(): Promise<AiCredentialList> {
  return api.get<AiCredentialList>(CREDENTIALS_BASE);
}

/**
 * `PUT /api/ai-credentials` — save or replace the caller's own key.
 *
 * Blank or omitted `apiKey` PRESERVES the stored key; it never erases one.
 */
export async function saveAiCredential(
  input: SaveAiCredentialInput,
): Promise<AiCredentialStatus> {
  return api.put<AiCredentialStatus>(CREDENTIALS_BASE, input);
}

/**
 * `POST /api/ai-credentials/test`.
 *
 * ⚠ RESOLVES ON A REFUSED PROBE. The endpoint answers **200** with
 * `{ ok: false, detail }` when the provider refuses the key — that is the
 * interesting case and it is NOT an exception. It rejects only when the call
 * itself fails (a 400, a 403, a dropped connection).
 */
export async function testAiCredential(
  input: TestAiCredentialInput,
): Promise<AiConnectionTest> {
  return api.post<AiConnectionTest>(`${CREDENTIALS_BASE}/test`, input);
}

/**
 * `DELETE /api/ai-credentials/{provider}` — the ONLY way to erase a key.
 *
 * Idempotent: removing a key that is not there succeeds, because the goal is
 * "there is no key here" and a double-clicked button should not error.
 */
export async function removeAiCredential(provider: string): Promise<void> {
  await api.delete<void>(`${CREDENTIALS_BASE}/${encodeURIComponent(provider)}`);
}

/** `GET /api/ai-settings` — `system_settings:read`. */
export async function getAiSettings(): Promise<AiSettingsAdminView> {
  return api.get<AiSettingsAdminView>(SETTINGS_BASE);
}

/**
 * `PUT /api/ai-settings` — `system_settings:write`.
 *
 * `expectedVersion` is passed through as-is, INCLUDING `0`: the check is on
 * `undefined`, never a truthiness test, so the very first save on a fresh
 * deployment is still guarded rather than being the one unprotected write.
 */
export async function updateAiSettings(
  input: UpdateAiSettingsInput,
  expectedVersion?: number,
): Promise<AiSettingsAdminView> {
  return api.put<AiSettingsAdminView>(SETTINGS_BASE, input, {
    headers:
      expectedVersion === undefined
        ? undefined
        : { 'If-Match': String(expectedVersion) },
  });
}

/**
 * `GET /api/ai-settings/models` — `system_settings:write`, not `:read` (#78).
 *
 * ⚠ THIS SPENDS A REAL VENDOR CALL ON THE CALLING ADMINISTRATOR'S OWN API KEY.
 * This deployment stores no AI key of any kind, so discovery has to
 * authenticate as somebody, and the only somebody available is the person
 * clicking the button. That is also why the route is gated on write: looking at
 * settings is not probing a third party. It is not a call to make on mount —
 * every invocation costs the administrator a request against their own account
 * — so it is wired to an explicit button and never to an effect.
 *
 * ⚠ RESOLVES ON A REFUSED PROBE, like every other `/test`-shaped call in this
 * module: read {@link AiModelDiscovery.ok} and render `detail` either way. It
 * REJECTS for the two real failures, which need different sentences:
 *   • **400** — no provider is active and none was named, the named provider is
 *     not implemented by this build, or it cannot list models at all;
 *   • **409** — *the caller* has saved no key. {@link aiDiscoveryConflictReason}
 *     is how that is told apart from a generic conflict, and it must be, since
 *     the fix is on a different page.
 *
 * `provider` defaults to the ACTIVE one. Naming a different one lets an
 * administrator inspect a catalogue BEFORE switching to it — the same "prove
 * what you typed, not what you committed" workflow the `baseUrl` override on
 * `testAiReachability` serves.
 *
 * ⚠ `includeAll` SKIPS A HEURISTIC, WHICH IS WHY IT EXISTS (#97). Without it the
 * API filters the vendor's list to what LOOKS like a chat model, and a heuristic
 * is exactly the kind of thing that is right for two years and then quietly
 * wrong about the model somebody needs on a Tuesday. With it, the answer is
 * every id the provider listed — embeddings, speech, image and moderation
 * models included, none of which can generate a note. So it is an opt-in escape
 * hatch presented as one, never the default: a list where most rows cannot
 * possibly work is a worse first answer than a filtered one.
 */
export async function discoverAiModels(
  provider?: string | null,
  includeAll?: boolean,
): Promise<AiModelDiscovery> {
  // Built with `URLSearchParams` rather than a template literal so an id
  // carrying a `&` or a space cannot split the query string. Each key is
  // omitted entirely when it has nothing to say: `?provider=` with an empty
  // value is a `min(1)` violation and a 400, where "use the active provider" is
  // what was meant, and `?includeAll=false` is the default spelled out for no
  // reason.
  const params = new URLSearchParams();
  if (provider) params.set('provider', provider);
  if (includeAll) params.set('includeAll', 'true');
  const query = params.toString();

  return api.get<AiModelDiscovery>(
    `${SETTINGS_BASE}/models${query ? `?${query}` : ''}`,
  );
}

/**
 * `POST /api/ai-settings/test` — `system_settings:write`.
 *
 * Same 200-on-failure contract as `testAiCredential`, and carries no credential
 * at all: there is no deployment key to probe with.
 */
export async function testAiReachability(
  input: TestAiReachabilityInput,
): Promise<AiReachabilityTest> {
  return api.post<AiReachabilityTest>(`${SETTINGS_BASE}/test`, input);
}
