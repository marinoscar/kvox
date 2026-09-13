import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  NotificationChannel,
  channelsFor,
  findEvent,
  isMandatory,
  supportsChannel,
} from './notification-events';

// =============================================================================
// Notification event registry — tests (issue #121, epic #109)
// =============================================================================
//
// This is a small, pure data module, so the value here is not in restating
// today's three seeded events — it is in the INVARIANTS that must keep
// holding as more events are added later. Every structural check below is
// written as a loop over `NOTIFICATION_EVENTS`, never hardcoded to today's
// count or contents, so it keeps guarding the registry as it grows.
// =============================================================================

describe('NOTIFICATION_EVENTS structural invariants', () => {
  it('has at least one event registered', () => {
    // Sanity check for the loops below: an empty array would make every
    // `.every(...)` assertion in this file vacuously true.
    expect(NOTIFICATION_EVENTS.length).toBeGreaterThan(0);
  });

  it('every key is unique', () => {
    const keys = NOTIFICATION_EVENTS.map((event) => event.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every event declares at least one channel', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.channels.length).toBeGreaterThan(0);
    }
  });

  it('every declared channel is a member of NOTIFICATION_CHANNELS', () => {
    for (const event of NOTIFICATION_EVENTS) {
      for (const channel of event.channels) {
        expect(NOTIFICATION_CHANNELS).toContain(channel);
      }
    }
  });

  it('every event has a non-empty label', () => {
    // Rendered as the row heading on the preferences page (#126) — a blank
    // label ships a row with no heading.
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('every event has a non-empty description', () => {
    // The only place "why did I get this?" is answered — a blank
    // description ships a blank row.
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('mandatory implies defaultEnabled: true', () => {
    // The most valuable invariant in this file. `mandatory` with
    // `defaultEnabled: false` is self-contradictory: it asserts a user
    // cannot turn off something that is already off. Every mandatory event,
    // present and future, must default to enabled.
    for (const event of NOTIFICATION_EVENTS) {
      if (event.mandatory === true) {
        expect(event.defaultEnabled).toBe(true);
      }
    }
  });

  it('every key follows the documented "<area>.<event>" convention', () => {
    // This is a CONVENTION the three seeded keys happen to follow (see the
    // "KEYS ARE NAMESPACED" comment on NOTIFICATION_EVENTS in
    // notification-events.ts), not a functional requirement enforced
    // anywhere else in the registry's code — findEvent/channelsFor/etc. treat
    // `key` as an opaque string. This test exists so that if the convention
    // is ever deliberately abandoned, the change is a conscious edit to this
    // test rather than a silent drift.
    const NAMESPACED_KEY = /^[a-z]+(_[a-z]+)*\.[a-z]+(_[a-z]+)*$/;
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.key).toMatch(NAMESPACED_KEY);
    }
  });
});

describe('findEvent', () => {
  it('returns the definition for a known key', () => {
    const event = findEvent('security.role_changed');
    expect(event).toBeDefined();
    expect(event?.key).toBe('security.role_changed');
  });

  it('returns undefined for an unknown key', () => {
    expect(findEvent('does.not_exist')).toBeUndefined();
  });
});

describe('channelsFor', () => {
  it("returns the event's declared channels for a known key", () => {
    expect(channelsFor('security.role_changed')).toEqual(['email', 'browser']);
  });

  it('returns an empty array for an unknown key, rather than throwing', () => {
    expect(() => channelsFor('does.not_exist')).not.toThrow();
    expect(channelsFor('does.not_exist')).toEqual([]);
  });

  it('returns a defensive copy: mutating the result does not affect a later call', () => {
    // Called out specifically by the implementer: a caller sorting the
    // result in place (or pushing to it) must not silently reconfigure
    // delivery for every later dispatch in the process.
    const first = channelsFor('security.role_changed');
    first.sort().reverse();
    first.push('email');
    first.length = 0;

    const second = channelsFor('security.role_changed');
    expect(second).toEqual(['email', 'browser']);
  });

  it('returns a fresh array instance on every call', () => {
    const first = channelsFor('security.role_changed');
    const second = channelsFor('security.role_changed');
    expect(first).not.toBe(second);
  });
});

describe('supportsChannel', () => {
  it('is true for a channel the event declares', () => {
    expect(supportsChannel('security.role_changed', 'email')).toBe(true);
    expect(supportsChannel('security.role_changed', 'browser')).toBe(true);
  });

  it('is false for a channel the event does not declare', () => {
    expect(supportsChannel('allowlist.invitation', 'browser')).toBe(false);
  });

  it('is false for an unknown key', () => {
    expect(supportsChannel('does.not_exist', 'email' as NotificationChannel)).toBe(
      false,
    );
  });
});

describe('isMandatory', () => {
  it('is true for a mandatory event', () => {
    expect(isMandatory('security.role_changed')).toBe(true);
  });

  it('is false for a non-mandatory event', () => {
    expect(isMandatory('user.welcome')).toBe(false);
    expect(isMandatory('allowlist.invitation')).toBe(false);
  });

  it('is false for an unknown key', () => {
    expect(isMandatory('does.not_exist')).toBe(false);
  });
});

describe('seeded events', () => {
  it('security.role_changed is mandatory and supports both channels', () => {
    const event = findEvent('security.role_changed');
    expect(event?.mandatory).toBe(true);
    expect(event?.channels).toEqual(
      expect.arrayContaining(['email', 'browser']),
    );
    expect(event?.channels).toHaveLength(2);
  });

  it('the four operational events (#288) are registered with the declared channels and defaults', () => {
    // The table from issue #288, asserted as a table rather than as four
    // loose expectations, so a channel quietly added or removed is a diff in
    // one place.
    const expected = [
      { key: 'jobs.job_failed', channels: ['email'], defaultEnabled: true, mandatory: false },
      {
        key: 'nodes.node_offline',
        channels: ['email', 'browser'],
        defaultEnabled: true,
        mandatory: false,
      },
      {
        key: 'db_backup.backup_failed',
        channels: ['email', 'browser'],
        defaultEnabled: true,
        mandatory: false,
      },
      {
        key: 'db_backup.restore_completed',
        channels: ['email', 'browser'],
        defaultEnabled: true,
        mandatory: true,
      },
    ];

    for (const row of expected) {
      const event = findEvent(row.key);

      expect(event).toBeDefined();
      expect(event?.channels).toEqual(row.channels);
      expect(event?.defaultEnabled).toBe(row.defaultEnabled);
      expect(isMandatory(row.key)).toBe(row.mandatory);
    }
  });

  it('db_backup.restore_completed is the ONLY mandatory one of the four', () => {
    // The three failures are things an operator may reasonably decide to watch
    // in an alerting stack instead. A database that has just been replaced with
    // an older copy of itself is not.
    expect(isMandatory('db_backup.restore_completed')).toBe(true);
    expect(isMandatory('jobs.job_failed')).toBe(false);
    expect(isMandatory('nodes.node_offline')).toBe(false);
    expect(isMandatory('db_backup.backup_failed')).toBe(false);
  });

  it('jobs.job_failed is email-only, and deliberately so', () => {
    // Not an oversight and not "the browser template is still to come": a
    // failed job's detail is a filter on the jobs list rather than a page, so a
    // bell row for it would have no honest click target. The browser channel
    // map (`EVENT_BROWSER_TEMPLATES`) has no entry for it either, and that
    // agreement is the property worth pinning.
    expect(channelsFor('jobs.job_failed')).toEqual(['email']);
    expect(supportsChannel('jobs.job_failed', 'browser')).toBe(false);
  });

  it('allowlist.invitation is email-only', () => {
    // Its recipient has no account and no open tab by definition — that is
    // what being newly allowlisted means — so a browser channel would be
    // meaningless: there is no session to render a notification into. A
    // future edit adding 'browser' here needs to explain how an
    // unauthenticated, session-less recipient would ever see it.
    const event = findEvent('allowlist.invitation');
    expect(event?.channels).toEqual(['email']);
  });
});
