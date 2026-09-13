import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './api-client.js';
import {
  DeviceLoginError,
  MAX_POLL_INTERVAL_SECONDS,
  POLL_MARGIN_MS,
  SLOW_DOWN_INCREMENT_SECONDS,
  classifyPollFailure,
  pollForDeviceToken,
  type DeviceCredential,
} from './device-auth.js';
import { ApiError, EXIT, NetworkError } from './errors.js';

// =============================================================================
// RFC 8628 polling state machine (issue #142, epic #110)
// =============================================================================
//
// `sleep` and `now` are the injection points `PollForTokenOptions` exposes —
// no real timer or wall clock is ever waited on here. `now` is pinned to a
// constant so the local deadline (`expiresInSeconds` in the future) never
// trips inside a fast test run, and `sleep` is a vi.fn that resolves
// immediately while recording every delay it was asked for, which is what
// lets the slow_down-widening and interval-honouring assertions below inspect
// the ACTUAL delay value rather than merely "polling continued".
// =============================================================================

function apiErrorFor(args: {
  status: number;
  error: string;
  description?: string;
}): ApiError {
  // Built through `ApiError.fromBody`, exactly as `ApiClient.send` builds it
  // from a real HTTP response — so these tests exercise the same body-parsing
  // path a live poll against the (post-#153) API would produce: an RFC 8628
  // verbatim `{ error, error_description }` body, with no `code` field for
  // the envelope-derived fallback to find.
  return ApiError.fromBody({
    status: args.status,
    statusText: 'Error',
    rawBody: JSON.stringify({
      error: args.error,
      error_description: args.description ?? `${args.error} description`,
    }),
    method: 'POST',
    url: 'https://example.test/api/auth/device/token',
  });
}

function fakeClient(post: (...args: unknown[]) => Promise<unknown>): ApiClient {
  return { post: vi.fn(post) } as unknown as ApiClient;
}

const APPROVED_CREDENTIAL: DeviceCredential = {
  accessToken: 'pat_deadbeef',
  tokenType: 'Bearer',
  expiresIn: 3600,
  credentialType: 'pat',
  expiresAt: undefined,
  tokenId: undefined,
  tokenName: undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyPollFailure', () => {
  it('classifies authorization_pending as pending', () => {
    const signal = classifyPollFailure(
      apiErrorFor({ status: 400, error: 'authorization_pending' }),
    );
    expect(signal.kind).toBe('pending');
  });

  it('classifies slow_down as slow_down', () => {
    const signal = classifyPollFailure(apiErrorFor({ status: 400, error: 'slow_down' }));
    expect(signal.kind).toBe('slow_down');
  });

  it('classifies access_denied as denied', () => {
    const signal = classifyPollFailure(apiErrorFor({ status: 400, error: 'access_denied' }));
    expect(signal.kind).toBe('denied');
  });

  it('classifies expired_token as expired', () => {
    const signal = classifyPollFailure(apiErrorFor({ status: 400, error: 'expired_token' }));
    expect(signal.kind).toBe('expired');
  });

  it('classifies invalid_grant as invalid_grant, carrying the server message', () => {
    const signal = classifyPollFailure(
      apiErrorFor({ status: 401, error: 'invalid_grant', description: 'Invalid device code' }),
    );
    expect(signal.kind).toBe('invalid_grant');
    if (signal.kind === 'invalid_grant') {
      expect(signal.message).toContain('Invalid device code');
    }
  });

  it('gives each RFC code a DISTINCT outcome — no two collapse to the same kind', () => {
    const kinds = new Set(
      ['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant'].map(
        (error) => classifyPollFailure(apiErrorFor({ status: 400, error })).kind,
      ),
    );
    expect(kinds.size).toBe(5);
  });

  it('classifies an unrecognised error as unclassified rather than guessing', () => {
    const signal = classifyPollFailure(
      apiErrorFor({ status: 400, error: 'some_future_rfc_code' }),
    );
    expect(signal.kind).toBe('unclassified');
  });
});

describe('pollForDeviceToken — slow_down widens the interval', () => {
  it('increases the ACTUAL next-poll delay by more than the RFC-minimum 5s, and honours interval + margin as the base', async () => {
    const post = vi
      .fn()
      // Poll 1: still waiting — establishes the BASE delay.
      .mockRejectedValueOnce(apiErrorFor({ status: 400, error: 'authorization_pending' }))
      // Poll 2: server asks us to back off.
      .mockRejectedValueOnce(apiErrorFor({ status: 400, error: 'slow_down' }))
      // Poll 3: approved, so the loop terminates.
      .mockResolvedValueOnce(APPROVED_CREDENTIAL);

    const sleep = vi.fn().mockResolvedValue(undefined);
    const baseIntervalSeconds = 5;

    const credential = await pollForDeviceToken({
      client: fakeClient(post),
      deviceCode: 'device-code',
      intervalSeconds: baseIntervalSeconds,
      expiresInSeconds: 900,
      sleep,
      now: () => 0,
    });

    expect(credential).toEqual(APPROVED_CREDENTIAL);
    expect(post).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    // The delay before the SECOND poll (after the first, still-pending
    // response) must be the server's advertised interval PLUS the documented
    // POLL_MARGIN_MS — not the bare interval.
    const delayBeforeSlowDownWasSeen = sleep.mock.calls[0]?.[0];
    expect(delayBeforeSlowDownWasSeen).toBe(baseIntervalSeconds * 1000 + POLL_MARGIN_MS);

    // The delay before the THIRD poll (after slow_down) must reflect the
    // widened interval: RFC 8628 §3.5's minimum 5s increment, plus margin.
    const delayAfterSlowDown = sleep.mock.calls[1]?.[0];
    const widenedIntervalSeconds = baseIntervalSeconds + SLOW_DOWN_INCREMENT_SECONDS;
    expect(delayAfterSlowDown).toBe(widenedIntervalSeconds * 1000 + POLL_MARGIN_MS);

    // The actual delay value used for the NEXT poll is strictly larger than
    // it was before slow_down — not just "polling continued".
    expect(delayAfterSlowDown).toBeGreaterThan(delayBeforeSlowDownWasSeen);
    expect(widenedIntervalSeconds - baseIntervalSeconds).toBeGreaterThanOrEqual(5);
  });

  it('clamps a runaway widened interval at MAX_POLL_INTERVAL_SECONDS rather than growing unbounded', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(apiErrorFor({ status: 400, error: 'slow_down' }))
      .mockResolvedValueOnce(APPROVED_CREDENTIAL);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await pollForDeviceToken({
      client: fakeClient(post),
      deviceCode: 'device-code',
      // Already near the ceiling, so one more +5s would exceed it without the
      // clamp.
      intervalSeconds: MAX_POLL_INTERVAL_SECONDS,
      expiresInSeconds: 900,
      sleep,
      now: () => 0,
    });

    const delay = sleep.mock.calls[0]?.[0];
    expect(delay).toBe(MAX_POLL_INTERVAL_SECONDS * 1000 + POLL_MARGIN_MS);
  });
});

describe('pollForDeviceToken — the server interval is the honoured base delay', () => {
  it('uses interval + POLL_MARGIN_MS for the very first sleep, not the bare interval', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(apiErrorFor({ status: 400, error: 'authorization_pending' }))
      .mockResolvedValueOnce(APPROVED_CREDENTIAL);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const serverInterval = 7;

    await pollForDeviceToken({
      client: fakeClient(post),
      deviceCode: 'device-code',
      intervalSeconds: serverInterval,
      expiresInSeconds: 900,
      sleep,
      now: () => 0,
    });

    expect(sleep).toHaveBeenCalledWith(serverInterval * 1000 + POLL_MARGIN_MS, undefined);
  });
});

describe('pollForDeviceToken — terminal outcomes stop polling', () => {
  it('expired_token throws and does not poll or sleep again', async () => {
    const post = vi.fn().mockRejectedValueOnce(apiErrorFor({ status: 400, error: 'expired_token' }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollForDeviceToken({
        client: fakeClient(post),
        deviceCode: 'device-code',
        intervalSeconds: 5,
        expiresInSeconds: 900,
        sleep,
        now: () => 0,
      }),
    ).rejects.toThrow(DeviceLoginError);

    expect(post).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('access_denied throws and does not poll or sleep again', async () => {
    const post = vi.fn().mockRejectedValueOnce(apiErrorFor({ status: 400, error: 'access_denied' }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollForDeviceToken({
        client: fakeClient(post),
        deviceCode: 'device-code',
        intervalSeconds: 5,
        expiresInSeconds: 900,
        sleep,
        now: () => 0,
      }),
    ).rejects.toThrow(DeviceLoginError);

    expect(post).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('pollForDeviceToken — a network failure is distinguishable from a protocol outcome', () => {
  it('lets a NetworkError propagate untouched, rather than reading it as access_denied or any other classification', async () => {
    const networkFailure = new NetworkError({
      kind: 'refused',
      method: 'POST',
      url: 'https://example.test/api/auth/device/token',
      message: 'Connection refused by example.test. Nothing is listening on that host and port.',
    });
    const post = vi.fn().mockRejectedValueOnce(networkFailure);
    const sleep = vi.fn().mockResolvedValue(undefined);

    let caught: unknown;
    try {
      await pollForDeviceToken({
        client: fakeClient(post),
        deviceCode: 'device-code',
        intervalSeconds: 5,
        expiresInSeconds: 900,
        sleep,
        now: () => 0,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NetworkError);
    expect(caught).not.toBeInstanceOf(DeviceLoginError);
    expect((caught as NetworkError).exitCode).toBe(EXIT.NETWORK);
  });
});

describe('pollForDeviceToken — exit codes', () => {
  it('expired_token exits with EXIT.AUTH', async () => {
    const post = vi.fn().mockRejectedValueOnce(apiErrorFor({ status: 400, error: 'expired_token' }));

    let caught: unknown;
    try {
      await pollForDeviceToken({
        client: fakeClient(post),
        deviceCode: 'device-code',
        intervalSeconds: 5,
        expiresInSeconds: 900,
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => 0,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeviceLoginError);
    expect((caught as DeviceLoginError).reason).toBe('expired');
    expect((caught as DeviceLoginError).exitCode).toBe(EXIT.AUTH);
  });

  it('a cancelled flow (aborted signal) exits with EXIT.AUTH, without polling at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const post = vi.fn();

    let caught: unknown;
    try {
      await pollForDeviceToken({
        client: fakeClient(post),
        deviceCode: 'device-code',
        intervalSeconds: 5,
        expiresInSeconds: 900,
        signal: controller.signal,
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => 0,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeviceLoginError);
    expect((caught as DeviceLoginError).reason).toBe('cancelled');
    expect((caught as DeviceLoginError).exitCode).toBe(EXIT.AUTH);
    expect(post).not.toHaveBeenCalled();
  });

  it('access_denied exits with EXIT.API, not EXIT.AUTH', async () => {
    const post = vi.fn().mockRejectedValueOnce(apiErrorFor({ status: 400, error: 'access_denied' }));

    let caught: unknown;
    try {
      await pollForDeviceToken({
        client: fakeClient(post),
        deviceCode: 'device-code',
        intervalSeconds: 5,
        expiresInSeconds: 900,
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => 0,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeviceLoginError);
    expect((caught as DeviceLoginError).reason).toBe('denied');
    expect((caught as DeviceLoginError).exitCode).toBe(EXIT.API);
  });

  it('a network failure exits with EXIT.NETWORK', async () => {
    const post = vi.fn().mockRejectedValueOnce(
      new NetworkError({
        kind: 'timeout',
        method: 'POST',
        url: 'https://example.test/api/auth/device/token',
        message: 'Timed out.',
      }),
    );

    let caught: unknown;
    try {
      await pollForDeviceToken({
        client: fakeClient(post),
        deviceCode: 'device-code',
        intervalSeconds: 5,
        expiresInSeconds: 900,
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => 0,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as NetworkError).exitCode).toBe(EXIT.NETWORK);
  });
});
