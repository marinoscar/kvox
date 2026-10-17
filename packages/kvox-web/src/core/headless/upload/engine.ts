// =============================================================================
// The resumable upload engine
// =============================================================================
//
// =============================================================================
// WHY THE PART PUTS ARE NOT BUILT ON `host.http`
// =============================================================================
//
// A JSON transport is `fetch`-based, and **`fetch` cannot report upload
// progress**. There is no `upload.onprogress` equivalent in the Fetch API: a
// `fetch()` with a 5 GB body resolves once, at the end, and reports nothing in
// between. `ReadableStream` request bodies (the only workaround) are
// HTTP/2-only, unsupported in Safari, and require `duplex: 'half'`.
//
// A recording that takes twenty minutes to upload on a phone with no progress
// bar is indistinguishable from a hung app, so the part PUTs in this file use
// `XMLHttpRequest` (the one transport in every browser that emits byte-level
// upload progress) unless the host supplies its own `upload.putPart`. The
// CONTROL PLANE (init, presign, list parts, complete, abort) goes through
// `host.http`, so it inherits the host's bearer token, its one-shot
// 401 -> refresh -> retry and its error hooks like every other call.
//
// =============================================================================
// THE PART PUTS ARE CROSS-ORIGIN AND MUST STAY THAT WAY
// =============================================================================
//
// Every part goes DIRECTLY to a presigned S3 URL. The bytes never touch the
// API: the same data-plane rule the worker-node design follows
// (`docs/specs/worker-nodes.md`), and what makes a multi-gigabyte upload from a
// phone survivable at all.
//
// Two consequences are load-bearing:
//
//   1. **The client never reads the `ETag` response header.** A cross-origin
//      response exposes no headers unless the bucket's CORS policy lists them
//      in `ExposeHeaders`, and one misconfigured bucket would then break every
//      upload with an error that looks like a client bug. The platform's
//      `POST :id/upload/complete` requires a `parts` array with an ETag per
//      part, so `completeUpload` below reads the part list back from
//      `GET :id/upload/parts` (an S3 `ListParts` on the server) and forwards it
//      verbatim. That list is authoritative anyway: it describes what the
//      provider actually holds, not what this client believes it sent.
//   2. **The service worker must never see these requests.** A part PUT is
//      `cors`, so it bypasses a navigation-only worker entirely.
//
// =============================================================================
// NO REACT IN THIS FILE
// =============================================================================
//
// Progress is emitted through a `subscribe()` callback, not React state. An
// upload outlives the component that started it, and an engine that called
// `setState` could not be driven from a test without a renderer, could not keep
// running while its screen is unmounted, and would re-render the app on every
// one of the hundreds of progress events a large file produces. The app's
// provider subscribes and throttles into React; this module only ever calls
// listeners.
// =============================================================================

import { KvoxApiError } from '../errors.js';
import type { KvoxWebHost } from '../host.js';
import { kvoxDelete, kvoxGet, kvoxPost } from '../http.js';

// =============================================================================
// Wire shapes — the contract of issue #21's endpoints
// =============================================================================

/**
 * One presigned part URL, as the init and parts endpoints return it.
 *
 * @stability experimental
 */
export interface PresignedPart {
  /** Part number. */
  partNumber: number;
  /** Url. */
  url: string;
  /**
   * ISO-8601. After this the URL is dead and must be re-requested.
   *
   * OPTIONAL, because the two endpoints that produce these do not agree:
   * `POST /upload/parts` sends it, and the `presignedUrls` inside an INIT
   * response (`initUploadResponseSchema`, and the identical block inside
   * `POST /api/transcripts`) does not. `hasFreshUrl` already handles its
   * absence — an unparseable expiry is treated as fresh, and a URL that turns
   * out to be dead is re-signed on the retry — so the field being absent is a
   * supported state rather than a latent bug. It is typed as optional so a
   * caller adopting an init response (issue #30's New-transcript screen) does
   * not have to invent a timestamp the server never sent.
   */
  expiresAt?: string;
}

/**
 * `POST /api/storage/objects/upload/init` — the platform's body
 * (`initUploadSchema`, the platform storage contract).
 *
 * @stability experimental
 */
export interface UploadInitRequest {
  /** Name. */
  name: string;
  /** Size. */
  size: number;
  /** Mime type. */
  mimeType: string;
}

/**
 * The platform's init response (`initUploadResponseSchema`). Presigns only the
 * first batch of parts (ten); the engine asks the app's `POST :id/upload/parts`
 * for the rest.
 *
 * @stability experimental
 */
export interface PlatformInitUploadResponse {
  /** Object id. */
  objectId: string;
  /** Upload id. */
  uploadId: string;
  /** Part size. */
  partSize: number;
  /** Total parts. */
  totalParts: number;
  /** Presigned urls. */
  presignedUrls: PresignedPart[];
}

/**
 * The init response — and everything the engine needs to lay out the file.
 *
 * @stability experimental
 */
export interface UploadInitResponse {
  /** Object id. */
  objectId: string;
  /** Part size. */
  partSize: number;
  /** Total parts. */
  totalParts: number;
  /** Upload id. */
  uploadId: string;
  /** The FIRST BATCH of presigned URLs, not necessarily all of them. */
  parts: PresignedPart[];
}

/**
 * One part the provider already holds: an element of the app's
 * `GET /api/storage/objects/:id/upload/parts` (a server-side S3 `ListParts`).
 *
 * @stability experimental
 */
export interface UploadedPart {
  /** Part number. */
  partNumber: number;
  /** As the provider returned it. Only ever forwarded to `…/upload/complete`. */
  etag: string;
  /** Size. */
  size: number;
}

/**
 * What a resume needs: the part layout and the parts already stored.
 *
 * The part size is NOT on the platform's status payload, so the caller passes
 * the one the upload was initialised with (the persisted session record) and it
 * is echoed here. Re-deriving it from the deployment's current setting would
 * renumber the parts of an upload begun before an operator changed it.
 *
 * @stability experimental
 */
export interface UploadResumeState {
  /** Part size. */
  partSize: number;
  /** Total parts. */
  totalParts: number;
  /** 1-based part numbers the provider already holds. */
  uploadedParts: number[];
}

// =============================================================================
// Progress
// =============================================================================

/**
 * Where an upload is. `completing` is deliberately distinct from `uploading`:
 * the last byte is sent but `POST …/complete` (an S3 `CompleteMultipartUpload`
 * behind it) can take seconds on a large object, and a progress bar frozen at
 * 100% with no explanation is the single most common "is it stuck?" report.
 *
 * @stability experimental
 */
export type UploadPhase =
  | 'idle'
  | 'uploading'
  | 'paused'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Immutable snapshot handed to every subscriber. Never mutated in place.
 *
 * @stability experimental
 */
export interface UploadProgress {
  /** Phase. */
  phase: UploadPhase;
  /** Bytes S3 has acknowledged, plus bytes currently in flight. */
  uploadedBytes: number;
  /** Total bytes. */
  totalBytes: number;
  /** 0-100, clamped. */
  percent: number;
  /** Parts fully acknowledged by S3. */
  completedParts: number;
  /** Total parts. */
  totalParts: number;
  /** Moving average over the last few seconds; 0 before enough samples. */
  bytesPerSecond: number;
  /** Seconds remaining, or `null` when no speed has been measured yet. */
  etaSeconds: number | null;
  /** Set when `phase === 'failed'`, `null` otherwise. */
  error: string | null;
  /**
   * The engine paused itself because the browser went offline. Distinct from
   * `phase === 'paused'` by a user's click: the UI says "waiting for network"
   * rather than offering a Resume button that would do nothing.
   */
  waitingForNetwork: boolean;
}

/**
 * A subscriber of an upload's progress snapshots.
 *
 * @stability experimental
 */
export type UploadProgressListener = (progress: UploadProgress) => void;

/**
 * How an upload ended. `whenSettled()` resolves with this and never rejects.
 *
 * @stability experimental
 */
export interface UploadOutcome {
  /** Object id. */
  objectId: string;
  /** Status. */
  status: 'completed' | 'cancelled' | 'failed';
  /** Error. */
  error: string | null;
}

// =============================================================================
// Injectable runtime — why this exists
// =============================================================================

/**
 * Everything ambient this engine touches, in one object.
 *
 * Time, randomness, `XMLHttpRequest` and `navigator.onLine` are all read
 * through here so a test can drive them. Without it, asserting "retries back
 * off exponentially with jitter" means either sleeping for real seconds or
 * mocking globals, and asserting a moving-average speed means controlling the
 * clock — which `Date.now` does not allow.
 *
 * Every member has a real default (`defaultUploadRuntime`); production never
 * passes one.
 *
 * @stability experimental
 */
export interface UploadRuntime {
  /** Now. */
  now(): number;
  /** Random. */
  random(): number;
  /** Create xhr. */
  createXhr(): XMLHttpRequest;
  /** Is online. */
  isOnline(): boolean;
  /** Set timeout. */
  setTimeout(handler: () => void, ms: number): number;
  /** Clear timeout. */
  clearTimeout(handle: number): void;
  /** Parts uploaded in parallel. See `detectPartConcurrency`. */
  concurrency(): number;
  /**
   * Subscribe to Content Security Policy violations. Returns an unsubscribe
   * function. See `cspBlockedUploadMessage` for why the engine listens at all.
   */
  onCspViolation(handler: (violation: CspViolation) => void): () => void;
}

/**
 * The two fields of a `SecurityPolicyViolationEvent` the engine reads.
 *
 * @stability experimental
 */
export interface CspViolation {
  /** A full URL, a bare origin, or a keyword (`inline`, `eval`) — browsers vary. */
  blockedURI: string;
  /** `effectiveDirective`, falling back to `violatedDirective`. */
  directive: string;
}

function subscribeToCspViolations(handler: (violation: CspViolation) => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const listener = (event: Event) => {
    const violation = event as SecurityPolicyViolationEvent;
    handler({
      blockedURI: violation.blockedURI ?? '',
      directive: violation.effectiveDirective || violation.violatedDirective || '',
    });
  };
  document.addEventListener('securitypolicyviolation', listener);
  return () => document.removeEventListener('securitypolicyviolation', listener);
}

/**
 * Parallel part uploads on a phone.
 *
 * @stability experimental
 */
export const MOBILE_PART_CONCURRENCY = 3;
/**
 * Parallel part uploads on a desktop.
 *
 * @stability experimental
 */
export const DESKTOP_PART_CONCURRENCY = 4;

/**
 * How many parts to push at once.
 *
 * ⚠️ DETECTED WITH `matchMedia('(pointer: coarse)')`, NOT `navigator.maxTouchPoints`.
 *
 * The question being asked is "is this a phone?", and the two signals answer
 * different questions. `maxTouchPoints > 0` is true of every touchscreen
 * laptop and every Windows convertible in desktop mode — machines with desktop
 * bandwidth, desktop power budgets and no carrier link — so it would hand the
 * conservative mobile setting to hardware that does not need it. A COARSE
 * PRIMARY POINTER means the device's main input is a finger, which is as close
 * as CSS gets to "phone or tablet", and it is also the exact signal the rest
 * of this app already gates its compact treatment on (`useMediaQuery` against
 * MUI breakpoints). Three vs four is a small difference; getting it backwards
 * on a metered phone link is not.
 *
 * Falls back to the desktop value where `matchMedia` is unavailable.
 *
 * @stability experimental
 */
export function detectPartConcurrency(): number {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(pointer: coarse)').matches
        ? MOBILE_PART_CONCURRENCY
        : DESKTOP_PART_CONCURRENCY;
    }
  } catch {
    // A browser that throws on an unknown media feature is still a browser we
    // must upload from. Fall through.
  }
  return DESKTOP_PART_CONCURRENCY;
}

/**
 * The runtime production uses: the real clock, `Math.random`, `XMLHttpRequest` and `navigator`.
 *
 * @stability experimental
 */
export const defaultUploadRuntime: UploadRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  createXhr: () => new XMLHttpRequest(),
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  concurrency: () => detectPartConcurrency(),
  onCspViolation: (handler) => subscribeToCspViolations(handler),
};

// =============================================================================
// Tuning constants
// =============================================================================

/**
 * Presigned URLs requested per call.
 *
 * The endpoint accepts at most 100 `partNumbers`; 50 is half that on purpose.
 * A URL has a lifetime, so asking for the maximum up front means the tail of a
 * batch can expire before the engine reaches it on a slow link — every expiry
 * costs a re-presign round trip and a retried PUT. Smaller batches, fetched
 * just ahead of the work, expire far less often, and the extra round trips are
 * one small JSON call per 50 parts.
 *
 * @stability experimental
 */
export const PART_URL_BATCH_SIZE = 50;

/**
 * Treat a URL as dead this long BEFORE its stated expiry.
 *
 * A part PUT that starts one second before expiry and takes thirty seconds on
 * a phone link is a 403 that the engine then has to discover, re-presign and
 * retry — having already sent the bytes. The skew spends a cheap re-presign to
 * avoid re-sending a part.
 *
 * @stability experimental
 */
export const URL_EXPIRY_SKEW_MS = 30_000;

/**
 * Window the speed moving average is computed over.
 *
 * @stability experimental
 */
export const SPEED_WINDOW_MS = 5_000;

/** Cap on retained speed samples, so a long upload cannot grow one unboundedly. */
const MAX_SPEED_SAMPLES = 240;

/**
 * Per-part retry policy. Overridable per upload, mostly so tests run fast.
 *
 * @stability experimental
 */
export interface RetryPolicy {
  /** Max attempts. */
  maxAttempts: number;
  /** Base ms. */
  baseMs: number;
  /** Max ms. */
  maxMs: number;
}

/**
 * The retry policy of one part.
 *
 * @stability experimental
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseMs: 500,
  maxMs: 30_000,
};

/**
 * Exponential backoff with **equal jitter**: half the delay is deterministic,
 * half is random within the window.
 *
 * The jitter is not decoration. Parts fail in correlated bursts — a flaky
 * tower, a bucket briefly throttling — and with `concurrency` parts retrying on
 * an identical schedule they would all come back simultaneously, reproduce the
 * same overload, and back off in lockstep again. Spreading the retries is what
 * breaks that convoy.
 *
 * @stability experimental
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: number): number {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + exponential * 0.5 * random);
}

// =============================================================================
// Control-plane calls
// =============================================================================

/**
 * Start a generic multipart upload through the PLATFORM's init route and adapt
 * its response (`presignedUrls`) to the shape the engine takes (`parts`).
 *
 * @stability experimental
 */
export async function initUpload(
  host: KvoxWebHost,
  input: UploadInitRequest,
): Promise<UploadInitResponse> {
  const response = await kvoxPost<PlatformInitUploadResponse>(
    host,
    '/storage/objects/upload/init',
    input,
  );
  return {
    objectId: response.objectId,
    uploadId: response.uploadId,
    partSize: response.partSize,
    totalParts: response.totalParts,
    parts: response.presignedUrls,
  };
}

/**
 * Ask for more presigned part URLs: the app's `POST /storage/objects/:id/upload/parts`
 * (the platform presigns only the first ten parts at init).
 *
 * ⚠️ The endpoint rejects more than 100 part numbers per call. Callers here
 * never exceed `PART_URL_BATCH_SIZE`; the slice below is belt-and-braces so a
 * future caller cannot turn that into a 400 at runtime.
 *
 * @stability experimental
 */
export async function requestUploadParts(
  host: KvoxWebHost,
  objectId: string,
  partNumbers: number[],
): Promise<PresignedPart[]> {
  return kvoxPost<PresignedPart[]>(host, `/storage/objects/${objectId}/upload/parts`, {
    partNumbers: partNumbers.slice(0, 100),
  });
}

/**
 * The active storage driver cannot list the parts of a multipart upload
 * (`501 list_parts_unsupported`), which this client needs both to resume and to
 * complete without reading an ETag header.
 *
 * @stability experimental
 */
export class ListPartsUnsupportedError extends Error {
  constructor() {
    super(
      'The configured storage provider does not support browser multipart uploads that can be resumed or completed. ' +
        'An administrator needs to switch Storage to an S3-compatible provider.',
    );
    this.name = 'ListPartsUnsupportedError';
  }
}

/**
 * The parts the provider holds for this upload — the app's
 * `GET /storage/objects/:id/upload/parts`, an S3 `ListParts` on the server.
 *
 * Authoritative: it describes what is actually stored, not what this tab
 * believes it sent. Throws `ListPartsUnsupportedError` on a 501, and the
 * ordinary `KvoxApiError` otherwise (404 when the upload no longer exists).
 *
 * @stability experimental
 */
export async function listUploadedParts(
  host: KvoxWebHost,
  objectId: string,
): Promise<UploadedPart[]> {
  try {
    return await kvoxGet<UploadedPart[]>(host, `/storage/objects/${objectId}/upload/parts`);
  } catch (err) {
    if (err instanceof KvoxApiError && err.status === 501) throw new ListPartsUnsupportedError();
    throw err;
  }
}

/**
 * Where a resumed upload stands.
 *
 * Reads the provider's own part list. Only when the driver cannot list parts
 * (501) does it fall back to the platform's `…/upload/status`, which knows only
 * parts recorded at complete time: harmless, since it then reports nothing and
 * every part is re-sent. (Completing such an upload fails with
 * `ListPartsUnsupportedError`, loudly, rather than at the very end of a
 * transfer: the fallback exists so that a 404 still surfaces as "gone".)
 *
 * @stability experimental
 */
export async function fetchUploadResumeState(
  host: KvoxWebHost,
  objectId: string,
  layout: { partSize: number; size: number },
): Promise<UploadResumeState> {
  const totalParts = Math.max(1, Math.ceil(layout.size / layout.partSize));
  let uploadedParts: number[];
  try {
    uploadedParts = (await listUploadedParts(host, objectId)).map((part) => part.partNumber);
  } catch (err) {
    if (!(err instanceof ListPartsUnsupportedError)) throw err;
    const status = await kvoxGet<{ uploadedParts: number[] }>(
      host,
      `/storage/objects/${objectId}/upload/status`,
    );
    uploadedParts = status.uploadedParts;
  }
  return {
    partSize: layout.partSize,
    totalParts,
    uploadedParts: uploadedParts.filter((part) => part >= 1 && part <= totalParts),
  };
}

/**
 * Finish the upload.
 *
 * **The client never reads an ETag header.** See the file header: it reads the
 * part list back from the app's `GET …/upload/parts` and forwards it to the
 * platform's `POST …/upload/complete` (`{ parts: [{ partNumber, eTag }] }`), so
 * no upload depends on a bucket CORS `ExposeHeaders` entry for the READ side.
 *
 * Refuses to complete (with `UploadIncompleteError`) when the provider is
 * missing any of `totalParts`: a `CompleteMultipartUpload` over a gap would
 * assemble a silently truncated object.
 *
 * @stability experimental
 */
export async function completeUpload(
  host: KvoxWebHost,
  objectId: string,
  totalParts: number,
): Promise<void> {
  const listed = await listUploadedParts(host, objectId);
  const held = new Map<number, string>();
  for (const part of listed) held.set(part.partNumber, part.etag);

  const missing: number[] = [];
  for (let part = 1; part <= totalParts; part += 1) {
    if (!held.has(part)) missing.push(part);
  }
  if (missing.length > 0) throw new UploadIncompleteError(missing);

  const parts = Array.from({ length: totalParts }, (_, index) => ({
    partNumber: index + 1,
    eTag: held.get(index + 1)!,
  }));
  await kvoxPost<void>(host, `/storage/objects/${objectId}/upload/complete`, { parts });
}

/**
 * Aborts the multipart upload on the server (`DELETE …/upload/abort`).
 *
 * @param host - The host.
 * @param objectId - The storage object of the upload.
 *
 * @stability experimental
 */
export async function abortUpload(host: KvoxWebHost, objectId: string): Promise<void> {
  await kvoxDelete<void>(host, `/storage/objects/${objectId}/upload/abort`);
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Some parts are not stored at the provider yet, so the upload cannot complete.
 *
 * @stability experimental
 */
export class UploadIncompleteError extends Error {
  /** The 1-based part numbers the provider does not hold. */
  readonly missingParts: number[];

  /**
   * Builds the error.
   *
   * @param missingParts - The part numbers the provider does not hold.
   */
  constructor(missingParts: number[]) {
    super(
      `${missingParts.length} part${missingParts.length === 1 ? '' : 's'} did not reach storage. ` +
        'Resume the upload to send them.',
    );
    this.missingParts = missingParts;
    this.name = 'UploadIncompleteError';
  }
}

/**
 * A part exhausted its attempts, or the control plane refused. Terminal.
 *
 * @stability experimental
 */
export class UploadFailedError extends Error {
  /** The part that failed, when the failure belongs to one. */
  readonly partNumber?: number | undefined;
  /** The HTTP status of the last attempt, when there was one. */
  readonly status?: number | undefined;

  /**
   * Builds the error.
   *
   * @param message - What to show the user.
   * @param partNumber - The part that failed.
   * @param status - The HTTP status of the last attempt.
   */
  constructor(message: string, partNumber?: number, status?: number) {
    super(message);
    this.partNumber = partNumber;
    this.status = status;
    this.name = 'UploadFailedError';
  }
}

/**
 * The failure message for a part PUT the browser refused to send because of
 * this site's Content Security Policy.
 *
 * ⚠️ WHY CSP IS SPECIAL-CASED RATHER THAN RETRIED LIKE ANY NETWORK ERROR.
 *
 * A PUT blocked by `connect-src` never leaves the device, and to
 * `XMLHttpRequest` it is indistinguishable from a dropped connection: `onerror`,
 * status 0, no body, no reason. Left to the ordinary retry loop the engine
 * spends every attempt and its backoff on a policy decision that is identical
 * on every try, then reports `Part N failed after N attempts` — which reads as
 * a flaky network and sends the user to find better Wi-Fi, when the only fix
 * is an operator adding the storage origin to the policy (issue #84; the policy allows `https:` by default, so only a plain-http origin needs this). The
 * `securitypolicyviolation` DOM event is the one signal that tells the two
 * apart, so the engine listens for it and fails fast with a message naming
 * the origin and the setting. Every other part targets the same origin under
 * the same policy, so failing the whole upload loses nothing.
 *
 * @stability experimental
 */
export function cspBlockedUploadMessage(origin: string): string {
  return (
    `Your browser blocked the upload to storage (${origin}) because of this site's ` +
    'Content Security Policy. An administrator needs to allow that origin in infra/nginx/app.d/csp/ (connect-src and media-src).'
  );
}

/**
 * The origin of an absolute URL or bare origin, or `null` for anything that
 * does not parse (`inline`, `eval`, an empty string). Deliberately no base URL:
 * resolving a CSP keyword against `location` would turn it into this page's
 * own origin.
 */
function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Internal: a PUT was aborted by pause/cancel. Never surfaces to callers. */
class PartAbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'PartAbortedError';
  }
}

/** Internal: a PUT came back non-2xx. Carries the status so 403 can re-presign. */
class PartHttpError extends Error {
  constructor(readonly status: number) {
    super(`part upload failed with HTTP ${status}`);
    this.name = 'PartHttpError';
  }
}

// =============================================================================
// The public handle
// =============================================================================

/**
 * The handle of one upload: state, control and completion.
 *
 * @stability experimental
 */
export interface ResumableUpload {
  /** Object id. */
  readonly objectId: string;
  /** File name. */
  readonly fileName: string;
  /** Total bytes. */
  readonly totalBytes: number;
  /** The current snapshot. Cheap; safe to call in a render. */
  getProgress(): UploadProgress;
  /** Returns an unsubscribe function. Fires immediately with the current state. */
  subscribe(listener: UploadProgressListener): () => void;
  /** Idempotent: a second call while running does nothing. */
  start(): void;
  /** Pause. */
  pause(): void;
  /** Resume. */
  resume(): void;
  /** Aborts every in-flight PUT and calls `DELETE …/upload/abort`. */
  cancel(): Promise<void>;
  /** Resolves when the upload reaches a terminal phase. NEVER REJECTS. */
  whenSettled(): Promise<UploadOutcome>;
}

/**
 * Options of an upload engine.
 *
 * @stability experimental
 */
export interface ResumableUploadOptions {
  /** Runtime. */
  runtime?: Partial<UploadRuntime>;
  /** Retry. */
  retry?: Partial<RetryPolicy>;
  /** Parts S3 already holds (resume). 1-based part numbers. */
  completedParts?: number[];
  /** Presigned URLs already in hand (the init response's first batch). */
  presignedParts?: PresignedPart[];
  /**
   * Attach `online`/`offline` listeners. Always on in the app; a test that
   * wants no ambient network behaviour turns it off.
   */
  watchNetwork?: boolean;
}

interface UploadEngineConfig {
  host: KvoxWebHost;
  file: File;
  objectId: string;
  partSize: number;
  totalParts: number;
}

// =============================================================================
// The engine
// =============================================================================

class UploadEngine implements ResumableUpload {
  readonly objectId: string;
  readonly fileName: string;
  readonly totalBytes: number;

  private readonly host: KvoxWebHost;
  private readonly file: File;
  private readonly partSize: number;
  private readonly runtime: UploadRuntime;
  private readonly retry: RetryPolicy;
  private readonly watchNetwork: boolean;

  readonly totalParts: number;

  /** Part numbers still to send, in order. */
  private queue: number[] = [];
  /** Part numbers S3 has acknowledged. */
  private readonly done = new Set<number>();
  /** Bytes reported by `upload.onprogress` for each part currently in flight. */
  private readonly inFlightBytes = new Map<number, number>();
  private readonly activeXhrs = new Map<number, XMLHttpRequest>();
  /** In-flight parts sent through the host's own `upload.putPart`. */
  private readonly activeHostPuts = new Map<number, AbortController>();
  private readonly urls = new Map<number, PresignedPart>();

  private phase: UploadPhase = 'idle';
  private error: string | null = null;
  private waitingForNetwork = false;
  private running = 0;
  /**
   * Bumped by every pause/cancel. A callback from a previous generation
   * checks it and returns instead of touching state that has moved on.
   */
  private generation = 0;

  private readonly listeners = new Set<UploadProgressListener>();
  private readonly samples: Array<{ t: number; bytes: number }> = [];
  private snapshot: UploadProgress;

  private settle!: (outcome: UploadOutcome) => void;
  private readonly settled: Promise<UploadOutcome>;
  private isSettled = false;

  private presignChain: Promise<void> = Promise.resolve();
  private readonly pendingTimers = new Set<number>();
  private networkListenersAttached = false;

  private readonly onOffline = () => this.handleOffline();
  private readonly onOnline = () => this.handleOnline();

  /** Origins this upload has sent (or tried to send) a part PUT to. */
  private readonly partOrigins = new Set<string>();
  /** Part origins a `connect-src` violation has been reported for. Never cleared. */
  private readonly cspBlockedOrigins = new Set<string>();
  private cspUnsubscribe: (() => void) | null = null;

  constructor(config: UploadEngineConfig, options: ResumableUploadOptions = {}) {
    this.host = config.host;
    this.file = config.file;
    this.objectId = config.objectId;
    this.fileName = config.file.name;
    this.totalBytes = config.file.size;
    this.partSize = config.partSize;
    this.totalParts = config.totalParts;
    this.runtime = { ...defaultUploadRuntime, ...options.runtime };
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.watchNetwork = options.watchNetwork !== false;

    for (const part of options.completedParts ?? []) {
      this.done.add(part);
    }
    for (const part of options.presignedParts ?? []) {
      this.urls.set(part.partNumber, part);
    }
    this.queue = [];
    for (let part = 1; part <= this.totalParts; part += 1) {
      if (!this.done.has(part)) this.queue.push(part);
    }

    this.settled = new Promise<UploadOutcome>((resolve) => {
      this.settle = resolve;
    });
    this.snapshot = this.buildSnapshot();
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  getProgress(): UploadProgress {
    return this.snapshot;
  }

  subscribe(listener: UploadProgressListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.phase !== 'idle' && this.phase !== 'paused') return;
    this.attachNetworkListeners();

    if (this.watchNetwork && !this.runtime.isOnline()) {
      // Starting while already offline is not an error; it is the ordinary
      // "picked a file in a lift" case. Park in the same waiting state the
      // `offline` event produces, so `online` resumes it through one path.
      this.phase = 'paused';
      this.waitingForNetwork = true;
      this.emit();
      return;
    }

    this.waitingForNetwork = false;
    this.phase = 'uploading';
    this.error = null;
    this.attachCspListener();
    this.emit();
    this.pump();
  }

  pause(): void {
    if (this.phase !== 'uploading' && this.phase !== 'idle') return;
    this.waitingForNetwork = false;
    this.stopInFlight('paused');
    this.emit();
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.start();
  }

  async cancel(): Promise<void> {
    if (this.isTerminal()) return;
    this.stopInFlight('cancelled');
    this.detachNetworkListeners();
    this.emit();
    try {
      await abortUpload(this.host, this.objectId);
    } catch {
      // A failed abort leaves an orphaned multipart upload that the bucket's
      // own lifecycle rule reaps. Never surface it: the user asked to stop,
      // and the upload HAS stopped — an error toast here would describe a
      // server-side tidy-up they cannot act on.
    }
    this.finish('cancelled', null);
  }

  whenSettled(): Promise<UploadOutcome> {
    return this.settled;
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private pump(): void {
    if (this.phase !== 'uploading') return;

    if (this.queue.length === 0 && this.running === 0) {
      void this.complete();
      return;
    }

    const limit = Math.max(1, this.runtime.concurrency());
    while (this.phase === 'uploading' && this.running < limit && this.queue.length > 0) {
      const partNumber = this.queue.shift()!;
      this.running += 1;
      const generation = this.generation;
      void this.uploadPart(partNumber, generation)
        .then(() => {
          if (generation !== this.generation) return;
          this.done.add(partNumber);
          this.inFlightBytes.delete(partNumber);
          this.emit();
        })
        .catch((err: unknown) => {
          if (generation !== this.generation) return;
          this.inFlightBytes.delete(partNumber);
          if (err instanceof PartAbortedError) {
            // Pause/cancel already moved the phase. Put the part back so a
            // resume re-sends it: S3 has no partial-part concept, so the
            // bytes already pushed for it are simply lost.
            this.requeue(partNumber);
            return;
          }
          this.fail(
            err instanceof Error ? err.message : `Part ${partNumber} failed`,
          );
        })
        .finally(() => {
          if (generation !== this.generation) return;
          this.running -= 1;
          this.pump();
        });
    }
  }

  private requeue(partNumber: number): void {
    if (this.done.has(partNumber) || this.queue.includes(partNumber)) return;
    this.queue.push(partNumber);
    this.queue.sort((a, b) => a - b);
  }

  private async complete(): Promise<void> {
    if (this.phase !== 'uploading') return;
    this.phase = 'completing';
    this.emit();
    try {
      await completeUpload(this.host, this.objectId, this.totalParts);
    } catch (err) {
      this.fail(
        err instanceof KvoxApiError ||
          err instanceof ListPartsUnsupportedError ||
          err instanceof UploadIncompleteError
          ? err.message
          : 'Could not finalise the upload',
      );
      return;
    }
    this.detachNetworkListeners();
    this.finish('completed', null);
  }

  // ---------------------------------------------------------------------------
  // One part, with retries
  // ---------------------------------------------------------------------------

  private async uploadPart(partNumber: number, generation: number): Promise<void> {
    let forceRepresign = false;
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      if (generation !== this.generation || this.phase !== 'uploading') {
        throw new PartAbortedError();
      }

      let url: string;
      try {
        url = await this.ensureUrl(partNumber, forceRepresign);
      } catch (err) {
        throw new UploadFailedError(
          err instanceof KvoxApiError
            ? err.message
            : `Could not get an upload URL for part ${partNumber}`,
          partNumber,
        );
      }

      if (generation !== this.generation || this.phase !== 'uploading') {
        throw new PartAbortedError();
      }

      try {
        await this.putPart(partNumber, url, generation);
        return;
      } catch (err) {
        if (err instanceof PartAbortedError) throw err;

        // A 403 from S3 is what an EXPIRED presigned URL looks like — the
        // signature no longer validates. It is indistinguishable from a policy
        // denial at this layer, and re-presigning costs one small JSON call,
        // so the engine always treats it as expiry and asks for a fresh URL.
        // (A genuine policy denial then fails again and exhausts the attempts,
        // which is the correct outcome either way.)
        forceRepresign = err instanceof PartHttpError && err.status === 403;
        lastStatus = err instanceof PartHttpError ? err.status : undefined;
        this.inFlightBytes.set(partNumber, 0);
        this.emit();

        // A status-0 failure may be a CSP block (see `cspBlockedUploadMessage`).
        // The violation event can be dispatched before OR after `onerror`, so
        // this is checked twice: now, and again after the backoff below, by
        // which time the event has certainly arrived.
        const isNetworkError = !(err instanceof PartHttpError);
        if (isNetworkError) this.throwIfCspBlocked(partNumber, url);

        if (attempt === this.retry.maxAttempts) {
          throw new UploadFailedError(
            `Part ${partNumber} failed after ${attempt} attempts`,
            partNumber,
            lastStatus,
          );
        }

        await this.delay(backoffDelayMs(attempt, this.retry, this.runtime.random()));

        if (isNetworkError && generation === this.generation) {
          this.throwIfCspBlocked(partNumber, url);
        }
      }
    }
  }

  /**
   * Throw a terminal `UploadFailedError` — no further attempts, no re-presign —
   * when a `connect-src` violation has been recorded for this part's origin.
   */
  private throwIfCspBlocked(partNumber: number, url: string): void {
    const origin = originOf(url);
    if (origin === null || !this.cspBlockedOrigins.has(origin)) return;
    throw new UploadFailedError(cspBlockedUploadMessage(origin), partNumber);
  }

  /** The one place `XMLHttpRequest` is used. See the file header for why. */
  private putPart(partNumber: number, url: string, generation: number): Promise<void> {
    const hostUpload = this.host.upload;
    if (hostUpload) return this.putPartThroughHost(hostUpload, partNumber, url, generation);
    return new Promise<void>((resolve, reject) => {
      const blob = this.slicePart(partNumber);
      const xhr = this.runtime.createXhr();
      this.activeXhrs.set(partNumber, xhr);
      this.inFlightBytes.set(partNumber, 0);

      const cleanup = () => {
        if (this.activeXhrs.get(partNumber) === xhr) {
          this.activeXhrs.delete(partNumber);
        }
      };

      xhr.upload.onprogress = (event: ProgressEvent) => {
        if (generation !== this.generation) return;
        this.inFlightBytes.set(partNumber, Math.min(event.loaded, blob.size));
        this.emit();
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          // Count the WHOLE part: `upload.onprogress` reports bytes handed to
          // the socket, which can lag the final acknowledgement by a chunk.
          this.inFlightBytes.set(partNumber, blob.size);
          resolve();
          return;
        }
        reject(new PartHttpError(xhr.status));
      };
      xhr.onerror = () => {
        cleanup();
        reject(new Error(`Network error uploading part ${partNumber}`));
      };
      xhr.ontimeout = () => {
        cleanup();
        reject(new Error(`Timed out uploading part ${partNumber}`));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new PartAbortedError());
      };

      // Recorded BEFORE the send, so a violation dispatched for this request
      // always finds its origin already known.
      const origin = originOf(url);
      if (origin !== null) this.partOrigins.add(origin);

      xhr.open('PUT', url, true);
      // NO `Authorization` HEADER, and no `withCredentials`. The presigned URL
      // carries its own signature; adding either would make the browser send a
      // preflight the bucket is unlikely to answer, and S3 rejects a request
      // that is signed two ways.
      xhr.send(blob);
    });
  }

  /**
   * The same part, sent by the host's own transport. Progress moves per part
   * (the port reports no bytes), and an abort rejects like an XHR abort does.
   */
  private async putPartThroughHost(
    port: NonNullable<KvoxWebHost['upload']>,
    partNumber: number,
    url: string,
    generation: number,
  ): Promise<void> {
    const blob = this.slicePart(partNumber);
    const controller = new AbortController();
    this.activeHostPuts.set(partNumber, controller);
    this.inFlightBytes.set(partNumber, 0);
    const origin = originOf(url);
    if (origin !== null) this.partOrigins.add(origin);
    try {
      await port.putPart(url, blob, controller.signal);
    } catch (err) {
      if (controller.signal.aborted || generation !== this.generation) throw new PartAbortedError();
      const status = (err as { status?: unknown } | null)?.status;
      if (typeof status === 'number') throw new PartHttpError(status);
      throw err instanceof Error ? err : new Error(`Network error uploading part ${partNumber}`);
    } finally {
      if (this.activeHostPuts.get(partNumber) === controller) this.activeHostPuts.delete(partNumber);
    }
    this.inFlightBytes.set(partNumber, blob.size);
  }

  private slicePart(partNumber: number): Blob {
    const start = (partNumber - 1) * this.partSize;
    const end = Math.min(start + this.partSize, this.totalBytes);
    return this.file.slice(start, end);
  }

  private partBytes(partNumber: number): number {
    const start = (partNumber - 1) * this.partSize;
    return Math.max(0, Math.min(start + this.partSize, this.totalBytes) - start);
  }

  // ---------------------------------------------------------------------------
  // Presigned URLs
  // ---------------------------------------------------------------------------

  private hasFreshUrl(partNumber: number): boolean {
    const cached = this.urls.get(partNumber);
    if (!cached) return false;
    // An ABSENT expiry (the init endpoint sends none — see `PresignedPart`)
    // and an unparseable one are the same case: nothing is known, so the URL
    // is treated as fresh and a dead one is re-signed on the retry.
    if (cached.expiresAt === undefined) return true;
    const expiry = Date.parse(cached.expiresAt);
    if (Number.isNaN(expiry)) return true;
    return expiry - URL_EXPIRY_SKEW_MS > this.runtime.now();
  }

  private async ensureUrl(partNumber: number, force: boolean): Promise<string> {
    if (force) this.urls.delete(partNumber);
    if (!this.hasFreshUrl(partNumber)) {
      await this.fetchUrlBatch(partNumber);
    }
    const part = this.urls.get(partNumber);
    if (!part) {
      throw new UploadFailedError(`No upload URL for part ${partNumber}`, partNumber);
    }
    return part.url;
  }

  /**
   * Fetch URLs in batches, SERIALISED through one chain.
   *
   * With `concurrency` parts starting at once, every one of them would
   * otherwise discover the cache empty simultaneously and fire its own
   * presign call for overlapping ranges. Chaining means the first call covers
   * the next `PART_URL_BATCH_SIZE` parts and the rest find their URL already
   * cached — one round trip per 50 parts instead of one per part.
   */
  private fetchUrlBatch(partNumber: number): Promise<void> {
    const run = this.presignChain.then(async () => {
      if (this.hasFreshUrl(partNumber)) return;
      const wanted = this.collectPartsNeedingUrls(partNumber);
      const parts = await requestUploadParts(this.host, this.objectId, wanted);
      for (const part of parts) {
        this.urls.set(part.partNumber, part);
      }
    });
    this.presignChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private collectPartsNeedingUrls(partNumber: number): number[] {
    const wanted = [partNumber];
    for (let part = partNumber + 1; part <= this.totalParts; part += 1) {
      if (wanted.length >= PART_URL_BATCH_SIZE) break;
      if (this.done.has(part)) continue;
      if (this.hasFreshUrl(part)) continue;
      wanted.push(part);
    }
    return wanted;
  }

  // ---------------------------------------------------------------------------
  // Network awareness
  // ---------------------------------------------------------------------------

  private attachNetworkListeners(): void {
    if (!this.watchNetwork || this.networkListenersAttached) return;
    if (typeof window === 'undefined') return;
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('online', this.onOnline);
    this.networkListenersAttached = true;
  }

  private detachNetworkListeners(): void {
    if (!this.networkListenersAttached || typeof window === 'undefined') return;
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('online', this.onOnline);
    this.networkListenersAttached = false;
  }

  // ---------------------------------------------------------------------------
  // Content Security Policy — see `cspBlockedUploadMessage`
  // ---------------------------------------------------------------------------

  /** Idempotent. Attached only while parts can be in flight. */
  private attachCspListener(): void {
    if (this.cspUnsubscribe) return;
    this.cspUnsubscribe = this.runtime.onCspViolation((violation) =>
      this.handleCspViolation(violation),
    );
  }

  private detachCspListener(): void {
    const unsubscribe = this.cspUnsubscribe;
    this.cspUnsubscribe = null;
    unsubscribe?.();
  }

  private handleCspViolation(violation: CspViolation): void {
    // Older browsers may report the directive with its value attached.
    if (violation.directive.trim().split(/\s+/)[0] !== 'connect-src') return;
    // `blockedURI` is a full URL in some browsers and a bare origin in others;
    // comparing origins accepts both. A violation for an origin this upload
    // never targeted belongs to something else on the page.
    const origin = originOf(violation.blockedURI);
    if (origin === null || !this.partOrigins.has(origin)) return;
    this.cspBlockedOrigins.add(origin);
  }

  private handleOffline(): void {
    if (this.phase !== 'uploading') return;
    this.stopInFlight('paused');
    this.waitingForNetwork = true;
    this.emit();
  }

  private handleOnline(): void {
    if (!this.waitingForNetwork) return;
    this.waitingForNetwork = false;
    if (this.phase === 'paused') {
      this.start();
    } else {
      this.emit();
    }
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  /** Abort every in-flight PUT and move to `phase`, invalidating callbacks. */
  private stopInFlight(phase: UploadPhase): void {
    this.generation += 1;
    this.phase = phase;
    this.running = 0;
    // Pause, offline, cancel and fail all pass through here; `start()`
    // re-attaches on resume.
    this.detachCspListener();
    for (const [partNumber, xhr] of this.activeXhrs) {
      this.inFlightBytes.delete(partNumber);
      this.requeue(partNumber);
      try {
        xhr.abort();
      } catch {
        // An XHR that is already done throws nothing useful; ignore.
      }
    }
    this.activeXhrs.clear();
    for (const [partNumber, controller] of this.activeHostPuts) {
      this.inFlightBytes.delete(partNumber);
      this.requeue(partNumber);
      controller.abort();
    }
    this.activeHostPuts.clear();
    for (const timer of this.pendingTimers) {
      this.runtime.clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  private fail(message: string): void {
    if (this.isTerminal()) return;
    this.stopInFlight('failed');
    this.detachNetworkListeners();
    this.error = message;
    this.finish('failed', message);
  }

  private finish(status: UploadOutcome['status'], error: string | null): void {
    this.phase = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    this.error = error;
    // Covers `complete()`, the one terminal path that skips `stopInFlight`.
    this.detachCspListener();
    if (status === 'completed') {
      // Credit every part: a resumed upload never sent the parts S3 already
      // held, so summing observed bytes would finish a resumed 2 GB file at
      // "400 MB of 2 GB" — correct arithmetic, wrong answer.
      for (let part = 1; part <= this.totalParts; part += 1) this.done.add(part);
    }
    this.emit();
    if (this.isSettled) return;
    this.isSettled = true;
    this.settle({ objectId: this.objectId, status, error });
  }

  private isTerminal(): boolean {
    return this.phase === 'completed' || this.phase === 'cancelled' || this.phase === 'failed';
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const handle = this.runtime.setTimeout(() => {
        this.pendingTimers.delete(handle);
        resolve();
      }, ms);
      this.pendingTimers.add(handle);
    });
  }

  // ---------------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------------

  private uploadedBytes(): number {
    let total = 0;
    for (const part of this.done) total += this.partBytes(part);
    for (const [part, bytes] of this.inFlightBytes) {
      if (this.done.has(part)) continue;
      total += bytes;
    }
    return Math.min(total, this.totalBytes);
  }

  private recordSample(bytes: number): void {
    const t = this.runtime.now();
    this.samples.push({ t, bytes });
    while (this.samples.length > 1 && t - this.samples[0].t > SPEED_WINDOW_MS) {
      this.samples.shift();
    }
    while (this.samples.length > MAX_SPEED_SAMPLES) this.samples.shift();
  }

  /**
   * Moving average over `SPEED_WINDOW_MS`, not an all-time average.
   *
   * An all-time average on a 40-minute upload keeps reporting the speed of the
   * first minute long after the user walked out of Wi-Fi range, so the ETA it
   * feeds stays confidently wrong. A short window tracks the link the user is
   * actually on.
   */
  private speed(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t <= first.t) return 0;
    const bytes = last.bytes - first.bytes;
    if (bytes <= 0) return 0;
    return (bytes * 1000) / (last.t - first.t);
  }

  private buildSnapshot(): UploadProgress {
    const uploadedBytes = this.uploadedBytes();
    const bytesPerSecond = this.speed();
    const remaining = Math.max(0, this.totalBytes - uploadedBytes);
    return {
      phase: this.phase,
      uploadedBytes,
      totalBytes: this.totalBytes,
      percent:
        this.totalBytes === 0
          ? this.phase === 'completed'
            ? 100
            : 0
          : Math.min(100, Math.round((uploadedBytes / this.totalBytes) * 1000) / 10),
      completedParts: this.done.size,
      totalParts: this.totalParts,
      bytesPerSecond,
      etaSeconds: bytesPerSecond > 0 ? Math.round(remaining / bytesPerSecond) : null,
      error: this.error,
      waitingForNetwork: this.waitingForNetwork,
    };
  }

  private emit(): void {
    this.recordSample(this.uploadedBytes());
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        // A subscriber that throws must not take the upload down with it.
      }
    }
  }
}

// =============================================================================
// Factories
// =============================================================================

/**
 * Start an upload from an init response already in hand.
 *
 * Separate from `createTranscriptUpload` so the init call and the transfer can
 * be tested — and retried — independently, and so a caller that obtained an
 * init response some other way (a server-rendered hand-off, a test fixture)
 * does not have to fake an endpoint to use the engine.
 *
 * @stability experimental
 */
export function startUpload(
  host: KvoxWebHost,
  file: File,
  init: UploadInitResponse,
  options: ResumableUploadOptions = {},
): ResumableUpload {
  const upload = new UploadEngine(
    {
      host,
      file,
      objectId: init.objectId,
      partSize: init.partSize,
      totalParts: init.totalParts,
    },
    { ...options, presignedParts: init.parts ?? options.presignedParts },
  );
  upload.start();
  return upload;
}

/**
 * What {@link createTranscriptUpload} returns.
 *
 * @stability experimental
 */
export interface CreatedUpload {
  /** The running upload. */
  upload: ResumableUpload;
  /** The init response it was started from. */
  init: UploadInitResponse;
}

/**
 * Init + start through the PLATFORM's generic init route, for a file that is
 * not tied to a transcript row. (A transcript's own upload is initialised by
 * `POST /api/transcripts` and adopted through `startUpload`; the platform's
 * init takes no transcript id, so none is accepted here.)
 *
 * @stability experimental
 */
export async function createTranscriptUpload(
  host: KvoxWebHost,
  file: File,
  engineOptions: ResumableUploadOptions = {},
): Promise<CreatedUpload> {
  const init = await initUpload(host, {
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
  });
  return { upload: startUpload(host, file, init, engineOptions), init };
}

/**
 * Resume an upload the server already knows about.
 *
 * The resume state (`fetchUploadResumeState`, the provider's own part list) is
 * the ONLY authority on what has landed — never a local record of what this tab
 * believed it sent. A tab that died mid-PUT, another
 * device that uploaded some of the same object, a part S3 rejected after the
 * browser closed: all of them make a local tally wrong in the direction that
 * silently corrupts the object (skipping a part that was never stored).
 *
 * @stability experimental
 */
export function resumeUpload(
  host: KvoxWebHost,
  file: File,
  objectId: string,
  state: UploadResumeState,
  options: ResumableUploadOptions = {},
): ResumableUpload {
  const upload = new UploadEngine(
    {
      host,
      file,
      objectId,
      partSize: state.partSize,
      totalParts: state.totalParts,
    },
    {
      ...options,
      completedParts: state.uploadedParts,
    },
  );
  upload.start();
  return upload;
}

/**
 * What {@link createResumableUpload} needs: the file and its layout.
 *
 * @stability experimental
 */
export interface ResumableUploadInit extends ResumableUploadOptions {
  /** The file to send. */
  file: File;
  /** The storage object the server created for it. */
  objectId: string;
  /** Bytes per part, as the init response set it. */
  partSize: number;
  /** How many parts the file has. */
  totalParts: number;
}

/**
 * Builds an upload engine WITHOUT starting it. Call `start()` when ready.
 *
 * @remarks
 * The lower-level form of {@link startUpload} and {@link resumeUpload}, for a
 * caller that wants to subscribe before the first byte moves. Seed
 * `completedParts` to resume and `presignedParts` with the init response.
 *
 * @param host - The host whose `http` carries the control plane.
 * @param init - The file, its object and part layout, and the engine options.
 * @returns The upload handle, in the `idle` phase.
 *
 * @stability experimental
 */
export function createResumableUpload(host: KvoxWebHost, init: ResumableUploadInit): ResumableUpload {
  const { file, objectId, partSize, totalParts, ...options } = init;
  return new UploadEngine({ host, file, objectId, partSize, totalParts }, options);
}
