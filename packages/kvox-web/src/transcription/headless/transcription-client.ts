/**
 * The transcription admin API, as the web app sees it.
 *
 * Issue #23, epic #19 — see the parallel backend work in
 * `packages/kvox-api/src/transcription/`. The transport is the host's
 * (`KvoxWebHost.http`: the bearer token, the refresh dance, any maintenance
 * recogniser), and this module holds the five calls next to the types they
 * produce.
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

import { kvoxDelete, kvoxGet, kvoxPost, kvoxPut } from '../../core/headless/index.js';
import type { KvoxWebHost } from '../../core/headless/index.js';
import type {
  TranscriptionProviderId as ContractProviderId,
  AssemblyAiRegion as ContractRegion,
  AudioDeliveryMode as ContractDeliveryMode,
} from '@marinoscar/kvox-contract/transcription';

/**
 * A provider this build can be configured to use.
 *
 * @stability experimental
 */
export type TranscriptionProviderId = ContractProviderId;

/**
 * An AssemblyAI region (`us` or `eu`).
 *
 * @stability experimental
 */
export type AssemblyAiRegion = ContractRegion;

/**
 * How audio reaches the provider: a presigned URL or an upload.
 *
 * @stability experimental
 */
export type AudioDeliveryMode = ContractDeliveryMode;

/**
 * What the UI may know about a stored API key. Mirrors `PrivateKeyStatus` field
 * for field: never the plaintext, only enough to say WHICH key is live and when
 * it was last set.
 *
 * @stability experimental
 */
export interface ProviderKeyStatus {
  /** Provider id. */
  providerId: string;
  /** Is a key stored for this provider at all? */
  configured: boolean;
  /** A masked hint (e.g. `"••••a1b2"`), or `null` when nothing is stored. NEVER the key. */
  hint: string | null;
  /** When the value was last changed, ISO-8601, or `null`. */
  updatedAt: string | null;
  /** The user who last changed it, or `null`. */
  updatedByUserId: string | null;
}

/**
 * One choice of a `select` field.
 *
 * @stability experimental
 */
export interface ProviderFieldOption {
  /** The value sent to the API. */
  value: string;
  /** The text shown to the admin. */
  label: string;
}

/**
 * One admin-form field a provider needs — the API describes its own form.
 *
 * @stability experimental
 */
export interface ProviderFieldDescriptor {
  /** Key. */
  key: string;
  /** The display label. */
  label: string;
  /** Type. */
  type: 'text' | 'select' | 'number' | 'boolean';
  /** Options. */
  options?: ProviderFieldOption[];
  /** Help text. */
  helpText?: string;
  /** Required. */
  required: boolean;
  /** Default value. */
  defaultValue?: string | number | boolean | null;
}

/**
 * What a provider can do, published so the UI need not discover it by trying.
 *
 * @stability experimental
 */
export interface TranscriptionProviderCapabilities {
  /** Diarization. */
  diarization: boolean;
  /** Word timestamps. */
  wordTimestamps: boolean;
  /** Language detection. */
  languageDetection: boolean;
  /** Speakers expected hint. */
  speakersExpectedHint: boolean;
  /** Accepts url. */
  acceptsUrl: boolean;
  /** Accepts upload. */
  acceptsUpload: boolean;
  /** Max input bytes. */
  maxInputBytes: number;
  /** Max duration ms. */
  maxDurationMs: number;
  /** Accepted mime types. */
  acceptedMimeTypes: string[];
  /** Remote delete. */
  remoteDelete: boolean;
  /** Cancel. */
  cancel: boolean;
}

/**
 * One provider of the catalogue the admin form renders itself from.
 *
 * @stability experimental
 */
export interface TranscriptionProviderDescription {
  /** The identifier. */
  id: string;
  /** The display label. */
  label: string;
  /** What the provider can do. */
  capabilities: TranscriptionProviderCapabilities;
  /** The admin-form fields the provider needs. */
  fieldDescriptors: ProviderFieldDescriptor[];
}

/**
 * The stored policy. Carries no secret, by construction on both sides.
 *
 * @stability experimental
 */
export interface TranscriptionSettings {
  /** Whether the feature is switched on. */
  enabled: boolean;
  /** The provider id. */
  provider: TranscriptionProviderId | null;
  /** Per-provider settings. */
  providers: {
    /** Assemblyai. */
    assemblyai: {
      /** The provider region. */
      region: AssemblyAiRegion;
      /** The provider's speech model identifier. */
      speechModel: string;
    };
  };
  /** Audio delivery. */
  audioDelivery: AudioDeliveryMode;
  /** Presigned url ttl minutes. */
  presignedUrlTtlMinutes: number;
  /** Delete remote after ingest. */
  deleteRemoteAfterIngest: boolean;
  /** Default language. */
  defaultLanguage: string | null;
  /** Transcode node offload enabled. */
  transcodeNodeOffloadEnabled: boolean;
  /**
   * Hours an upload may sit with no activity before the server deletes the
   * transcript and its partial object (issue #322). Integer, 1–720, default 3.
   */
  abandonedUploadHours: number;
  /** Playback transcoding settings. */
  playback: {
    /** Playback bitrate, in kbit/s. */
    bitrateKbps: number;
  };
}

/**
 * Who last changed the settings.
 *
 * @stability experimental
 */
export interface TranscriptionSettingsActor {
  /** The user id. */
  id: string;
  /** The user's email address. */
  email: string;
}

/**
 * `GET /api/transcription-settings`, and the body every write returns.
 *
 * @stability experimental
 */
export interface TranscriptionSettingsAdminView {
  /** The stored policy. */
  settings: TranscriptionSettings;
  /** One entry per registered provider, configured or not. */
  keyStatuses: ProviderKeyStatus[];
  /** The provider catalogue the form renders itself from. */
  providers: TranscriptionProviderDescription[];
  /** Bumped on every write. Pass back as `If-Match` on the next PUT. */
  version: number;
  /** When the value was last changed, ISO-8601, or `null`. */
  updatedAt: string | null;
  /** Who last changed it. */
  updatedBy: TranscriptionSettingsActor | null;
}

/**
 * `PUT /api/transcription-settings` — every settings field optional, plus the
 * write-only `apiKey`.
 *
 * A DEEP PARTIAL, matching the API's PATCH schema: sending
 * `{ playback: { bitrateKbps: 96 } }` must be legal, or the page has to send
 * the whole namespace to change one control.
 *
 * @stability experimental
 */
export interface UpdateTranscriptionSettingsInput {
  /** Whether the feature is switched on. */
  enabled?: boolean;
  /** The provider id. */
  provider?: TranscriptionProviderId | null;
  /** Per-provider settings. */
  providers?: {
    /** Assemblyai. */
    assemblyai?: {
      /** The provider region. */
      region?: AssemblyAiRegion;
      /** The provider's speech model identifier. */
      speechModel?: string;
    };
  };
  /** Audio delivery. */
  audioDelivery?: AudioDeliveryMode;
  /** Presigned url ttl minutes. */
  presignedUrlTtlMinutes?: number;
  /** Delete remote after ingest. */
  deleteRemoteAfterIngest?: boolean;
  /** Default language. */
  defaultLanguage?: string | null;
  /** Transcode node offload enabled. */
  transcodeNodeOffloadEnabled?: boolean;
  /** Abandoned upload hours. */
  abandonedUploadHours?: number;
  /** Playback transcoding settings. */
  playback?: {
    /** Playback bitrate, in kbit/s. */
    bitrateKbps?: number;
  };
  /**
   * WRITE-ONLY. Omit or send empty to keep the stored key. There is no way to
   * erase a key through this call — see `removeTranscriptionCredential`.
   */
  apiKey?: string | null;
}

/**
 * `POST /api/transcription-settings/test`.
 *
 * @stability experimental
 */
export interface TestTranscriptionConnectionInput {
  /** The provider id. */
  provider: TranscriptionProviderId;
  /** Probe a region other than the stored one, for this call only. */
  region?: AssemblyAiRegion | null;
  /** The key to probe. **Does not need to have been saved** — that is the point. */
  apiKey?: string | null;
}

/**
 * The outcome of a probe. `ok: false` arrives as a 200, not an exception.
 *
 * @stability experimental
 */
export interface TranscriptionConnectionTest {
  /** Whether the probe succeeded. */
  ok: boolean;
  /** Round-trip time of the probe, in milliseconds. */
  latencyMs: number;
  /** A specific, actionable sentence — which of three different fixes applies. */
  detail: string;
}

/**
 * `GET /api/transcription/config` — the non-admin capability probe.
 *
 * @stability experimental
 */
export interface TranscriptionConfig {
  /** Available. */
  available: boolean;
  /** Provider label. */
  providerLabel: string | null;
  /** Max upload bytes. */
  maxUploadBytes: number;
  /** Max duration ms. */
  maxDurationMs: number;
  /** Accepted extensions. */
  acceptedExtensions: string[];
  /** Accepted mime types. */
  acceptedMimeTypes: string[];
  /**
   * Whether the active provider can be told which names and terms to expect
   * (#327). Offer a keyterms field only when this is true.
   */
  keytermsSupported: boolean;
  /** Most keyterms the create call will forward. 0 when unsupported. */
  maxKeyterms: number;
}

const BASE = '/transcription-settings';

/**
 * `GET` — `system_settings:read`.
 *
 * @stability experimental
 */
export async function getTranscriptionSettings(
  host: KvoxWebHost,
): Promise<TranscriptionSettingsAdminView> {
  return kvoxGet<TranscriptionSettingsAdminView>(host, BASE);
}

/**
 * `PUT` — `system_settings:write`.
 *
 * `expectedVersion` is passed through as-is, INCLUDING `0`: the check on the
 * header is `undefined`, never a truthiness test, so the very first save on a
 * fresh deployment is still guarded rather than being the one unprotected
 * write. Copied from `updatePushConfig` for the same reason.
 *
 * @stability experimental
 */
export async function updateTranscriptionSettings(
  host: KvoxWebHost,
  input: UpdateTranscriptionSettingsInput,
  expectedVersion?: number,
): Promise<TranscriptionSettingsAdminView> {
  return kvoxPut<TranscriptionSettingsAdminView>(
    host,
    BASE,
    input,
    expectedVersion === undefined ? undefined : { headers: { 'If-Match': String(expectedVersion) } },
  );
}

/**
 * `POST /test` — `system_settings:write`.
 *
 * ⚠ RESOLVES ON A FAILED PROBE. The endpoint answers 200 with
 * `{ ok: false, detail }` when the provider refuses the credential; that is the interesting
 * case and it is NOT an exception. It rejects only when the call itself fails
 * (403, 400, a dropped connection).
 *
 * @stability experimental
 */
export async function testTranscriptionConnection(
  host: KvoxWebHost,
  input: TestTranscriptionConnectionInput,
): Promise<TranscriptionConnectionTest> {
  return kvoxPost<TranscriptionConnectionTest>(host, `${BASE}/test`, input);
}

/**
 * `DELETE /credentials/:provider` — `system_settings:write`.
 *
 * The ONLY way to erase a stored key. Idempotent, and it does NOT change the
 * settings: removing the active provider's key mid-rotation must not take the
 * deployment off the air.
 *
 * @stability experimental
 */
export async function removeTranscriptionCredential(
  host: KvoxWebHost,
  providerId: string,
): Promise<void> {
  await kvoxDelete<void>(host, `${BASE}/credentials/${encodeURIComponent(providerId)}`);
}

/**
 * `GET /api/transcription/config` — readable by any authenticated user.
 *
 * @stability experimental
 */
export async function getTranscriptionConfig(host: KvoxWebHost): Promise<TranscriptionConfig> {
  return kvoxGet<TranscriptionConfig>(host, '/transcription/config');
}
