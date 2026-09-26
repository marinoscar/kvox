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
 * Issue #191, epic #165 — the `Search Indexing` card.
 *
 * CLAUDE.md's "MANDATORY: Settings UI Pattern" rule 1: a settings page must be
 * DECLARED in a section registry, not merely routed — a route with no card is
 * one the hub, the Console rail and the AppBar title resolver all disagree
 * about. Rule 2: it is its own DESTINATION, not a tab bolted onto an existing
 * settings page. Modelled directly on `dangerZoneCard.test.ts`.
 *
 * The last assertion is the one with teeth for THIS card: it must be a
 * per-USER card and must never appear in the admin registry. The key is the
 * user's, the content is the user's, and the bill is the user's — there is no
 * deployment key to fall back on, so an administrator pressing this button on
 * somebody's behalf could not even work.
 */
const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');

const PATH = '/settings/search-index';

function findCard() {
  for (const section of USER_SETTINGS_SECTIONS) {
    const card = section.cards.find((entry) => entry.path === PATH);
    if (card) return card;
  }
  return undefined;
}

describe('USER_SETTINGS_SECTIONS — Search Indexing card (issue #191)', () => {
  it('is declared in the registry, not merely routed', () => {
    const card = findCard();
    expect(card).toBeDefined();
    expect(card?.title).toBe('Search Indexing');
  });

  it('sits in the Account group, after the AI Provider card it depends on', () => {
    const account = USER_SETTINGS_SECTIONS.find((section) => section.label === 'Account');
    const paths = account?.cards.map((card) => card.path) ?? [];

    expect(paths).toContain(PATH);
    expect(paths.indexOf(PATH)).toBeGreaterThan(paths.indexOf('/settings/ai'));
  });

  it('declares no permission — the API gates both routes on @Auth() with no permission string', () => {
    const card = findCard();
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('is visible to a Viewer, who holds no admin permission at all', () => {
    const result = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false);
    const titles = result.flatMap((section) => section.cards.map((card) => card.title));

    expect(titles).toContain('Search Indexing');
  });

  it('resolves its route to its own title rather than the hub title', () => {
    expect(settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, PATH)).toBe(
      'Search Indexing',
    );
  });

  it('has a route in App.tsx, read from the live file rather than a copy', () => {
    const source = readFileSync(APP_TSX, 'utf8');
    const paths = [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1]);

    expect(paths).toContain(PATH);
  });

  it('is a PER-USER card and exists nowhere in the admin registry', () => {
    const adminPaths = ADMIN_SECTIONS.flatMap((section) =>
      section.cards.map((card) => card.path),
    );

    expect(adminPaths).not.toContain(PATH);
    expect(adminPaths.some((path) => path.includes('search'))).toBe(false);
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, PATH),
    ).toBeNull();
  });

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
