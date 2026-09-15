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
A K-WAVE MONOGRAM: the letter K whose stem is a single bar and whose arms are
the diverging envelope of an audio waveform. Four vertical rounded bars on a
square mark box of side M:

    column 0   the stem          one bar, full height M
    column 1   the junction      two bars of 0.22 M, centred +/- 0.11 M
    column 2   the spread        two bars of 0.22 M, centred +/- 0.24 M
    column 3   the mouth         two bars of 0.22 M, centred +/- 0.37 M

    bar width  0.17 M            corner radius = half the bar width
    pitch      (M - 0.17 M) / 3  so the outer columns touch the box edges
    extent     0.37 M + 0.11 M = 0.48 M from centre, inside the half-box

Column 1's pair meet exactly on the centre line, which is the junction that
makes the shape read as a K; columns 2 and 3 open outwards, which is what
makes it read as a waveform. Rounded rectangles are the ONLY primitive used,
on purpose — see the geometry block below for why a K with true diagonal
strokes is not drawable here, and why a microphone or a speech bubble was not
the answer either.

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
# The mark: a K-WAVE MONOGRAM. Four vertical rounded bars on a square mark box
# of side M. Column 0 is the K's stem, full height. Columns 1-3 are its arms:
# each is a PAIR of short bars sitting symmetrically above and below the box's
# vertical centre, the pair spreading further apart with every column, so the
# three pairs trace the diverging envelope of a waveform — the K's two arms and
# an audio waveform being, conveniently, the same drawing.
#
# WHY BARS AND NOT A REAL K
# A K drawn honestly has two DIAGONAL strokes, and Pillow's only primitives
# here are `rounded_rectangle` (axis-aligned) and `polygon` (hard-edged, no
# corner radius) — a rotated rounded stroke is not expressible without either a
# rasteriser or hand-composited circles, and this file exists precisely so that
# no image toolchain beyond Pillow is ever required (see the module docstring).
# Sampling the diagonal at three columns keeps the letter readable while
# staying inside the one primitive both this script and a plain SVG `<rect>`
# can draw identically. Rejected alternatives: a microphone and a speech
# bubble, both of which are the two most generic marks in this product
# category and say nothing about whose transcript it is; and rasterising
# `icons/source.svg`, which is the CI dependency this template refuses.
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
# MASKABLE SAFE ZONE, RE-CHECKED FOR A SQUARE MARK (rule 1 above). The safe
# zone is a centred circle of 80% DIAMETER, i.e. radius 0.40 x size. A square
# box is at its furthest from the centre at its CORNERS, not its edges, so the
# check is the half-diagonal, not the half-side:
#     0.50 x 0.50 x sqrt(2) = 0.354 x size  <  0.40 x size
# 0.354 < 0.40, so even the corners of the mark box clear the safe circle, and
# the drawn bars — whose own extremes are 0.48 of the box, not 0.50 — clear it
# by more. Raising MARK_RATIO_MASKABLE above 0.5657 would push the corners out.

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
