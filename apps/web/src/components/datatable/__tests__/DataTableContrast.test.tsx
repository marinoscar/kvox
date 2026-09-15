/**
 * Component tests — DataTable color contrast, computed against the REAL
 * theme (issue #257).
 *
 * `axe-core`'s `color-contrast` rule is disabled in the conformance suite's
 * axe pass (`conformance/runDataTableConformanceSuite.tsx` documents why:
 * jsdom performs no real layout/paint, so the rule cannot resolve an
 * element's true effective background and is a well-known false-negative
 * trap there). This file is the real substitute: a pure WCAG 2.1
 * relative-luminance / contrast-ratio calculator
 * (`testUtils/contrast.ts`) run directly against the actual
 * `lightTheme` / `darkTheme` palette values the app ships
 * (`../../../theme/light.ts`, `dark.ts`) for the specific foreground/
 * background pairs THIS component paints — not a generic "is the theme
 * accessible" audit.
 *
 * ## Every ratio here is re-pinned against THIS repo's palette
 *
 * The measured ratios in the comments below were computed from
 * `theme/light.ts` / `theme/dark.ts` as they stand, NOT carried over from the
 * upstream palette this suite was ported from. They are recorded so that a
 * future palette change shows up as a diff in intent, not just as a pass/fail
 * flip. Issue #110 repalletted the app and every number below moved; the
 * tightest pair in this file, `primary.main` on light paper, went from 4.60:1
 * (0.10 over the AA floor) to 6.29:1.
 *
 * ## Translucent FOREGROUNDS must be composited too
 *
 * Since issue #110 the TEXT colors are opaque hex (`text.primary` is `#1a1b2e`
 * light / `#e6e8f0` dark), so the compositing argument is no longer
 * load-bearing for them — but it still is for the selected-row tint and the
 * detail wash, which are genuinely translucent, and the trap it guards has not
 * gone anywhere: `contrastRatio()` only composites a translucent color when it
 * is given the opaque surface behind it, so calling it with two arguments
 * treats `rgba(0, 0, 0, 0.6)` as pure black and reports 21:1 — the same number
 * as black-on-white. That is a FALSE pass, not a strict one: it reports a
 * contrast the user never actually sees.
 *
 * So every assertion below passes the opaque backing surface explicitly,
 * including the ones where it is now a no-op — a suite where some calls
 * composite and some do not is a suite where the next reader has to work out
 * which is which — and the "both text colors cannot be equal" property is
 * itself asserted at the bottom of this file so the mistake cannot silently
 * return.
 *
 * ## The palette values are READ, never restated
 *
 * Every color in this file now comes from `lightPalette` / `darkPalette` or is
 * derived from one with `alpha()`. Issue #110 removed the last three literals
 * (the two selection tints and the error pair), each of which had been "verified
 * to match" a component or MUI's default at the time it was written and each of
 * which this issue's palette change would have silently invalidated.
 */

import { describe, it, expect } from 'vitest';
import { alpha } from '@mui/material/styles';
import { lightPalette } from '../../../theme/light';
import { darkPalette } from '../../../theme/dark';
import {
  contrastRatio,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
  WCAG_AA_UI_COMPONENT,
} from './testUtils/contrast';

// Component-authored colors that are not part of the theme palette but ARE
// painted by DataTable — the selected-row tint (`DesktopGridRenderer.tsx`'s
// `.MuiDataGrid-row.Mui-selected` equivalent styling, `DataCard.tsx`'s
// selected background) and the bulk-action-bar tint (`BulkActionBar.tsx`).
//
// DERIVED from `primary.main`, not mirrored as literals (issue #110). They used
// to be hand-copied `rgba(25, 118, 210, 0.06)` / `rgba(144, 202, 249, 0.10)`
// strings "verified to match those two files" — which is a verification that
// holds exactly until somebody edits one side, and both sides were in fact
// edited by issue #110. The two components now build their tint with `alpha()`
// over `theme.palette.primary.main`, so this file calls the same function over
// the same palette: a future palette change moves the component and this
// assertion together, by construction, and there is nothing left to keep in
// step by hand. The two ALPHAS are still restated (0.06 / 0.10), because those
// are genuinely this component's own choice and not a palette value.
const SELECTED_ROW_TINT_LIGHT = alpha(lightPalette.primary!.main!, 0.06);
const SELECTED_ROW_TINT_DARK = alpha(darkPalette.primary!.main!, 0.1);

// The collapsed "More details" region's own backing wash (`DataCard.tsx:279-280`),
// painted over the card's `background.paper`.
const DETAIL_REGION_TINT_LIGHT = 'rgba(0, 0, 0, 0.02)';
const DETAIL_REGION_TINT_DARK = 'rgba(255, 255, 255, 0.03)';

const LIGHT_PAPER = lightPalette.background!.paper!;
const DARK_PAPER = darkPalette.background!.paper!;

describe('DataTable — WCAG contrast (computed against the real theme)', () => {
  describe('body text on the card / paper surface', () => {
    // Measured: 16.93:1. `text.primary` is an opaque #1a1b2e on #ffffff.
    it('light theme: text.primary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(lightPalette.text!.primary!, LIGHT_PAPER, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 6.24:1 — the tightest of the four. Since issue #110 the text
    // tokens are opaque, so the third argument is a no-op here rather than
    // load-bearing; it is kept because the tints below still need it and a
    // suite where some calls composite and some do not is a suite where the
    // next reader has to check which is which.
    it('light theme: text.secondary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(lightPalette.text!.secondary!, LIGHT_PAPER, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 14.20:1. `text.primary` is opaque #e6e8f0 on #171a23.
    it('dark theme: text.primary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(darkPalette.text!.primary!, DARK_PAPER, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 7.28:1. #a2a7bd on #171a23.
    it('dark theme: text.secondary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(darkPalette.text!.secondary!, DARK_PAPER, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('body text over the SELECTED-row tint (translucent, composited)', () => {
    // The tint is painted over `background.paper` (the Card / DataGrid row's
    // own surface); text.primary is what sits on top of it in both
    // `DataCard.tsx` and the grid's selected-row styling. A translucent tint
    // is the one case a naive two-color contrast check gets wrong — the
    // ACTUAL rendered background is the tint alpha-composited over paper, not
    // the tint's own (mostly-transparent) color read in isolation.

    // Measured: 15.49:1.
    it('light theme: text.primary over the selected-row tint (composited over paper) meets AA', () => {
      const ratio = contrastRatio(lightPalette.text!.primary!, SELECTED_ROW_TINT_LIGHT, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 11.75:1.
    it('dark theme: text.primary over the selected-row tint (composited over paper) meets AA', () => {
      const ratio = contrastRatio(darkPalette.text!.primary!, SELECTED_ROW_TINT_DARK, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('detail-region body text (the card’s collapsed "More details" wash)', () => {
    // The region's `secondary`-column label/value pairs are `text.secondary`
    // over the detail wash over paper — a THREE-layer stack, and the pair with
    // the least headroom in the light theme once alpha is honoured.

    // Measured: 5.98:1.
    it('light theme: text.secondary over the detail wash (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        lightPalette.text!.secondary!,
        DETAIL_REGION_TINT_LIGHT,
        LIGHT_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 6.75:1.
    it('dark theme: text.secondary over the detail wash (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        darkPalette.text!.secondary!,
        DETAIL_REGION_TINT_DARK,
        DARK_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('primary-colored UI elements (chips, links, focus/selection accents)', () => {
    // `primary.main` is what `DataCard.tsx`'s "More details" control, the
    // filter chips (`variant="outlined" color="primary"`), and the selected
    // row's border all use. WCAG 1.4.11 (non-text contrast) sets the floor at
    // 3:1 against its background, not the stricter 4.5:1 for body text.

    // Measured: 6.29:1 — the brand indigo on #ffffff. Was 4.60:1 under the old
    // #1976d2, i.e. clearing AA normal text by 0.10; issue #110's palette buys
    // this pair real headroom, and `src/__tests__/theme/tokens.test.ts` now
    // holds primary.main to the full 4.5:1 on BOTH surfaces rather than to the
    // 3:1 non-text floor this assertion uses.
    it('light theme: primary.main on background.paper meets the UI-component floor (3:1)', () => {
      const ratio = contrastRatio(lightPalette.primary!.main!, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // Measured: 8.72:1 — #a5b4fc on #171a23.
    it('dark theme: primary.main on background.paper meets the UI-component floor (3:1)', () => {
      const ratio = contrastRatio(darkPalette.primary!.main!, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // The "More details" / "Fewer details" toggle and filter-chip labels are
    // `body2`-sized text COLORED with `primary.main`, not just a border or
    // icon — held to the stricter large-text-or-better floor as a matter of
    // this suite's own discipline, even though WCAG's text rule technically
    // only requires 4.5:1 for genuinely small text.
    it('light theme: primary.main text on background.paper clears the large-text floor (3:1)', () => {
      const ratio = contrastRatio(lightPalette.primary!.main!, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    });

    it('dark theme: primary.main text on background.paper clears the large-text floor (3:1)', () => {
      const ratio = contrastRatio(darkPalette.primary!.main!, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    });
  });

  describe('error (destructive) palette', () => {
    // Destructive row/bulk actions (`destructive: true`) paint in
    // `theme.palette.error.main`. This used to pin MUI's OWN defaults (#d32f2f
    // light, #f44336 dark) as literals, with a note that "if a future palette
    // change ever adds a custom override, this test starts exercising it for
    // free". Issue #110 is that change: `error` is now a brand token in both
    // modes, so the values are READ from the palette rather than restated, and
    // the pin below has become a pin on the tokens being present at all.

    // Measured: 6.47:1 — #b91c1c on #ffffff (MUI's default managed 4.98:1).
    it('light theme: error.main on background.paper meets the UI-component floor', () => {
      const ratio = contrastRatio(lightPalette.error!.main!, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // Measured: 6.28:1 — #f87171 on #171a23 (MUI's default managed 4.53:1).
    it('dark theme: error.main on background.paper meets the UI-component floor', () => {
      const ratio = contrastRatio(darkPalette.error!.main!, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // The palette objects above are `PaletteOptions`, i.e. a REQUEST; this
    // asserts that the built themes actually carry the requested value, so a
    // future `createTheme` call that drops or augments the override cannot
    // leave the two assertions above measuring a colour the app never paints.
    it('the built themes carry the error tokens these ratios were computed from', async () => {
      const { lightTheme, darkTheme } = await import('../../../theme');
      const { BRAND_TOKENS } = await import('../../../theme/tokens');
      expect(lightTheme.palette.error.main).toBe(BRAND_TOKENS.light.error);
      expect(darkTheme.palette.error.main).toBe(BRAND_TOKENS.dark.error);
    });
  });

  describe('the calculator itself honours alpha', () => {
    // Guards the porting mistake this file's docblock describes: if a future
    // edit drops the third argument, `text.secondary` collapses onto
    // `text.primary`'s ratio and every assertion above silently over-reports.
    it('light theme: text.secondary is measurably LOWER contrast than text.primary', () => {
      const primary = contrastRatio(lightPalette.text!.primary!, LIGHT_PAPER, LIGHT_PAPER);
      const secondary = contrastRatio(lightPalette.text!.secondary!, LIGHT_PAPER, LIGHT_PAPER);
      expect(secondary).toBeLessThan(primary);
    });

    it('dark theme: text.secondary is measurably LOWER contrast than text.primary', () => {
      const primary = contrastRatio(darkPalette.text!.primary!, DARK_PAPER, DARK_PAPER);
      const secondary = contrastRatio(darkPalette.text!.secondary!, DARK_PAPER, DARK_PAPER);
      expect(secondary).toBeLessThan(primary);
    });

    // The palette-independent anchor (§17): pure black on pure white is
    // exactly 21:1 by definition, so this pins the calculator rather than the
    // theme and stays valid through any palette change.
    it('black on white is exactly 21:1 regardless of palette', () => {
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    });
  });
});
