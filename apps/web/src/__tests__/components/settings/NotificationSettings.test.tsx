import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import {
  NotificationSettings,
  isEventChannelEnabled,
  preferenceWriteFor,
  browserChannelState,
  pushChannelState,
} from '../../../components/settings/NotificationSettings';
import type { NotificationEventDef, NotificationPreferences } from '../../../types';
import type { NotificationCapability } from '../../../hooks/useNotificationCapability';

/**
 * Every state of the #221 union, written as a `Record` KEYED BY THE UNION and
 * only then flattened to an array.
 *
 * That indirection is the point: a plain array of literals stays valid when a
 * ninth capability is added and forgotten, so the "distinct remedy" sweep below
 * would silently stop covering it — the exact failure mode where a new state
 * quietly inherits the `default` arm's copy and nobody notices. An exhaustive
 * `Record` makes the omission a COMPILE error instead. The values are the
 * documented precedence positions, which is also where a reader can check that
 * the order in the hook and the order here still agree - note that 5 to 8 are
 * not a continuation of the chain but the four PERMISSION-SHAPED states, which
 * the hook decides together (`sw-unavailable` is reached only with permission
 * already granted).
 */
const CAPABILITY_PRECEDENCE: Record<NotificationCapability, number> = {
  'admin-disabled': 1,
  'insecure-context': 2,
  unsupported: 3,
  'ios-needs-install': 4,
  denied: 5,
  default: 6,
  'sw-unavailable': 7,
  granted: 8,
};

const ALL_CAPABILITIES = Object.keys(CAPABILITY_PRECEDENCE) as NotificationCapability[];

/**
 * Issue #126, epic #109. Covers the pure derivation helpers this component
 * exports (`isEventChannelEnabled`, `preferenceWriteFor`, `browserChannelState`)
 * and the component's rendering of the sparse absent-key contract those
 * helpers encode. See the extensive header of
 * `components/settings/NotificationSettings.tsx` for the rules under test.
 *
 * `pushChannelState` and the push column's rendering are covered here too
 * (issue #228, epic #215): `NOTIFICATION_CHANNELS` was widened to include
 * `'push'`, but no `NOTIFICATION_EVENTS` entry declares it yet, so this file
 * uses a synthetic fixture (`PUSH_CAPABLE` below) to exercise the column
 * ahead of #229/#230 wiring a real event to it.
 */

const WELCOME: NotificationEventDef = {
  key: 'user.welcome',
  label: 'Welcome',
  description: 'Sent once, the first time you sign in to this application.',
  channels: ['email'],
  defaultEnabled: true,
  mandatory: false,
};

// A defaultEnabled: false event, so preferenceWriteFor's "opting IN" direction
// has something real to exercise - none of the seeded registry events in the
// API declare one, so this is synthetic on purpose.
const WEEKLY_DIGEST: NotificationEventDef = {
  key: 'weekly.digest',
  label: 'Weekly digest',
  description: 'A weekly summary of activity.',
  channels: ['email'],
  defaultEnabled: false,
  mandatory: false,
};

const ROLE_CHANGED: NotificationEventDef = {
  key: 'security.role_changed',
  label: 'Your roles changed',
  description: 'Sent when an administrator changes your roles.',
  channels: ['email', 'browser'],
  defaultEnabled: true,
  mandatory: true,
};

// Synthetic only: as of #228 (epic #215), no real NOTIFICATION_EVENTS entry
// declares 'push' in its `channels` yet - that is #229/#230's job, not this
// one's. This fixture exercises the push column, and the email/browser
// columns sitting alongside it on the SAME event, before any real event can.
const PUSH_CAPABLE: NotificationEventDef = {
  key: 'synthetic.push_capable',
  label: 'Synthetic push event',
  description: 'A synthetic event for exercising the push column before any real event declares it.',
  channels: ['email', 'browser', 'push'],
  defaultEnabled: true,
  mandatory: false,
};

describe('isEventChannelEnabled', () => {
  it('resolves to the registry default when preferences is undefined - the untouched-account case', () => {
    expect(isEventChannelEnabled(WELCOME, 'email', undefined)).toBe(true);
    expect(isEventChannelEnabled(WEEKLY_DIGEST, 'email', undefined)).toBe(false);
  });

  it('resolves to the registry default when the channel has no entry at all', () => {
    const prefs: NotificationPreferences = {
      browser: { 'security.role_changed': false },
    };
    expect(isEventChannelEnabled(WELCOME, 'email', prefs)).toBe(true);
  });

  it('resolves to the registry default when the event key is absent from a present channel', () => {
    const prefs: NotificationPreferences = { email: { 'some.other.event': false } };
    expect(isEventChannelEnabled(WELCOME, 'email', prefs)).toBe(true);
  });

  it('honours an explicit stored false, even against a true default', () => {
    const prefs: NotificationPreferences = { email: { 'user.welcome': false } };
    expect(isEventChannelEnabled(WELCOME, 'email', prefs)).toBe(false);
  });

  it('honours an explicit stored true, even against a false default', () => {
    const prefs: NotificationPreferences = { email: { 'weekly.digest': true } };
    expect(isEventChannelEnabled(WEEKLY_DIGEST, 'email', prefs)).toBe(true);
  });

  it('a mandatory event resolves to enabled on every channel, ignoring a stored false', () => {
    const prefs: NotificationPreferences = {
      email: { 'security.role_changed': false },
      browser: { 'security.role_changed': false },
    };
    expect(isEventChannelEnabled(ROLE_CHANGED, 'email', prefs)).toBe(true);
    expect(isEventChannelEnabled(ROLE_CHANGED, 'browser', prefs)).toBe(true);
  });

  it('uses hasOwnProperty, not a prototype lookup - an event key like "constructor" must not resolve off Object.prototype', () => {
    const trap: NotificationEventDef = { ...WELCOME, key: 'constructor' };
    const prefs: NotificationPreferences = { email: {} };
    // An empty channel object naively indexed with `channelPrefs['constructor']`
    // would return `Object.prototype.constructor` (a function, not undefined),
    // and `typeof choice === 'boolean'` would then be false, silently falling
    // through to the default anyway - so this also pins that the fallback is
    // for the RIGHT reason (own-property check), not an accident of the
    // boolean guard alone.
    expect(isEventChannelEnabled(trap, 'email', prefs)).toBe(true);
  });

  it('falls back to the registry default when the stored value is not a boolean', () => {
    const prefs = { email: { 'user.welcome': 'yes' } } as unknown as NotificationPreferences;
    expect(isEventChannelEnabled(WELCOME, 'email', prefs)).toBe(true);
  });
});

describe('preferenceWriteFor', () => {
  it('un-muting a defaultEnabled:true event back to true sends null (a delete), never the literal true', () => {
    expect(preferenceWriteFor(WELCOME, true)).toBeNull();
  });

  it('muting a defaultEnabled:true event sends the explicit false', () => {
    expect(preferenceWriteFor(WELCOME, false)).toBe(false);
  });

  it('opting a defaultEnabled:false event back OUT to false sends null (a delete), never the literal false', () => {
    expect(preferenceWriteFor(WEEKLY_DIGEST, false)).toBeNull();
  });

  it('opting IN to a defaultEnabled:false event sends the explicit true', () => {
    expect(preferenceWriteFor(WEEKLY_DIGEST, true)).toBe(true);
  });
});

describe('browserChannelState', () => {
  it('granted: nothing disabled, nothing to say', () => {
    expect(browserChannelState('granted')).toEqual({
      disabled: false,
      note: null,
      alert: null,
    });
  });

  it('default: not disabled - a stored preference is still meaningful before permission is granted', () => {
    const state = browserChannelState('default');
    expect(state.disabled).toBe(false);
    expect(state.alert).not.toBeNull();
  });

  it('denied and unsupported are both disabled, but are not the same state', () => {
    const denied = browserChannelState('denied');
    const unsupported = browserChannelState('unsupported');

    expect(denied.disabled).toBe(true);
    expect(unsupported.disabled).toBe(true);

    // THE PAIR THIS TEST EXISTS FOR. Both look similar on screen (disabled,
    // with a banner) but the remedies are completely different - "change your
    // browser's site settings" vs. "there is nothing to configure, get a
    // different browser" - so the copy must differ, not just the boolean.
    expect(denied.note).not.toBe(unsupported.note);
    expect(denied.alert?.title).not.toBe(unsupported.alert?.title);
    expect(denied.alert?.body).not.toBe(unsupported.alert?.body);
  });

  // #221 replaced the generic "allow it in your browser settings" with the
  // real per-platform route, because the control is in a different place in
  // every browser and is nowhere near anything labelled "settings" in two of
  // the three - so the old copy named a remedy nobody could actually follow.
  it('denied names the per-platform remedy, which this app cannot perform itself', () => {
    const state = browserChannelState('denied');
    expect(state.alert?.severity).toBe('warning');

    const body = state.alert!.body.toLowerCase();
    expect(body).toContain('chrome');
    expect(body).toContain('firefox');
    expect(body).toContain('safari');
    expect(body).toContain('address bar');
  });

  it('unsupported does not claim the user blocked anything - there is nothing to allow', () => {
    const state = browserChannelState('unsupported');
    expect(state.alert?.severity).toBe('info');
    expect(state.alert?.body.toLowerCase()).not.toContain('block');
  });

  // ===========================================================================
  // Issue #221: the four states the 4-state permission could not express
  // ===========================================================================

  it('every one of the eight states resolves to a shape - no state falls off the switch', () => {
    for (const capability of ALL_CAPABILITIES) {
      const state = browserChannelState(capability);
      expect(typeof state.disabled).toBe('boolean');
      if (capability === 'granted') {
        expect(state.alert).toBeNull();
        expect(state.note).toBeNull();
      } else {
        expect(state.alert).not.toBeNull();
        expect(state.note).not.toBeNull();
      }
    }
  });

  // THE POINT OF THE WHOLE 8-STATE UNION. Before #221 an iOS Safari tab, a
  // plain-HTTP origin and a genuinely incapable browser rendered the IDENTICAL
  // "not supported by this browser" copy - one of which is a lie and none of
  // which names the fix. If two arms could be swapped without anyone noticing,
  // the extra state is buying nothing.
  it('each state yields a DISTINCT remedy - no two arms share a title, body, or note', () => {
    const nonGranted = ALL_CAPABILITIES.filter((c) => c !== 'granted');

    const titles = nonGranted.map((c) => browserChannelState(c).alert!.title);
    const bodies = nonGranted.map((c) => browserChannelState(c).alert!.body);
    const notes = nonGranted.map((c) => browserChannelState(c).note!);

    expect(new Set(titles).size).toBe(nonGranted.length);
    expect(new Set(bodies).size).toBe(nonGranted.length);
    expect(new Set(notes).size).toBe(nonGranted.length);
  });

  it('ios-needs-install names Add to Home Screen and never claims the browser is incapable', () => {
    const state = browserChannelState('ios-needs-install');

    expect(state.disabled).toBe(true);
    expect(state.alert!.body.toLowerCase()).toContain('home screen');
    // The exact wrong-remedy failure #221 exists to delete: iOS DOES support
    // notifications, just only for an installed web app.
    expect(state.alert!.body.toLowerCase()).not.toContain('not support');
    expect(state.alert!.title.toLowerCase()).not.toContain('cannot');
  });

  it('insecure-context blames HTTPS, not the browser, and says localhost counts as secure', () => {
    const state = browserChannelState('insecure-context');

    expect(state.disabled).toBe(true);
    expect(state.alert!.body.toLowerCase()).toContain('https');
    // A developer on plain HTTP is the most likely person to see this, and
    // "use HTTPS" alone reads as "impossible locally" when it is not.
    expect(state.alert!.body.toLowerCase()).toContain('localhost');
  });

  it('sw-unavailable is DEGRADED, not blocked - the control stays live', () => {
    const state = browserChannelState('sw-unavailable');

    // The single assertion that separates this state from the other five
    // problem states: the page-level Notification fallback may still work and
    // a stored preference is still meaningful, so disabling the control would
    // overstate the failure.
    expect(state.disabled).toBe(false);
    expect(state.alert!.severity).toBe('warning');
    expect(state.alert!.body.toLowerCase()).toContain('service worker');
  });

  // This state is reached ONLY with permission already granted (see the
  // precedence in `useNotificationCapability`), so copy that told the user to
  // enable or allow something would be asking for a step they have taken - the
  // remaining problem is the app's, not theirs.
  it('sw-unavailable acknowledges that permission was already granted', () => {
    const body = browserChannelState('sw-unavailable').alert!.body.toLowerCase();

    expect(body).toContain('you have allowed');
    expect(body).not.toContain('allow notifications for this site');
    expect(body).not.toContain('cannot take effect');
  });

  it('admin-disabled says no user action will help, and does not blame the browser', () => {
    const state = browserChannelState('admin-disabled');

    expect(state.disabled).toBe(true);
    expect(state.alert!.body.toLowerCase()).toContain('administrator');
    // Nothing is broken and nothing is at risk - it is a deliberate setting.
    expect(state.alert!.severity).toBe('info');
    expect(state.alert!.body.toLowerCase()).not.toContain('your browser is blocking');
  });
});

describe('pushChannelState', () => {
  it('pushEnabled: false - disabled, with a non-null note and an informational alert', () => {
    const state = pushChannelState(false);
    expect(state.disabled).toBe(true);
    expect(state.note).not.toBeNull();
    expect(state.alert).not.toBeNull();
    expect(state.alert?.severity).toBe('info');
  });

  it('pushEnabled: true - nothing disabled, nothing to say, mirroring browserChannelState("granted")', () => {
    expect(pushChannelState(true)).toEqual({
      disabled: false,
      note: null,
      alert: null,
    });
  });

  it('the false-state copy blames an unimplemented feature, not the user\'s browser', () => {
    // Unlike browserChannelState's denied/unsupported copy, this must not
    // read like a browser permission problem the user could fix themselves -
    // there is nothing to allow or configure yet.
    const state = pushChannelState(false);
    expect(state.alert?.body.toLowerCase()).not.toContain('browser settings');
    expect(state.alert?.body.toLowerCase()).not.toContain('block');
  });

  // ===========================================================================
  // Issue #365: pushEnabled is now real, and the second `browserCapability`
  // argument reports whether THIS device is actually ready to receive a push
  // (per-account preference, per-device readiness - see the function's own
  // header). None of the tests above ever pass a second argument, so they
  // also double as regression coverage that the parameter is optional and
  // defaults to "assume ready" (`browserCapability === undefined`).
  // ===========================================================================

  describe('device readiness (#365, second argument)', () => {
    it('never disabled once pushEnabled is true, regardless of device capability', () => {
      for (const capability of ['default', 'denied', 'sw-unavailable', 'granted', 'ios-needs-install'] as const) {
        expect(pushChannelState(true, capability).disabled).toBe(false);
      }
    });

    it('notes "Not enabled on this device" when granted is neither granted nor sw-unavailable', () => {
      for (const capability of ['default', 'denied', 'ios-needs-install', 'admin-disabled', 'insecure-context', 'unsupported'] as const) {
        expect(pushChannelState(true, capability).note).toBe('Not enabled on this device');
      }
    });

    it('has no note when the device capability is granted', () => {
      expect(pushChannelState(true, 'granted').note).toBeNull();
    });

    it('has no note when the device capability is sw-unavailable - degraded delivery still counts as "enabled here"', () => {
      expect(pushChannelState(true, 'sw-unavailable').note).toBeNull();
    });

    it('has no note when no capability is passed at all - the safe "assume ready" default', () => {
      expect(pushChannelState(true).note).toBeNull();
      expect(pushChannelState(true, undefined).note).toBeNull();
    });

    it('never adds a banner alert for the device-readiness note - the remedy lives in the permission banners, not a second alert here', () => {
      expect(pushChannelState(true, 'default').alert).toBeNull();
      expect(pushChannelState(true, 'denied').alert).toBeNull();
    });

    it('pushEnabled: false ignores the device capability entirely - still disabled, still "Not available yet"', () => {
      const withoutCapability = pushChannelState(false);
      const withCapability = pushChannelState(false, 'granted');
      expect(withCapability).toEqual(withoutCapability);
    });
  });
});

describe('NotificationSettings component', () => {
  const onToggle = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "no notifications" when the registry is empty, rather than an empty matrix', () => {
    render(
      <NotificationSettings
        events={[]}
        preferences={undefined}
        onToggle={onToggle}
        browserCapability="granted"
      />,
    );

    expect(
      screen.getByText(/does not send any notifications yet/i),
    ).toBeInTheDocument();
  });

  it('an untouched account (preferences undefined) renders every control at its registry default', () => {
    render(
      <NotificationSettings
        events={[WELCOME, WEEKLY_DIGEST]}
        preferences={undefined}
        onToggle={onToggle}
        browserCapability="granted"
      />,
    );

    expect(
      screen.getByRole('switch', { name: /email notifications for welcome/i }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /email notifications for weekly digest/i }),
    ).not.toBeChecked();
  });

  it('toggling a switch calls onToggle with the channel, the event, and the null-delete when returning to default', async () => {
    const user = userEvent.setup();
    render(
      <NotificationSettings
        events={[WELCOME]}
        preferences={{ email: { 'user.welcome': false } }}
        onToggle={onToggle}
        browserCapability="granted"
      />,
    );

    const toggle = screen.getByRole('switch', { name: /email notifications for welcome/i });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('email', WELCOME, null);
  });

  it('toggling a switch away from the default sends the explicit boolean', async () => {
    const user = userEvent.setup();
    render(
      <NotificationSettings
        events={[WELCOME]}
        preferences={undefined}
        onToggle={onToggle}
        browserCapability="granted"
      />,
    );

    const toggle = screen.getByRole('switch', { name: /email notifications for welcome/i });
    expect(toggle).toBeChecked();

    await user.click(toggle);

    expect(onToggle).toHaveBeenCalledWith('email', WELCOME, false);
  });

  describe('mandatory events', () => {
    it('renders visibly locked, with the "Always on" chip and the reason', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="granted"
        />,
      );

      expect(screen.getByText('Always on')).toBeInTheDocument();
      expect(
        screen.getByText(/this is a security notification and cannot be turned off/i),
      ).toBeInTheDocument();
    });

    it('disables every channel the event declares, not just one', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="granted"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /email notifications for your roles changed/i }),
      ).toBeDisabled();
      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).toBeDisabled();
    });

    it('a stale stored false for a mandatory event still renders ON - that is what the user actually receives', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={{
            email: { 'security.role_changed': false },
            browser: { 'security.role_changed': false },
          }}
          onToggle={onToggle}
          browserCapability="granted"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /email notifications for your roles changed/i }),
      ).toBeChecked();
      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).toBeChecked();
    });

    it('clicking a disabled mandatory switch never calls onToggle', async () => {
      // `pointerEventsCheck: 0` skips userEvent's CSS `pointer-events: none`
      // guard (MUI's `Mui-disabled` class), so this exercises the layer that
      // actually matters here: the native `disabled` attribute on the
      // `<input>` itself. `fireEvent.click` was deliberately NOT used - jsdom
      // still runs a checkbox's default (de)activation behaviour for a
      // `dispatchEvent`-driven click even when `disabled` is set, which
      // would make this assertion pass for the wrong reason. `userEvent`
      // simulates a real user's pointer interaction, which browsers do not
      // deliver to a disabled control at all.
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="granted"
        />,
      );

      const toggle = screen.getByRole('switch', {
        name: /email notifications for your roles changed/i,
      });
      expect(toggle).toBeDisabled();

      await user.click(toggle);

      expect(onToggle).not.toHaveBeenCalled();
    });
  });

  describe('browser channel permission states', () => {
    it('disables the browser switch, with a note, when permission is denied', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="denied"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).toBeDisabled();
      expect(screen.getByText('Browser notifications are blocked')).toBeInTheDocument();
    });

    it('does not disable the email switch when the browser channel is denied - email is unaffected', () => {
      const emailOnly: NotificationEventDef = { ...WELCOME };
      render(
        <NotificationSettings
          events={[emailOnly, ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="denied"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /email notifications for welcome/i }),
      ).not.toBeDisabled();
    });

    it('does NOT call Notification.requestPermission when rendered with a "default" permission', () => {
      const originalNotification = (window as any).Notification;
      const requestPermission = vi.fn();
      (window as any).Notification = { permission: 'default', requestPermission };

      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="default"
        />,
      );

      expect(requestPermission).not.toHaveBeenCalled();
      expect(
        screen.getByText('Browser notifications need your permission'),
      ).toBeInTheDocument();

      (window as any).Notification = originalNotification;
    });

    // =========================================================================
    // Issue #221: the capability states, rendered
    // =========================================================================

    it('an iOS tab is told to add the app to the Home Screen, NOT that its browser is incapable', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="ios-needs-install"
        />,
      );

      expect(screen.getByText('Add this app to your Home Screen')).toBeInTheDocument();
      expect(
        screen.queryByText('This browser cannot show notifications'),
      ).not.toBeInTheDocument();
    });

    // =========================================================================
    // Issue #231: `ios-needs-install` gets the illustrated `AddToHomeScreenPanel`
    // INSTEAD OF the generic `browser.alert` banner - see the render branch in
    // `NotificationSettings.tsx` just above the matrix. NOTE: the panel's own
    // `AlertTitle` reuses the exact string "Add this app to your Home Screen"
    // that `browserChannelState('ios-needs-install')` also uses as its (now
    // unrendered) generic title, so that title alone cannot distinguish the two
    // - these tests key off content that exists on only one side.
    // =========================================================================

    it('ios-needs-install renders the illustrated panel, not the generic alert body, and no permission button', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="ios-needs-install"
          onRequestPermission={vi.fn()}
        />,
      );

      // The panel's distinguishing content (`AddToHomeScreenPanel.tsx`).
      expect(screen.getByText(/Tap the Share button/i)).toBeInTheDocument();
      expect(screen.getByText(/Choose "Add to Home Screen"/i)).toBeInTheDocument();

      // The generic alert's own body - a short placeholder superseded by the
      // panel per #231 - must NOT also render; its distinguishing closing
      // sentence is unique to it (the panel's closing sentence is worded
      // differently).
      expect(
        screen.queryByText(/then open the app from there and allow notifications/i),
      ).not.toBeInTheDocument();

      // No permission to grant until the app is installed - see
      // `browserChannelState`'s header for why `ios-needs-install` never gets
      // the "Allow notifications" button.
      expect(
        screen.queryByRole('button', { name: /allow notifications/i }),
      ).not.toBeInTheDocument();
    });

    it.each([
      ['denied'],
      ['unsupported'],
      ['admin-disabled'],
      ['insecure-context'],
      ['sw-unavailable'],
    ] as const)(
      '%s still renders its generic alert, and never the iOS panel (regression check for the #231 branch split)',
      (capability) => {
        render(
          <NotificationSettings
            events={[ROLE_CHANGED]}
            preferences={undefined}
            onToggle={onToggle}
            browserCapability={capability}
          />,
        );

        // The alert this capability has always rendered is unchanged.
        const expected = browserChannelState(capability);
        expect(screen.getByText(expected.alert!.title)).toBeInTheDocument();

        // The panel must never render outside `ios-needs-install`.
        expect(screen.queryByText(/Tap the Share button/i)).not.toBeInTheDocument();
        expect(
          screen.queryByText(/Choose "Add to Home Screen"/i),
        ).not.toBeInTheDocument();
      },
    );

    it('granted and default render neither the generic alert body\'s Home Screen banner nor the iOS panel', () => {
      // `default` keeps its own pre-existing "Browser notifications need your
      // permission" banner and "Allow notifications" button flow (#127),
      // already covered above - this only confirms the #231 panel is not one
      // of the things it (or `granted`) renders.
      for (const capability of ['granted', 'default'] as const) {
        const { unmount } = render(
          <NotificationSettings
            events={[ROLE_CHANGED]}
            preferences={undefined}
            onToggle={onToggle}
            browserCapability={capability}
          />,
        );

        expect(screen.queryByText(/Tap the Share button/i)).not.toBeInTheDocument();
        expect(
          screen.queryByText(/Choose "Add to Home Screen"/i),
        ).not.toBeInTheDocument();

        unmount();
      }
    });

    it('sw-unavailable warns but leaves the browser switch usable - degraded, not blocked', () => {
      render(
        <NotificationSettings
          events={[WELCOME, { ...ROLE_CHANGED, mandatory: false }]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="sw-unavailable"
        />,
      );

      expect(
        screen.getByText('Notifications are on, but may not always arrive'),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).not.toBeDisabled();
    });

    it('admin-disabled disables the browser switch and leaves email alone', () => {
      render(
        <NotificationSettings
          events={[WELCOME, { ...ROLE_CHANGED, mandatory: false }]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="admin-disabled"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).toBeDisabled();
      expect(
        screen.getByRole('switch', { name: /email notifications for welcome/i }),
      ).not.toBeDisabled();
    });

    // THE ONE-SHOT PROMPT GUARD, restated over eight states. Asking is only
    // ever right where the browser has not been asked yet AND the answer could
    // actually be used - `sw-unavailable` and `ios-needs-install` in particular
    // would burn the (effectively permanent) prompt on a page that could not
    // display the result.
    it('renders the "Allow notifications" button in the default state and in NO other', () => {
      for (const capability of ALL_CAPABILITIES) {
        const { unmount } = render(
          <NotificationSettings
            events={[ROLE_CHANGED]}
            preferences={undefined}
            onToggle={onToggle}
            browserCapability={capability}
            onRequestPermission={vi.fn()}
          />,
        );

        const button = screen.queryByRole('button', { name: /allow notifications/i });
        if (capability === 'default') {
          expect(button).toBeInTheDocument();
        } else {
          expect(button).not.toBeInTheDocument();
        }

        unmount();
      }
    });
  });

  describe('push channel (issue #228; synthetic event, since no registry event declares push yet)', () => {
    it('renders the push column disabled, with the "not available yet" note, when pushEnabled is not passed (defaults to false)', () => {
      render(
        <NotificationSettings
          events={[PUSH_CAPABLE]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
        />,
      );

      const pushSwitch = screen.getByRole('switch', {
        name: /push notifications for synthetic push event/i,
      });
      expect(pushSwitch).toBeDisabled();
      expect(screen.getByText('Not available yet')).toBeInTheDocument();
    });

    it('shows the informational push banner when a passed-in event declares push', () => {
      render(
        <NotificationSettings
          events={[PUSH_CAPABLE]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
        />,
      );

      expect(
        screen.getByText('Push notifications are not available yet'),
      ).toBeInTheDocument();
    });

    it('renders the push column disabled even when pushEnabled is explicitly false', () => {
      render(
        <NotificationSettings
          events={[PUSH_CAPABLE]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
          pushEnabled={false}
        />,
      );

      expect(
        screen.getByRole('switch', { name: /push notifications for synthetic push event/i }),
      ).toBeDisabled();
    });

    it('does not disable the email or browser columns on the same event when push is present alongside them', () => {
      render(
        <NotificationSettings
          events={[PUSH_CAPABLE]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /email notifications for synthetic push event/i }),
      ).not.toBeDisabled();
      expect(
        screen.getByRole('switch', { name: /browser notifications for synthetic push event/i }),
      ).not.toBeDisabled();
    });

    it('clicking the disabled push switch never calls onToggle', async () => {
      // Same rationale as the mandatory-switch test above: userEvent (not
      // fireEvent) is what actually exercises the native `disabled` attribute
      // the way a real pointer interaction would.
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      render(
        <NotificationSettings
          events={[PUSH_CAPABLE]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
        />,
      );

      const pushSwitch = screen.getByRole('switch', {
        name: /push notifications for synthetic push event/i,
      });
      await user.click(pushSwitch);

      expect(onToggle).not.toHaveBeenCalled();
    });

    it('pushEnabled: true enables the push switch (once #229/#230 land and a caller passes it)', () => {
      render(
        <NotificationSettings
          events={[PUSH_CAPABLE]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
          pushEnabled
        />,
      );

      expect(
        screen.getByRole('switch', { name: /push notifications for synthetic push event/i }),
      ).not.toBeDisabled();
      expect(
        screen.queryByText('Push notifications are not available yet'),
      ).not.toBeInTheDocument();
    });

    // ==========================================================================
    // Issue #365: the account preference (`pushEnabled`) and this device's own
    // readiness (`browserCapability`) are independent axes. These use the
    // correct `browserCapability` prop (the ones above in this describe block
    // pass a nonexistent `browserPermission` prop, which does not affect
    // `NotificationSettings` at all - it silently falls through to the
    // component's `browserCapability` default of `undefined`).
    // ==========================================================================

    it('shows "Not enabled on this device" beside the push switch when pushEnabled but this device has not granted permission', () => {
      render(
        <NotificationSettings
          events={[PUSH_CAPABLE]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="default"
          pushEnabled
        />,
      );

      expect(
        screen.getByRole('switch', { name: /push notifications for synthetic push event/i }),
      ).not.toBeDisabled();
      expect(screen.getByText('Not enabled on this device')).toBeInTheDocument();
    });

    it('shows no device-readiness note when pushEnabled and this device has granted permission', () => {
      render(
        <NotificationSettings
          events={[PUSH_CAPABLE]}
          preferences={undefined}
          onToggle={onToggle}
          browserCapability="granted"
          pushEnabled
        />,
      );

      expect(
        screen.queryByText('Not enabled on this device'),
      ).not.toBeInTheDocument();
    });

    it('showsPushChannel gates the banner off when no passed-in event declares push - the common/default case today', () => {
      render(
        <NotificationSettings
          events={[WELCOME, WEEKLY_DIGEST, ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
        />,
      );

      expect(
        screen.queryByText('Push notifications are not available yet'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Not available yet')).not.toBeInTheDocument();
    });
  });

  it('isSaving disables every switch, not just the one that changed', () => {
    render(
      <NotificationSettings
        events={[WELCOME, WEEKLY_DIGEST]}
        preferences={undefined}
        onToggle={onToggle}
        isSaving
        browserCapability="granted"
      />,
    );

    expect(
      screen.getByRole('switch', { name: /email notifications for welcome/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('switch', { name: /email notifications for weekly digest/i }),
    ).toBeDisabled();
  });
});
