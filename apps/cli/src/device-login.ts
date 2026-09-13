import { hostname, userInfo } from 'node:os';

import { ApiClient, resolveApiBaseUrl } from './api-client.js';
import { openInBrowser, type BrowserOpenResult } from './browser.js';
import { CLI_DISPLAY_NAME, CLI_NAME } from './branding.js';
import { saveCredentials, type ConfigContext } from './config.js';
import {
  DeviceLoginError,
  pollForDeviceToken,
  requestDeviceCode,
  type DeviceCodeGrant,
  type DeviceCredential,
  type DevicePollSignal,
  type DevicePollState,
} from './device-auth.js';
import { ApiError } from './errors.js';
import { CLI_VERSION } from './package-info.js';

// =============================================================================
// The reusable device-login sequence  (issue #142, epic #110)
// =============================================================================
//
// EXTRACTED FROM THE COMMAND ON PURPOSE, and this is the reason: #145 renders
// the same flow as an ink screen. Two consumers, one sequence. If the
// request-code → show-instructions → open-browser → poll → validate → save
// chain lived inside `commands/login.ts`, the TUI would have to reimplement
// it, and the second implementation is where the interval handling and the
// four RFC outcomes quietly diverge from the first. The reference
// implementation split `device-login.ts` out of `commands/login.ts` for
// exactly this reason.
//
// The split is drawn at I/O: NOTHING HERE WRITES TO A TERMINAL. Everything a
// user would see is delivered through `hooks`, so the command formats it as
// lines and the TUI renders it as components, from identical data. That is
// also what makes the sequence testable without capturing stdout.
//
// The one thing this module DOES do besides orchestrate is write the config,
// because "validate, then save" is a single indivisible step that both entry
// points must perform identically — see `completeLogin`.
// =============================================================================

/** `GET /api/auth/me`, matching CurrentUserDto. Enough to confirm and greet. */
export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
  isActive: boolean;
  roles: Array<{ name: string }>;
  permissions: string[];
}

/** Everything a UI needs, pushed rather than printed. All optional. */
export interface DeviceLoginHooks {
  /** The code pair arrived. Show `userCode` and `verificationUriComplete` NOW. */
  onCodeIssued?: ((grant: DeviceCodeGrant) => void) | undefined;
  /** The browser was, or was not, opened. Never a failure. */
  onBrowserOpen?: ((result: BrowserOpenResult & { url: string }) => void) | undefined;
  /** Live polling state, for a spinner or a status line. */
  onPollState?: ((state: DevicePollState) => void) | undefined;
  /** Fired once if the server's poll responses could not be classified. */
  onUnclassified?: ((signal: Extract<DevicePollSignal, { kind: 'unclassified' }>) => void) | undefined;
}

export interface DeviceLoginOptions {
  /** What the user typed — `app.example.com`, not the `/api` root. */
  serverUrl: string;
  /** Shown on the activation page and used to name the PAT. */
  deviceName?: string | undefined;
  hooks?: DeviceLoginHooks | undefined;
  signal?: AbortSignal | undefined;
  /** Skip the browser launch (a `--no-browser` flag, or a TUI that opens it). */
  openBrowser?: boolean | undefined;
  /** Test seam, forwarded to the poll loop. */
  sleep?: ((ms: number, signal?: AbortSignal | undefined) => Promise<void>) | undefined;
  /** Test seam: build the client rather than constructing the real one. */
  createClient?: ((apiBaseUrl: string) => ApiClient) | undefined;
}

export interface DeviceLoginResult {
  grant: DeviceCodeGrant;
  credential: DeviceCredential;
  /** The `/api` root the credential is good against. */
  apiBaseUrl: string;
}

/**
 * Per-poll HTTP timeout.
 *
 * Much shorter than the client's 30s default, deliberately. A poll is a
 * sub-second request repeated every few seconds; if one hangs, the right
 * answer is to abandon it and poll again on schedule, not to stall the whole
 * flow for half a minute and let the interval collapse. It must stay
 * comfortably below the poll interval times a small factor so a stuck request
 * cannot pile up behind the next one.
 */
const POLL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Run the device flow and return the issued credential. Does NOT save.
 *
 * Saving is separate because the two entry points (`login` and `login
 * --token`) converge only at `completeLogin`, and because a caller that wants
 * the credential without touching the user's config — a test, a future
 * `--print-token`-free integration — should not have to opt out of a side
 * effect.
 */
export async function runDeviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const apiBaseUrl = resolveApiBaseUrl(options.serverUrl);
  const hooks = options.hooks;

  // No token: `/auth/device/code` and `/auth/device/token` are both @Public(),
  // and the entire purpose of the flow is that we do not have one yet.
  const client =
    options.createClient?.(apiBaseUrl) ??
    new ApiClient({ baseUrl: apiBaseUrl, timeoutMs: POLL_REQUEST_TIMEOUT_MS });

  const grant = await requestDeviceCode(client, {
    deviceName: options.deviceName ?? defaultDeviceName(),
    userAgent: `${CLI_NAME}/${CLI_VERSION} (node ${process.version})`,
    signal: options.signal,
  });

  // Emitted BEFORE the browser attempt, always. The user code is the one thing
  // the flow cannot proceed without, so it must be on screen even if the
  // browser launch hangs for its full timeout, and even if it succeeds — the
  // browser may open on a different machine's display, or behind other
  // windows.
  hooks?.onCodeIssued?.(grant);

  if (options.openBrowser !== false) {
    const result = await openInBrowser(grant.verificationUriComplete);
    hooks?.onBrowserOpen?.({ ...result, url: grant.verificationUriComplete });
  }

  const credential = await pollForDeviceToken({
    client,
    deviceCode: grant.deviceCode,
    intervalSeconds: grant.interval,
    expiresInSeconds: grant.expiresIn,
    signal: options.signal,
    onState: hooks?.onPollState,
    onUnclassified: hooks?.onUnclassified,
    sleep: options.sleep,
  });

  return { grant, credential, apiBaseUrl };
}

/**
 * Validate a token against `GET /api/auth/me`.
 *
 * WHY VALIDATE AT ALL when the device flow just minted the token: because the
 * headless `--token` path did not, and both paths must fail in the same place
 * for the same reason. A pasted token that is mistyped, expired, revoked, or
 * from a different server is the common case there, and the difference between
 * catching it here and not catching it is the difference between "that token
 * is not valid on this server" at login and a mystifying 401 from an unrelated
 * command three days later — by which time nobody remembers what was pasted.
 *
 * It is also the only check that the account is USABLE. `JwtAuthGuard` rejects
 * a disabled user, so a token belonging to a deactivated account fails here
 * rather than after being written to disk as if it worked.
 */
export async function validateToken(
  serverUrl: string,
  token: string,
  options?: {
    signal?: AbortSignal | undefined;
    createClient?: ((apiBaseUrl: string, token: string) => ApiClient) | undefined;
  },
): Promise<CurrentUser> {
  const apiBaseUrl = resolveApiBaseUrl(serverUrl);
  const client =
    options?.createClient?.(apiBaseUrl, token) ?? new ApiClient({ baseUrl: apiBaseUrl, token });

  try {
    return await client.get<CurrentUser>(
      '/auth/me',
      options?.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // Rewritten, because the server's own 401 message ("Unauthorized") is
      // true and useless. The message must NOT echo the token — not even a
      // prefix of it — since this error is printed and ends up in scrollback,
      // screenshots and pasted bug reports.
      throw new ApiError({
        status: error.status,
        serverMessage: `the server rejected this token. It may be expired, revoked, or issued by a different server. Check the Access Tokens page on ${serverUrl}, or run \`${CLI_NAME} login\` to get a new one.`,
        code: error.code,
        details: undefined,
        method: error.method,
        url: error.url,
        structured: error.structured,
      });
    }
    throw error;
  }
}

export interface CompleteLoginInput {
  serverUrl: string;
  token: string;
  expiresAt?: string | undefined;
  tokenId?: string | undefined;
  tokenName?: string | undefined;
  signal?: AbortSignal | undefined;
  configContext?: ConfigContext | undefined;
  createClient?: ((apiBaseUrl: string, token: string) => ApiClient) | undefined;
}

export interface CompleteLoginResult {
  user: CurrentUser;
  /** Where the config was written. Safe to print; contains no secret. */
  path: string;
}

/**
 * Validate, THEN save. The final step of both login paths.
 *
 * THE ORDER IS THE POINT. Saving first and validating afterwards leaves a
 * token that does not work sitting in the config on every failure, and the
 * next command reports a 401 that looks like a revoked credential rather than
 * a login that never succeeded. Validating first means a failed login changes
 * nothing on disk — the previous, working credential survives an attempt to
 * replace it with a bad one, which is the behaviour a user assumes and would
 * not think to check.
 */
export async function completeLogin(input: CompleteLoginInput): Promise<CompleteLoginResult> {
  const user = await validateToken(input.serverUrl, input.token, {
    signal: input.signal,
    createClient: input.createClient,
  });

  const path = saveCredentials(
    {
      // The URL as the user gave it, NOT the resolved `/api` root. #143 stores
      // "the server", and re-deriving the API root on read keeps the stored
      // value meaningful if the prefix ever changes.
      serverUrl: input.serverUrl,
      token: input.token,
      expiresAt: input.expiresAt,
      tokenId: input.tokenId,
      tokenName: input.tokenName,
    },
    input.configContext,
  );

  return { user, path };
}

/**
 * A name the user will recognise in the Access Tokens page.
 *
 * `user@host` is the string that answers the only question that page asks —
 * "which machine is this, and should it still have access?" — and it is what
 * makes revocation possible in practice. A generic "CLI" on four rows tells
 * nobody which laptop was lost.
 *
 * `userInfo()` throws when the uid has no passwd entry, which happens in
 * containers running as an arbitrary uid — a routine setup, not an exotic one
 * — so both halves degrade rather than taking the login down over a label.
 * The server sanitises this before it becomes a token name
 * (`DeviceAuthService.buildPatName`), which matters because it is
 * attacker-supplied from the API's point of view.
 */
export function defaultDeviceName(): string {
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    user = 'unknown';
  }

  let host: string;
  try {
    host = hostname();
  } catch {
    host = 'unknown-host';
  }

  return `${CLI_DISPLAY_NAME}: ${user}@${host}`;
}

/** Re-exported so a consumer needs one import for the whole flow. */
export { DeviceLoginError };
export type { DeviceCodeGrant, DeviceCredential, DevicePollState };
