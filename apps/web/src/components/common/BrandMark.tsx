import { Box } from '@mui/material';

/**
 * The brand mark, rendered beside the wordmark.
 *
 * WHY IT POINTS AT `/favicon.svg` RATHER THAN DRAWING THE GEOMETRY
 *
 * The K-wave monogram is already described twice — in
 * `apps/web/public/favicon.svg` and, because this template refuses to make a
 * fork's CI install an SVG rasteriser, a second time as Pillow constants in
 * `apps/web/scripts/generate-icons.py`. A component that inlined a third copy
 * as JSX `<rect>`s would be a third thing to keep in step, and the one with
 * the fewest guards: the two files above are compared bar for bar by
 * `src/__tests__/pwa/brandMark.test.ts`, and a JSX copy would sit outside that
 * comparison and drift silently. So this renders the committed file. The
 * favicon crop (mark box at 80% of the canvas) is also the right one here —
 * this is a ~28px mark, the same size regime the tab icon lives in.
 *
 * WHY `alt=""` AND `aria-hidden`
 *
 * It is decorative and it is never alone: every place it is mounted, the
 * product's name is rendered as real text immediately beside it. Giving it
 * alternative text would make a screen reader announce the name twice.
 *
 * WHY THE INDIGO PLATE IS KEPT IN BOTH THEMES
 *
 * The rounded plate is the brand's OWN ground, not a themed surface — the same
 * plate the installed app's launcher icon, the tab favicon and the iOS Home
 * Screen icon all show, in whatever theme the OS happens to be in. Swapping it
 * for `background.paper` in dark mode would make the in-app mark stop matching
 * the icon the user tapped to get here. The `borderRadius` below is the SVG's
 * own `rx` (0.22 of the canvas) restated in CSS, so the img element's box is
 * clipped to the same corner the artwork draws — without it a browser that
 * ever paints a background or outline behind the image would square the
 * corners off.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <Box
      component="img"
      src="/favicon.svg"
      alt=""
      aria-hidden
      width={size}
      height={size}
      sx={{ borderRadius: size * 0.22 }}
    />
  );
}
