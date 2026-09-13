import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';

/**
 * The compact drill-down top bar — `AppBar.tsx`'s `resolveDrillDown` branch.
 * Below `sm` (600px) on a settings-surface route, the wordmark is replaced by
 * a back arrow plus the resolved page title, and the theme toggle is dropped.
 *
 * Route: `/admin/settings/users`, resolving to "Users & Allowlist" via
 * `settingsPageTitle` over `ADMIN_SECTIONS` (`config/adminSections.tsx`) — the
 * only admin child route the visual harness (`apps/web/visual/main.tsx`)
 * mounts besides the hub itself; #366 removed the General-group pages this
 * spec used to target.
 *
 * Scoped to the `header` element (MUI's `AppBar` renders a `<header>`), not a
 * full page: `UsersPage`'s own body fetches `/api/users` and `/api/allowlist`,
 * whose resolution timing this harness does not control (see `main.tsx`'s
 * header comment on why `/api` calls are left unproxied and fail fast, but
 * not necessarily at an identical wall-clock moment every run). The AppBar's
 * title/back-arrow resolution is pure route + breakpoint — no fetch — so it
 * is stable the instant it paints, which is exactly why scoping to it keeps
 * this spec deterministic without waiting on that page's data.
 */

test('Compact drill-down AppBar: back arrow + resolved title @ <sm', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(harnessUrl({ route: '/admin/settings/users' }));
  // Inter must be in before any pixel is captured - see waitForInter (#111).
  await waitForInter(page);

  const header = page.locator('header');
  await expect(header.getByRole('button', { name: 'Back' })).toBeVisible();
  // NOT `getByRole('heading', ...)`: `AppBar.tsx` renders the drill-down
  // title as `<Typography variant="h6" component="div">`, so it carries `h6`
  // styling but not the semantic `<h6>` tag (and so no implicit heading
  // role) — verified against the actual accessibility tree, not assumed.
  await expect(header.getByText('Users & Allowlist', { exact: true })).toBeVisible();
  // Dropped in the drill-down treatment — asserting its absence is part of
  // pinning the treatment, not just its presence.
  await expect(header.getByRole('button', { name: 'toggle theme' })).toHaveCount(0);

  await expect(header).toHaveScreenshot('drilldown-appbar-390px-back-arrow-title.png');
});
