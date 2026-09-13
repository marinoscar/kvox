import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';

/**
 * The Console-mode rail — `NavigationRail.tsx`'s `consoleMode` branch, active
 * on any `/admin/*` route once the rail is expanded (`isDesktop && !railCollapsed`,
 * so `lg`/1200px and up here).
 *
 * `Back to library` IS always the first row in console mode — read directly
 * from the component: it renders UNCONDITIONALLY at the top of the
 * `consoleMode` branch, before the `consoleSections.map(...)` group loop, with
 * no permission gate of its own (getting into Console mode at all already
 * required one). The group headers ("General", "Access", "Operations") come
 * from `ADMIN_SECTIONS`' three section labels.
 *
 * The `Operations` assertions below are the point of this spec catching #266
 * at all: a card registered with `disabled: true` and no `path` must NOT appear
 * as a rail link, while its live siblings must — "declared in the IA" and
 * "reachable from the rail" are two different statements, and the rail is where
 * conflating them shows up. Both of the group's originally-inert cards have
 * since been flipped (Worker Nodes by #271, Database Backup by #287), and each
 * flip ADDED a rail row — which is the same assertion from the other side, and
 * why the baseline moved with each.
 *
 * Scoped to the `nav` element rather than a full-page screenshot: this spec
 * exists to pin the rail's own content, and scoping keeps it independent of
 * whatever the hub body happens to render (already covered by
 * `admin-hub.spec.ts`).
 */

test('Console rail: Back to library + General/Access/Operations groups @ lg', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(harnessUrl({ route: '/admin/settings' }));
  // Inter must be in before any pixel is captured - see waitForInter (#111).
  await waitForInter(page);

  const rail = page.locator('nav[aria-label="Console navigation"]');
  await expect(rail).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Back to library' })).toBeVisible();
  await expect(rail.getByText('General', { exact: true })).toBeVisible();
  await expect(rail.getByText('Access', { exact: true })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Maintenance' })).toBeVisible();
  await expect(rail.getByText('Operations', { exact: true })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Users & Allowlist' })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Jobs', exact: true })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Job Insights' })).toBeVisible();
  // Live since #271 — the rail row appearing IS the assertion that flipping a
  // card from `disabled` to routed reaches all three consumers of the registry,
  // not just the hub.
  await expect(rail.getByRole('link', { name: 'Worker Nodes' })).toBeVisible();
  // Live since #287, the epic's last issue — and the row appearing here is the
  // whole reason `NavigationRail` was left to key on `!card.path ||
  // card.disabled` rather than on a second list: flipping two fields in the
  // registry is what makes the rail draw it.
  await expect(rail.getByRole('link', { name: 'Database Backup' })).toBeVisible();

  await expect(rail).toHaveScreenshot('console-rail-lg-expanded.png');
});
