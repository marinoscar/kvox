/**
 * `useReducedMotion` — `prefers-reduced-motion: reduce` (GIC-08, #669). With
 * it on, the bottom sheet has no spring animation and the layout has no tween.
 */

import useMediaQuery from '@mui/material/useMediaQuery';

/**
 * `true` when the user asked the system for less motion.
 *
 * @stability experimental
 */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
