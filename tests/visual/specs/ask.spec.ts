import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { ASK_PERMS, CONV_ANSWERED_ID, CONV_FAILED_ID, installAskApi } from '../support/askApi';

/**
 * The `/ask` page (#380, epic #348) at the three widths every page baseline
 * here uses — phone (390), tablet (820), desktop (1440). 390 and 820 sit either
 * side of the `sm` (600px) boundary the page's own list/drawer switch reads.
 *
 *   - the empty state (no conversation open, suggested questions);
 *   - a completed, cited answer with its tool steps EXPANDED (all three
 *     citation chips, the removed-citation caption);
 *   - a failed turn with its copy and "Try again";
 *   - the phone's conversation drawer open.
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

test.describe('Ask', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`ask empty state @ ${name}`, async ({ page }) => {
      await installAskApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/ask', perms: ASK_PERMS }));
      await waitForInter(page);

      await expect(page.getByRole('heading', { name: 'Ask about your meetings' })).toBeVisible();
      await expect(page.getByRole('button', { name: "What's the latest on Joe Rivera?" })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Model: GPT-4o mini' })).toBeVisible();

      await expect(page).toHaveScreenshot(`ask-empty-${name}.png`);
    });

    test(`ask cited answer @ ${name}`, async ({ page }) => {
      await installAskApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: `/ask/${CONV_ANSWERED_ID}`, perms: ASK_PERMS }));
      await waitForInter(page);

      const thread = page.getByRole('region', { name: 'Conversation' });
      await expect(thread.getByText("1 source couldn't be verified and was removed.")).toBeVisible();
      // Evidence chips resolve their titles in one batch; wait for it.
      await expect(thread.getByRole('button', { name: 'Source 1: Q3 planning call' })).toBeVisible();
      await thread.getByRole('button', { name: /Searched “Atlas beta”/ }).click();
      await expect(thread.getByRole('list', { name: 'Lookups' })).toBeVisible();

      await expect(page).toHaveScreenshot(`ask-answer-${name}.png`);
    });

    test(`ask failed turn @ ${name}`, async ({ page }) => {
      await installAskApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: `/ask/${CONV_FAILED_ID}`, perms: ASK_PERMS }));
      await waitForInter(page);

      await expect(page.getByText('Your AI provider is rate-limiting requests. Try again in a minute.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

      await expect(page).toHaveScreenshot(`ask-failed-${name}.png`);
    });
  }

  test('ask conversation drawer open @ phone-390', async ({ page }) => {
    await installAskApi(page);
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: `/ask/${CONV_ANSWERED_ID}`, perms: ASK_PERMS }));
    await waitForInter(page);

    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
    await page.getByRole('button', { name: 'Conversations' }).click();
    const list = page.getByRole('navigation', { name: 'Conversations' });
    await expect(list.getByRole('link', { name: /What did Joe promise us\?/ })).toBeVisible();

    await expect(page).toHaveScreenshot('ask-drawer-phone-390.png');
  });
});
