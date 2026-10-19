import type { ReactElement } from 'react';
import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { KVOX_BRAND } from './identity.js';
import {
  MARK_ACCENT,
  MARK_ARMS,
  MARK_BARS,
  MARK_CANVAS,
  MARK_INK,
  MARK_PLATE_RADIUS,
  MARK_STEM,
  MARK_STROKE,
} from './mark-geometry.js';

/**
 * Props of {@link BrandMark}.
 *
 * @stability experimental
 */
export interface BrandMarkProps {
  /** Side of the square mark, in CSS pixels. Default 28. */
  size?: number;
  /**
   * An accessible name. Leave it out when the product name is rendered next to
   * the mark (the mark is then decorative and hidden from assistive technology);
   * set it when the mark stands alone.
   */
  title?: string;
  /** Extra MUI `sx`, merged after the mark's own. */
  sx?: SxProps<Theme>;
}

/**
 * The KVox brand mark: a white K and five amber waveform bars on the brand plate,
 * drawn as inline SVG.
 *
 * It needs no network request and no `public/` folder, which is why a host
 * without a web server (KVox Desktop) can show the same mark as the web app. The
 * geometry is `mark-geometry.ts` (the favicon crop of `assets/favicon.svg`); the
 * plate colour is `KVOX_BRAND.themeColor`.
 *
 * The plate stays brand-coloured in both themes. It is the brand's own ground,
 * the same plate as the launcher icon and the tab favicon, so it does not follow
 * `background.paper`.
 *
 * `borderRadius` is `size * 0.22`, the plate's own corner ratio, set on the
 * element so a box painted behind it is clipped to the same corner. MUI's `sx`
 * multiplies a number by `theme.shape.borderRadius`, exactly as the web app's
 * former `<img>` mark did, so the clip is as it has always been.
 *
 * @example
 * ```tsx
 * <BrandMark size={56} />
 * ```
 *
 * @stability experimental
 */
export function BrandMark({ size = 28, title, sx }: BrandMarkProps): ReactElement {
  const labelled = title !== undefined && title !== '';
  const own = { borderRadius: size * 0.22 };
  return (
    <Box
      component="svg"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${MARK_CANVAS} ${MARK_CANVAS}`}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      data-testid="kvox-brand-mark"
      sx={[own, ...(Array.isArray(sx) ? sx : sx === undefined ? [] : [sx])]}
    >
      {labelled ? <title>{title}</title> : null}
      <rect width={MARK_CANVAS} height={MARK_CANVAS} rx={MARK_PLATE_RADIUS} fill={KVOX_BRAND.themeColor} />
      <g fill={MARK_INK}>
        <rect
          x={MARK_STEM.x}
          y={MARK_STEM.y}
          width={MARK_STEM.width}
          height={MARK_STEM.height}
          rx={MARK_STEM.rx}
        />
      </g>
      <g stroke={MARK_INK} strokeWidth={MARK_STROKE} strokeLinecap="round" fill="none">
        {MARK_ARMS.map((arm) => (
          <line key={arm.y2} x1={arm.x1} y1={arm.y1} x2={arm.x2} y2={arm.y2} />
        ))}
      </g>
      <g fill={MARK_ACCENT}>
        {MARK_BARS.map((bar) => (
          <rect key={bar.x} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={bar.rx} />
        ))}
      </g>
    </Box>
  );
}
