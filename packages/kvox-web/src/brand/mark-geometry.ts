/**
 * The geometry of the KVox mark. It moved to `@marinoscar/kvox-contract/brand` so the
 * API's document exporters draw the same logo; this file re-exports it so
 * `BrandMark.tsx` and the brand tests keep their imports.
 */

export {
  MARK_ACCENT,
  MARK_ARMS,
  MARK_BARS,
  MARK_CANVAS,
  MARK_INK,
  MARK_PLATE_RADIUS,
  MARK_STEM,
  MARK_STROKE,
} from '@marinoscar/kvox-contract/brand';
export type { MarkLine, MarkRect } from '@marinoscar/kvox-contract/brand';
