import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';

/**
 * The knowledge graph's index and entity page (#373, epic #347) at the three
 * widths every page baseline here uses — phone (390), tablet (820), desktop
 * (1440) — for the reason `transcripts.spec.ts` gives: 390 and 820 sit either
 * side of the `sm` (600px) boundary, and 820 is the tablet band a `md`-gated
 * layout would wrongly hand the phone treatment to.
 *
 * Plus the evidence popover OPEN on a phone, where it is a bottom sheet rather
 * than a popover — the one layout this feature adds that no other baseline
 * covers.
 *
 * ⚠ These baselines are valid only when generated inside the pinned Playwright
 * image (`.github/workflows/visual-baselines.yml`).
 */

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };

const WIDTHS = [
  ['phone-390', PHONE],
  ['tablet-820', TABLET],
  ['desktop-1440', DESKTOP],
] as const;

test.describe('Knowledge index', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`graph index @ ${name}`, async ({ page }) => {
      await installGraphApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/graph', perms: GRAPH_PERMS }));
      await waitForInter(page);

      await expect(page.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Joe Rivera/ })).toBeVisible();
      // The chips come from the ontology request; wait for its labels.
      await expect(page.getByRole('button', { name: /Projects/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();

      await expect(page).toHaveScreenshot(`graph-index-${name}.png`);
    });
  }

  test('graph index empty state @ phone-390', async ({ page }) => {
    await installGraphApi(page, { empty: true });
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/graph', perms: GRAPH_PERMS }));
    await waitForInter(page);

    await expect(page.getByText('Nothing in your graph yet')).toBeVisible();

    await expect(page).toHaveScreenshot('graph-index-empty-phone-390.png');
  });
});

test.describe('Entity page', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`entity page @ ${name}`, async ({ page }) => {
      await installGraphApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: `/graph/entities/${JOE_ID}`, perms: GRAPH_PERMS }));
      await waitForInter(page);

      await expect(page.getByRole('heading', { level: 1, name: 'Joe Rivera' })).toBeVisible();
      await expect(page.getByText('Joe was promoted to VP Engineering in February.')).toBeVisible();
      // Every section has loaded — the last one on the page is Mentions.
      await expect(page.getByText('No longer available')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Works for' })).toBeVisible();
      // The evidence chips resolve their titles in one batch; wait for it so
      // the capture never lands on the frame where they are still "Source 1".
      await expect(page.getByRole('button', { name: 'Source 1: Q3 planning call' }).first()).toBeVisible();

      await expect(page).toHaveScreenshot(`graph-entity-${name}.png`, { fullPage: true });
    });
  }

  test('evidence sheet open @ phone-390', async ({ page }) => {
    await installGraphApi(page);
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: `/graph/entities/${JOE_ID}`, perms: GRAPH_PERMS }));
    await waitForInter(page);

    const chip = page.getByRole('button', { name: 'Source 1: Q3 planning call' }).first();
    await expect(chip).toBeVisible();
    await chip.click();

    await expect(page.getByRole('dialog', { name: 'Q3 planning call' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play from 12:34' })).toBeVisible();

    await expect(page).toHaveScreenshot('graph-evidence-sheet-phone-390.png');
  });
});
