// =============================================================================
// KvoxApiError: the one error a slice catches
// =============================================================================
//
// A host transport rejects with whatever its HTTP client raises (the web
// edition's client raises the platform's `ApiError`; Desktop's raises its own).
// Every core helper normalises that into this class, so a slice's
// `err instanceof KvoxApiError` works in every host and a slice never imports a
// host's error type.
// =============================================================================

import { isKvoxErrorCode } from '@marinoscar/kvox-contract/errors';
import type { KvoxErrorCode } from '@marinoscar/kvox-contract/errors';

/**
 * A failed API call, as a slice sees it.
 *
 * @remarks
 * The API sends its domain reason in `details.reason` (the top-level `code` is
 * derived from the status). `reason` carries that string verbatim and
 * `kvoxCode` is the same string when it is a code of the contract's catalogue
 * (`@marinoscar/kvox-contract/errors`), so a page can show the same copy for a
 * 409 whichever host it runs in.
 *
 * @stability experimental
 */
export class KvoxApiError extends Error {
  /** The HTTP status; `0` for a failure that never produced a response. */
  readonly status: number;
  /** The API's top-level error code (`CONFLICT`, `NOT_FOUND`), when it sent one. */
  readonly code?: string;
  /** The error envelope's `details`, untouched. */
  readonly details?: unknown;
  /** `details.reason`, when it is a string. */
  readonly reason?: string;
  /** `details.reason` when it is a code of the contract's catalogue. */
  readonly kvoxCode?: KvoxErrorCode;

  /**
   * Builds the error.
   *
   * @param message - The API's message, shown to the user.
   * @param status - The HTTP status.
   * @param code - The API's top-level error code.
   * @param details - The error envelope's `details`.
   */
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'KvoxApiError';
    this.status = status;
    if (code !== undefined) this.code = code;
    if (details !== undefined) this.details = details;
    const reason = readReason(details);
    if (reason !== undefined) {
      this.reason = reason;
      if (isKvoxErrorCode(reason)) this.kvoxCode = reason;
    }
  }
}

function readReason(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Whether a value is a {@link KvoxApiError}.
 *
 * @param value - Anything caught.
 * @returns `true` for a `KvoxApiError`.
 *
 * @stability experimental
 */
export function isKvoxApiError(value: unknown): value is KvoxApiError {
  return value instanceof KvoxApiError;
}

/**
 * An error as a {@link KvoxApiError}: one already is returned as it is; an
 * object with a numeric `status` (the shape of every host client's error) is
 * wrapped; anything else (an abort, a network failure) is returned unchanged.
 *
 * @param error - What a host transport rejected with.
 * @returns A `KvoxApiError` when the failure carries a status, else `error`.
 *
 * @stability experimental
 */
export function toKvoxApiError(error: unknown): unknown {
  if (error instanceof KvoxApiError) return error;
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { status?: unknown; message?: unknown; code?: unknown; details?: unknown };
    if (typeof candidate.status === 'number') {
      return new KvoxApiError(
        typeof candidate.message === 'string' ? candidate.message : `Request failed (${candidate.status})`,
        candidate.status,
        typeof candidate.code === 'string' ? candidate.code : undefined,
        candidate.details,
      );
    }
  }
  return error;
}

/**
 * The `{ data }` envelope removed: `body.data` when the body is an object that
 * has a `data` member, else the body itself.
 *
 * @remarks
 * A host transport that talks to the API directly applies this once to the
 * parsed JSON. The core helpers do not apply it again: the contract of
 * `KvoxHttpPort` is that the payload arrives already unwrapped.
 *
 * @param body - The parsed JSON of a successful response.
 * @returns The payload.
 *
 * @stability experimental
 */
export function unwrapEnvelope<T = unknown>(body: unknown): T {
  if (typeof body === 'object' && body !== null && 'data' in body) {
    const data = (body as { data?: unknown }).data;
    if (data !== undefined && data !== null) return data as T;
  }
  return body as T;
}
