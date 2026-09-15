#!/usr/bin/env python3
"""
Generate every brand raster under `apps/web/public/`.

The brand COLOURS come from `packages/shared/identity.json` — the one manifest
the application, the CLI and the web app manifest all read — so a rebrand
cannot leave the icons behind. The mark GEOMETRY lives in the constants below.

    python3 apps/web/scripts/generate-icons.py

WHY A COMMITTED SCRIPT AND COMMITTED PNGs, RATHER THAN A BUILD STEP
=============================================================================
This repository is a TEMPLATE. A fork that rebrands it must not be forced to
install an image toolchain (sharp, ImageMagick, librsvg) in CI just to produce
a favicon, so no image library appears in any `package.json` and nothing in
`npm run build` calls this file. The PNGs it writes are committed; this script
is the documented, reproducible way to REGENERATE them after a rebrand, run by
hand, on a machine with Python 3 and Pillow:

    pip install --user 'Pillow>=10'

THE MARK
=============================================================================
A K MONOGRAM: one vertical stem and two round-capped diagonal arms, on a
square mark box of side M whose origin is its own top-left corner.

    stroke     W = 0.17 M         stem width and arm stroke alike
    cap radius W / 2 = 0.085 M
    stem       (0, 0) to (0.17 M, M), corner radius 0.085 M
    junction   (0.085 M, 0.5 M)   ON the stem's centre line, not its edge
    upper arm  junction to (0.915 M, 0.085 M)
    lower arm  junction to (0.915 M, 0.915 M)

Two properties of those numbers are load-bearing. The arms begin on the stem's
CENTRE LINE rather than its right edge, so stroke and stem merge into one
shape instead of meeting at a visible seam. And 0.915 is 1 - 0.085, i.e. every
endpoint is inset by exactly one cap radius, so each round cap lands flush
against the mark box and nothing overflows: 0.915 + 0.085 = 1.0 exactly.

⚠ THE FIRST ATTEMPT AT THIS MARK DID NOT WORK, and the reason is worth keeping.
It drew the arms as four columns of short axis-aligned rounded bars, on the
theory that Pillow draws rectangles more readily than anything else. It did not
read as a K. Consecutive columns sit a clear horizontal gap (about 0.107 M)
apart, so the bars never joined into a diagonal — they stayed six separate
dots and the icon read as a domino. Both toolchains turn out to draw a
round-capped line perfectly well (`stroke-linecap="round"` in SVG; in Pillow a
`line` plus a circle centred on each endpoint, because its `width` gives butt
ends and `joint="curve"` only affects joints between segments), so the letter
is drawn honestly. Rejected alternatives: tapered strokes, which need a path
Pillow cannot mirror; a microphone or a speech bubble, the two most generic
marks in this product category; and rasterising the SVG, which is the CI
dependency this template exists to avoid.

The mark itself also exists as hand-editable vector art in
`apps/web/public/icons/source.svg`, and a second time, at the tighter favicon
crop, in `apps/web/public/favicon.svg`. Those SVGs and the geometry constants
in this file describe the same mark and must be kept in step — this script
deliberately does NOT rasterise the SVG, because doing so would reintroduce
exactly the rendering dependency (rsvg / cairosvg / a headless browser) the
committed-PNG approach exists to avoid. `src/__tests__/pwa/brandMark.test.ts`
is the guard that the two vectors have not drifted apart from each other.

WHAT IT WRITES
=============================================================================
    public/icons/icon-192.png              192  manifest, purpose: any
    public/icons/icon-512.png              512  manifest, purpose: any
    public/icons/icon-maskable-192.png     192  manifest, purpose: maskable
    public/icons/icon-maskable-512.png     512  manifest, purpose: maskable
    public/icons/badge-96.png               96  notification badge, monochrome
    public/icons/apple-touch-icon-180.png  180  iOS Home Screen
    public/favicon.ico                   16/32/48 frames

`public/favicon.svg` and `public/icons/source.svg` are hand-written vector and
are NOT touched by this script.

Running it is idempotent: same inputs, byte-comparable outputs, every file
rewritten from scratch.

THREE PLATFORM RULES THIS ENCODES (get one wrong and the icon looks broken
only on the platform that cares)
=============================================================================
1. MASKABLE icons are cropped by the launcher to a shape it chooses — circle,
   squircle, teardrop. So their background is FULL-BLEED with no rounding of
   our own, and all meaningful content stays inside the centred safe-zone
   circle of 80% diameter. A maskable icon that reuses the standard artwork
   gets its own rounded corners shaved off.
2. The Android notification BADGE is used as an ALPHA MASK. Every opaque pixel
   is repainted in the system's colour, so a blue square would render as a
   solid blob. It is therefore a transparent canvas with the mark in white.
3. The iOS touch icon must have NO alpha channel at all: iOS composites
   transparency against black, so transparent corners come out as black
   corners. It is written as RGB with the rounded-square corners filled with
   the background colour.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

# =============================================================================
# Paths
# =============================================================================
# Everything is resolved from THIS FILE's own location, never from the current
# working directory. The documented invocation is
# `python3 apps/web/scripts/generate-icons.py` from the repository root, but the
# script must write the same bytes to the same places when it is run from
# `apps/web/scripts/`, from a sibling checkout, or from anywhere else.
SCRIPT_DIR = Path(__file__).resolve().parent    # apps/web/scripts
WEB_DIR = SCRIPT_DIR.parent                     # apps/web
REPO_ROOT = WEB_DIR.parent.parent               # <repo root>
PUBLIC_DIR = WEB_DIR / "public"
ICONS_DIR = PUBLIC_DIR / "icons"
IDENTITY_MANIFEST = REPO_ROOT / "packages" / "shared" / "identity.json"

FAVICON_ICO_SIZES = (16, 32, 48)


# =============================================================================
# Brand constants
# =============================================================================
# SOURCE OF TRUTH: `packages/shared/identity.json` (`themeColor`,
# `backgroundColor`). That manifest is what `packages/shared/index.js` exports as
# `THEME_COLOR` / `BACKGROUND_COLOR`, and therefore what the application, the MUI
# theme and the web app manifest all read at runtime.
#
# These values are READ from it rather than copied into it, and that is the whole
# point: this script paints them into committed PNGs, so a rebrand that edited
# one place and forgot the other used to leave every generated icon on the old
# colour with nothing to catch it. JSON is the one format both a CommonJS module
# and a Python script can read — a Python script cannot import
# `packages/shared/index.js` — so the manifest, not either consumer, holds the
# fact. To rebrand: edit `identity.json` (or run `node scripts/rename.mjs`), then
# re-run this script to regenerate the rasters.


def load_identity() -> dict:
    """Parse `packages/shared/identity.json`, or exit with an actionable error."""
    try:
        with IDENTITY_MANIFEST.open(encoding="utf-8") as handle:
            identity = json.load(handle)
    except FileNotFoundError:
        raise SystemExit(
            f"generate-icons: brand manifest not found at {IDENTITY_MANIFEST}\n"
            "  It is the source of truth for the icon colours. Run this script "
            "from a complete\n"
            "  checkout of the repository, or restore "
            "`packages/shared/identity.json`."
        ) from None
    except json.JSONDecodeError as error:
        raise SystemExit(
            f"generate-icons: {IDENTITY_MANIFEST} is not valid JSON\n"
            f"  {error}\n"
            "  Fix the manifest, then re-run this script."
        ) from None

    if not isinstance(identity, dict):
        raise SystemExit(
            f"generate-icons: {IDENTITY_MANIFEST} must contain a JSON object, "
            f"got {type(identity).__name__}."
        )

    return identity


def identity_color(identity: dict, key: str) -> str:
    """Read one colour from the manifest, or exit saying exactly which is wrong."""
    value = identity.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(
            f"generate-icons: `{key}` is missing (or is not a colour string) in "
            f"{IDENTITY_MANIFEST}\n"
            f'  Add it as a 6-digit hex literal, e.g. "{key}": "#1976d2", then '
            "re-run this script."
        )
    return value


_IDENTITY = load_identity()

BRAND_COLOR = identity_color(_IDENTITY, "themeColor")
# Opaque fill for the iOS icon, which must have no alpha channel (see rule 3).
BACKGROUND_COLOR = identity_color(_IDENTITY, "backgroundColor")

# The mark is drawn in this colour on the brand-coloured plate. Not a manifest
# field: it is not an identity choice but a legibility one — the badge is an
# alpha mask (rule 2) and the mark must contrast with the plate at 16px.
FOREGROUND_COLOR = "#ffffff"

# =============================================================================
# Mark geometry — all fractions, so the mark is resolution independent
# =============================================================================
CORNER_RADIUS_RATIO = 0.22   # rounded-square plate radius, as a fraction of size

# THE MARK: a K monogram -- one vertical stem, and two diagonal arms meeting on
# the stem's centre line. Every value is a fraction of the MARK BOX's side, so
# the mark is resolution independent.
#
# WHY DIAGONALS AND NOT STACKED BARS. The first attempt drew the arms as four
# columns of short axis-aligned rounded bars, because Pillow draws rectangles
# more readily than anything else. It did not read as a K: consecutive columns
# sit a clear horizontal gap apart, so the bars stayed six separate dots and
# the shape read as a domino. A round-capped diagonal line is the smallest
# change that actually produces the letter, and it is still drawable in both
# toolchains -- SVG has `stroke-linecap="round"`, and Pillow needs a `line`
# plus a circle centred on each endpoint, because its `width` gives butt ends
# and `joint="curve"` only affects joints between segments.
STROKE_WIDTH_RATIO = 0.17    # stem width and arm stroke, as a fraction of the box
JUNCTION_Y_RATIO = 0.50      # where the arms meet the stem, down the box
ARM_END_RATIO = 0.915        # how far the arm endpoints reach across and down
# 0.915 is not arbitrary: it is 1 - STROKE_WIDTH_RATIO / 2, so an endpoint sits
# exactly one cap radius inside the box and every round cap lands flush against
# the edge rather than overflowing it (0.915 + 0.085 == 1.0).

# How much of the canvas the mark occupies, per icon family. `mark_ratio` is now
# the SIDE OF THE SQUARE MARK BOX (it used to be the width of the widest bar of
# the old three-bar stack) — the numbers are unchanged because the old stack was
# 0.86 of its width tall and this box is 1.00, so the mark reads at very nearly
# the same optical size and every family's padding is still right.
MARK_RATIO_STANDARD = 0.68   # rounded plate, corners are ours to shape
MARK_RATIO_MASKABLE = 0.50   # inside the 80%-diameter safe zone with room to spare
MARK_RATIO_BADGE = 0.70      # no plate, so the mark can breathe wider
MARK_RATIO_FAVICON = 0.80    # tab-sized: padding costs whole pixels, so spend fewer
# MASKABLE SAFE ZONE, RE-CHECKED FOR THE DIAGONAL MARK (rule 1 above). The safe
# zone is a centred circle of 80% DIAMETER, i.e. radius 0.40 x size, and what
# has to clear it is the mark's furthest DRAWN pixel from the box centre — not
# the box's own corner, which nothing is drawn in.
#
# Two candidates tie for furthest, by symmetry. The stem's rounded top-left
# corner is an arc of radius 0.085 about (0.085, 0.085); the point on it at 45
# degrees is (0.085 - 0.085/sqrt(2)) on both axes = 0.0249, which is
#     sqrt(2) x (0.5 - 0.0249) = 0.672 of the box from its centre.
# The upper arm's end cap is a circle of radius 0.085 about (0.915, 0.085),
# whose centre is sqrt(2) x 0.415 = 0.587 from the box centre; add the radius
# and it is 0.672 too. So the mark's reach is 0.672 M, not the box's 0.707.
#
# At MARK_RATIO_MASKABLE:
#     0.672 x 0.50 = 0.336 x size  <  0.40 x size
# 0.336 < 0.40, so the mark clears the safe circle with about 16% of the radius
# to spare. The ceiling is 0.40 / 0.672 = 0.595 — raising MARK_RATIO_MASKABLE
# past that would push the stem's top corner out of the safe zone, where a
# circular launcher mask would shave it off.

# Anti-aliasing. Pillow's drawing primitives are hard-edged, so everything is
# drawn at this multiple and downsampled with LANCZOS; that resample IS the
# anti-aliasing. 8x rather than 4x because the 16px favicon frame is where it
# shows: at 4x its bar edges land on visibly coarser alpha steps.
SUPERSAMPLE = 8


def draw_mark(draw: ImageDraw.ImageDraw, size: int, mark_ratio: float, fill: str) -> None:
    """Draw the K monogram centred on a `size`x`size` canvas.

    ⚠ `mark_ratio` IS THE SIDE OF THE SQUARE MARK BOX as a fraction of the
    canvas. It used to mean the width of the widest bar of the old three-bar
    mark, which is a different quantity -- a reader carrying the old meaning
    across will size every icon wrongly.
    """
    mark = size * mark_ratio
    left = (size - mark) / 2
    top = (size - mark) / 2

    stroke = mark * STROKE_WIDTH_RATIO
    radius = stroke / 2

    # The stem. A radius of half the width is the largest that is still a
    # rounded rectangle rather than a lozenge with a flat middle.
    draw.rounded_rectangle(
        (left, top, left + stroke, top + mark),
        radius=radius,
        fill=fill,
    )

    # The arms start on the stem's CENTRE LINE, not on its right edge, so they
    # merge into it instead of butting against it and leaving a seam.
    junction = (left + radius, top + mark * JUNCTION_Y_RATIO)
    end_x = left + mark * ARM_END_RATIO
    ends = (
        (end_x, top + mark * (1.0 - ARM_END_RATIO)),  # upper arm
        (end_x, top + mark * ARM_END_RATIO),          # lower arm
    )

    for end in ends:
        draw.line([junction, end], fill=fill, width=max(1, int(round(stroke))))
        # Pillow's line `width` gives BUTT ends, so the round caps SVG gets
        # from `stroke-linecap` have to be drawn here as circles. Without
        # these the arms end in flat diagonal chops and the mark stops
        # matching the two SVGs.
        for (cx, cy) in (junction, end):
            draw.ellipse(
                (cx - radius, cy - radius, cx + radius, cy + radius),
                fill=fill,
            )


def render_standard(size: int, mark_ratio: float = MARK_RATIO_STANDARD) -> Image.Image:
    """Rounded brand-coloured plate, transparent corners, mark on top. RGBA."""
    scale = size * SUPERSAMPLE
    image = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (0, 0, scale - 1, scale - 1),
        radius=scale * CORNER_RADIUS_RATIO,
        fill=BRAND_COLOR,
    )
    draw_mark(draw, scale, mark_ratio, FOREGROUND_COLOR)
    return image.resize((size, size), Image.LANCZOS)


def render_maskable(size: int) -> Image.Image:
    """Full-bleed plate (the launcher applies its own mask), small mark. RGB.

    No alpha channel: every pixel is opaque by construction, and an RGB file
    makes it impossible to reintroduce transparent corners by accident.
    """
    scale = size * SUPERSAMPLE
    image = Image.new("RGB", (scale, scale), BRAND_COLOR)
    draw = ImageDraw.Draw(image)
    draw_mark(draw, scale, MARK_RATIO_MASKABLE, FOREGROUND_COLOR)
    return image.resize((size, size), Image.LANCZOS)


def render_badge(size: int) -> Image.Image:
    """Transparent canvas, white mark. RGBA — Android reads ONLY the alpha."""
    scale = size * SUPERSAMPLE
    image = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw_mark(draw, scale, MARK_RATIO_BADGE, FOREGROUND_COLOR)
    return image.resize((size, size), Image.LANCZOS)


def render_apple_touch(size: int) -> Image.Image:
    """Rounded plate with the corners filled opaque. RGB — iOS renders alpha black."""
    standard = render_standard(size)
    canvas = Image.new("RGB", (size, size), BACKGROUND_COLOR)
    canvas.paste(standard, (0, 0), standard)
    return canvas


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)

    outputs: list[tuple[Path, Image.Image]] = [
        (ICONS_DIR / "icon-192.png", render_standard(192)),
        (ICONS_DIR / "icon-512.png", render_standard(512)),
        (ICONS_DIR / "icon-maskable-192.png", render_maskable(192)),
        (ICONS_DIR / "icon-maskable-512.png", render_maskable(512)),
        (ICONS_DIR / "badge-96.png", render_badge(96)),
        (ICONS_DIR / "apple-touch-icon-180.png", render_apple_touch(180)),
    ]

    for path, image in outputs:
        image.save(path, format="PNG", optimize=True)
        print(f"wrote {path.relative_to(WEB_DIR)}  {image.size[0]}x{image.size[1]}  {image.mode}")

    # The .ico carries three frames because the contexts that still read it
    # differ: 16px is the browser tab, 32px the bookmark bar and taskbar, 48px
    # a Windows desktop shortcut. Each frame is rendered and downsampled
    # independently rather than letting the ICO encoder shrink one big frame —
    # the 16px bars survive the difference visibly. They also use the tighter
    # favicon crop, which `public/favicon.svg` matches.
    frames = [render_standard(size, MARK_RATIO_FAVICON) for size in FAVICON_ICO_SIZES]
    ico_path = PUBLIC_DIR / "favicon.ico"
    frames[-1].save(
        ico_path,
        format="ICO",
        sizes=[(size, size) for size in FAVICON_ICO_SIZES],
        append_images=frames[:-1],
    )
    print(
        f"wrote {ico_path.relative_to(WEB_DIR)}  "
        f"{'/'.join(str(size) for size in FAVICON_ICO_SIZES)}px frames"
    )

    print("\nfavicon.svg and icons/source.svg are hand-written vector — not regenerated.")


if __name__ == "__main__":
    main()
