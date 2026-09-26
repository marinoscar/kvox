import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { GRAPH_PERMS, installGraphApi } from '../support/graphApi';

/**
 * The whole-graph overview (`/graph/overview`, issue #375, epic #347) at the
 * three widths every page baseline here uses — phone (390), tablet (820),
 * desktop (1440) — either side of the `sm` (600px) boundary.
 *
 * DETERMINISTIC BY CONSTRUCTION. The overview never lays anything out: node
 * and cluster positions come from the mocked snapshot (`graphApi.ts` computes
 * them with a fixed formula), and the page always renders `GraphCanvas` with
 * `layout="static"`, so ForceAtlas2 never runs.
 *
 * WEBGL. Sigma draws with WebGL only; like `graph-explorer.spec.ts`, this spec
 * opts into SwiftShader so the canvas renders in the GPU-less Playwright image
 * (without it the page would, correctly, force its list view).
 *
 * The header caption says "Built <relative time>" — it is masked, so a
 * baseline cannot roll over from "2 years ago" to "3 years ago".
 *
 * ⚠ These baselines are valid only when generated inside the pinned Playwright
 * image (`.github/workflows/visual-baselines.yml`).
 */

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };

const WIDTHS = [
  ['phone-390', PHONE],
  ['tablet-820', TABLET],
  ['desktop-1440', DESKTOP],
] as const;

async function openOverview(page: Page, route = '/graph/overview') {
  await page.goto(harnessUrl({ route, perms: GRAPH_PERMS }));
  await waitForInter(page);
  // `includeHidden`: on a phone, a `?cluster=` opens the bottom sheet, which
  // (as a modal) hides the page beneath it from the accessibility tree.
  await expect(page.getByRole('heading', { level: 1, name: 'Overview', includeHidden: true })).toBeVisible();
}

async function canvasReady(page: Page) {
  const app = page.getByRole('application', { name: /^Graph overview, 6 clusters/, includeHidden: true });
  await expect(app).toBeVisible();
  await expect(app.locator('canvas').first()).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  return app;
}

function caption(page: Page) {
  return page.getByText(/^Built /);
}

test.describe('Graph overview', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`clusters layer @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize(viewport);
      await openOverview(page);
      await canvasReady(page);
      await expect(page.getByRole('button', { name: 'Clusters', pressed: true })).toBeVisible();

      await expect(page).toHaveScreenshot(`graph-overview-clusters-${name}.png`, { mask: [caption(page)] });
    });

    test(`everything layer @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize(viewport);
      await openOverview(page, '/graph/overview?layer=nodes');
      await canvasReady(page);
      await expect(page.getByRole('button', { name: 'Everything', pressed: true })).toBeVisible();

      await expect(page).toHaveScreenshot(`graph-overview-nodes-${name}.png`, { mask: [caption(page)] });
    });

    test(`selected cluster @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize(viewport);
      await openOverview(page, '/graph/overview?cluster=0');
      await canvasReady(page);
      // A right-hand panel from 600px up; a bottom sheet on the phone.
      await expect(page.getByRole('heading', { level: 2, name: 'Acme Corp' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Explore this cluster' })).toBeVisible();

      await expect(page).toHaveScreenshot(`graph-overview-selected-${name}.png`, { mask: [caption(page)] });
    });
  }

  test('stale banner with Refresh @ desktop-1440', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages', overviewStale: true });
    await page.setViewportSize(DESKTOP);
    await openOverview(page);
    await canvasReady(page);
    await expect(page.getByText('Your graph has changed since this overview was built.')).toBeVisible();

    await expect(page).toHaveScreenshot('graph-overview-stale-desktop-1440.png', { mask: [caption(page)] });
  });

  for (const [name, viewport] of [WIDTHS[0], WIDTHS[2]] as const) {
    test(`list view @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize(viewport);
      await openOverview(page, '/graph/overview?view=list&cluster=0');

      const list = page.getByRole('region', { name: 'Clusters as a list' });
      await expect(list.getByRole('link', { name: 'Joe Rivera' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'List view', pressed: true })).toBeVisible();

      await expect(page).toHaveScreenshot(`graph-overview-list-${name}.png`, {
        fullPage: true,
        mask: [caption(page)],
      });
    });
  }

  test('no horizontal scroll @ phone-390', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(PHONE);
    await openOverview(page, '/graph/overview?cluster=1');
    await canvasReady(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
