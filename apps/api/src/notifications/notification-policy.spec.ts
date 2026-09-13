import { NOTIFICATION_EVENTS, type NotificationEventDef } from './notification-events';
import {
  DEFAULT_NOTIFICATION_POLICY,
  isBrowserToastAllowed,
  policyChannels,
  type NotificationPolicy,
} from './notification-policy';
import { resolveChannels } from './notification-preferences';

// =============================================================================
// Admin policy resolution — tests (issue #226, epic #215)
// =============================================================================
//
// Pure functions, so this suite calls them directly: no DI, no database, no
// HTTP. The properties under test are the two the issue turns on, and they pull
// in opposite directions on purpose:
//
//   1. An operator's switch REALLY suppresses browser delivery — it is not a
//      client-side suggestion.
//   2. It does NOT suppress a `mandatory` event's channel, because that
//      event's `notifications` row IS the delivery and muting a toast must not
//      mute an audit-relevant inbox entry.
//
// SYNTHETIC EVENT DEFINITIONS, not registry entries, for the non-mandatory
// browser case. Today's registry has exactly one browser-capable event and it
// is mandatory (`security.role_changed`), so a test written against the
// registry alone could not exercise the branch where policy actually removes a
// channel — and that branch is the whole feature. Building a definition here
// tests the FUNCTION rather than today's contents of a list that is expected to
// grow.
// =============================================================================

/** A browser-capable event a user is free to opt out of. */
const optionalEvent: NotificationEventDef = {
  key: 'build.finished',
  label: 'Build finished',
  description: 'Sent when one of your builds finishes.',
  channels: ['email', 'browser'],
  defaultEnabled: true,
};

/** The same, but one the user may not silence — the `mandatory` branch. */
const mandatoryEvent: NotificationEventDef = {
  ...optionalEvent,
  key: 'security.something_happened',
  mandatory: true,
};

/** Email-only: policy has nothing to say about it either way. */
const emailOnlyEvent: NotificationEventDef = {
  key: 'user.welcome',
  label: 'Welcome',
  description: 'Sent once.',
  channels: ['email'],
  defaultEnabled: true,
};

// SYNTHETIC, same reason as the browser fixtures above: #228 (epic #215)
// widened NOTIFICATION_CHANNELS to include 'push', but no NOTIFICATION_EVENTS
// entry declares it yet (that is #229/#230's job), so a test against the
// registry alone could not exercise `policyChannels` for a push-capable
// event at all.
const pushCapableEvent: NotificationEventDef = {
  key: 'synthetic.push_capable',
  label: 'Push-capable event',
  description: 'A synthetic event for exercising the push channel before any real event declares it.',
  channels: ['email', 'browser', 'push'],
  defaultEnabled: true,
};

const KILL_SWITCH_OFF: NotificationPolicy = {
  browserEnabled: false,
  disabledEvents: [],
};

const ONE_EVENT_SUPPRESSED: NotificationPolicy = {
  browserEnabled: true,
  disabledEvents: ['build.finished'],
};

describe('isBrowserToastAllowed', () => {
  it('allows a toast under the default policy', () => {
    expect(
      isBrowserToastAllowed('build.finished', DEFAULT_NOTIFICATION_POLICY),
    ).toBe(true);
  });

  it('treats an absent policy as the permissive default', () => {
    // The direction matters: a policy that could not be read must not silence
    // a security alert's toast with nothing anywhere to say why.
    expect(isBrowserToastAllowed('build.finished')).toBe(true);
  });

  it('refuses every event when the kill switch is off', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(isBrowserToastAllowed(event.key, KILL_SWITCH_OFF)).toBe(false);
    }
  });

  it('refuses only the named event when one is suppressed', () => {
    expect(
      isBrowserToastAllowed('build.finished', ONE_EVENT_SUPPRESSED),
    ).toBe(false);
    expect(
      isBrowserToastAllowed('security.role_changed', ONE_EVENT_SUPPRESSED),
    ).toBe(true);
  });

  it('has NO mandatory exemption — the toast is decoration, the row is the delivery', () => {
    expect(isBrowserToastAllowed(mandatoryEvent.key, KILL_SWITCH_OFF)).toBe(
      false,
    );
  });
});

describe('policyChannels', () => {
  it('returns the declared channels untouched under the default policy', () => {
    expect(policyChannels(optionalEvent, DEFAULT_NOTIFICATION_POLICY)).toEqual([
      'email',
      'browser',
    ]);
  });

  it('drops browser from an optional event when the kill switch is off', () => {
    expect(policyChannels(optionalEvent, KILL_SWITCH_OFF)).toEqual(['email']);
  });

  it('drops browser from exactly the suppressed event and no other', () => {
    expect(policyChannels(optionalEvent, ONE_EVENT_SUPPRESSED)).toEqual([
      'email',
    ]);
    expect(
      policyChannels(
        { ...optionalEvent, key: 'build.started' },
        ONE_EVENT_SUPPRESSED,
      ),
    ).toEqual(['email', 'browser']);
  });

  it('never touches email — #225 declared no deployment-wide gate for it', () => {
    expect(policyChannels(emailOnlyEvent, KILL_SWITCH_OFF)).toEqual(['email']);
  });

  it('KEEPS a mandatory event’s browser channel whatever the policy says', () => {
    // THE INVARIANT OF #226. Dropping it here would stop the dispatcher calling
    // the browser channel, and the `notifications` row — the durable record a
    // privilege change must leave behind — would never be written.
    expect(policyChannels(mandatoryEvent, KILL_SWITCH_OFF)).toEqual([
      'email',
      'browser',
    ]);
    expect(
      policyChannels(mandatoryEvent, {
        browserEnabled: true,
        disabledEvents: [mandatoryEvent.key],
      }),
    ).toEqual(['email', 'browser']);
  });

  it('returns a fresh array rather than the registry’s own', () => {
    const event = NOTIFICATION_EVENTS.find((e) => e.channels.length > 1);
    if (!event) throw new Error('Test fixture error: no multi-channel event.');

    const returned = policyChannels(event, DEFAULT_NOTIFICATION_POLICY);
    returned.length = 0;

    expect(event.channels.length).toBeGreaterThan(0);
  });

  it('never touches push either - #228 widened the type only, and #230 owns its eventual gate', () => {
    // Mirrors the 'never touches email' test above: push falls through the
    // `channel === 'browser' ? isBrowserToastAllowed(...) : true` branch
    // exactly like email does today. The browser kill switch still drops
    // *browser* (that gate is real and unrelated to this widening) but must
    // leave both email and push untouched.
    expect(policyChannels(pushCapableEvent, KILL_SWITCH_OFF)).toEqual([
      'email',
      'push',
    ]);
    expect(
      policyChannels(pushCapableEvent, {
        browserEnabled: true,
        disabledEvents: [pushCapableEvent.key],
      }),
    ).toEqual(['email', 'push']);
  });

  it('an unknown key in disabledEvents matches nothing and breaks nothing', () => {
    // #225 stores syntactically valid keys without checking them against the
    // registry, so that a rollback across the addition of an event is
    // uneventful. That only works if a stale key is inert here.
    expect(
      policyChannels(optionalEvent, {
        browserEnabled: true,
        disabledEvents: ['nothing.declares_this'],
      }),
    ).toEqual(['email', 'browser']);
  });
});

describe('resolveChannels agrees with policyChannels under every combination', () => {
  // THE AGREEMENT PROPERTY. `GET /api/notifications/events` serves
  // `policyChannels`, and the dispatcher narrows `resolveChannels`. A channel
  // the matrix offers must be one delivery would use, and vice versa — so
  // `resolveChannels` must never return a channel `policyChannels` dropped.
  const policies: NotificationPolicy[] = [
    DEFAULT_NOTIFICATION_POLICY,
    KILL_SWITCH_OFF,
    { browserEnabled: true, disabledEvents: ['build.finished'] },
    { browserEnabled: true, disabledEvents: ['security.something_happened'] },
    { browserEnabled: false, disabledEvents: ['build.finished'] },
  ];

  const events = [
    ...NOTIFICATION_EVENTS,
    optionalEvent,
    mandatoryEvent,
    emailOnlyEvent,
  ];

  it('resolveChannels is always a subset of policyChannels', () => {
    for (const event of events) {
      for (const policy of policies) {
        const offered = policyChannels(event, policy);

        for (const preferences of [
          {},
          { browser: { [event.key]: false } },
          { email: { [event.key]: false } },
        ]) {
          for (const channel of resolveChannels(event, preferences, policy)) {
            expect(offered).toContain(channel);
          }
        }
      }
    }
  });

  it('with no stored preferences the two are identical for a default-enabled event', () => {
    for (const event of events) {
      if (!event.defaultEnabled) continue;

      for (const policy of policies) {
        expect(resolveChannels(event, {}, policy)).toEqual(
          policyChannels(event, policy),
        );
      }
    }
  });

  it('a user’s opt-out narrows further, and only for a non-mandatory event', () => {
    expect(
      resolveChannels(
        optionalEvent,
        { browser: { [optionalEvent.key]: false } },
        DEFAULT_NOTIFICATION_POLICY,
      ),
    ).toEqual(['email']);

    expect(
      resolveChannels(
        mandatoryEvent,
        { browser: { [mandatoryEvent.key]: false } },
        KILL_SWITCH_OFF,
      ),
    ).toEqual(['email', 'browser']);
  });

  it('defaults to the permissive policy when none is passed', () => {
    expect(resolveChannels(optionalEvent, {})).toEqual(['email', 'browser']);
  });
});
