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
 */

import { api } from './api';

// =============================================================================
// GET /api/ai/config — the capability probe
// =============================================================================

/** One model this deployment permits, already narrowed by its own token policy. */
export interface AiConfigModel {
  id: string;
  label: string;
  /** The model's own context window, already narrowed by deployment policy. */
  contextWindowTokens: number;
  /** The model's own output ceiling, already narrowed by deployment policy. */
  maxOutputTokens: number;
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
 * The stored AI policy.
 *
 * ⚠ NO FIELD HERE CAN HOLD AN API KEY, and that is the API's shape rather than
 * this module's editorial choice — see the file header.
 */
export interface AiSettings {
  enabled: boolean;
  providers: {
    openai: {
      baseUrl: string;
      allowedModels: string[];
      defaultModel: string;
    };
  };
  maxInputTokens: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  /** Ceiling on one uploaded note source document, in bytes. An AI policy, not a storage one. */
  maxDocumentBytes: number;
}

/** `GET /api/ai-settings`, and the body every write returns. */
export interface AiSettingsAdminView {
  settings: AiSettings;
  /** Every registered provider, with its models and form fields. */
  providers: AiProviderDescription[];
  /**
   * Model ids the policy permits that no registered provider declares.
   * Reported rather than silently dropped: such a model can never be offered,
   * and an administrator who mistyped one would otherwise have nothing to
   * explain why it disappeared.
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
  providers?: {
    openai?: {
      baseUrl?: string;
      /** REPLACES wholesale — a merging list could never express "stop permitting this model". */
      allowedModels?: string[];
      defaultModel?: string;
    };
  };
  maxInputTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  maxDocumentBytes?: number;
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
