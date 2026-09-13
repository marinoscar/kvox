import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';

/**
 * The per-user settings hub — `/settings`, `UserSettingsHubPage` over the same
 * `SettingsHub` component as the admin console, parameterised with
 * `USER_SETTINGS_SECTIONS` (`config/userSettingsSections.tsx`): `Account`
 * (Profile, Appearance) and `Security` (Access Tokens). No card in this
 * registry declares a `permission` — every authenticated user owns their own
 * settings — so nothing here depends on the harness's `perms` param.
 *
 * `/settings` is not an admin route, so the rail stays in library mode
 * (Console pinned at the foot) rather than swapping to Console mode — this
 * spec's full-page screenshot is therefore also incidental coverage of that.
 */

test('User settings hub @ /settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(harnessUrl({ route: '/settings' }));
  // Inter must be in before any pixel is captured - see waitForInter (#111).
  await waitForInter(page);

  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // `exact: true` — the card's own description text ("...personal access
  // tokens for API...") contains a case-insensitive substring match for
  // "Access Tokens" too, and Playwright's default `getByText` matching is
  // case-insensitive, which without `exact` resolves to both elements and
  // fails Playwright's strict mode.
  await expect(main.getByText('Access Tokens', { exact: true })).toBeVisible();
  await expect(main.getByText('Profile', { exact: true })).toBeVisible();

  await expect(page).toHaveScreenshot('user-hub-1440x900.png', {
    fullPage: true,
  });
});
