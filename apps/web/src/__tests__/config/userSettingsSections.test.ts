import { describe, it, expect } from 'vitest';
import { USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

/**
 * Issue #126, epic #109. The Notifications card follows the same
 * MANDATORY settings-registry pattern every other `/settings/*` card does
 * (see CLAUDE.md's "MANDATORY: Settings UI Pattern" and
 * `config/userSettingsSections.tsx`'s own header): declared once, here, with
 * NO `permission` field.
 *
 * Every other card under `USER_SETTINGS_SECTIONS` is unpermissioned for the
 * same reason - these are the caller's OWN settings, and the API grants
 * `user_settings:read` / `user_settings:write` to all three roles. A
 * `permission` field on this card would invent an authorization rule the API
 * does not enforce, and would lock a Viewer out of saying how they want to be
 * contacted.
 */
describe('USER_SETTINGS_SECTIONS - Notifications card (issue #126)', () => {
  function findNotificationsCard() {
    for (const section of USER_SETTINGS_SECTIONS) {
      const card = section.cards.find((c) => c.path === '/settings/notifications');
      if (card) return card;
    }
    return undefined;
  }

  it('is present in the registry', () => {
    const card = findNotificationsCard();
    expect(card).toBeDefined();
    expect(card?.title).toBe('Notifications');
  });

  it('declares no permission - reachable by every authenticated user, not gated on a specific one', () => {
    const card = findNotificationsCard();
    expect(card).toBeDefined();
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('points at /settings/notifications', () => {
    const card = findNotificationsCard();
    expect(card?.path).toBe('/settings/notifications');
  });

  it('is grouped under Account, not Security - it is about how the account is contacted, not a credential', () => {
    const accountSection = USER_SETTINGS_SECTIONS.find((s) => s.label === 'Account');
    expect(accountSection?.cards.some((c) => c.path === '/settings/notifications')).toBe(
      true,
    );
  });

  // The wider claim: this is not a one-off omission on this card, it is true
  // of the whole per-user registry (see the file's own header comment). A
  // regression that added a permission ANYWHERE in USER_SETTINGS_SECTIONS
  // would be exactly the kind of invented gate that CLAUDE.md's Settings UI
  // Pattern rule 3 warns against.
  it('no card in USER_SETTINGS_SECTIONS declares a permission', () => {
    const allCards = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards);
    for (const card of allCards) {
      expect(card.permission).toBeUndefined();
    }
  });
});
