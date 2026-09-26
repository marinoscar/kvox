import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';
import { CONV_JOE_SCOPED_ID, installEntityAskApi } from '../support/askApi';

/**
 * The entity page's Ask panel (#381, epic #348) OPEN over Joe Rivera's page,
 * showing an answered, cited question, at the three widths every page
 * baseline here uses — phone (390), tablet (820), desktop (1440). 390 is the
 * bottom sheet; 820 and 1440 are the 440 px right-hand drawer, the `sm`
 * (600px) boundary the panel's own page-level read switches on.
 *
 * `?ask=<id>` opens it straight on the conversation (the reload path), and
 * `?layout=static` keeps the page's Neighbourhood canvas deterministic
 * underneath (see `graph-explorer.spec.ts`).
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

test.describe('Entity Ask panel', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`entity ask panel answered @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await installEntityAskApi(page);
      await page.setViewportSize(viewport);
      await page.goto(
        harnessUrl({
          route: `/graph/entities/${JOE_ID}?layout=static&ask=${CONV_JOE_SCOPED_ID}`,
          perms: GRAPH_PERMS,
        }),
      );
      await waitForInter(page);

      const panel = page.getByRole('dialog', { name: 'Ask about Joe Rivera' });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('combobox', { name: 'Conversation' })).toHaveText('What did Joe promise us?');
      const thread = panel.getByRole('region', { name: 'Conversation' });
      // Evidence chips resolve their titles in one batch; wait for it.
      await expect(thread.getByRole('button', { name: 'Source 1: Q3 planning call' })).toBeVisible();
      await expect(panel.getByRole('link', { name: 'Open in Ask' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Model: GPT-4o mini' })).toBeVisible();

      await expect(page).toHaveScreenshot(`ask-entity-panel-${name}.png`);
    });
  }
});
