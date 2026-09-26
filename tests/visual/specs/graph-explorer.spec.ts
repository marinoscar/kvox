import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';

/**
 * The graph explorer (`/graph/explore`, issue #374, epic #347) and the entity
 * page's Neighbourhood widget, at the three widths every page baseline here
 * uses — phone (390), tablet (820), desktop (1440) — either side of the `sm`
 * (600px) boundary, with 820 the tablet band a `md`-gated layout would wrongly
 * hand the phone treatment to.
 *
 * DETERMINISTIC LAYOUT. Every capture uses `?layout=static`: node positions
 * are the explorer model's own deterministic ring placement and ForceAtlas2
 * never runs, so a baseline cannot depend on how many layout frames happened
 * to run before the capture.
 *
 * WEBGL. Sigma draws with WebGL only. Chromium in the pinned Playwright image
 * has no GPU, so this spec opts into SwiftShader (Chromium's bundled software
 * rasteriser) explicitly — deterministic output on a fixed image, and without
 * it the explorer would (correctly) fall back to its list view and the canvas
 * baselines would never show a canvas.
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

const EXPLORE = `/graph/explore?seed=${JOE_ID}&layout=static`;

async function openExplorer(page: Page, route = EXPLORE) {
  await page.goto(harnessUrl({ route, perms: GRAPH_PERMS }));
  await waitForInter(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
}

/** The canvas has its slice (the count comes from the same graph the canvas draws). */
async function canvasReady(page: Page, count: number) {
  await expect(page.getByLabel(`${count} of 300 nodes`)).toBeVisible();
  const app = page.getByRole('application', { name: /^Graph explorer/ });
  await expect(app).toBeVisible();
  await expect(app.locator('canvas').first()).toBeVisible();
  // No spinner left over the canvas.
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  return app;
}

test.describe('Graph explorer', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`explorer @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize(viewport);
      await openExplorer(page);
      // Joe plus his five neighbours.
      await canvasReady(page, 6);

      await expect(page).toHaveScreenshot(`graph-explorer-${name}.png`);
    });
  }

  test('one node expanded, side panel open @ desktop-1440', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(DESKTOP);
    await openExplorer(page);
    const app = await canvasReady(page, 6);

    // Keyboard order is degree then label: Joe, then Acme Corp.
    await app.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('complementary', { name: 'Acme Corp' })).toBeVisible();
    await page.keyboard.press('Enter');
    // Acme adds Ben Okafor, Dana Li and Project Atlas.
    await canvasReady(page, 9);
    await expect(page.getByRole('button', { name: 'Expand again' })).toBeVisible();

    await expect(page).toHaveScreenshot('graph-explorer-expanded-desktop-1440.png');
  });

  test('side panel as a bottom sheet @ phone-390', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(PHONE);
    await openExplorer(page);
    const app = await canvasReady(page, 6);

    await app.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('heading', { level: 2, name: 'Joe Rivera' })).toBeVisible();

    await expect(page).toHaveScreenshot('graph-explorer-sheet-phone-390.png');
  });

  test('cap warning @ desktop-1440', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages', explorerCapped: true });
    await page.setViewportSize(DESKTOP);
    await openExplorer(page);
    await canvasReady(page, 300);
    await expect(page.getByText(/Showing 300 nodes — the limit for the explorer/)).toBeVisible();

    await expect(page).toHaveScreenshot('graph-explorer-capped-desktop-1440.png');
  });

  for (const [name, viewport] of [WIDTHS[0], WIDTHS[2]] as const) {
    test(`list view @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize(viewport);
      await openExplorer(page, `${EXPLORE}&view=list`);

      const list = page.getByRole('region', { name: 'Graph as a list' });
      await expect(list.getByText('Acme Corp')).toBeVisible();
      await expect(page.getByRole('button', { name: 'List view', pressed: true })).toBeVisible();

      await expect(page).toHaveScreenshot(`graph-explorer-list-${name}.png`, { fullPage: true });
    });
  }
});

test.describe('Entity page — Neighbourhood widget', () => {
  for (const [name, viewport] of [WIDTHS[0], WIDTHS[2]] as const) {
    test(`neighbourhood widget @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize(viewport);
      await page.goto(
        harnessUrl({ route: `/graph/entities/${JOE_ID}?layout=static`, perms: GRAPH_PERMS }),
      );
      await waitForInter(page);

      await expect(page.getByRole('heading', { level: 1, name: 'Joe Rivera' })).toBeVisible();
      const widget = page.getByRole('region', { name: 'Neighbourhood' });
      await expect(widget.locator('canvas').first()).toBeVisible();
      await expect(widget.getByRole('link', { name: 'Open in explorer' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Works for' })).toBeVisible();

      await expect(widget).toHaveScreenshot(`graph-neighbourhood-${name}.png`);
    });
  }
});
