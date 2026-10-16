import {
  isChannelEnabled,
  readNotificationPreferences,
  resolveChannels,
  type NotificationPreferences,
} from './notification-preferences';
import type { NotificationEventDef } from './notification-events';

// =============================================================================
// Preference resolution — tests (issue #125, epic #109)
// =============================================================================
//
// This is the subtle part of #125: a sparse, absent-key-means-default contract
// over a JSONB blob a user can PATCH directly. Every branch in
// notification-preferences.ts exists because getting one of them backwards is
// either "the whole user base goes silent on arrival" or "a crafted PATCH
// silences a security alert" — see the header comment on that file. These
// tests exist to make either regression fail loudly here rather than being
// discovered from a support ticket.
//
// Fixture events are used throughout instead of the real registry
// (notification-events.ts) so this file can freely exercise defaultEnabled:
// true AND false, and mandatory AND non-mandatory, independent of whatever
// NOTIFICATION_EVENTS happens to contain today.
// =============================================================================

const optionalOnByDefault: NotificationEventDef = {
  key: 'test.optional-on',
  label: 'Optional (default on)',
  description: 'A non-mandatory event the user gets unless they opt out.',
  channels: ['email', 'browser'],
  defaultEnabled: true,
};

const optionalOffByDefault: NotificationEventDef = {
  key: 'test.optional-off',
  label: 'Optional (default off)',
  description: 'A non-mandatory event the user does not get unless they opt in.',
  channels: ['email', 'browser'],
  defaultEnabled: false,
};

const mandatoryEvent: NotificationEventDef = {
  key: 'test.mandatory',
  label: 'Mandatory',
  description: 'A security event the user cannot silence.',
  channels: ['email', 'browser'],
  defaultEnabled: true,
  mandatory: true,
};

// =============================================================================
// readNotificationPreferences — the sparse parse
// =============================================================================

describe('readNotificationPreferences', () => {
  describe('total and never throwing', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'nope'],
      ['a number', 42],
      ['a boolean', true],
      ['an array', ['email']],
    ])('returns {} for a settings value that is %s', (_label, value) => {
      expect(readNotificationPreferences(value)).toEqual({});
    });

    it('returns {} when the settings row has no notifications namespace at all', () => {
      expect(
        readNotificationPreferences({ theme: 'dark', profile: {} }),
      ).toEqual({});
    });

    it('returns {} when the notifications namespace is present but not an object', () => {
      expect(readNotificationPreferences({ notifications: 'nope' })).toEqual(
        {},
      );
      expect(
        readNotificationPreferences({ notifications: ['email'] }),
      ).toEqual({});
      expect(readNotificationPreferences({ notifications: null })).toEqual(
        {},
      );
    });
  });

  describe('unknown channels are dropped; unknown event keys are retained', () => {
    it('drops a channel key the registry does not declare, keeping a sibling known channel', () => {
      const prefs = readNotificationPreferences({
        notifications: {
          email: { 'user.welcome': false },
          // 'sms' rather than 'push': #228 (epic #215) widened
          // NOTIFICATION_CHANNELS to include 'push', so 'push' is no longer a
          // usable stand-in for "a channel the registry does not declare".
          sms: { 'user.welcome': false }, // not a member of NOTIFICATION_CHANNELS
        },
      });

      expect(prefs.email).toEqual({ 'user.welcome': false });
      expect((prefs as Record<string, unknown>).sms).toBeUndefined();
    });

    it('keeps an event key this build does not recognise, within a known channel', () => {
      // A rolling deploy can legitimately have a newer build write a key an
      // older build has not registered yet. Dropping it here would be a lossy
      // read that a later PATCH (#126) would then persist as a loss.
      const prefs = readNotificationPreferences({
        notifications: {
          email: { 'not.yet.registered.by.this.build': true, 'user.welcome': false },
        },
      });

      expect(prefs.email).toEqual({
        'not.yet.registered.by.this.build': true,
        'user.welcome': false,
      });
    });
  });

  describe('malformed data degrades entry by entry rather than discarding everything', () => {
    it('drops a channel whose stored value is not an object, keeping a sibling channel intact', () => {
      const prefs = readNotificationPreferences({
        notifications: {
          email: { 'user.welcome': false },
          browser: 'not-an-object',
        },
      });

      expect(prefs.email).toEqual({ 'user.welcome': false });
      expect(prefs.browser).toBeUndefined();
    });

    it('drops a channel whose stored value is an array, keeping a sibling channel intact', () => {
      const prefs = readNotificationPreferences({
        notifications: {
          email: { 'user.welcome': false },
          browser: ['user.welcome'],
        },
      });

      expect(prefs.email).toEqual({ 'user.welcome': false });
      expect(prefs.browser).toBeUndefined();
    });

    it('drops a non-boolean event value, keeping a valid boolean sibling mute in the SAME channel', () => {
      // This is the case the header comment calls out explicitly: one
      // malformed key must not discard a deliberate mute sitting right next
      // to it.
      const prefs = readNotificationPreferences({
        notifications: {
          email: {
            'security.role_changed': 'yes', // malformed: a string, not a boolean
            'user.welcome': false, // a real, deliberate mute
          },
        },
      });

      expect(prefs.email).toEqual({ 'user.welcome': false });
      expect((prefs.email as Record<string, unknown>)['security.role_changed']).toBeUndefined();
    });

    it('drops a null event value and a nested-object event value, keeping a valid sibling', () => {
      const prefs = readNotificationPreferences({
        notifications: {
          email: {
            'a.null': null,
            'a.number': 1,
            'a.nested.object': { on: true },
            'user.welcome': false,
          },
        },
      });

      expect(prefs.email).toEqual({ 'user.welcome': false });
    });

    it('treats an empty stored channel map the same as an absent channel', () => {
      // { email: {} } and {} must resolve identically per the source
      // comment — an empty map is not stored as a real preference.
      const prefs = readNotificationPreferences({
        notifications: { email: {} },
      });

      expect(prefs.email).toBeUndefined();
    });

    it('a channel that becomes entirely malformed entries resolves as absent, not as {}', () => {
      const prefs = readNotificationPreferences({
        notifications: { email: { 'user.welcome': 'nope', 'x.y': 1 } },
      });

      expect(prefs.email).toBeUndefined();
    });
  });

  describe('__proto__ as a stored key does not poison the lookup', () => {
    it('JSON.parse makes __proto__ a real own property; a valid sibling mute still survives', () => {
      // Constructed via JSON.parse specifically: JSON.parse creates a genuine
      // own data property named "__proto__" (via CreateDataProperty), unlike
      // an object literal `{ __proto__: ... }`, which instead sets the
      // object's actual prototype. This is the shape a JSONB column round
      // trip actually produces.
      const raw = JSON.parse(
        '{"notifications":{"email":{"__proto__":true,"user.welcome":false}}}',
      ) as unknown;

      expect(() => readNotificationPreferences(raw)).not.toThrow();

      const prefs = readNotificationPreferences(raw);

      // The deliberate mute survives regardless of the neighbouring
      // __proto__ entry.
      expect(prefs.email).toMatchObject({ 'user.welcome': false });

      // No pollution: a fresh object's prototype is untouched by having
      // processed this input.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });

    it('a normally-inherited key name (constructor) is treated as an ordinary own property, not the inherited function', () => {
      const raw = JSON.parse(
        '{"notifications":{"email":{"constructor":true,"user.welcome":false}}}',
      ) as unknown;

      const prefs = readNotificationPreferences(raw);

      expect(prefs.email).toEqual({ constructor: true, 'user.welcome': false });

      // And it resolves through isChannelEnabled as the boolean it is, not
      // as truthy-because-it's-a-function.
      const event: NotificationEventDef = {
        key: 'constructor',
        label: 'x',
        description: 'x',
        channels: ['email'],
        defaultEnabled: false,
      };
      expect(isChannelEnabled(event, 'email', prefs)).toBe(true);
    });
  });
});

// =============================================================================
// isChannelEnabled — the three-level fallback and the mandatory override
// =============================================================================

describe('isChannelEnabled', () => {
  describe('absent-key contract: three independent levels, each falling back to defaultEnabled', () => {
    it('an absent notifications namespace (preferences = {}) uses the registry default for every event', () => {
      expect(isChannelEnabled(optionalOnByDefault, 'email', {})).toBe(true);
      expect(isChannelEnabled(optionalOnByDefault, 'browser', {})).toBe(true);
      expect(isChannelEnabled(optionalOffByDefault, 'email', {})).toBe(false);
      expect(isChannelEnabled(optionalOffByDefault, 'browser', {})).toBe(
        false,
      );
    });

    it('an absent channel key (the user has opinions on one channel, not this one) uses the default', () => {
      const prefs: NotificationPreferences = {
        email: { [optionalOnByDefault.key]: false },
        // browser is entirely absent
      };

      expect(isChannelEnabled(optionalOnByDefault, 'browser', prefs)).toBe(
        true,
      );
    });

    it('an absent event key within a present channel uses the default', () => {
      const prefs: NotificationPreferences = {
        email: { 'some.other.event': false },
      };

      expect(isChannelEnabled(optionalOnByDefault, 'email', prefs)).toBe(
        true,
      );
      expect(isChannelEnabled(optionalOffByDefault, 'email', prefs)).toBe(
        false,
      );
    });
  });

  describe('an explicit choice overrides the default', () => {
    it('explicit false suppresses an event that defaults on', () => {
      const prefs: NotificationPreferences = {
        email: { [optionalOnByDefault.key]: false },
      };
      expect(isChannelEnabled(optionalOnByDefault, 'email', prefs)).toBe(
        false,
      );
    });

    it('explicit true enables an event that defaults off', () => {
      const prefs: NotificationPreferences = {
        email: { [optionalOffByDefault.key]: true },
      };
      expect(isChannelEnabled(optionalOffByDefault, 'email', prefs)).toBe(
        true,
      );
    });
  });

  describe('mandatory overrides an explicit opt-out — the security boundary', () => {
    it('mandatory returns true even when the user explicitly stored false on every declared channel', () => {
      const prefs: NotificationPreferences = {
        email: { [mandatoryEvent.key]: false },
        browser: { [mandatoryEvent.key]: false },
      };

      expect(isChannelEnabled(mandatoryEvent, 'email', prefs)).toBe(true);
      expect(isChannelEnabled(mandatoryEvent, 'browser', prefs)).toBe(true);
    });

    it('no stored shape reaches the opt-out branch for a mandatory event', () => {
      // A grab bag of every shape that would suppress a NON-mandatory event
      // elsewhere in this file, replayed against the mandatory event. If any
      // of these ever flips this to false, the mandatory gate has a hole.
      const adversarialShapes: NotificationPreferences[] = [
        {},
        { email: { [mandatoryEvent.key]: false } },
        { browser: { [mandatoryEvent.key]: false } },
        {
          email: { [mandatoryEvent.key]: false },
          browser: { [mandatoryEvent.key]: false },
        },
        // A malformed sibling next to the mute changes nothing either.
        { email: { [mandatoryEvent.key]: false, 'other.key': 'yes' as unknown as boolean } },
      ];

      for (const shape of adversarialShapes) {
        for (const channel of mandatoryEvent.channels) {
          expect(isChannelEnabled(mandatoryEvent, channel, shape)).toBe(true);
        }
      }
    });
  });

  describe('defensive: a non-boolean choice reaching this function directly falls back to the default', () => {
    it('is not thrown by readNotificationPreferences under normal operation, but is handled if a caller hands one in anyway', () => {
      const prefs = {
        email: { [optionalOnByDefault.key]: 'yes' as unknown as boolean },
      } as NotificationPreferences;

      expect(isChannelEnabled(optionalOnByDefault, 'email', prefs)).toBe(
        optionalOnByDefault.defaultEnabled,
      );
    });
  });
});

// =============================================================================
// resolveChannels — the intersection the dispatcher consumes
// =============================================================================

describe('resolveChannels', () => {
  it('resolves per-channel independently: email off, browser on', () => {
    const prefs: NotificationPreferences = {
      email: { [optionalOnByDefault.key]: false },
      // browser: absent -> default (true)
    };

    expect(resolveChannels(optionalOnByDefault, prefs)).toEqual(['browser']);
  });

  it('mandatory: returns EVERY declared channel, all-or-nothing, regardless of stored preference', () => {
    const prefs: NotificationPreferences = {
      email: { [mandatoryEvent.key]: false },
      browser: { [mandatoryEvent.key]: false },
    };

    expect(resolveChannels(mandatoryEvent, prefs)).toEqual(
      mandatoryEvent.channels,
    );
  });

  it('returns a fresh array, not a reference into the event definition', () => {
    const result = resolveChannels(optionalOnByDefault, {});
    expect(result).not.toBe(optionalOnByDefault.channels);

    result.push('email');
    expect(optionalOnByDefault.channels).toEqual(['email', 'browser']);
  });

  it('returns [] when every declared channel is muted', () => {
    const prefs: NotificationPreferences = {
      email: { [optionalOnByDefault.key]: false },
      browser: { [optionalOnByDefault.key]: false },
    };

    expect(resolveChannels(optionalOnByDefault, prefs)).toEqual([]);
  });
});
