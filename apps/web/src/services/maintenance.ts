/**
 * The client half of the maintenance wire contract — issue #258, epic #254.
 *
 * =============================================================================
 * WHAT THIS FILE IS FOR
 * =============================================================================
 *
 * A `503` is also what a crashed API, an exhausted connection pool, an upstream
 * that failed to boot, and a reverse proxy with no healthy backend all produce.
 * The whole point of #257's marker is that a client can tell a DELIBERATE
 * maintenance window apart from a broken deployment — and therefore dares to
 * show the operator's message and a retry, instead of showing that message the
 * next time the API simply falls over.
 *
 * So this file holds exactly two things:
 *
 *   1. THE MIRRORED CONSTANTS AND THE RECOGNISER. `MAINTENANCE_ERROR_MARKER`
 *      is the same string `apps/api/src/common/maintenance/maintenance.guard.ts`
 *      exports, and `readMaintenanceBlock` is the ONE place in the web app that
 *      decides whether a failed response is a maintenance window. Changing
 *      either is a wire-contract change on both sides.
 *
 *   2. A TINY MODULE-LEVEL STORE for the block, so `services/api.ts` can report
 *      one from inside a `fetch` handler — a plain async function with no React
 *      in scope — and `components/common/MaintenanceGate.tsx` can render it.
 *
 * =============================================================================
 * WHY THE STORE LIVES HERE AND NOT IN A REACT CONTEXT
 * =============================================================================
 *
 * Because the producer is not a component. The interception happens centrally
 * in `ApiService.request` (see `services/api.ts`) precisely so that every
 * existing call site inherits it with no change; that method is called from
 * hooks, from event handlers, and from module-scope helpers, and none of those
 * can reach a context value. A context would force each of ~30 call sites to
 * hand the error to a provider — which is the per-call-site change this design
 * exists to avoid.
 *
 * `useSyncExternalStore` (`hooks/useMaintenance.ts`) is the supported bridge
 * back into React, so subscribers still re-render correctly, including under
 * concurrent rendering.
 *
 * =============================================================================
 * WHY THERE IS NO IMPORT OF `./api` IN THIS FILE
 * =============================================================================
 *
 * `services/api.ts` imports THIS module, so an import back the other way would
 * be a cycle. It would technically work — both usages are deferred to call time
 * — but a cycle between the app's HTTP client and the module that classifies
 * its errors is the kind of thing that breaks silently under a bundler change
 * rather than loudly at review time.
 *
 * The consequence, and it is deliberate: the two `/admin/maintenance` REST
 * calls are NOT here. They live in `services/api.ts` with every other endpoint
 * function in this application (`getEmailSettings`, `getNotificationConfig`,
 * …), which is where a reader looks for them.
 */

import type { MaintenanceStatus } from '../types';

/**
 * The stable marker on a maintenance `503`'s body, at `details.reason`.
 *
 * MIRRORED FROM `MAINTENANCE_ERROR_MARKER` in
 * `apps/api/src/common/maintenance/maintenance.guard.ts`. It lives under
 * `details` rather than at the top level because the API's exception filter
 * rebuilds every error body from a fixed key allowlist and would silently strip
 * a custom top-level field — so `details.reason` is not a stylistic choice on
 * either side, and reading it from anywhere else would never match.
 */
export const MAINTENANCE_ERROR_MARKER = 'MAINTENANCE_MODE';

/**
 * The `Retry-After` the API promises, in seconds. Mirrors
 * `MAINTENANCE_RETRY_AFTER_SECONDS`.
 *
 * Used only as the FALLBACK when a response somehow carries the marker without
 * `details.retryAfterSeconds`. The number on the wire wins whenever it is
 * there, so a future server that lengthens the delay is honoured by a client
 * built before the change.
 */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 30;

/**
 * The admin page that closes a window (`pages/Admin/MaintenancePage.tsx`).
 *
 * THE CLIENT MIRROR OF `@AllowDuringMaintenance()`. On the API, the maintenance
 * controller is exempt from its own guard for the obvious reason — the switch
 * that ends a window has to be reachable while the window is open. The same
 * reasoning applies to the screen in front of it: `MaintenanceGate` lets this
 * one route through, so an administrator blocked by an `allowAdmins: false`
 * window is not also locked out of the page that would undo it.
 *
 * The literal is repeated in `config/adminSections.tsx` and `App.tsx` (both of
 * which spell every route out, and the second of which is parsed as TEXT by
 * `__tests__/config/destinations.test.ts`), so
 * `__tests__/services/maintenance.test.ts` asserts this constant equals the
 * card's declared path rather than leaving the three to drift.
 */
export const MAINTENANCE_ADMIN_PATH = '/admin/settings/maintenance';

/**
 * What a blocked caller learned from the 503 — the whole of what the
 * maintenance screen has to work with.
 */
export interface MaintenanceBlock {
  /** The operator's own copy. Rendered verbatim; it is the only thing that explains the window. */
  message: string;
  /** How long the API asked us to wait. */
  retryAfterSeconds: number;
  /**
   * Whether an admin bearer would have been let through.
   *
   * Told to the blocked caller by the API on purpose: it is the difference
   * between "come back later" and "sign in as an administrator and carry on",
   * and the maintenance screen says something different in each case.
   */
  allowAdmins: boolean;
}

/** The `details` block the API puts on a maintenance 503. Every field is treated as untrusted. */
interface MaintenanceErrorDetails {
  reason?: unknown;
  retryAfterSeconds?: unknown;
  allowAdmins?: unknown;
}

/** The shape `ApiService` has already parsed out of a failed response. */
interface FailedResponseBody {
  message?: unknown;
  details?: unknown;
}

/**
 * The default shown when a window is open but the operator supplied no copy.
 *
 * The API's own schema requires a non-empty message and seeds one, so this
 * should be unreachable against a healthy deployment. It exists because the
 * alternative — rendering a maintenance screen with an empty body — is the one
 * outcome that would leave a user with no information at all.
 */
export const MAINTENANCE_FALLBACK_MESSAGE =
  'The application is temporarily unavailable for scheduled maintenance.';

/**
 * Decide whether a failed response is a maintenance window, and extract what
 * the screen needs.
 *
 * THE TWO CONDITIONS ARE BOTH REQUIRED, and that conjunction is the feature:
 *
 *   * `status === 503` — a marker on any other status is not a window.
 *   * `details.reason === MAINTENANCE_ERROR_MARKER` — a 503 WITHOUT it is an
 *     ordinary upstream failure and keeps its existing behaviour exactly, all
 *     the way down to the `ApiError` its call site already catches.
 *
 * Returns `null` for everything else, which is what the caller in `api.ts`
 * branches on. Nothing here throws: it runs on the error path of every failed
 * request in the application, and an exception raised while classifying an
 * error would replace a useful failure with a useless one.
 */
export function readMaintenanceBlock(
  status: number,
  body: unknown,
): MaintenanceBlock | null {
  if (status !== 503) return null;
  if (typeof body !== 'object' || body === null) return null;

  const details = (body as FailedResponseBody).details;
  if (typeof details !== 'object' || details === null) return null;

  const { reason, retryAfterSeconds, allowAdmins } = details as MaintenanceErrorDetails;
  if (reason !== MAINTENANCE_ERROR_MARKER) return null;

  const message = (body as FailedResponseBody).message;

  return {
    message:
      typeof message === 'string' && message.trim()
        ? message
        : MAINTENANCE_FALLBACK_MESSAGE,
    // `Number.isFinite` and not a truthiness check: a server that sent `0`
    // means "retry immediately", which is a real answer, whereas `undefined`
    // and `null` are not.
    retryAfterSeconds:
      typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : MAINTENANCE_RETRY_AFTER_SECONDS,
    // Defaults to `false`, the more restrictive reading. A client that assumed
    // `true` from a missing field would tell a user to sign in as an
    // administrator on a window that locks administrators out too.
    allowAdmins: allowAdmins === true,
  };
}

// -----------------------------------------------------------------------------
// The block store
// -----------------------------------------------------------------------------

let currentBlock: MaintenanceBlock | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * The current block, or `null`.
 *
 * IDENTITY IS STABLE between changes — `useSyncExternalStore` calls this on
 * every render and compares with `Object.is`, so returning a freshly built
 * object here would loop forever. The stored reference is handed back as-is and
 * only replaced when the block actually changes.
 */
export function getMaintenanceBlock(): MaintenanceBlock | null {
  return currentBlock;
}

/** Subscribe to block changes. Returns the unsubscribe function. */
export function subscribeToMaintenanceBlock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record that the API answered with a maintenance 503. Called from exactly one
 * place — `ApiService.request` — and not exported to pages for that reason.
 *
 * A REPEAT REPORT WITH THE SAME CONTENT IS A NO-OP. Every in-flight request of
 * a blocked page reports independently (a settings page, the notification bell
 * and the rail's preferences fetch will all fail together), and re-emitting per
 * failure would re-render the maintenance screen once per request for nothing.
 */
export function reportMaintenanceBlock(block: MaintenanceBlock): void {
  if (
    currentBlock &&
    currentBlock.message === block.message &&
    currentBlock.retryAfterSeconds === block.retryAfterSeconds &&
    currentBlock.allowAdmins === block.allowAdmins
  ) {
    return;
  }
  currentBlock = block;
  emit();
}

/**
 * Drop the block, so the gate renders the application again.
 *
 * DELIBERATELY NOT AUTOMATIC ON A SUCCESSFUL RESPONSE. Several routes stay
 * reachable during a window by design (`/api/auth/me`, `/api/auth/refresh`, the
 * maintenance endpoints themselves), so "some request succeeded" does not mean
 * the window closed — clearing on it would drop the screen, let the next
 * blocked call raise it again, and leave the user watching the application
 * flicker in and out of service.
 *
 * The two callers that DO know something changed are the retry button on the
 * maintenance screen and a save that turned the window off
 * (`hooks/useMaintenance.ts`).
 */
export function clearMaintenanceBlock(): void {
  if (currentBlock === null) return;
  currentBlock = null;
  emit();
}

/**
 * Whether a `MaintenanceStatus` names `layer` as the one deciding `enabled`.
 *
 * A one-line helper rather than `status.source === layer` written out three
 * times in the admin page's layer list: the "which layer wins" badge is the
 * single thing an operator debugging "why is it still on" is looking for, and
 * it is worth having exactly one expression of it — including one place for a
 * test to pin.
 */
export function isDecidingLayer(
  status: MaintenanceStatus,
  layer: MaintenanceStatus['source'],
): boolean {
  return status.source === layer;
}
