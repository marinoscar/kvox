import {
  HEARTBEAT_INTERVAL_MS,
  NOTIFICATION_SSE_EVENT,
  NotificationStreamEvent,
  NotificationStreamService,
  SseMessage,
} from './notification-stream.service';

// =============================================================================
// NotificationStreamService — tests (issue #127, epic #109)
// =============================================================================
//
// No NestJS TestingModule: `NotificationStreamService` has no constructor
// dependencies, so `new NotificationStreamService()` is enough — the same
// pattern the header comment on the source file uses to justify testing it
// by calling functions directly.
//
// THE CENTREPIECE is the isolation test below: two different users, each
// subscribed, and a publish to one must leave the other's captured stream
// completely untouched — not merely uncounted, but deep-equal to its
// pre-publish state.
// =============================================================================

function makeEvent(overrides: Partial<NotificationStreamEvent> = {}): NotificationStreamEvent {
  return {
    id: 'notif-1',
    eventKey: 'security.role_changed',
    title: 'Your roles changed',
    body: 'An administrator changed your roles.',
    link: '/settings',
    createdAt: '2026-01-01T00:00:00.000Z',
    // #226. The registry is a dumb pipe for this field — it publishes whatever
    // the browser channel computed — so the default here is simply the ordinary
    // case, and a test that cares passes an override.
    toast: true,
    ...overrides,
  };
}

describe('NotificationStreamService', () => {
  let service: NotificationStreamService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new NotificationStreamService();
  });

  afterEach(async () => {
    // Make sure no interval from one test bleeds into the next.
    await service.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /** Subscribes and collects every emitted message into an array, in order. */
  function collect(userId: string): {
    messages: SseMessage[];
    unsubscribe: () => void;
  } {
    const messages: SseMessage[] = [];
    const subscription = service.subscribe(userId).subscribe((msg) => {
      messages.push(msg);
    });
    return { messages, unsubscribe: () => subscription.unsubscribe() };
  }

  // ==========================================================================
  // Connection lifecycle
  // ==========================================================================

  describe('subscribe()', () => {
    it('emits { comment: "connected" } immediately on subscription', () => {
      const { messages } = collect('user-a');

      expect(messages).toEqual([{ comment: 'connected' }]);
    });

    it('emits a heartbeat comment every HEARTBEAT_INTERVAL_MS', () => {
      const { messages } = collect('user-a');
      expect(messages).toHaveLength(1); // just 'connected' so far

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(messages).toEqual([
        { comment: 'connected' },
        { comment: 'heartbeat' },
      ]);

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(messages).toEqual([
        { comment: 'connected' },
        { comment: 'heartbeat' },
        { comment: 'heartbeat' },
      ]);
    });

    it('does not fire a heartbeat before the interval has elapsed', () => {
      const { messages } = collect('user-a');

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
      expect(messages).toEqual([{ comment: 'connected' }]);
    });
  });

  // ==========================================================================
  // THE CENTREPIECE: per-user isolation
  // ==========================================================================

  describe('per-user isolation', () => {
    it('publish(userA, event) never reaches userB — userB’s captured stream stays byte-identical to its pre-publish state', () => {
      const a = collect('user-a');
      const b = collect('user-b');

      // Snapshot userB's state BEFORE the publish, so the post-publish
      // assertion is a real diff and not just "it still has length 1".
      const bBeforePublish = [...b.messages];

      const event = makeEvent({ id: 'notif-for-a' });
      const delivered = service.publish('user-a', event);

      expect(delivered).toBe(1);

      // userA got it.
      expect(a.messages).toEqual([
        { comment: 'connected' },
        { type: NOTIFICATION_SSE_EVENT, data: event },
      ]);

      // userB's array is deep-equal to its pre-publish snapshot: neither the
      // event payload nor any trace of it (no extra array entry at all).
      expect(b.messages).toEqual(bBeforePublish);
      expect(b.messages).toEqual([{ comment: 'connected' }]);
      expect(b.messages).not.toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ id: 'notif-for-a' }) }),
      );
    });

    it('a user with multiple tabs open receives the same publish on every one of their own connections', () => {
      const tab1 = collect('user-a');
      const tab2 = collect('user-a');
      const other = collect('user-b');

      const event = makeEvent();
      const delivered = service.publish('user-a', event);

      expect(delivered).toBe(2);
      expect(tab1.messages).toContainEqual({ type: NOTIFICATION_SSE_EVENT, data: event });
      expect(tab2.messages).toContainEqual({ type: NOTIFICATION_SSE_EVENT, data: event });
      expect(other.messages).toEqual([{ comment: 'connected' }]);
    });
  });

  // ==========================================================================
  // connectionCount()
  // ==========================================================================

  describe('connectionCount()', () => {
    it('is 0 for a user who has never connected', () => {
      expect(service.connectionCount('nobody')).toBe(0);
    });

    it('reflects opens and a single close', () => {
      expect(service.connectionCount('user-a')).toBe(0);

      const first = collect('user-a');
      expect(service.connectionCount('user-a')).toBe(1);

      const second = collect('user-a');
      expect(service.connectionCount('user-a')).toBe(2);

      first.unsubscribe();
      expect(service.connectionCount('user-a')).toBe(1);

      second.unsubscribe();
      expect(service.connectionCount('user-a')).toBe(0);
    });

    it('unsubscribing removes only that one observer, leaving a sibling connection alive', () => {
      const first = collect('user-a');
      const second = collect('user-a');

      first.unsubscribe();

      expect(service.connectionCount('user-a')).toBe(1);

      // The sibling connection is still alive: it still receives publishes.
      const event = makeEvent();
      const delivered = service.publish('user-a', event);
      expect(delivered).toBe(1);
      expect(second.messages).toContainEqual({ type: NOTIFICATION_SSE_EVENT, data: event });
    });

    it('unsubscribing the LAST subscriber for a user deletes the Map bucket entirely', () => {
      const only = collect('user-a');
      expect((service as any).subscribers.has('user-a')).toBe(true);

      only.unsubscribe();

      expect(service.connectionCount('user-a')).toBe(0);
      // Not merely an empty Set left behind — the bucket itself is gone,
      // which is the property that keeps a long-lived process from
      // accumulating one Map entry per user who ever connected.
      expect((service as any).subscribers.has('user-a')).toBe(false);
    });
  });

  // ==========================================================================
  // publish()
  // ==========================================================================

  describe('publish()', () => {
    it('returns 0 and does not throw when nobody is subscribed', () => {
      expect(() => {
        const delivered = service.publish('nobody-home', makeEvent());
        expect(delivered).toBe(0);
      }).not.toThrow();
    });

    it('returns 0 and does not throw when publishing to a bucket that has already been torn down', () => {
      const { unsubscribe } = collect('user-a');
      unsubscribe();

      expect(() => {
        const delivered = service.publish('user-a', makeEvent());
        expect(delivered).toBe(0);
      }).not.toThrow();
    });

    it('never throws even if an individual subscriber write fails', () => {
      const { messages } = collect('user-a');

      // Reach into the private registry to make one subscriber's `.next`
      // throw, simulating a connection that died between the Map lookup and
      // the write — the scenario the try/catch in `publish` exists for.
      const bucket: Set<{ next: (msg: SseMessage) => void }> = (service as any).subscribers.get(
        'user-a',
      );
      const [observer] = [...bucket];
      const originalNext = observer.next.bind(observer);
      let callCount = 0;
      observer.next = ((msg: SseMessage) => {
        callCount += 1;
        throw new Error('write to a dead connection');
      }) as never;

      let delivered = -1;
      expect(() => {
        delivered = service.publish('user-a', makeEvent());
      }).not.toThrow();

      expect(callCount).toBe(1);
      // The throwing subscriber is not counted as delivered.
      expect(delivered).toBe(0);
      // No new message landed in the collected array (the mocked `.next`
      // threw before pushing).
      expect(messages).toEqual([{ comment: 'connected' }]);

      observer.next = originalNext;
    });
  });

  // ==========================================================================
  // onModuleDestroy()
  // ==========================================================================

  describe('onModuleDestroy()', () => {
    it('completes every open subscriber across every user', async () => {
      let aCompleted = false;
      let bCompleted = false;

      service.subscribe('user-a').subscribe({ complete: () => (aCompleted = true) });
      service.subscribe('user-b').subscribe({ complete: () => (bCompleted = true) });

      expect(aCompleted).toBe(false);
      expect(bCompleted).toBe(false);

      await service.onModuleDestroy();

      expect(aCompleted).toBe(true);
      expect(bCompleted).toBe(true);
    });

    it('clears the internal map so no bucket survives shutdown', async () => {
      service.subscribe('user-a').subscribe();
      service.subscribe('user-b').subscribe();

      expect((service as any).subscribers.size).toBeGreaterThan(0);

      await service.onModuleDestroy();

      expect((service as any).subscribers.size).toBe(0);
      expect(service.connectionCount('user-a')).toBe(0);
      expect(service.connectionCount('user-b')).toBe(0);
    });

    it('completing every subscriber also runs each one’s teardown (interval cleared, bucket removed)', async () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      service.subscribe('user-a').subscribe();

      await service.onModuleDestroy();

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('is a no-op — no throw — when there are zero subscribers', async () => {
      expect((service as any).subscribers.size).toBe(0);

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();

      expect((service as any).subscribers.size).toBe(0);
    });

    it('handles multiple users each with multiple connections without skipping any (snapshot-before-iterate)', async () => {
      const completions: string[] = [];

      service.subscribe('user-a').subscribe({ complete: () => completions.push('a1') });
      service.subscribe('user-a').subscribe({ complete: () => completions.push('a2') });
      service.subscribe('user-b').subscribe({ complete: () => completions.push('b1') });

      await service.onModuleDestroy();

      expect(completions.sort()).toEqual(['a1', 'a2', 'b1']);
    });
  });
});
