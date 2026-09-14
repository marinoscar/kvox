import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  USER_SETTINGS_SECTIONS,
  USER_HUB_PATH,
  USER_HUB_TITLE,
} from '../../config/userSettingsSections';
import {
  ADMIN_SECTIONS,
  ADMIN_HUB_PATH,
  ADMIN_HUB_TITLE,
  settingsPageTitle,
  visibleSettingsSections,
} from '../../config/adminSections';

/**
 * Issue #56, epic #45 — the `Note Templates` card.
 *
 * CLAUDE.md's "MANDATORY: Settings UI Pattern" rule 1: a settings page must be
 * DECLARED in a section registry, not merely routed. A route with no card is a
 * route the hub, the Console rail and the AppBar title resolver all disagree
 * about, because none of the three has any way to know it exists — so this
 * suite checks the card, the route, and that the two agree.
 */
const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');

const PATH = '/settings/note-templates';

function findCard() {
  for (const section of USER_SETTINGS_SECTIONS) {
    const card = section.cards.find((entry) => entry.path === PATH);
    if (card) return card;
  }
  return undefined;
}

describe('USER_SETTINGS_SECTIONS — Note Templates card (issue #56)', () => {
  it('is declared in the registry, not merely routed', () => {
    const card = findCard();
    expect(card).toBeDefined();
    expect(card?.title).toBe('Note Templates');
  });

  it('sits under Account, beside the AI Provider card it depends on', () => {
    // The page renders `AiKeyRequired` without a key, so the two belong
    // together and in this order — the hub reads the way the setup happens.
    const account = USER_SETTINGS_SECTIONS.find((section) => section.label === 'Account');
    const paths = account?.cards.map((card) => card.path) ?? [];

    expect(paths).toContain(PATH);
    expect(paths.indexOf(PATH)).toBeGreaterThan(paths.indexOf('/settings/ai'));
  });

  it('declares no permission — note_templates:* is seeded to all three roles', () => {
    const card = findCard();
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('is visible to a Viewer, who holds no admin permission at all', () => {
    // One assertion covering the hub, the rail and the AppBar title resolver,
    // because all three run this same function.
    const result = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false);
    const titles = result.flatMap((section) => section.cards.map((card) => card.title));

    expect(titles).toContain('Note Templates');
  });

  it('resolves its route to its own title rather than the hub title', () => {
    expect(settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, PATH)).toBe(
      'Note Templates',
    );
    // And the admin registry knows nothing about it, so neither surface can
    // shadow the other's name.
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, PATH),
    ).toBeNull();
  });

  it('has a route in App.tsx, read from the live file rather than a copy', () => {
    const source = readFileSync(APP_TSX, 'utf8');
    const paths = [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1]);

    expect(paths).toContain(PATH);
  });

  it('mirrors the card description as the page description, so the hub and the page agree', () => {
    const card = findCard();
    const page = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../pages/UserNoteTemplatesPage.tsx'),
      'utf8',
    );

    expect(card?.description).toBeTruthy();
    expect(page).toContain(card?.description as string);
  });
});
