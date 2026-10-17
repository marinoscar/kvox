import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { dangerZoneLastViolations } from '@marinoscar/platform-web/user-data/headless';
import { DATA_EXPORT_PATH } from '@marinoscar/platform-web/exports/ui';

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
 * Issue #532 (Part B of #479) — the `Download your data` card, the platform's exports slice.
 *
 * "MANDATORY: Settings UI Pattern" rule 1: a settings page must be DECLARED in a section registry, not
 * merely routed. Modelled on `dangerZoneCard.test.ts`. The notification deep link
 * (`DATA_EXPORT_PAGE_PATH` in the API, `/settings/data-export`) must reach this route.
 */
const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');

const PATH = '/settings/data-export';

function cardsAt(path: string) {
  return USER_SETTINGS_SECTIONS.flatMap((section) => section.cards).filter((card) => card.path === path);
}

describe('USER_SETTINGS_SECTIONS — Download your data card (issue #532)', () => {
  it('is declared in the registry exactly once, at the package’s path', () => {
    const cards = cardsAt(PATH);

    expect(DATA_EXPORT_PATH).toBe(PATH);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Download your data');
  });

  it('declares no permission — each source the page offers every role needs only user_settings:read', () => {
    const [card] = cardsAt(PATH);

    expect('permission' in card).toBe(false);
    expect(card.permission).toBeUndefined();
  });

  it('sits in its own "Your data" group directly above the Danger Zone, which stays alone and last', () => {
    const index = USER_SETTINGS_SECTIONS.findIndex((section) => section.cards.some((card) => card.path === PATH));
    const section = USER_SETTINGS_SECTIONS[index];

    expect(section.label).toBe('Your data');
    expect(section.cards).toHaveLength(1);
    expect(USER_SETTINGS_SECTIONS[index + 1]?.label).toBe('Danger Zone');
    expect(dangerZoneLastViolations(USER_SETTINGS_SECTIONS, '/settings/danger-zone')).toEqual([]);
  });

  it('is visible to a holder of no admin permission at all', () => {
    const titles = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false).flatMap((section) =>
      section.cards.map((card) => card.title),
    );

    expect(titles).toContain('Download your data');
  });

  it('resolves its route to its own title, and the admin registry knows nothing about it', () => {
    expect(settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, PATH)).toBe(
      'Download your data',
    );
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, PATH)).toBeNull();
  });

  it('has exactly one route in App.tsx, read from the live file rather than a copy', () => {
    const source = readFileSync(APP_TSX, 'utf8');
    const paths = [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1]);

    expect(paths.filter((path) => path === PATH)).toHaveLength(1);
    // Ungated: no RequirePermission wraps it.
    expect(source).toMatch(/<Route path="\/settings\/data-export" element=\{<DataExportPage \/>\} \/>/);
  });
});
