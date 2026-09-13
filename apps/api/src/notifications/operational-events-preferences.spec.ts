import { userSettingsSchema } from '../common/schemas/settings.schema';
import { findEvent, isMandatory } from './notification-events';
import {
  readNotificationPreferences,
  resolveChannels,
} from './notification-preferences';
import { DEFAULT_NOTIFICATION_POLICY } from './notification-policy';

// =============================================================================
// The four operational events, round-tripped through the preferences matrix
// (issue #288, epic #254)
// =============================================================================
//
// #288's acceptance criterion is not "the registry has four more rows" — it is
// that a USER CAN ACTUALLY MUTE three of them and CANNOT mute the fourth. That
// claim spans three files that a registry test alone never touches:
//
//   1. `userSettingsSchema` — the WRITE side. A key the schema strips is a
//      toggle the preferences page appears to save and does not.
//   2. `readNotificationPreferences` — the READ side, which drops unknown
//      channels and keeps unknown event keys.
//   3. `resolveChannels` — the GATE, where `mandatory` overrides everything.
//
// So each key is driven through all three here, in the order a real save takes,
// rather than asserted against any one of them.
// =============================================================================

/** The three the user is in charge of. */
const MUTEABLE = [
  'jobs.job_failed',
  'nodes.node_offline',
  'db_backup.backup_failed',
] as const;

const MANDATORY = 'db_backup.restore_completed';

/**
 * A complete, valid settings document carrying `notifications`.
 *
 * `theme` and `profile` are REQUIRED by `userSettingsSchema` and are filled in
 * here so the assertions below are about the notifications namespace and not
 * about the rest of the document.
 */
function parseSettings(notifications: Record<string, Record<string, boolean>>) {
  return userSettingsSchema.parse({
    theme: 'system',
    profile: { imageSource: 'provider' },
    notifications,
  });
}

/**
 * Stores `enabled` for `key` on every channel the event declares, the way the
 * preferences page's PUT would, and returns what the dispatcher then resolves.
 */
function roundTrip(key: string, enabled: boolean): string[] {
  const event = findEvent(key);
  if (!event) throw new Error(`Test fixture error: '${key}' is not registered.`);

  const written: Record<string, Record<string, boolean>> = {};
  for (const channel of event.channels) {
    written[channel] = { [key]: enabled };
  }

  // 1. THE WRITE SIDE. `.parse` strips anything the schema does not accept, so
  //    a key that does not survive this line is a toggle that silently does
  //    nothing.
  const stored = parseSettings(written);

  // 2. THE READ SIDE, from the raw `user_settings.value` shape.
  const preferences = readNotificationPreferences(stored);

  // 3. THE GATE.
  return resolveChannels(event, preferences, DEFAULT_NOTIFICATION_POLICY);
}

describe('the operational events survive a write/read/resolve round trip', () => {
  it.each(MUTEABLE)('%s: an explicit mute reaches the dispatcher and silences it', (key) => {
    expect(roundTrip(key, false)).toEqual([]);
  });

  it.each(MUTEABLE)('%s: an explicit enable resolves to every declared channel', (key) => {
    const event = findEvent(key)!;

    expect(roundTrip(key, true)).toEqual(event.channels);
  });

  it.each(MUTEABLE)('%s: saying nothing at all resolves to the registry default (on)', (key) => {
    const event = findEvent(key)!;

    // The sparse absent-key contract: absent means `defaultEnabled`, and all
    // four of these default to on.
    expect(resolveChannels(event, {}, DEFAULT_NOTIFICATION_POLICY)).toEqual(
      event.channels,
    );
  });

  it(`${MANDATORY}: an explicit mute on EVERY channel is ignored`, () => {
    // THE SECURITY-SHAPED ONE. A database replaced by an older copy of itself
    // is not something a user may decide not to hear about, and `mandatory` is
    // ALL-OR-NOTHING: per-channel opt-out would reopen the hole it closes.
    expect(isMandatory(MANDATORY)).toBe(true);

    const event = findEvent(MANDATORY)!;
    expect(roundTrip(MANDATORY, false)).toEqual(event.channels);
  });

  it(`${MANDATORY}: the stored preference is still WRITTEN — it is ignored at resolution, not rejected at save`, () => {
    // Worth pinning: the write side does not special-case mandatory events, and
    // should not. The override lives in ONE place (`isChannelEnabled`), and a
    // second enforcement point at save time would be a second thing to get
    // wrong — and would break a client that PUTs the whole matrix back.
    const stored = parseSettings({ email: { [MANDATORY]: false } });

    expect(stored.notifications).toEqual({ email: { [MANDATORY]: false } });
  });

  it('a mute on one operational event does not affect its siblings', () => {
    const stored = parseSettings({ email: { 'jobs.job_failed': false } });
    const preferences = readNotificationPreferences(stored);

    expect(
      resolveChannels(findEvent('jobs.job_failed')!, preferences, DEFAULT_NOTIFICATION_POLICY),
    ).toEqual([]);
    expect(
      resolveChannels(
        findEvent('db_backup.backup_failed')!,
        preferences,
        DEFAULT_NOTIFICATION_POLICY,
      ),
    ).toEqual(['email', 'browser']);
  });

  it('muting the email channel of a two-channel event leaves the browser row alone', () => {
    // Per-channel independence, which is what makes the matrix a matrix rather
    // than a list of switches.
    const stored = parseSettings({ email: { 'nodes.node_offline': false } });

    expect(
      resolveChannels(
        findEvent('nodes.node_offline')!,
        readNotificationPreferences(stored),
        DEFAULT_NOTIFICATION_POLICY,
      ),
    ).toEqual(['browser']);
  });
});
