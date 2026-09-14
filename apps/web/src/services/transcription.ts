/**
 * The transcription admin API, as the web app sees it.
 *
 * Issue #23, epic #19 — see the parallel backend work in
 * `apps/api/src/transcription/`. Shaped after `services/pushConfig.ts`:
 * `services/api.ts` stays the transport (the `ApiService` instance, the
 * refresh dance, the maintenance recogniser), and this module holds the five
 * calls next to the types they produce.
 *
 * =============================================================================
 * THE API KEY IS NEVER ON THE WIRE IN THE RESPONSE DIRECTION
 * =============================================================================
 *
 * No endpoint below ever returns key material — only `ProviderKeyStatus`, a
 * masked hint mirroring `PrivateKeyStatus` and `SmtpPasswordStatus`. Nothing in
 * this module, or in any component built on it, should ever grow a field that
 * could hold the real key.
 *
 * `apiKey` travels ONE WAY: into `updateTranscriptionSettings` and
 * `testTranscriptionConnection`, and nowhere else.
 *
 * =============================================================================
 * BLANK PRESERVES
 * =============================================================================
 *
 * Omitting `apiKey` (or sending it empty) on a save keeps the stored key — the
 * form renders that box empty because the value is unreadable by design, so an
 * empty submission cannot be allowed to mean "erase it". Erasing is
 * `removeTranscriptionCredential`, from a distinct control.
 */

import { api } from './api';

/** A provider this build can be configured to use. */
export type TranscriptionProviderId = 'assemblyai';

export type AssemblyAiRegion = 'us' | 'eu';

export type AudioDeliveryMode = 'presigned_url' | 'upload';

/**
 * What the UI may know about a stored API key. Mirrors `PrivateKeyStatus` field
 * for field: never the plaintext, only enough to say WHICH key is live and when
 * it was last set.
 */
export interface ProviderKeyStatus {
  providerId: string;
  /** Is a key stored for this provider at all? */
  configured: boolean;
  /** A masked hint (e.g. `"••••a1b2"`), or `null` when nothing is stored. NEVER the key. */
  hint: string | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

/** One admin-form field a provider needs — the API describes its own form. */
export interface ProviderFieldDescriptor {
  key: string;
  label: string;
  type: 'text' | 'select' | 'number' | 'boolean';
  options?: Array<{ value: string; label: string }>;
  helpText?: string;
  required: boolean;
  defaultValue?: string | number | boolean | null;
}

/** What a provider can do, published so the UI need not discover it by trying. */
export interface TranscriptionProviderCapabilities {
  diarization: boolean;
  wordTimestamps: boolean;
  languageDetection: boolean;
  speakersExpectedHint: boolean;
  acceptsUrl: boolean;
  acceptsUpload: boolean;
  maxInputBytes: number;
  maxDurationMs: number;
  acceptedMimeTypes: string[];
  remoteDelete: boolean;
  cancel: boolean;
}

export interface TranscriptionProviderDescription {
  id: string;
  label: string;
  capabilities: TranscriptionProviderCapabilities;
  fieldDescriptors: ProviderFieldDescriptor[];
}

/** The stored policy. Carries no secret, by construction on both sides. */
export interface TranscriptionSettings {
  enabled: boolean;
  provider: TranscriptionProviderId | null;
  providers: {
    assemblyai: {
      region: AssemblyAiRegion;
      speechModel: string;
    };
  };
  audioDelivery: AudioDeliveryMode;
  presignedUrlTtlMinutes: number;
  deleteRemoteAfterIngest: boolean;
  defaultLanguage: string | null;
  transcodeNodeOffloadEnabled: boolean;
  playback: {
    bitrateKbps: number;
  };
}

/** `GET /api/transcription-settings`, and the body every write returns. */
export interface TranscriptionSettingsAdminView {
  settings: TranscriptionSettings;
  /** One entry per registered provider, configured or not. */
  keyStatuses: ProviderKeyStatus[];
  /** The provider catalogue the form renders itself from. */
  providers: TranscriptionProviderDescription[];
  /** Bumped on every write. Pass back as `If-Match` on the next PUT. */
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/**
 * `PUT /api/transcription-settings` — every settings field optional, plus the
 * write-only `apiKey`.
 *
 * A DEEP PARTIAL, matching the API's PATCH schema: sending
 * `{ playback: { bitrateKbps: 96 } }` must be legal, or the page has to send
 * the whole namespace to change one control.
 */
export interface UpdateTranscriptionSettingsInput {
  enabled?: boolean;
  provider?: TranscriptionProviderId | null;
  providers?: {
    assemblyai?: {
      region?: AssemblyAiRegion;
      speechModel?: string;
    };
  };
  audioDelivery?: AudioDeliveryMode;
  presignedUrlTtlMinutes?: number;
  deleteRemoteAfterIngest?: boolean;
  defaultLanguage?: string | null;
  transcodeNodeOffloadEnabled?: boolean;
  playback?: { bitrateKbps?: number };
  /**
   * WRITE-ONLY. Omit or send empty to keep the stored key. There is no way to
   * erase a key through this call — see `removeTranscriptionCredential`.
   */
  apiKey?: string | null;
}

/** `POST /api/transcription-settings/test`. */
export interface TestTranscriptionConnectionInput {
  provider: TranscriptionProviderId;
  /** Probe a region other than the stored one, for this call only. */
  region?: AssemblyAiRegion | null;
  /** The key to probe. **Does not need to have been saved** — that is the point. */
  apiKey?: string | null;
}

/** The outcome of a probe. `ok: false` arrives as a 200, not an exception. */
export interface TranscriptionConnectionTest {
  ok: boolean;
  latencyMs: number;
  /** A specific, actionable sentence — which of three different fixes applies. */
  detail: string;
}

/** `GET /api/transcription/config` — the non-admin capability probe. */
export interface TranscriptionConfig {
  available: boolean;
  providerLabel: string | null;
  maxUploadBytes: number;
  maxDurationMs: number;
  acceptedExtensions: string[];
  acceptedMimeTypes: string[];
}

const BASE = '/transcription-settings';

/** `GET` — `system_settings:read`. */
export async function getTranscriptionSettings(): Promise<TranscriptionSettingsAdminView> {
  return api.get<TranscriptionSettingsAdminView>(BASE);
}

/**
 * `PUT` — `system_settings:write`.
 *
 * `expectedVersion` is passed through as-is, INCLUDING `0`: the check on the
 * header is `undefined`, never a truthiness test, so the very first save on a
 * fresh deployment is still guarded rather than being the one unprotected
 * write. Copied from `updatePushConfig` for the same reason.
 */
export async function updateTranscriptionSettings(
  input: UpdateTranscriptionSettingsInput,
  expectedVersion?: number,
): Promise<TranscriptionSettingsAdminView> {
  return api.put<TranscriptionSettingsAdminView>(BASE, input, {
    headers:
      expectedVersion === undefined
        ? undefined
        : { 'If-Match': String(expectedVersion) },
  });
}

/**
 * `POST /test` — `system_settings:write`.
 *
 * ⚠ RESOLVES ON A FAILED PROBE. The endpoint answers 200 with `{ ok: false,
 * detail }` when the provider refuses the credential; that is the interesting
 * case and it is NOT an exception. It rejects only when the call itself fails
 * (403, 400, a dropped connection).
 */
export async function testTranscriptionConnection(
  input: TestTranscriptionConnectionInput,
): Promise<TranscriptionConnectionTest> {
  return api.post<TranscriptionConnectionTest>(`${BASE}/test`, input);
}

/**
 * `DELETE /credentials/:provider` — `system_settings:write`.
 *
 * The ONLY way to erase a stored key. Idempotent, and it does NOT change the
 * settings: removing the active provider's key mid-rotation must not take the
 * deployment off the air.
 */
export async function removeTranscriptionCredential(
  providerId: string,
): Promise<void> {
  await api.delete<void>(`${BASE}/credentials/${encodeURIComponent(providerId)}`);
}

/** `GET /api/transcription/config` — readable by any authenticated user. */
export async function getTranscriptionConfig(): Promise<TranscriptionConfig> {
  return api.get<TranscriptionConfig>('/transcription/config');
}
