import type { ReactElement } from 'react';
import { Box } from '@mui/material';
import { BrandMark } from './BrandMark.js';
import { KVOX_BRAND } from './identity.js';

/**
 * Props of {@link BrandLockup}.
 *
 * @stability experimental
 */
export interface BrandLockupProps {
  /** Side of the mark in CSS pixels. Default 28, the web app bar's size. */
  size?: number;
  /** Draw the product name beside the mark. Default true. */
  showName?: boolean;
}

/**
 * The mark and the product name side by side, as the web app's bar shows them: an
 * inline flex row with an 8px gap, the name in the surrounding text style.
 *
 * It is a plain `span`, so a host wraps it in whatever link or typography it
 * uses for the bar title. With `showName` off it is the mark alone, still named
 * by the product name so that it is announced once.
 *
 * @example
 * ```tsx
 * <ShellAppBar brand={<BrandLockup />} ... />
 * ```
 *
 * @stability experimental
 */
export function BrandLockup({ size = 28, showName = true }: BrandLockupProps = {}): ReactElement {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <BrandMark size={size} title={showName ? undefined : KVOX_BRAND.productName} />
      {showName ? KVOX_BRAND.productName : null}
    </Box>
  );
}
