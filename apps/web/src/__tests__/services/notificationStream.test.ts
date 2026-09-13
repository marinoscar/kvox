import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SseFrame, SseOptions } from '../../services/sse';

/**
 * Issue #127, epic #109. `notificationStream.ts` is thin by design: SSE
 * framing/reconnection live in `services/sse.ts`, and this module only
 * supplies the URL, the frame-name filter, and the data-to-notification
 * mapping. `connectSse` is mocked so these tests verify the wiring - what
 * options it's called with, and how `onFrame` behaves - without any real
 * network or timers.
 */

const connectSseMock = vi.fn();

vi.mock('../../services/sse', async () => {
  const actual = await vi.importActual<typeof import('../../services/sse')>(
    '../../services/sse',
  );
  return {
    ...actual,
    connectSse: (options: SseOptions) => connectSseMock(options),
  };
});

const getAccessTokenMock = vi.fn<() => string | null>();
const refreshTokenMock = vi.fn<() => Promise<boolean>>();

vi.mock('../../services/api', () => ({
  API_BASE_URL: 'http://localhost:3000/api',
  api: {
    getAccessToken: (...args: unknown[]) => getAccessTokenMock(...(args as [])),
    refreshToken: (...args: unknown[]) => refreshTokenMock(...(args as [])),
  },
}));

// Imported AFTER the mocks above so the module under test picks them up.
import {
  parseNotificationEvent,
  streamEventToNotification,
  connectNotificationStream,
  NOTIFICATION_SSE_EVENT,
  NOTIFICATION_STREAM_URL,
} from '../../services/notificationStream';

describe('parseNotificationEvent', () => {
  const valid = {
    id: 'n1',
    eventKey: 'security.role_changed',
    title: 'Your role changed',
    body: 'You are now an Admin.',
    createdAt: '2026-01-01T00:00:00.000Z',
    link: '/settings',
    // #226. Server-computed: may this client raise an OS notification for this
    // event? Validated like every other field rather than defaulted — see the
    // parser for why neither default is safe.
    toast: true,
  };

  it('parses a well-formed payload', () => {
    const result = parseNotificationEvent(JSON.stringify(valid));
    expect(result).toEqual(valid);
  });

  it('accepts link: null explicitly', () => {
    const payload = { ...valid, link: null };
    const result = parseNotificationEvent(JSON.stringify(payload));
    expect(result).toEqual(payload);
  });

  it('returns null, never throws, on invalid JSON', () => {
    expect(() => parseNotificationEvent('{not json')).not.toThrow();
    expect(parseNotificationEvent('{not json')).toBeNull();
  });

  it('returns null for a JSON value that is not an object', () => {
    expect(parseNotificationEvent('42')).toBeNull();
    expect(parseNotificationEvent('"a string"')).toBeNull();
    expect(parseNotificationEvent('null')).toBeNull();
  });

  it.each(['id', 'eventKey', 'title', 'body', 'createdAt'])(
    'returns null when %s is missing',
    (field) => {
      const payload: Record<string, unknown> = { ...valid };
      delete payload[field];
      expect(parseNotificationEvent(JSON.stringify(payload))).toBeNull();
    },
  );

  it.each(['id', 'eventKey', 'title', 'body', 'createdAt'])(
    'returns null when %s has the wrong type',
    (field) => {
      const payload: Record<string, unknown> = { ...valid, [field]: 42 };
      expect(parseNotificationEvent(JSON.stringify(payload))).toBeNull();
    },
  );

  it('rejects link: undefined specifically - the key must be string | null, not absent', () => {
    const payload: Record<string, unknown> = { ...valid };
    delete payload.link;
    expect(parseNotificationEvent(JSON.stringify(payload))).toBeNull();
  });

  it('rejects a link of the wrong type', () => {
    const payload = { ...valid, link: 42 };
    expect(parseNotificationEvent(JSON.stringify(payload))).toBeNull();
  });

  it('parses toast: false — the administrator has muted the bubble', () => {
    const payload = { ...valid, toast: false };
    expect(parseNotificationEvent(JSON.stringify(payload))).toEqual(payload);
  });

  it('rejects a missing toast rather than guessing a default', () => {
    // Neither default is safe: `true` would let a frame this client cannot
    // fully understand re-enable something an administrator switched off, and
    // `false` would silently drop toasts a server is still sending.
    const payload: Record<string, unknown> = { ...valid };
    delete payload.toast;
    expect(parseNotificationEvent(JSON.stringify(payload))).toBeNull();
  });

  it('rejects a toast of the wrong type', () => {
    expect(
      parseNotificationEvent(JSON.stringify({ ...valid, toast: 'yes' })),
    ).toBeNull();
  });
});

describe('streamEventToNotification', () => {
  const event = {
    id: 'n1',
    eventKey: 'security.role_changed',
    title: 'Title',
    body: 'Body',
    createdAt: '2026-01-01T00:00:00.000Z',
    link: null,
    toast: true,
  };

  it('spreads the event and adds readAt: null', () => {
    const { toast: _toast, ...row } = event;

    expect(streamEventToNotification(event)).toEqual({ ...row, readAt: null });
  });

  it('drops `toast` — it describes the live delivery, not the stored row', () => {
    // A fetched notification has no such field, and the centre must not hold
    // two subtly different objects depending on how one arrived.
    expect(
      streamEventToNotification({ ...event, toast: false }),
    ).not.toHaveProperty('toast');
  });
});

describe('connectNotificationStream', () => {
  beforeEach(() => {
    connectSseMock.mockReset();
    connectSseMock.mockReturnValue({ close: vi.fn() });
    getAccessTokenMock.mockReset();
    refreshTokenMock.mockReset();
  });

  it('calls connectSse with a url ending in /notifications/stream', () => {
    connectNotificationStream({ onNotification: vi.fn(), onOpen: vi.fn() });

    expect(connectSseMock).toHaveBeenCalledTimes(1);
    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    expect(options.url).toBe(NOTIFICATION_STREAM_URL);
    expect(options.url.endsWith('/notifications/stream')).toBe(true);
  });

  it('the authorization callback delegates to api.getAccessToken, prefixing Bearer', () => {
    getAccessTokenMock.mockReturnValue('tok-123');
    connectNotificationStream({ onNotification: vi.fn(), onOpen: vi.fn() });

    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    expect(options.authorization()).toBe('Bearer tok-123');
    expect(getAccessTokenMock).toHaveBeenCalled();
  });

  it('the authorization callback returns null when there is no access token', () => {
    getAccessTokenMock.mockReturnValue(null);
    connectNotificationStream({ onNotification: vi.fn(), onOpen: vi.fn() });

    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    expect(options.authorization()).toBeNull();
  });

  it('reauthenticate delegates to api.refreshToken', async () => {
    refreshTokenMock.mockResolvedValue(true);
    connectNotificationStream({ onNotification: vi.fn(), onOpen: vi.fn() });

    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    await expect(options.reauthenticate()).resolves.toBe(true);
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
  });

  it('passes onOpen and onStateChange through to connectSse', () => {
    const onOpen = vi.fn();
    const onStateChange = vi.fn();
    connectNotificationStream({ onNotification: vi.fn(), onOpen, onStateChange });

    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    expect(options.onOpen).toBe(onOpen);
    expect(options.onStateChange).toBe(onStateChange);
  });

  it('onFrame filters by event name - a non-"notification" frame never calls onNotification', () => {
    const onNotification = vi.fn();
    connectNotificationStream({ onNotification, onOpen: vi.fn() });

    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    const frame: SseFrame = { event: 'message', data: '{}', id: null };
    options.onFrame(frame);

    expect(onNotification).not.toHaveBeenCalled();
  });

  it('onFrame calls onNotification with a well-formed notification frame, passing toast through as the second argument', () => {
    const onNotification = vi.fn();
    connectNotificationStream({ onNotification, onOpen: vi.fn() });

    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    const payload = {
      id: 'n1',
      eventKey: 'security.role_changed',
      title: 'Title',
      body: 'Body',
      createdAt: '2026-01-01T00:00:00.000Z',
      link: '/settings',
      toast: true,
    };
    const frame: SseFrame = {
      event: NOTIFICATION_SSE_EVENT,
      data: JSON.stringify(payload),
      id: null,
    };
    options.onFrame(frame);

    const { toast: _toast, ...row } = payload;

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith({ ...row, readAt: null }, true);
  });

  // #227: `toast` is the live-delivery instruction, and it must reach
  // `onNotification` UNCHANGED from the frame's own value - a `false` here is
  // an administrator's mute reaching this specific arrival, and folding it
  // into a default (or dropping it) would silently re-enable a bubble the
  // server just said not to show.
  it('onFrame passes toast: false through unchanged, as the second argument', () => {
    const onNotification = vi.fn();
    connectNotificationStream({ onNotification, onOpen: vi.fn() });

    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    const payload = {
      id: 'n2',
      eventKey: 'security.role_changed',
      title: 'Title',
      body: 'Body',
      createdAt: '2026-01-01T00:00:00.000Z',
      link: '/settings',
      toast: false,
    };
    const frame: SseFrame = {
      event: NOTIFICATION_SSE_EVENT,
      data: JSON.stringify(payload),
      id: null,
    };
    options.onFrame(frame);

    const { toast: _toast, ...row } = payload;

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith({ ...row, readAt: null }, false);
  });

  it('onFrame silently drops a notification-event frame with malformed JSON - no throw, onNotification not called', () => {
    const onNotification = vi.fn();
    connectNotificationStream({ onNotification, onOpen: vi.fn() });

    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    const frame: SseFrame = { event: NOTIFICATION_SSE_EVENT, data: '{bad json', id: null };

    expect(() => options.onFrame(frame)).not.toThrow();
    expect(onNotification).not.toHaveBeenCalled();
  });

  it('onFrame silently drops a notification-event frame with valid JSON missing a required field', () => {
    const onNotification = vi.fn();
    connectNotificationStream({ onNotification, onOpen: vi.fn() });

    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    const incomplete = { id: 'n1', eventKey: 'x', title: 'T' }; // missing body/createdAt/link
    const frame: SseFrame = {
      event: NOTIFICATION_SSE_EVENT,
      data: JSON.stringify(incomplete),
      id: null,
    };

    expect(() => options.onFrame(frame)).not.toThrow();
    expect(onNotification).not.toHaveBeenCalled();
  });
});
