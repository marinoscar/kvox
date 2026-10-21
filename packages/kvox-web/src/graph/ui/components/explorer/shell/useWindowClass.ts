/**
 * `useWindowClass` — which of the Insight Canvas's three window classes the
 * window is in (GIC-08, #669; epic #661).
 *
 * | Class      | Width      | Typical device                                   |
 * |------------|------------|--------------------------------------------------|
 * | `compact`  | under 600  | phone                                            |
 * | `medium`   | 600 – 1199 | tablet portrait, a narrowed KVox Desktop window  |
 * | `expanded` | 1200 and up| tablet landscape, laptop, KVox Desktop           |
 *
 * 600 deliberately equals the platform's `sm` gate, so the explorer and the
 * app chrome flip together; 1200 is chosen so a tablet in landscape gets three
 * panes. This hook is the explorer's OWN read of the window: it never changes,
 * and is not one of, the five platform shell gates (`ShellLayout`,
 * `ShellBottomNav`, `<main>` padding, `SettingsHub`, `ShellAppBar`), which are
 * the package `@marinoscar/platform-web`'s. The shell lives inside the page's
 * `<main>`.
 */

import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';

/**
 * The explorer's window classes.
 *
 * @stability experimental
 */
export type WindowClass = 'compact' | 'medium' | 'expanded';

/** First width (px) of the `medium` class; equal to the platform `sm` boundary. */
export const WINDOW_CLASS_MEDIUM_MIN = 600;
/** First width (px) of the `expanded` class. */
export const WINDOW_CLASS_EXPANDED_MIN = 1200;

/**
 * The window class of a width in CSS pixels. Pure; the hook below is the same
 * rule against live media queries.
 *
 * @stability experimental
 */
export function windowClassForWidth(width: number): WindowClass {
  if (width >= WINDOW_CLASS_EXPANDED_MIN) return 'expanded';
  if (width >= WINDOW_CLASS_MEDIUM_MIN) return 'medium';
  return 'compact';
}

/**
 * The current window class, re-read on every resize and rotation.
 *
 * @stability experimental
 */
export function useWindowClass(): WindowClass {
  const theme = useTheme();
  const expanded = useMediaQuery(theme.breakpoints.up(WINDOW_CLASS_EXPANDED_MIN));
  const medium = useMediaQuery(theme.breakpoints.up(WINDOW_CLASS_MEDIUM_MIN));
  if (expanded) return 'expanded';
  return medium ? 'medium' : 'compact';
}
