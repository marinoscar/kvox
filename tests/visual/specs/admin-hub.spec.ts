import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';

/**
 * The admin (Console) settings hub — `/admin/settings`, `SettingsHubPage` over
 * `SettingsHub` (`apps/web/src/components/settings/SettingsHub.tsx`) — at the
 * three responsive treatments `SettingsHub.tsx` itself documents:
 *
 *   - `md` and up (≥900px):  3-column card grid (`Grid size={{ xs: 12, sm: 6,
 *     md: 4 }}` — verified by reading the component rather than assumed), rail
 *     expanded because the viewport is also ≥ `lg` (1200px).
 *   - `sm`–`md` (600–899px):  2-column card grid, rail forced collapsed
 *     because the viewport is below `lg`.
 *   - below `sm` (<600px):    drill-down list (`SettingsHub`'s own
 *     `isCompactWindow` gate) with no rail at all (`Layout`'s `showRail` gate)
 *     and the compact back-arrow `AppBar` in its place.
 *
 * `ADMIN_SECTIONS` (`apps/web/src/config/adminSections.tsx`) has 3 groups / 10
 * cards total — General (Email, Notifications, Web Push, Maintenance), Access
 * (Users & Allowlist) and Operations (Jobs, Job Insights, Worker Nodes,
 * Database Backup, Broadcasts) — so "3-up"/"2-up" describes the CSS grid's
 * column count at that width, not the number of sections.
 *
 * ⚠ THAT COUNT IS LOAD-BEARING ONLY IF THE HARNESS CAN SEE EVERY CARD. The
 * hub filters by permission, so a card whose permission is missing from
 * `DEFAULT_PERMISSIONS` in `apps/web/visual/main.tsx` renders nowhere and this
 * suite quietly stops asserting anything about it. When a group is added,
 * that list is the second half of the change — see its own comment.
 *
 * `SettingsHub` makes no network request of its own (the registry is a static
 * array), so every screenshot here is safe as a FULL PAGE capture — nothing on
 * this route races a `fetch` the way a leaf settings page's own body would.
 */

test.describe('Admin settings hub', () => {
  test('3-up grid + expanded Console rail @ 1919x862', async ({ page }) => {
    await page.setViewportSize({ width: 1919, height: 862 });
    await page.goto(harnessUrl({ route: '/admin/settings' }));
    // Inter must be in before any pixel is captured - see waitForInter (#111).
    await waitForInter(page);

    // Scoped to `<main>` (`Layout.tsx`'s content region): at this width the
    // Console rail ALSO renders a "Maintenance" row (it reads the same
    // `ADMIN_SECTIONS`), so an unscoped `getByText` here would match twice and
    // fail Playwright's strict mode.
    const main = page.locator('main');
    await expect(main.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(main.getByText('Maintenance')).toBeVisible();
    // Rail present and expanded — the Console-mode "Back to library" row only
    // renders when `expanded` is true (see `NavigationRail.tsx`).
    await expect(page.getByRole('link', { name: 'Back to library' })).toBeVisible();

    await expect(page).toHaveScreenshot('admin-hub-1919x862-3up-console-expanded.png', {
      fullPage: true,
    });
  });

  test('2-up grid + collapsed library rail @ 767x844', async ({ page }) => {
    await page.setViewportSize({ width: 767, height: 844 });
    await page.goto(harnessUrl({ route: '/admin/settings' }));
    // Inter must be in before any pixel is captured - see waitForInter (#111).
    await waitForInter(page);

    const main = page.locator('main');
    await expect(main.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(main.getByText('Maintenance')).toBeVisible();
    // Below `lg` the rail is unconditionally collapsed AND stays in LIBRARY
    // mode (Console mode is expanded-only) — so the pinned Console row shows
    // here, not "Back to library".
    await expect(page.getByRole('link', { name: 'Console' })).toBeVisible();

    await expect(page).toHaveScreenshot('admin-hub-767x844-2up-rail-collapsed.png', {
      fullPage: true,
    });
  });

  test('drill-down list + back-arrow AppBar @ 551x840', async ({ page }) => {
    await page.setViewportSize({ width: 551, height: 840 });
    await page.goto(harnessUrl({ route: '/admin/settings' }));
    // Inter must be in before any pixel is captured - see waitForInter (#111).
    await waitForInter(page);

    // Below `sm` there is no rail at all (`Layout`'s `showRail` gate) — the
    // hub itself becomes the navigation.
    // `exact: true` is load-bearing, not tidiness: accessible-name matching is
    // substring-based by default, and the Operations group's "Database Backup"
    // row contains "Back". Without it this resolves to two elements and fails
    // on strict mode. Still true after #287 routed that card — losing its
    // "Coming soon" chip changed the row's name, not the substring that
    // collides.
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
    await expect(page.locator('main').getByText('Maintenance')).toBeVisible();

    await expect(page).toHaveScreenshot('admin-hub-551x840-drilldown.png', {
      fullPage: true,
    });
  });
});
