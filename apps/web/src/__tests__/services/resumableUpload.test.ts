/**
 * The resumable upload engine — issue #22, epic #19.
 *
 * The control plane (init, presign, status, complete, abort) is answered by
 * MSW; the part PUTs are driven by hand through the shared fake
 * `XMLHttpRequest` (`../utils/fakeXhr`), because every property worth
 * asserting here is about TIMING — bytes reported mid-flight, a request
 * aborted halfway, a retry that must wait — and a mocked transport that simply
 * answers cannot express any of it.
 *
 * Time, randomness and `navigator.onLine` come from the injected
 * `UploadRuntime`, so "backs off exponentially with jitter" is asserted on the
 * delays the engine ASKS FOR rather than by sleeping through them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { createFakeXhrFactory, type FakeXhrController } from '../utils/fakeXhr';
import {
  backoffDelayMs,
  cspBlockedUploadMessage,
  defaultUploadRuntime,
  detectPartConcurrency,
  DESKTOP_PART_CONCURRENCY,
  MOBILE_PART_CONCURRENCY,
  resumeUpload,
  startUpload,
  createTranscriptUpload,
  type CspViolation,
  type UploadInitResponse,
  type UploadRuntime,
  type UploadStatusResponse,
} from '../../services/resumableUpload';

const API = '*/api';
const OBJECT_ID = 'obj-1';
const PART_SIZE = 10;
const TOTAL_PARTS = 3;
const TOTAL_BYTES = PART_SIZE * TOTAL_PARTS;

/** Far enough in the future that the engine never treats it as expired. */
const FRESH = new Date('2099-01-01T00:00:00.000Z').toISOString();
/** 1970 — every clock this suite uses is well past it. */
const EXPIRED = new Date(0).toISOString();

function makeFile(size = TOTAL_BYTES, name = 'recording.m4a', lastModified = 111): File {
  return new File([new Uint8Array(size)], name, {
    type: 'audio/mp4',
    lastModified,
  });
}

function makeInit(overrides: Partial<UploadInitResponse> = {}): UploadInitResponse {
  return {
    objectId: OBJECT_ID,
    partSize: PART_SIZE,
    totalParts: TOTAL_PARTS,
    uploadId: 'upload-1',
    parts: Array.from({ length: TOTAL_PARTS }, (_, index) => ({
      partNumber: index + 1,
      url: `https://s3.example.com/${OBJECT_ID}/part-${index + 1}?sig=init`,
      expiresAt: FRESH,
    })),
    ...overrides,
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${message}`);
    await tick();
  }
}

describe('resumable upload engine', () => {
  let xhr: FakeXhrController;
  let clock: number;
  let online: boolean;
  let delays: number[];
  let runtime: Partial<UploadRuntime>;
  let completeCalls: number;
  let abortCalls: number;
  let partRequests: number[][];
  /** The handler `UploadEngine` last subscribed with, or `null` once unsubscribed. */
  let cspHandler: ((violation: CspViolation) => void) | null;
  let cspSubscribeCount: number;
  let cspUnsubscribeCount: number;

  /**
   * A controllable stand-in for `subscribeToCspViolations`: tests dispatch a
   * violation by calling `cspHandler?.(...)` directly, and the subscribe/
   * unsubscribe counters pin the engine's listener lifecycle (attached once
   * per `start()`, detached on pause/cancel/fail/complete).
   */
  function fakeOnCspViolation(handler: (violation: CspViolation) => void): () => void {
    cspHandler = handler;
    cspSubscribeCount += 1;
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      if (cspHandler === handler) cspHandler = null;
      cspUnsubscribeCount += 1;
    };
  }

  beforeEach(() => {
    xhr = createFakeXhrFactory();
    clock = 1_000_000;
    online = true;
    delays = [];
    completeCalls = 0;
    abortCalls = 0;
    partRequests = [];
    cspHandler = null;
    cspSubscribeCount = 0;
    cspUnsubscribeCount = 0;

    runtime = {
      now: () => clock,
      // Mid-range jitter, so `backoffDelayMs` is exactly predictable.
      random: () => 0.5,
      createXhr: xhr.createXhr,
      isOnline: () => online,
      concurrency: () => 2,
      setTimeout: (handler, ms) => {
        delays.push(ms);
        // Run the retry immediately: the DELAY VALUE is what is asserted, and
        // actually sleeping for it would make the suite take minutes.
        return globalThis.setTimeout(handler, 0) as unknown as number;
      },
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
      onCspViolation: fakeOnCspViolation,
    };

    server.use(
      http.post(`${API}/storage/objects/upload/init`, () =>
        HttpResponse.json({ data: makeInit() }),
      ),
      http.post(`${API}/storage/objects/:id/upload/parts`, async ({ request }) => {
        const body = (await request.json()) as { partNumbers: number[] };
        partRequests.push(body.partNumbers);
        return HttpResponse.json({
          data: body.partNumbers.map((partNumber) => ({
            partNumber,
            url: `https://s3.example.com/${OBJECT_ID}/part-${partNumber}?sig=fresh`,
            expiresAt: FRESH,
          })),
        });
      }),
      http.post(`${API}/storage/objects/:id/upload/complete`, () => {
        completeCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`${API}/storage/objects/:id/upload/abort`, () => {
        abortCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
  });

  afterEach(() => {
    xhr.reset();
  });

  // ---------------------------------------------------------------------------

  describe('progress across parallel parts', () => {
    it('combines in-flight bytes from every part, and computes speed and ETA', async () => {
      const upload = startUpload(makeFile(), makeInit(), { runtime });

      // Concurrency is 2, so exactly two parts are in flight and the third
      // waits — if this ever became "all three", the engine would be ignoring
      // its own concurrency budget.
      const inFlight = await xhr.waitForPending(2);
      expect(inFlight).toHaveLength(2);
      expect(xhr.requests.every((request) => request.method === 'PUT')).toBe(true);

      clock += 1_000;
      inFlight[0].progress(6);
      inFlight[1].progress(4);

      const midway = upload.getProgress();
      // 6 + 4 of 30 — the point of the test: progress is the SUM across
      // concurrent parts, not the latest part's own count.
      expect(midway.uploadedBytes).toBe(10);
      expect(midway.percent).toBeCloseTo(33.3, 1);
      expect(midway.phase).toBe('uploading');
      // 10 bytes in 1 second.
      expect(midway.bytesPerSecond).toBe(10);
      // 20 bytes left at 10 B/s.
      expect(midway.etaSeconds).toBe(2);

      inFlight[0].respond();
      inFlight[1].respond();

      await waitUntil(
        () => upload.getProgress().completedParts === 2,
        'two parts acknowledged',
      );
      expect(upload.getProgress().uploadedBytes).toBe(20);

      const last = await xhr.waitForPending(1);
      last[0].respond();

      const outcome = await upload.whenSettled();
      expect(outcome.status).toBe('completed');
      expect(completeCalls).toBe(1);

      const final = upload.getProgress();
      expect(final.phase).toBe('completed');
      expect(final.percent).toBe(100);
      expect(final.uploadedBytes).toBe(TOTAL_BYTES);
    });

    it('notifies subscribers and stops when they unsubscribe', async () => {
      const listener = vi.fn();
      const upload = startUpload(makeFile(), makeInit(), { runtime });
      const unsubscribe = upload.subscribe(listener);

      // Fires immediately with the current snapshot, so a component that
      // mounts mid-upload paints the right thing on its first render.
      expect(listener).toHaveBeenCalledTimes(1);

      const inFlight = await xhr.waitForPending(2);
      inFlight[0].progress(5);
      expect(listener).toHaveBeenCalledTimes(2);

      unsubscribe();
      inFlight[0].progress(8);
      expect(listener).toHaveBeenCalledTimes(2);

      await upload.cancel();
    });
  });

  // ---------------------------------------------------------------------------

  describe('retries', () => {
    it('retries a failed part with exponential, jittered backoff and then succeeds', async () => {
      const upload = startUpload(makeFile(PART_SIZE), makeInit({ totalParts: 1 }), {
        runtime: { ...runtime, concurrency: () => 1 },
        retry: { maxAttempts: 4, baseMs: 100, maxMs: 10_000 },
      });

      const first = await xhr.waitForPending(1);
      first[0].networkError();

      const second = await xhr.waitForRequests(2);
      expect(second).toHaveLength(2);
      second[1].networkError();

      await xhr.waitForRequests(3);
      xhr.requests[2].respond();

      const outcome = await upload.whenSettled();
      expect(outcome.status).toBe('completed');

      // Equal jitter at `random() === 0.5`: half the exponential delay plus
      // half of it scaled by the jitter roll. 100 -> 75, 200 -> 150.
      expect(delays).toEqual([
        backoffDelayMs(1, { maxAttempts: 4, baseMs: 100, maxMs: 10_000 }, 0.5),
        backoffDelayMs(2, { maxAttempts: 4, baseMs: 100, maxMs: 10_000 }, 0.5),
      ]);
      expect(delays).toEqual([75, 150]);
    });

    it('fails terminally once the attempt budget is spent', async () => {
      const upload = startUpload(makeFile(PART_SIZE), makeInit({ totalParts: 1 }), {
        runtime: { ...runtime, concurrency: () => 1 },
        retry: { maxAttempts: 2, baseMs: 1, maxMs: 10 },
      });

      await xhr.waitForRequests(1);
      xhr.requests[0].networkError();
      await xhr.waitForRequests(2);
      xhr.requests[1].networkError();

      const outcome = await upload.whenSettled();
      expect(outcome.status).toBe('failed');
      expect(upload.getProgress().phase).toBe('failed');
      expect(upload.getProgress().error).toMatch(/Part 1 failed after 2 attempts/);
      expect(completeCalls).toBe(0);
    });

    it('treats a 403 from S3 as an expired URL: re-presigns, then retries', async () => {
      const upload = startUpload(makeFile(PART_SIZE), makeInit({ totalParts: 1 }), {
        runtime: { ...runtime, concurrency: () => 1 },
        retry: { maxAttempts: 3, baseMs: 1, maxMs: 10 },
      });

      const first = await xhr.waitForPending(1);
      expect(first[0].url).toContain('sig=init');
      first[0].respond(403);

      await xhr.waitForRequests(2);
      // The retry uses a NEWLY MINTED URL, not the one that just 403'd —
      // retrying the dead signature would fail identically forever.
      expect(xhr.requests[1].url).toContain('sig=fresh');
      expect(partRequests).toEqual([[1]]);

      xhr.requests[1].respond();
      expect((await upload.whenSettled()).status).toBe('completed');
    });

    it('re-presigns before sending when the URL it holds has already expired', async () => {
      const upload = startUpload(
        makeFile(PART_SIZE),
        makeInit({
          totalParts: 1,
          parts: [
            {
              partNumber: 1,
              url: 'https://s3.example.com/obj-1/part-1?sig=stale',
              expiresAt: EXPIRED,
            },
          ],
        }),
        {
          runtime: { ...runtime, concurrency: () => 1 },
          retry: { maxAttempts: 2, baseMs: 1, maxMs: 10 },
        },
      );

      const first = await xhr.waitForPending(1);
      // Never even attempted with the stale signature: a locally-known expiry
      // is spent on one small JSON call instead of on re-sending the bytes.
      expect(first[0].url).toContain('sig=fresh');
      expect(partRequests).toEqual([[1]]);

      first[0].respond();
      expect((await upload.whenSettled()).status).toBe('completed');
    });

    it('asks for presigned URLs in batches rather than one per part', async () => {
      const upload = startUpload(
        makeFile(),
        makeInit({ parts: [] }),
        { runtime },
      );

      await xhr.waitForPending(2);
      // ONE call covering every part still needing a URL, not one call per
      // part: `concurrency` parts all discovering an empty cache at once must
      // not produce `concurrency` round trips.
      expect(partRequests).toEqual([[1, 2, 3]]);

      await upload.cancel();
    });
  });

  // ---------------------------------------------------------------------------

  describe('network awareness and manual control', () => {
    it('pauses when the browser goes offline and resumes when it returns', async () => {
      const upload = startUpload(makeFile(), makeInit(), { runtime });
      const inFlight = await xhr.waitForPending(2);

      online = false;
      window.dispatchEvent(new Event('offline'));

      const paused = upload.getProgress();
      expect(paused.phase).toBe('paused');
      // Distinct from a user's pause: the UI says "waiting for network"
      // rather than offering a Resume button that would do nothing.
      expect(paused.waitingForNetwork).toBe(true);
      expect(inFlight.every((request) => request.aborted)).toBe(true);

      const sentBeforeOffline = xhr.requests.length;

      online = true;
      window.dispatchEvent(new Event('online'));

      await waitUntil(
        () => xhr.requests.length > sentBeforeOffline,
        'parts re-sent after coming back online',
      );
      expect(upload.getProgress().phase).toBe('uploading');
      expect(upload.getProgress().waitingForNetwork).toBe(false);

      await upload.cancel();
    });

    it('starts parked when the browser is already offline', async () => {
      online = false;
      const upload = startUpload(makeFile(), makeInit(), { runtime });

      expect(upload.getProgress().phase).toBe('paused');
      expect(upload.getProgress().waitingForNetwork).toBe(true);
      expect(xhr.requests).toHaveLength(0);

      online = true;
      window.dispatchEvent(new Event('online'));
      await xhr.waitForPending(2);
      expect(upload.getProgress().phase).toBe('uploading');

      await upload.cancel();
    });

    it('pauses and resumes on demand, re-sending the part it abandoned', async () => {
      const upload = startUpload(makeFile(), makeInit(), { runtime });
      const inFlight = await xhr.waitForPending(2);
      inFlight[0].progress(5);

      upload.pause();

      expect(upload.getProgress().phase).toBe('paused');
      expect(upload.getProgress().waitingForNetwork).toBe(false);
      expect(inFlight.every((request) => request.aborted)).toBe(true);
      // S3 has no partial-part concept, so the 5 bytes pushed for part 1 are
      // gone — reporting them would be a progress bar that goes backwards.
      expect(upload.getProgress().uploadedBytes).toBe(0);

      upload.resume();
      const resumed = await xhr.waitForPending(2);
      expect(resumed).toHaveLength(2);
      expect(xhr.requests).toHaveLength(4);

      await upload.cancel();
    });

    it('cancel aborts every in-flight part and tells the API to abort the upload', async () => {
      const upload = startUpload(makeFile(), makeInit(), { runtime });
      const inFlight = await xhr.waitForPending(2);

      await upload.cancel();

      expect(inFlight.every((request) => request.aborted)).toBe(true);
      expect(abortCalls).toBe(1);
      expect(upload.getProgress().phase).toBe('cancelled');
      expect((await upload.whenSettled()).status).toBe('cancelled');
      expect(completeCalls).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------

  describe('resume', () => {
    it('uploads only the parts the status endpoint says are missing', async () => {
      const status: UploadStatusResponse = {
        status: 'uploading',
        partSize: PART_SIZE,
        totalParts: TOTAL_PARTS,
        uploadedParts: [
          { partNumber: 1, size: PART_SIZE },
          { partNumber: 2, size: PART_SIZE },
        ],
        uploadedBytes: 2 * PART_SIZE,
        totalBytes: TOTAL_BYTES,
      };

      const upload = resumeUpload(makeFile(), OBJECT_ID, status, { runtime });

      // Credited for what the SERVER holds before a single byte is re-sent.
      expect(upload.getProgress().uploadedBytes).toBe(20);
      expect(upload.getProgress().completedParts).toBe(2);

      const inFlight = await xhr.waitForPending(1);
      expect(xhr.requests).toHaveLength(1);
      expect(inFlight[0].url).toContain('part-3');
      expect(partRequests).toEqual([[3]]);

      inFlight[0].respond();
      expect((await upload.whenSettled()).status).toBe('completed');
      expect(upload.getProgress().percent).toBe(100);
    });

    it('completes immediately when the server already holds every part', async () => {
      const status: UploadStatusResponse = {
        status: 'uploading',
        partSize: PART_SIZE,
        totalParts: TOTAL_PARTS,
        uploadedParts: [1, 2, 3].map((partNumber) => ({ partNumber, size: PART_SIZE })),
        uploadedBytes: TOTAL_BYTES,
        totalBytes: TOTAL_BYTES,
      };

      const upload = resumeUpload(makeFile(), OBJECT_ID, status, { runtime });

      expect((await upload.whenSettled()).status).toBe('completed');
      expect(xhr.requests).toHaveLength(0);
      expect(completeCalls).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------

  describe('createTranscriptUpload', () => {
    it('inits against the API and starts transferring', async () => {
      const { upload, init } = await createTranscriptUpload(makeFile(), {
        runtime,
        transcriptId: 'transcript-9',
      });

      expect(init.objectId).toBe(OBJECT_ID);
      await xhr.waitForPending(2);
      expect(upload.getProgress().phase).toBe('uploading');

      await upload.cancel();
    });
  });

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------

  describe('CSP-blocked part PUTs — issue #84', () => {
    it('fails fast with exactly one PUT attempt when the violation arrives before the XHR error', async () => {
      const upload = startUpload(makeFile(PART_SIZE), makeInit({ totalParts: 1 }), {
        runtime: { ...runtime, concurrency: () => 1 },
        retry: { maxAttempts: 5, baseMs: 100, maxMs: 1000 },
      });

      const first = await xhr.waitForPending(1);
      const fullUrl = first[0].url;
      const origin = new URL(fullUrl).origin;

      // Real Chromium reports the FULL presigned URL, query string included.
      cspHandler?.({ blockedURI: fullUrl, directive: 'connect-src' });
      first[0].networkError();

      const outcome = await upload.whenSettled();
      expect(outcome.status).toBe('failed');
      expect(outcome.error).toBe(cspBlockedUploadMessage(origin));
      expect(upload.getProgress().error).toBe(cspBlockedUploadMessage(origin));

      // No retry loop was ever entered: one PUT, no backoff, no re-presign.
      expect(xhr.requests).toHaveLength(1);
      expect(delays).toHaveLength(0);
      expect(partRequests).toHaveLength(0);
    });

    it('fails after the first backoff when the violation (bare origin) arrives after the XHR error', async () => {
      const upload = startUpload(makeFile(PART_SIZE), makeInit({ totalParts: 1 }), {
        runtime: { ...runtime, concurrency: () => 1 },
        retry: { maxAttempts: 5, baseMs: 1, maxMs: 10 },
      });

      const first = await xhr.waitForPending(1);
      const origin = new URL(first[0].url).origin;

      first[0].networkError();
      // Let the engine's immediate post-error check run (and find nothing)
      // and its backoff timer be scheduled, before the violation arrives.
      await tick();
      expect(delays).toHaveLength(1);

      // Some browsers report a bare origin rather than the full URL.
      cspHandler?.({ blockedURI: origin, directive: 'connect-src' });

      const outcome = await upload.whenSettled();
      expect(outcome.status).toBe('failed');
      expect(outcome.error).toBe(cspBlockedUploadMessage(origin));

      // The second (post-backoff) check caught it: no second PUT was sent.
      expect(xhr.requests).toHaveLength(1);
      expect(delays).toHaveLength(1);
    });

    it('ignores violations for other origins, non-connect-src directives, and unparseable blockedURIs', async () => {
      const upload = startUpload(makeFile(PART_SIZE), makeInit({ totalParts: 1 }), {
        runtime: { ...runtime, concurrency: () => 1 },
        retry: { maxAttempts: 2, baseMs: 1, maxMs: 10 },
      });

      const first = await xhr.waitForPending(1);

      // A different origin, correct directive.
      cspHandler?.({
        blockedURI: 'https://not-the-storage-origin.example.com/x',
        directive: 'connect-src',
      });
      // The right origin, wrong directives.
      cspHandler?.({ blockedURI: first[0].url, directive: 'img-src' });
      cspHandler?.({ blockedURI: first[0].url, directive: 'script-src' });
      // A CSP keyword, not a URL — deliberately unparseable.
      cspHandler?.({ blockedURI: 'inline', directive: 'connect-src' });

      first[0].networkError();
      const second = await xhr.waitForRequests(2);
      second[1].networkError();

      const outcome = await upload.whenSettled();
      expect(outcome.status).toBe('failed');
      expect(outcome.error).toMatch(/^Part 1 failed after 2 attempts$/);
      expect(xhr.requests).toHaveLength(2);
    });

    it('does not treat an HTTP error as a CSP block, even with a violation recorded for that origin', async () => {
      const upload = startUpload(makeFile(PART_SIZE), makeInit({ totalParts: 1 }), {
        runtime: { ...runtime, concurrency: () => 1 },
        retry: { maxAttempts: 2, baseMs: 1, maxMs: 10 },
      });

      const first = await xhr.waitForPending(1);
      cspHandler?.({ blockedURI: first[0].url, directive: 'connect-src' });
      // A real HTTP response (e.g. S3 500), not a status-0 network drop.
      first[0].respond(500);

      const second = await xhr.waitForRequests(2);
      second[1].respond(500);

      const outcome = await upload.whenSettled();
      expect(outcome.status).toBe('failed');
      expect(outcome.error).toMatch(/^Part 1 failed after 2 attempts$/);
      expect(outcome.error).not.toContain('Content Security Policy');
    });

    describe('listener lifecycle', () => {
      it('subscribes once on start, unsubscribes on pause, and re-subscribes on resume', async () => {
        const upload = startUpload(makeFile(), makeInit(), { runtime });
        await xhr.waitForPending(2);
        expect(cspSubscribeCount).toBe(1);
        expect(cspUnsubscribeCount).toBe(0);

        upload.pause();
        expect(cspUnsubscribeCount).toBe(1);

        upload.resume();
        await xhr.waitForPending(2);
        expect(cspSubscribeCount).toBe(2);
        expect(cspUnsubscribeCount).toBe(1);

        await upload.cancel();
        expect(cspUnsubscribeCount).toBe(2);
      });

      it('never double-subscribes across repeated start() calls', async () => {
        const upload = startUpload(makeFile(), makeInit(), { runtime });
        await xhr.waitForPending(2);
        upload.start();
        upload.start();
        expect(cspSubscribeCount).toBe(1);

        await upload.cancel();
      });

      it('unsubscribes when the browser goes offline and re-subscribes when it returns', async () => {
        const upload = startUpload(makeFile(), makeInit(), { runtime });
        await xhr.waitForPending(2);
        expect(cspSubscribeCount).toBe(1);

        online = false;
        window.dispatchEvent(new Event('offline'));
        expect(cspUnsubscribeCount).toBe(1);

        online = true;
        window.dispatchEvent(new Event('online'));
        await xhr.waitForPending(2);
        expect(cspSubscribeCount).toBe(2);

        await upload.cancel();
      });

      it('unsubscribes on terminal failure', async () => {
        const upload = startUpload(makeFile(PART_SIZE), makeInit({ totalParts: 1 }), {
          runtime: { ...runtime, concurrency: () => 1 },
          retry: { maxAttempts: 1, baseMs: 1, maxMs: 10 },
        });
        const first = await xhr.waitForPending(1);
        expect(cspSubscribeCount).toBe(1);

        first[0].networkError();

        const outcome = await upload.whenSettled();
        expect(outcome.status).toBe('failed');
        expect(cspUnsubscribeCount).toBe(1);
      });

      it('unsubscribes on cancel', async () => {
        const upload = startUpload(makeFile(), makeInit(), { runtime });
        await xhr.waitForPending(2);
        expect(cspSubscribeCount).toBe(1);

        await upload.cancel();
        expect(cspUnsubscribeCount).toBe(1);
      });

      it('unsubscribes on successful completion', async () => {
        const upload = startUpload(makeFile(PART_SIZE), makeInit({ totalParts: 1 }), {
          runtime: { ...runtime, concurrency: () => 1 },
        });
        const first = await xhr.waitForPending(1);
        expect(cspSubscribeCount).toBe(1);

        first[0].respond();

        const outcome = await upload.whenSettled();
        expect(outcome.status).toBe('completed');
        expect(cspUnsubscribeCount).toBe(1);
      });
    });
  });

  // ---------------------------------------------------------------------------

  describe('cspBlockedUploadMessage', () => {
    it('names the blocked origin and the STORAGE_CSP_ORIGIN setting', () => {
      const message = cspBlockedUploadMessage('https://storage.example.com');
      expect(message).toContain('https://storage.example.com');
      expect(message).toContain('STORAGE_CSP_ORIGIN');
    });
  });

  // ---------------------------------------------------------------------------

  describe('defaultUploadRuntime.onCspViolation (real DOM listener)', () => {
    it('maps blockedURI and effectiveDirective from a real securitypolicyviolation event, and stops after unsubscribe', () => {
      const handler = vi.fn();
      const unsubscribe = defaultUploadRuntime.onCspViolation(handler);

      const event = new Event('securitypolicyviolation');
      Object.defineProperty(event, 'blockedURI', {
        value: 'https://blocked.example.com/part-1?sig=x',
        configurable: true,
      });
      Object.defineProperty(event, 'effectiveDirective', {
        value: 'connect-src',
        configurable: true,
      });
      Object.defineProperty(event, 'violatedDirective', {
        value: "connect-src 'self'",
        configurable: true,
      });

      document.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        blockedURI: 'https://blocked.example.com/part-1?sig=x',
        directive: 'connect-src',
      });

      unsubscribe();
      document.dispatchEvent(event);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('falls back to violatedDirective when effectiveDirective is absent', () => {
      const handler = vi.fn();
      const unsubscribe = defaultUploadRuntime.onCspViolation(handler);

      const event = new Event('securitypolicyviolation');
      Object.defineProperty(event, 'blockedURI', { value: 'inline', configurable: true });
      Object.defineProperty(event, 'violatedDirective', {
        value: 'connect-src',
        configurable: true,
      });

      document.dispatchEvent(event);

      expect(handler).toHaveBeenCalledWith({ blockedURI: 'inline', directive: 'connect-src' });
      unsubscribe();
    });
  });

  // ---------------------------------------------------------------------------

  describe('tuning', () => {
    it('backs off exponentially, capped, with jitter spread across the window', () => {
      const policy = { maxAttempts: 5, baseMs: 1000, maxMs: 8000 };

      // No jitter roll: the floor of the window.
      expect(backoffDelayMs(1, policy, 0)).toBe(500);
      expect(backoffDelayMs(2, policy, 0)).toBe(1000);
      // Full roll: the ceiling.
      expect(backoffDelayMs(1, policy, 1)).toBe(1000);
      // Capped, so a long-running upload never waits minutes between parts.
      expect(backoffDelayMs(10, policy, 1)).toBe(8000);
    });

    it('uses the mobile concurrency on a coarse pointer and the desktop one otherwise', () => {
      const original = window.matchMedia;

      window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
      expect(detectPartConcurrency()).toBe(MOBILE_PART_CONCURRENCY);

      window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
      expect(detectPartConcurrency()).toBe(DESKTOP_PART_CONCURRENCY);

      window.matchMedia = original;
    });
  });
});
