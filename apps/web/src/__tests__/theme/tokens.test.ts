/**
 * The brand palette, measured — issue #110.
 *
 * WHY THIS FILE EXISTS RATHER THAN A REVIEW NOTE
 * =============================================================================
 * Two of the light speaker colours this issue replaced (`#e65100` at 3.48:1 and
 * `#00838f` at 4.15:1, both against the old `#f5f5f5` page ground) had failed
 * WCAG AA since the day they were written. Nobody had done anything wrong: a
 * hex in an array looks exactly as accessible as any other hex, and there is no
 * way to see a 3.48 by reading `#e65100`. The only thing that catches a failing
 * colour is arithmetic, and the only thing that keeps catching it is arithmetic
 * that runs on every commit.
 *
 * So this suite recomputes every ratio from the actual shipped literals on
 * every run. It does NOT record the numbers as the assertion — an
 * `expect(ratio).toBeCloseTo(6.29)` would fail the day somebody makes a colour
 * BETTER, which trains people to update the number without reading it. The
 * assertion is the FLOOR; the measured value is written in a comment beside
 * each group so a palette change shows up in review as a change in intent
 * rather than as a pass/fail flip. Several pairs clear the floor by very
 * little: light `secondary.main` on `background.default` is 4.69:1 and light
 * speaker index 6 is 4.60:1, both against a 4.5:1 requirement.
 *
 * EVERYTHING IS HELD TO 4.5:1, INCLUDING THINGS WCAG WOULD LET OFF AT 3:1
 * =============================================================================
 * `WCAG_AA_NORMAL_TEXT` is used for `primary.main` and `secondary.main` too,
 * even though a chip border or a tab indicator is a non-text UI component that
 * 1.4.11 floors at 3:1. That is deliberate and it is this suite's own
 * discipline rather than the standard's: in this application those two colours
 * are overwhelmingly used as INK — link text, the "More details" toggle, a
 * selected bottom-navigation label, a filter chip's label — and a palette that
 * only clears 3:1 is a palette where every one of those is a violation waiting
 * for someone to use the colour the obvious way.
 *
 * NO ALPHA HERE, AND THAT IS THE POINT
 * =============================================================================
 * Every value in `BRAND_TOKENS` is an opaque hex, so `contrastRatio` is called
 * with two arguments throughout and there is no compositing to get wrong. The
 * palette this replaced stated its text colours as `rgba(0,0,0,0.87)`, which is
 * why `DataTableContrast.test.tsx` has to pass a third argument everywhere and
 * why forgetting it there silently reports 21:1 for both text tiers. Opaque
 * tokens make that class of false pass unrepresentable in this file.
 *
 * `flattenOver` is imported and exercised anyway, at the bottom: the ONE thing
 * in this palette that is genuinely translucent is `action.selected` /
 * `action.hover`, which `light.ts` and `dark.ts` build with `alpha()`, and the
 * components that paint over them (`BulkActionBar`, `DataCard`) put real text
 * on top.
 */

import { describe, it, expect } from 'vitest';
import { THEME_COLOR } from '@app/shared';
import { BRAND_TOKENS } from '../../theme/tokens';
import { lightPalette } from '../../theme/light';
import { SPEAKER_PALETTES } from '../../utils/transcriptDisplay';
import {
  contrastRatio,
  flattenOver,
  parseColor,
  WCAG_AA_NORMAL_TEXT,
} from '../../components/datatable/__tests__/testUtils/contrast';

const MODES = ['light', 'dark'] as const;

/** Both grounds a colour in this palette can land on, named for the failure message. */
function surfaces(mode: (typeof MODES)[number]): ReadonlyArray<readonly [string, string]> {
  const { background } = BRAND_TOKENS[mode];
  return [
    ['background.default', background.default],
    ['background.paper', background.paper],
  ];
}

describe('the brand token map is the single source of both palettes', () => {
  // The rebrand contract (see `theme/tokens.ts`): `identity.json` is what
  // `scripts/rename.mjs` rewrites and what `generate-icons.py` paints into the
  // committed PNGs. If the light primary ever stops being that value, the
  // running application and the browser tab / Home Screen icon / OS chrome are
  // free to disagree, and nothing else in this repository would notice.
  it('light primary.main IS the shared THEME_COLOR, not a copy of it', () => {
    expect(BRAND_TOKENS.light.primary.main).toBe(THEME_COLOR);
    expect(lightPalette.primary).toMatchObject({ main: THEME_COLOR });
  });

  // A manifest's `theme_color` is parsed by the PLATFORM, not by a CSS engine,
  // and the 3-digit shorthand and `rgb()` forms are not reliably accepted
  // there; `scripts/rename.mjs` additionally lowercases and validates exactly
  // this shape, so an uppercase value would be rewritten out from under a fork
  // on its next rename.
  it('THEME_COLOR is a lowercase 6-digit hex literal', () => {
    expect(THEME_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });

  // The two lists are indexed by one persisted `color_index` per speaker, so a
  // speaker that has a colour in light mode must have one in dark mode.
  it('the two speaker lists are the same length', () => {
    expect(SPEAKER_PALETTES.light.length).toBe(SPEAKER_PALETTES.dark.length);
  });

  // Rule 2 of `transcriptDisplay.ts`'s header: a speaker drawn in the brand hue
  // reads as "selected" or "link", so no speaker colour may be one of the four
  // indigos the primary ramp is built from — in EITHER mode, since a speaker
  // keeps one `color_index` across both and a colour that is safe in light mode
  // is not automatically safe in dark.
  //
  // ⚠ Deliberately an EXACT-MATCH check and not a numeric "how indigo is it"
  // threshold. Both obvious metrics were tried and both are wrong here:
  // Euclidean RGB distance rejects `#7e22ce` (a purple that is 64 units from
  // `#4f46e5` and reads as an entirely different colour), and hue distance
  // rejects `#475569` and `#cbd5e1` (near-neutral slates whose residual hue
  // happens to sit 17–28° from indigo while carrying almost no saturation to
  // express it). A threshold tuned to pass those two is a threshold loose
  // enough to pass a genuine indigo, which would make the assertion worse than
  // none — it would read as a guarantee while guaranteeing nothing. The rule is
  // a design rule, enforced by the header comment and by review; what a test
  // CAN state without lying is that nobody has pasted a palette value in.
  it.each(MODES)('%s speaker colours reuse none of the primary ramp', (mode) => {
    const ramp = new Set<string>(
      MODES.flatMap((m) => {
        const { primary } = BRAND_TOKENS[m];
        return [primary.main, primary.light, primary.dark];
      }).map((value) => value.toLowerCase()),
    );

    for (const color of SPEAKER_PALETTES[mode]) {
      expect(ramp.has(color.toLowerCase())).toBe(false);
    }
  });
});

describe.each(MODES)('%s palette — WCAG AA (4.5:1) against both surfaces', (mode) => {
  const tokens = BRAND_TOKENS[mode];

  describe('text tiers', () => {
    // Measured, light:  text.primary   15.82:1 on default / 16.93:1 on paper
    //                   text.secondary  5.83:1 on default /  6.24:1 on paper
    // Measured, dark:   text.primary   15.42:1 on default / 14.20:1 on paper
    //                   text.secondary  7.91:1 on default /  7.28:1 on paper
    it.each(surfaces(mode))('text.primary on %s', (_name, surface) => {
      expect(contrastRatio(tokens.text.primary, surface)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT,
      );
    });

    it.each(surfaces(mode))('text.secondary on %s', (_name, surface) => {
      expect(contrastRatio(tokens.text.secondary, surface)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT,
      );
    });

    // `text.disabled` is deliberately NOT asserted. WCAG 1.4.3 exempts
    // "inactive user interface components" from the contrast requirement, and
    // it is exempt for a reason that matters here: a disabled control that
    // meets AA is a disabled control that does not look disabled. Light
    // `#9497ad` measures 2.88:1 on paper and dark `#6b7089` 3.56:1, both on
    // purpose. The property worth pinning is the ORDERING — disabled must be
    // fainter than secondary, or the tier means nothing.
    it('text.disabled is fainter than text.secondary', () => {
      const paper = tokens.background.paper;
      expect(contrastRatio(tokens.text.disabled, paper)).toBeLessThan(
        contrastRatio(tokens.text.secondary, paper),
      );
    });
  });

  describe('brand colours as ink', () => {
    // Measured, light:  primary.main   5.87:1 on default / 6.29:1 on paper
    //                   secondary.main 4.69:1 on default / 5.02:1 on paper  <- tightest
    // Measured, dark:   primary.main   9.47:1 on default / 8.72:1 on paper
    //                   secondary.main 11.30:1 on default / 10.41:1 on paper
    it.each(surfaces(mode))('primary.main on %s', (_name, surface) => {
      expect(contrastRatio(tokens.primary.main, surface)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT,
      );
    });

    it.each(surfaces(mode))('secondary.main on %s', (_name, surface) => {
      expect(contrastRatio(tokens.secondary.main, surface)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT,
      );
    });
  });

  describe('contrastText on its own fill (the filled-button pair)', () => {
    // This is the pair a `variant="contained"` button paints, and it is the one
    // MUI would otherwise CHOOSE for us by luminance threshold. Stating both
    // halves in the token map is what makes them measurable here instead of
    // dependent on an internal heuristic.
    //
    // Measured, light: 6.29:1 (#ffffff on #4f46e5) / 5.02:1 (#ffffff on #b45309)
    // Measured, dark:  9.47:1 (#0f1117 on #a5b4fc) / 11.30:1 (#0f1117 on #fbbf24)
    it('primary.contrastText on primary.main', () => {
      expect(
        contrastRatio(tokens.primary.contrastText, tokens.primary.main),
      ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    it('secondary.contrastText on secondary.main', () => {
      expect(
        contrastRatio(tokens.secondary.contrastText, tokens.secondary.main),
      ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('semantic colours on paper', () => {
    // These are Alert text, status chips and the destructive-action palette —
    // read as ink far more often than as a fill, hence the full 4.5:1.
    //
    // Measured, light: success 5.02 / warning 4.92 / error 6.47 / info 6.70
    // Measured, dark:  success 9.97 / warning 10.41 / error 6.28 / info 6.84
    it.each(['success', 'warning', 'error', 'info'] as const)('%s on background.paper', (key) => {
      expect(contrastRatio(tokens[key], tokens.background.paper)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT,
      );
    });
  });

  describe('every speaker colour, on both surfaces', () => {
    // A speaker's name is `body2`-sized ink directly above the segment text, so
    // there is no large-text exemption to lean on. Both surfaces are checked
    // because the name is drawn on the page ground in the segment list and on
    // `paper` inside the speaker filter and the library card.
    //
    // Measured minima, light: 4.60:1 on #f6f7fb (index 6, #a16207)
    //                         4.92:1 on #ffffff (index 6)
    // Measured minima, dark:  10.41:1 on #0f1117 (index 1, #f9a8d4)
    //                          9.58:1 on #171a23 (index 1)
    const cases = SPEAKER_PALETTES[mode].flatMap((color, index) =>
      surfaces(mode).map(([name, surface]) => [index, color, name, surface] as const),
    );

    it.each(cases)('speaker[%i] %s on %s', (_index, color, _name, surface) => {
      expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });
});

describe('the translucent washes the palette does build with alpha()', () => {
  // `action.selected` / `action.hover` (and the selection tints
  // `BulkActionBar` and `DataCard` derive from `primary.main`) are the only
  // non-opaque colours this design ships. Text still has to be legible ON them,
  // and a wash is exactly the case a two-argument contrast check gets wrong —
  // read in isolation, `alpha('#4f46e5', 0.08)` is mostly-transparent indigo
  // and reports nothing useful. `flattenOver` composites it onto the real
  // surface first, which is what a browser does.
  it.each(MODES)('%s: text.primary stays AA over the selected-row wash', (mode) => {
    const tokens = BRAND_TOKENS[mode];
    const washAlpha = mode === 'dark' ? 0.16 : 0.08;
    const brand = parseColor(tokens.primary.main);
    const composited = flattenOver(
      { ...brand, a: washAlpha },
      parseColor(tokens.background.paper),
    );
    const asCss = `rgb(${composited.r}, ${composited.g}, ${composited.b})`;

    expect(contrastRatio(tokens.text.primary, asCss)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT,
    );
  });

  // The palette-independent anchor: pure black on pure white is exactly 21:1 by
  // definition. Pins the calculator rather than the palette, so if this file
  // ever goes green because `contrastRatio` started returning a constant, this
  // is the assertion that says so.
  it('black on white is exactly 21:1, whatever the palette is', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
});
