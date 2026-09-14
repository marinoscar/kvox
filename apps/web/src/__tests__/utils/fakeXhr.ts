/**
 * A driveable `XMLHttpRequest` double — issue #22, epic #19.
 *
 * ONE implementation, shared by every upload suite. The engine's whole
 * contract is about WHEN bytes are reported, when a request fails, and what
 * happens to a request that is aborted halfway — none of which MSW can
 * express, because MSW answers a request rather than letting a test hold one
 * open and feed it progress events one at a time.
 *
 * The engine reaches for `XMLHttpRequest` through `UploadRuntime.createXhr`,
 * so a test hands `createFakeXhrFactory().createXhr` in and gets a list of
 * live requests it can progress, fail, 403 or abort by hand.
 *
 * Only the surface `resumableUpload.ts` actually uses is implemented
 * (`open`/`setRequestHeader`/`send`/`abort`, `upload.onprogress`,
 * `onload`/`onerror`/`ontimeout`/`onabort`, `status`) — a fuller fake would be
 * a second implementation of the browser rather than a test tool.
 */

/** One captured request, with the levers a test pulls on it. */
export interface FakeXhrRequest {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
  /** Bytes of the body, when it is a Blob. */
  size: number;
  settled: boolean;
  aborted: boolean;
  /** Fire `upload.onprogress` with `loaded` bytes. */
  progress: (loaded: number) => void;
  /** Finish with a status (default 200). */
  respond: (status?: number) => void;
  /** Fire `onerror` — a transport failure with no status. */
  networkError: () => void;
  /** Fire `ontimeout`. */
  timeout: () => void;
}

export interface FakeXhrController {
  /** Every request ever sent, in order. */
  readonly requests: FakeXhrRequest[];
  /** Requests that are neither settled nor aborted. */
  pending(): FakeXhrRequest[];
  /** Hand this to `UploadRuntime.createXhr`. */
  createXhr: () => XMLHttpRequest;
  /**
   * Wait until at least `count` requests have been sent in total.
   *
   * Polls macrotasks rather than awaiting a fixed delay: the engine reaches
   * `send()` through several `await`s (presign, then the PUT), and a fixed
   * `setTimeout(0)` is a race that passes locally and flakes on CI.
   */
  waitForRequests(count: number, timeoutMs?: number): Promise<FakeXhrRequest[]>;
  /** Wait until at least `count` requests are currently in flight. */
  waitForPending(count: number, timeoutMs?: number): Promise<FakeXhrRequest[]>;
  reset(): void;
}

type ProgressHandler = ((event: ProgressEvent) => void) | null;
type EventHandler = (() => void) | null;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function createFakeXhrFactory(): FakeXhrController {
  const requests: FakeXhrRequest[] = [];

  class FakeXhr {
    status = 0;
    readyState = 0;
    timeoutMs = 0;
    upload: { onprogress: ProgressHandler } = { onprogress: null };
    onload: EventHandler = null;
    onerror: EventHandler = null;
    onabort: EventHandler = null;
    ontimeout: EventHandler = null;

    private method = '';
    private url = '';
    private readonly headers: Record<string, string> = {};
    private record: FakeXhrRequest | null = null;

    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }

    send(body: unknown): void {
      const size =
        body && typeof body === 'object' && 'size' in (body as Blob)
          ? (body as Blob).size
          : 0;

      const record: FakeXhrRequest = {
        method: this.method,
        url: this.url,
        body,
        headers: this.headers,
        size,
        settled: false,
        aborted: false,
        progress: (loaded: number) => {
          if (record.settled) return;
          this.upload.onprogress?.({
            lengthComputable: true,
            loaded,
            total: size,
          } as ProgressEvent);
        },
        respond: (status = 200) => {
          if (record.settled) return;
          record.settled = true;
          this.status = status;
          this.readyState = 4;
          this.onload?.();
        },
        networkError: () => {
          if (record.settled) return;
          record.settled = true;
          this.onerror?.();
        },
        timeout: () => {
          if (record.settled) return;
          record.settled = true;
          this.ontimeout?.();
        },
      };

      this.record = record;
      requests.push(record);
    }

    abort(): void {
      const record = this.record;
      if (!record || record.settled) return;
      record.settled = true;
      record.aborted = true;
      this.onabort?.();
    }
  }

  const controller: FakeXhrController = {
    requests,
    pending: () => requests.filter((request) => !request.settled),
    createXhr: () => new FakeXhr() as unknown as XMLHttpRequest,
    async waitForRequests(count, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for ${count} upload requests; saw ${requests.length}`,
          );
        }
        await tick();
      }
      return requests;
    },
    async waitForPending(count, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (controller.pending().length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for ${count} in-flight requests; saw ${controller.pending().length}`,
          );
        }
        await tick();
      }
      return controller.pending();
    },
    reset() {
      requests.length = 0;
    },
  };

  return controller;
}

/** Let queued promise callbacks and timers run. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await tick();
}
