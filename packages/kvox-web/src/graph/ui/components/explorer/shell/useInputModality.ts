/**
 * `useInputModality` — whether the primary input is touch or a pointer
 * (GIC-08, #669), read from `(pointer: coarse)` and `(hover: none)`.
 *
 * Deliberately independent of the window width, so a touch laptop or an iPad
 * with a trackpad behaves correctly. Never sniffs the platform or the user
 * agent.
 */

import useMediaQuery from '@mui/material/useMediaQuery';

/**
 * How the user mainly points: fingers (`touch`) or a mouse or trackpad (`pointer`).
 *
 * @stability experimental
 */
export type InputModality = 'touch' | 'pointer';

/** The media query of a coarse primary pointer. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';
/** The media query of a primary input that cannot hover. */
export const NO_HOVER_QUERY = '(hover: none)';

/**
 * `touch` when the primary pointer is coarse or cannot hover, else `pointer`.
 *
 * @stability experimental
 */
export function useInputModality(): InputModality {
  const coarse = useMediaQuery(COARSE_POINTER_QUERY);
  const noHover = useMediaQuery(NO_HOVER_QUERY);
  return coarse || noHover ? 'touch' : 'pointer';
}
