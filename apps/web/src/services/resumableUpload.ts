/**
 * The resumable upload engine — issue #22, epic #19.
 *
 * =============================================================================
 * WHY THIS IS NOT BUILT ON `services/api.ts`
 * =============================================================================
 *
 * `ApiService.request` is `fetch`-based, and **`fetch` cannot report upload
 * progress**. There is no `upload.onprogress` equivalent in the Fetch API: a
 * `fetch()` with a 5 GB body resolves once, at the end, and reports nothing in
 * between. `ReadableStream` request bodies (the only workaround) are
 * HTTP/2-only, unsupported in Safari, and require `duplex: 'half'`.
 *
 * A recording that takes twenty minutes to upload on a phone with no progress
 * bar is indistinguishable from a hung app, so the part PUTs in this file use
 * `XMLHttpRequest` — the one transport in every browser that emits byte-level
 * upload progress. The CONTROL PLANE (init, presign, status, complete, abort)
 * still goes through `api`, so it inherits the bearer token, the one-shot
 * 401 → refresh → retry, and the maintenance interception like everything else.
 *
 * =============================================================================
 * THE PART PUTS ARE CROSS-ORIGIN AND MUST STAY THAT WAY
 * =============================================================================
 *
 * Every part goes DIRECTLY to a presigned S3 URL. The bytes never touch the
 * API — the same data-plane rule the worker-node design follows
 * (`docs/specs/worker-nodes.md`) — which is what makes a multi-gigabyte upload
 * from a phone survivable at all.
 *
 * Two consequences are load-bearing:
 *
 *   1. **The client never reads the `ETag` response header.** A cross-origin
 *      response exposes no headers unless the bucket's CORS policy lists them
 *      in `ExposeHeaders`, and one misconfigured bucket would then break every
 *      upload with an error that looks like a client bug. This is why
 *      `completeUpload` below sends NO `parts` array: the server reconstructs
 *      the part list with S3 `ListParts`, which is authoritative anyway (it
 *      describes what S3 actually holds, not what this client believes it
 *      sent).
 *   2. **The service worker must never see these requests.** `src/sw.ts`
 *      registers exactly one route, a `NavigationRoute`, which matches only
 *      `request.mode === 'navigate'` — a part PUT is `cors`, so it bypasses
 *      the worker entirely. There is no `fetch` listener and no runtime-caching
 *      strategy, deliberately; see `src/__tests__/pwa/service-worker-uploads.test.ts`,
 *      which asserts it rather than assuming it.
 *
 * =============================================================================
 * NO REACT IN THIS FILE
 * =============================================================================
 *
 * Progress is emitted through a `subscribe()` callback, not React state. An
 * upload outlives the component that started it — that is the whole point of
 * `UploadManagerContext` — and an engine that called `setState` could not be
 * driven from a test without a renderer, could not keep running while its
 * screen is unmounted, and would re-render the app on every one of the
 * hundreds of progress events a large file produces. The provider subscribes
 * and throttles into React; this module only ever calls listeners.
 */

import { api, ApiError } from './api';

// =============================================================================
// Wire shapes — the contract of issue #21's endpoints
// =============================================================================

/** One presigned part URL, as the init and parts endpoints return it. */
export interface PresignedPart {
  partNumber: number;
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

/** `POST /api/storage/objects/upload/init`. */
export interface UploadInitRequest {
  fileName: string;
  size: number;
  contentType: string;
  /** The transcript this upload belongs to, when one exists already. */
  transcriptId?: string | null;
}

/** The init response — and everything the engine needs to lay out the file. */
export interface UploadInitResponse {
  objectId: string;
  partSize: number;
  totalParts: number;
  uploadId: string;
  /** The FIRST BATCH of presigned URLs, not necessarily all of them. */
  parts: PresignedPart[];
}

/** One part the server already holds, from the status endpoint. */
export interface UploadedPart {
  partNumber: number;
  size: number;
}

/** `GET /api/storage/objects/:id/upload/status` — the resume oracle. */
export interface UploadStatusResponse {
  status: string;
  partSize: number;
  totalParts: number;
  uploadedParts: UploadedPart[];
  uploadedBytes: number;
  totalBytes: number;
}

// =============================================================================
// Progress
// =============================================================================

/**
 * Where an upload is. `completing` is deliberately distinct from `uploading`:
 * the last byte is sent but `POST …/complete` (an S3 `CompleteMultipartUpload`
 * behind it) can take seconds on a large object, and a progress bar frozen at
 * 100% with no explanation is the single most common "is it stuck?" report.
 */
export type UploadPhase =
  | 'idle'
  | 'uploading'
  | 'paused'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Immutable snapshot handed to every subscriber. Never mutated in place. */
export interface UploadProgress {
  phase: UploadPhase;
  /** Bytes S3 has acknowledged, plus bytes currently in flight. */
  uploadedBytes: number;
  totalBytes: number;
  /** 0-100, clamped. */
  percent: number;
  /** Parts fully acknowledged by S3. */
  completedParts: number;
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

export type UploadProgressListener = (progress: UploadProgress) => void;

/** How an upload ended. `whenSettled()` resolves with this and never rejects. */
export interface UploadOutcome {
  objectId: string;
  status: 'completed' | 'cancelled' | 'failed';
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
 */
export interface UploadRuntime {
  now(): number;
  random(): number;
  createXhr(): XMLHttpRequest;
  isOnline(): boolean;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  /** Parts uploaded in parallel. See `detectPartConcurrency`. */
  concurrency(): number;
}

/** Parallel part uploads on a phone. */
export const MOBILE_PART_CONCURRENCY = 3;
/** Parallel part uploads on a desktop. */
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

export const defaultUploadRuntime: UploadRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  createXhr: () => new XMLHttpRequest(),
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  concurrency: () => detectPartConcurrency(),
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
 */
export const PART_URL_BATCH_SIZE = 50;

/**
 * Treat a URL as dead this long BEFORE its stated expiry.
 *
 * A part PUT that starts one second before expiry and takes thirty seconds on
 * a phone link is a 403 that the engine then has to discover, re-presign and
 * retry — having already sent the bytes. The skew spends a cheap re-presign to
 * avoid re-sending a part.
 */
export const URL_EXPIRY_SKEW_MS = 30_000;

/** Window the speed moving average is computed over. */
export const SPEED_WINDOW_MS = 5_000;

/** Cap on retained speed samples, so a long upload cannot grow one unboundedly. */
const MAX_SPEED_SAMPLES = 240;

/** Per-part retry policy. Overridable per upload, mostly so tests run fast. */
export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

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
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: number): number {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + exponential * 0.5 * random);
}

// =============================================================================
// Control-plane calls
// =============================================================================

export async function initUpload(input: UploadInitRequest): Promise<UploadInitResponse> {
  return api.post<UploadInitResponse>('/storage/objects/upload/init', input);
}

/**
 * Ask for more presigned part URLs.
 *
 * ⚠️ The endpoint rejects more than 100 part numbers per call. Callers here
 * never exceed `PART_URL_BATCH_SIZE`; the slice below is belt-and-braces so a
 * future caller cannot turn that into a 400 at runtime.
 */
export async function requestUploadParts(
  objectId: string,
  partNumbers: number[],
): Promise<PresignedPart[]> {
  return api.post<PresignedPart[]>(`/storage/objects/${objectId}/upload/parts`, {
    partNumbers: partNumbers.slice(0, 100),
  });
}

export async function fetchUploadStatus(objectId: string): Promise<UploadStatusResponse> {
  return api.get<UploadStatusResponse>(`/storage/objects/${objectId}/upload/status`);
}

/**
 * Finish the upload.
 *
 * **Sends no `parts`, ever.** See the file header: the client cannot read
 * cross-origin `ETag` headers, and the server's `ListParts` reconstruction is
 * the authoritative answer anyway. Adding a `parts` body here would make every
 * upload depend on a bucket CORS `ExposeHeaders` entry.
 */
export async function completeUpload(objectId: string): Promise<void> {
  await api.post<void>(`/storage/objects/${objectId}/upload/complete`);
}

export async function abortUpload(objectId: string): Promise<void> {
  await api.delete<void>(`/storage/objects/${objectId}/upload/abort`);
}

// =============================================================================
// Errors
// =============================================================================

/** A part exhausted its attempts, or the control plane refused. Terminal. */
export class UploadFailedError extends Error {
  constructor(
    message: string,
    readonly partNumber?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UploadFailedError';
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

export interface ResumableUpload {
  readonly objectId: string;
  readonly fileName: string;
  readonly totalBytes: number;
  /** The current snapshot. Cheap; safe to call in a render. */
  getProgress(): UploadProgress;
  /** Returns an unsubscribe function. Fires immediately with the current state. */
  subscribe(listener: UploadProgressListener): () => void;
  /** Idempotent: a second call while running does nothing. */
  start(): void;
  pause(): void;
  resume(): void;
  /** Aborts every in-flight PUT and calls `DELETE …/upload/abort`. */
  cancel(): Promise<void>;
  /** Resolves when the upload reaches a terminal phase. NEVER REJECTS. */
  whenSettled(): Promise<UploadOutcome>;
}

export interface ResumableUploadOptions {
  runtime?: Partial<UploadRuntime>;
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

  constructor(config: UploadEngineConfig, options: ResumableUploadOptions = {}) {
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
      await abortUpload(this.objectId);
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
      await completeUpload(this.objectId);
    } catch (err) {
      this.fail(err instanceof ApiError ? err.message : 'Could not finalise the upload');
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
          err instanceof ApiError
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

        if (attempt === this.retry.maxAttempts) {
          throw new UploadFailedError(
            `Part ${partNumber} failed after ${attempt} attempts`,
            partNumber,
            lastStatus,
          );
        }

        await this.delay(backoffDelayMs(attempt, this.retry, this.runtime.random()));
      }
    }
  }

  /** The one place `XMLHttpRequest` is used. See the file header for why. */
  private putPart(partNumber: number, url: string, generation: number): Promise<void> {
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

      xhr.open('PUT', url, true);
      // NO `Authorization` HEADER, and no `withCredentials`. The presigned URL
      // carries its own signature; adding either would make the browser send a
      // preflight the bucket is unlikely to answer, and S3 rejects a request
      // that is signed two ways.
      xhr.send(blob);
    });
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
      const parts = await requestUploadParts(this.objectId, wanted);
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
 */
export function startUpload(
  file: File,
  init: UploadInitResponse,
  options: ResumableUploadOptions = {},
): ResumableUpload {
  const upload = new UploadEngine(
    {
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
 * Init + start, the ordinary path from a file picker.
 *
 * `transcriptId` is optional because a file can be uploaded before the
 * transcript row exists (issue #30's New-transcript screen creates the
 * transcript from the finished object).
 */
export async function createTranscriptUpload(
  file: File,
  options: ResumableUploadOptions & { transcriptId?: string | null } = {},
): Promise<{ upload: ResumableUpload; init: UploadInitResponse }> {
  const { transcriptId, ...engineOptions } = options;
  const init = await initUpload({
    fileName: file.name,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
    transcriptId: transcriptId ?? null,
  });
  return { upload: startUpload(file, init, engineOptions), init };
}

/**
 * Resume an upload the server already knows about.
 *
 * The status response is the ONLY authority on what has landed — never a local
 * record of what this tab believed it sent. A tab that died mid-PUT, another
 * device that uploaded some of the same object, a part S3 rejected after the
 * browser closed: all of them make a local tally wrong in the direction that
 * silently corrupts the object (skipping a part that was never stored).
 */
export function resumeUpload(
  file: File,
  objectId: string,
  status: UploadStatusResponse,
  options: ResumableUploadOptions = {},
): ResumableUpload {
  const upload = new UploadEngine(
    {
      file,
      objectId,
      partSize: status.partSize,
      totalParts: status.totalParts,
    },
    {
      ...options,
      completedParts: status.uploadedParts.map((part) => part.partNumber),
    },
  );
  upload.start();
  return upload;
}
