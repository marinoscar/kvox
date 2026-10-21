import useMediaQuery from '@mui/material/useMediaQuery';

/**
 * Whether the person asked the system for reduced motion. Under it the layout
 * shows only its final picture, in one jump, and nothing is tweened.
 *
 * @returns `true` under `prefers-reduced-motion: reduce`.
 */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
