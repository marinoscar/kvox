import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { dangerZoneLastViolations } from '@marinoscar/platform-web/user-data/headless';

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
 * Issue #80 — the `Delete my data` card, in its own `Danger Zone` group; the
 * platform's card and page since #480.
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

describe('USER_SETTINGS_SECTIONS — Delete my data card (issues #80, #480)', () => {
  it('is declared in the registry, not merely routed', () => {
    const card = findCard();
    expect(card).toBeDefined();
    expect(card?.title).toBe('Delete my data');
  });

  it('sits alone in its own last group, "Danger Zone" — not a fourth card under Account or a second under Security', () => {
    const section = findSection();
    expect(section?.label).toBe('Danger Zone');
    expect(section?.cards).toHaveLength(1);

    // Last in the array, so it is last on the hub and last in the Console
    // rail — below everything a user has an ordinary reason to open.
    expect(USER_SETTINGS_SECTIONS[USER_SETTINGS_SECTIONS.length - 1]).toBe(section);
  });

  it('conforms to the platform’s Danger-Zone-last rule, keeping the card’s path', () => {
    expect(dangerZoneLastViolations(USER_SETTINGS_SECTIONS, PATH)).toEqual([]);
  });

  it('declares no permission — the API gates both routes on @Auth() with no permission string', () => {
    const card = findCard();
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('is visible to a Viewer, who holds no admin permission at all', () => {
    const result = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false);
    const titles = result.flatMap((section) => section.cards.map((card) => card.title));

    expect(titles).toContain('Delete my data');
  });

  it('resolves its route to its own title rather than the hub title, and the admin registry knows nothing about it', () => {
    expect(settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, PATH)).toBe(
      'Delete my data',
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
  it('no card in USER_SETTINGS_SECTIONS declares a permission except the AI Provider (#477) and Knowledge graph (#369) cards — this card did not regress that', () => {
    // Two deliberate exceptions. Since #369 the Knowledge graph card carries
    // `graph:write`, the exact string its attribute-definition write routes
    // enforce (Settings UI rule 3). Since #477 the AI Provider card carries
    // `ai:use`, the string the platform's per-user AI routes enforce. Every
    // other card stays ungated.
    const allCards = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards);
    const gated = allCards
      .filter((card) => card.permission !== undefined)
      .map((card) => ({ path: card.path, permission: card.permission }));
    expect(gated).toEqual([
      { path: '/settings/ai', permission: 'ai:use' },
      { path: '/settings/knowledge-graph', permission: 'graph:write' },
    ]);
  });
});

/**
 * Issue #562 — the admin counterpart, the factory reset card: the platform's
 * card and page (`factoryResetSettingsPage`), in its own `Danger Zone` group
 * pinned LAST of `ADMIN_SECTIONS`.
 */
const FACTORY_PATH = '/admin/settings/factory-reset';
const FACTORY_PERMISSION = 'system:factory_reset';

function adminTitles(has: (permission: string) => boolean): string[] {
  return visibleSettingsSections(ADMIN_SECTIONS, has).flatMap((section) =>
    section.cards.map((card) => card.title),
  );
}

describe('ADMIN_SECTIONS — Factory reset card (issue #562)', () => {
  const section = ADMIN_SECTIONS.find((entry) =>
    entry.cards.some((card) => card.path === FACTORY_PATH),
  );
  const card = section?.cards.find((entry) => entry.path === FACTORY_PATH);

  it('is declared in the registry, alone in its own "Danger Zone" group, pinned LAST', () => {
    expect(card).toBeDefined();
    expect(card?.title).toBe('Factory reset');
    expect(section?.label).toBe('Danger Zone');
    expect(section?.cards).toHaveLength(1);
    expect(ADMIN_SECTIONS[ADMIN_SECTIONS.length - 1]).toBe(section);
  });

  it('conforms to the platform’s Danger-Zone-last rule, keeping the card’s path', () => {
    expect(dangerZoneLastViolations(ADMIN_SECTIONS, FACTORY_PATH)).toEqual([]);
  });

  it('declares system:factory_reset and no feature, and carries an icon', () => {
    expect(card?.permission).toBe(FACTORY_PERMISSION);
    expect(card?.feature).toBeUndefined();
    expect(card?.Icon).toBeDefined();
  });

  it('is visible to a holder of system:factory_reset', () => {
    expect(adminTitles((permission) => permission === FACTORY_PERMISSION)).toContain('Factory reset');
  });

  it('is hidden from a holder of every other permission, system_settings:write included', () => {
    expect(adminTitles((permission) => permission !== FACTORY_PERMISSION)).not.toContain(
      'Factory reset',
    );
    expect(
      adminTitles((permission) => permission.startsWith('system_settings:')),
    ).not.toContain('Factory reset');
  });

  it('resolves its route to its own title; the user registry knows nothing about it', () => {
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, FACTORY_PATH)).toBe(
      'Factory reset',
    );
    expect(
      settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, FACTORY_PATH),
    ).toBeNull();
  });

  it('has a route in App.tsx gated on the same permission, read from the live file', () => {
    const source = readFileSync(APP_TSX, 'utf8');
    const at = source.indexOf(`path="${FACTORY_PATH}"`);
    expect(at).toBeGreaterThan(-1);
    const route = source.slice(at, at + 400);
    expect(route).toContain(`permission="${FACTORY_PERMISSION}"`);
    expect(route).toContain('<FactoryResetPage />');
  });
});
