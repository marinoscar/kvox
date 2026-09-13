import { expect, test } from '@playwright/test';
import { harnessUrl, USERS_READ_ONLY_PERMS, waitForInter } from '../support/harness';

/**
 * A `users:read`-only user on the admin hub. `visibleSettingsSections`
 * (`config/adminSections.tsx`) drops any section left empty after its
 * permission filter — every `General` card gates on `system_settings:read` or
 * `system_settings:write`, none of which this user holds, so the whole
 * `General` group disappears rather than rendering an empty header. Only
 * `Access` / `Users & Allowlist` (gated on `users:read` alone) remains.
 *
 * `console`'s `anyPermission: ['system_settings:read', 'users:read']`
 * (`config/destinations.ts`) still holds on `users:read` alone, so the route
 * itself and the pinned rail row both stay reachable — this is a content
 * gate, not a reachability one.
 */

test('Hub with users:read only: General group hidden entirely', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(harnessUrl({ route: '/admin/settings', perms: USERS_READ_ONLY_PERMS }));
  // Inter must be in before any pixel is captured - see waitForInter (#111).
  await waitForInter(page);

  const main = page.locator('main');
  await expect(main.getByText('Users & Allowlist')).toBeVisible();
  await expect(main.getByText('Access', { exact: true })).toBeVisible();
  await expect(main.getByText('General', { exact: true })).toHaveCount(0);
  await expect(main.getByText('Email', { exact: true })).toHaveCount(0);
  await expect(main.getByText('Maintenance')).toHaveCount(0);

  await expect(page).toHaveScreenshot('hub-permissions-users-read-only.png', {
    fullPage: true,
  });
});
