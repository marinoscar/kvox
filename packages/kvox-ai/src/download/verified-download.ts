import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';

// =============================================================================
// One verified download, shared (issue #660)
// =============================================================================
//
// The Copilot runtime download (#630) and the local embedding model download
// (#660) are the same security problem: fetch a file from a short list of hosts
// and install it only if its SHA-256 matches a value pinned in code or in a
// manifest. This module is that mechanism, once:
//
//   • https only, no credentials in the URL, no non-default port;
//   • an EXACT host match against an allowlist, checked on the first URL and on
//     EVERY redirect hop (redirects are followed by hand, never by `fetch`);
//   • at most MAX_REDIRECTS hops;
//   • the body is streamed to the destination file while it is hashed, capped at
//     `maxBytes` (the Content-Length is checked first, then the running total);
//   • the SHA-256 is compared before the file is handed back; a mismatch deletes it;
//   • the caller's AbortSignal cancels the request and the stream.
//
// Failures are raised through the caller's `errors` factory, so each caller keeps
// its own error type and message prefix (Copilot: `AiError` with a
// `GitHub Copilot:` prefix and the `details.check` codes its tests pin).
// =============================================================================

/** The most redirects followed before the download is refused. */
export const MAX_REDIRECTS = 5;

/** Builds the caller's own errors; the downloader never throws a type of its own. */
export interface VerifiedDownloadErrors {
  /** An invalid input (a URL that does not parse). `check` names the failing input. */
  invalid(text: string, check: string): Error;
  /** A URL refused before any request: not https, credentials, a port, or a host outside the allowlist. */
  refusedHost(text: string, host: string | undefined): Error;
  /** A request, redirect or stream failure, or a cancellation. */
  failed(text: string): Error;
  /** The downloaded bytes do not hash to the pinned SHA-256 (the file is already deleted). */
  mismatch(): Error;
  /** The body is larger than `maxBytes`. */
  tooLarge(): Error;
  /** Removes secrets from a text taken from a thrown value or a header, when the caller has a redactor. */
  scrub?(text: string): string;
  /** Recognises an error this factory already built, so it is rethrown unwrapped. */
  isOwn?(error: unknown): boolean;
}

/** What {@link downloadVerifiedFile} needs. */
export interface DownloadVerifiedFileOptions {
  /** The first URL (already allowlisted by {@link assertAllowedUrl}, or checked here). */
  url: URL | string;
  /** The expected SHA-256, 64 lowercase hex characters. */
  sha256: string;
  /** The largest body accepted, in bytes. */
  maxBytes: number;
  /** The exact, lowercase hosts a hop may name. */
  allowedHosts: ReadonlySet<string>;
  /** Where the bytes are written (created exclusively, `wx`). The caller renames it into place. */
  destination: string;
  /** Cancels the download. */
  signal?: AbortSignal;
  /** Called with the bytes received so far and the total when the server said it. Never breaks the download. */
  onProgress?(received: number, total: number | undefined): void;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
  /** The caller's error factory. */
  errors: VerifiedDownloadErrors;
  /** Names the thing in messages ("runtime", "model file"). Default `file`. */
  subject?: string;
  /** The file-system calls, replaceable by a test. Default `node:fs/promises`. */
  fs?: VerifiedDownloadFs;
}

/** The two file-system calls the downloader makes. */
export interface VerifiedDownloadFs {
  /** `fs.promises.open` for exclusive writing. */
  open(path: string, flags: 'wx'): Promise<{ write(data: Uint8Array): Promise<unknown>; close(): Promise<void> }>;
  /** `fs.promises.rm`. */
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

/** A hostname for a message: letters, digits, dots, dashes only. */
export function safeHostText(host: string): string {
  return host.replace(/[^A-Za-z0-9.-]/g, '?').slice(0, 100);
}

/**
 * https, no credentials, default port, exact host match. Throws before any
 * network call.
 *
 * @param raw - the URL text.
 * @param hosts - the lowercase allowed hosts.
 * @param errors - the caller's error factory.
 * @returns the parsed URL.
 */
export function assertAllowedUrl(raw: string, hosts: ReadonlySet<string>, errors: VerifiedDownloadErrors): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw errors.invalid('A download URL is not a valid URL.', 'url');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw errors.refusedHost(`Refusing a non-https download (host ${safeHostText(host)}).`, host);
  if (url.username !== '' || url.password !== '') throw errors.refusedHost('Refusing a download URL that carries credentials.', host);
  if (url.port !== '') throw errors.refusedHost(`Refusing a download from a non-default port (host ${safeHostText(host)}).`, host);
  if (!hosts.has(host)) throw errors.refusedHost(`Refusing to download from ${safeHostText(host)}: not in allowedHosts.`, host);
  return url;
}

/**
 * `fetch` with manual redirects: every hop is checked against the allowed hosts
 * before it is requested.
 *
 * @param fetchImpl - the fetch to use.
 * @param first - the first URL, already allowed.
 * @param hosts - the lowercase allowed hosts.
 * @param signal - cancels the request.
 * @param errors - the caller's error factory.
 * @returns the first non-redirect response.
 */
export async function fetchWithAllowedHosts(
  fetchImpl: typeof fetch,
  first: URL,
  hosts: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  errors: VerifiedDownloadErrors,
): Promise<Response> {
  const scrub = errors.scrub ?? ((t: string) => t);
  let url = first;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let res: Response;
    try {
      res = await fetchImpl(url.href, { redirect: 'manual', ...(signal ? { signal } : {}) });
    } catch (err) {
      if (signal?.aborted) throw errors.failed('The download was cancelled.');
      throw errors.failed(`The download from ${safeHostText(url.hostname)} failed: ${errorText(err, scrub)}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw errors.failed('A redirect carried no location.');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw errors.failed('A redirect carried an invalid location.');
      }
      // Refuses a redirect to another host (or http) before it is requested.
      url = assertAllowedUrl(next.href, hosts, errors);
      continue;
    }
    return res;
  }
  throw errors.failed('Too many redirects.');
}

/**
 * Downloads one file from an allowlisted host into `destination` and verifies
 * its SHA-256.
 *
 * @remarks
 * On any failure `destination` is deleted. On success it holds exactly the
 * verified bytes; the caller renames it into place (the rename is the atomic
 * step, so a half-written file never has its final name).
 *
 * @param o - the URL, the pinned hash, the byte cap, the allowed hosts and the destination.
 * @returns the number of bytes written.
 */
export async function downloadVerifiedFile(o: DownloadVerifiedFileOptions): Promise<number> {
  const { errors, signal } = o;
  const fs: VerifiedDownloadFs = o.fs ?? { open: (p, f) => fsp.open(p, f), rm: (p, op) => fsp.rm(p, op) };
  const subject = o.subject ?? 'file';
  const scrub = errors.scrub ?? ((t: string) => t);
  const fetchImpl = o.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw errors.invalid('No fetch is available to download.', 'fetch');
  const first = typeof o.url === 'string' ? assertAllowedUrl(o.url, o.allowedHosts, errors) : o.url;

  const res = await fetchWithAllowedHosts(fetchImpl, first, o.allowedHosts, signal, errors);
  if (!res.ok || !res.body) throw errors.failed(`The ${subject} download failed (status ${res.status}).`);

  const lengthHeader = Number(res.headers.get('content-length'));
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : undefined;
  if (total !== undefined && total > o.maxBytes) {
    await res.body.cancel().catch(() => undefined);
    throw errors.tooLarge();
  }
  const progress = (received: number): void => {
    try {
      o.onProgress?.(received, total);
    } catch {
      /* a progress callback must never break the download */
    }
  };
  progress(0);

  const hash = createHash('sha256');
  const file = await fs.open(o.destination, 'wx');
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > o.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw errors.tooLarge();
      }
      hash.update(value);
      await file.write(value);
      progress(received);
    }
  } catch (err) {
    await file.close().catch(() => undefined);
    await fs.rm(o.destination, { recursive: true, force: true }).catch(() => undefined);
    if (errors.isOwn?.(err)) throw err;
    if (signal?.aborted) throw errors.failed('The download was cancelled.');
    throw errors.failed(`The ${subject} download was interrupted: ${errorText(err, scrub)}`);
  }
  await file.close();

  if (hash.digest('hex') !== o.sha256) {
    await fs.rm(o.destination, { recursive: true, force: true });
    throw errors.mismatch();
  }
  return received;
}

function errorText(err: unknown, scrub: (t: string) => string): string {
  return scrub(err instanceof Error ? err.message : String(err)).slice(0, 200);
}
