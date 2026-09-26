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
  settingsPageTitle,
  visibleSettingsSections,
} from '../../config/adminSections';

/**
 * Issue #369, epic #346 — the `Knowledge graph` card (docs/specs/ontology.md
 * §13: "the only registry entry this feature adds").
 *
 * Settings UI rule 1 (declared in the registry, not merely routed), rule 2 (its
 * own destination — no tabs), rule 3 (the `permission` is the exact string the
 * attribute-definition write routes enforce: `graph:write`), and the route
 * carries the same gate with a redirect to the hub.
 */
const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');
const PATH = '/settings/knowledge-graph';

function findSection() {
  return USER_SETTINGS_SECTIONS.find((section) =>
    section.cards.some((card) => card.path === PATH),
  );
}

describe('USER_SETTINGS_SECTIONS — Knowledge graph card (issue #369)', () => {
  it('is declared once, in its own Knowledge group right after Account', () => {
    const labels = USER_SETTINGS_SECTIONS.map((section) => section.label);
    expect(findSection()?.label).toBe('Knowledge');
    expect(labels.indexOf('Knowledge')).toBe(labels.indexOf('Account') + 1);

    const matches = USER_SETTINGS_SECTIONS.flatMap((s) => s.cards).filter((c) => c.path === PATH);
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Knowledge graph');
  });

  it('is gated on exactly graph:write', () => {
    const card = findSection()?.cards.find((c) => c.path === PATH);
    expect(card?.permission).toBe('graph:write');
  });

  it('is visible only to holders of graph:write', () => {
    const titles = (hasPermission: (p: string) => boolean) =>
      visibleSettingsSections(USER_SETTINGS_SECTIONS, hasPermission)
        .flatMap((s) => s.cards)
        .map((c) => c.title);

    expect(titles(() => false)).not.toContain('Knowledge graph');
    expect(titles((p) => p === 'graph:read')).not.toContain('Knowledge graph');
    expect(titles((p) => p === 'graph:write')).toContain('Knowledge graph');
  });

  it('resolves the AppBar title "Knowledge graph" through the registry', () => {
    expect(settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, PATH)).toBe(
      'Knowledge graph',
    );
  });

  it('is a per-user card, never an admin one', () => {
    const adminPaths = ADMIN_SECTIONS.flatMap((s) => s.cards).map((c) => c.path);
    expect(adminPaths).not.toContain(PATH);
  });

  it('is routed behind RequirePermission graph:write, redirecting to /settings', () => {
    const source = readFileSync(APP_TSX, 'utf8');
    const route = source.slice(source.indexOf(`path="${PATH}"`));
    expect(route.indexOf(`path="${PATH}"`)).toBe(0);
    const element = route.slice(0, route.indexOf('</RequirePermission>'));
    expect(element).toContain('permission="graph:write"');
    expect(element).toContain('<Navigate to="/settings" replace />');
    expect(element).toContain('<UserKnowledgeGraphPage />');
  });
});
