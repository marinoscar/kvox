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
 * Issue #80 — the `Delete My Data` card, in its own `Danger Zone` group.
 *
 * CLAUDE.md's "MANDATORY: Settings UI Pattern" rule 1: a settings page must be
 * DECLARED in a section registry, not merely routed — a route with no card is
 * one the hub, the Console rail and the AppBar title resolver all disagree
 * about. Modelled directly on `noteTemplatesCard.test.ts`.
 */
const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');

const PATH = '/settings/danger-zone';

function findCard() {
  for (const section of USER_SETTINGS_SECTIONS) {
    const card = section.cards.find((entry) => entry.path === PATH);
    if (card) return card;
  }
  return undefined;
}

function findSection() {
  return USER_SETTINGS_SECTIONS.find((section) =>
    section.cards.some((card) => card.path === PATH),
  );
}

describe('USER_SETTINGS_SECTIONS — Delete My Data card (issue #80)', () => {
  it('is declared in the registry, not merely routed', () => {
    const card = findCard();
    expect(card).toBeDefined();
    expect(card?.title).toBe('Delete My Data');
  });

  it('sits alone in its own last group, "Danger Zone" — not a fourth card under Account or a second under Security', () => {
    const section = findSection();
    expect(section?.label).toBe('Danger Zone');
    expect(section?.cards).toHaveLength(1);

    // Last in the array, so it is last on the hub and last in the Console
    // rail — below everything a user has an ordinary reason to open.
    expect(USER_SETTINGS_SECTIONS[USER_SETTINGS_SECTIONS.length - 1]).toBe(section);
  });

  it('declares no permission — the API gates both routes on @Auth() with no permission string', () => {
    const card = findCard();
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('is visible to a Viewer, who holds no admin permission at all', () => {
    const result = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false);
    const titles = result.flatMap((section) => section.cards.map((card) => card.title));

    expect(titles).toContain('Delete My Data');
  });

  it('resolves its route to its own title rather than the hub title, and the admin registry knows nothing about it', () => {
    expect(settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, PATH)).toBe(
      'Delete My Data',
    );
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, PATH),
    ).toBeNull();
  });

  it('has a route in App.tsx, read from the live file rather than a copy', () => {
    const source = readFileSync(APP_TSX, 'utf8');
    const paths = [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1]);

    expect(paths).toContain(PATH);
  });

  // The wider claim, mirroring `userSettingsSections.test.ts`'s own
  // whole-registry assertion: adding this card must not be the first card in
  // the file to invent a permission gate the API does not enforce.
  it('no card in USER_SETTINGS_SECTIONS declares a permission except the Knowledge graph card (#369) — this card did not regress that', () => {
    // One deliberate exception since #369: the Knowledge graph card carries
    // `graph:write`, the exact string its attribute-definition write routes
    // enforce (Settings UI rule 3). Every other card stays ungated.
    const allCards = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards);
    const gated = allCards
      .filter((card) => card.permission !== undefined)
      .map((card) => ({ path: card.path, permission: card.permission }));
    expect(gated).toEqual([
      { path: '/settings/knowledge-graph', permission: 'graph:write' },
    ]);
  });
});
