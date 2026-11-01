/**
 * `ExplorerMinimap` — the frame of the explorer's minimap (GIC-09, #670; G6, #775).
 *
 * The picture itself is G6's `minimap` plugin: the canvas draws a thumbnail of
 * the graph and the viewport rectangle into the element this component
 * renders, and dragging the rectangle pans the camera. The page passes the
 * element to `GraphCanvas` (`minimapContainer`), so the plugin stays inside the
 * lazily loaded canvas chunk.
 *
 * A POINTER AID, NOT A CONTROL FOR EVERYONE. It is `aria-hidden`: a keyboard or
 * screen-reader user keeps `0` (fit), the arrow keys between nodes, the command
 * palette and the list view. Whether it shows is `minimapVisible`'s rule
 * (never on a phone, on request on a tablet, above 150 nodes on a laptop).
 */

import Box from '@mui/material/Box';
import { alpha, useTheme } from '@mui/material/styles';

/** Width of the minimap in px. */
export const MINIMAP_WIDTH = 168;
/** Height of the minimap in px. */
export const MINIMAP_HEIGHT = 112;

/** Props of {@link ExplorerMinimap}. */
export interface ExplorerMinimapProps {
  /** Receives the element the canvas's minimap draws into (`null` on unmount). */
  onContainer: (element: HTMLDivElement | null) => void;
}

/** The minimap's frame: a themed, `aria-hidden` box the canvas fills. */
export function ExplorerMinimap({ onContainer }: ExplorerMinimapProps) {
  const theme = useTheme();
  return (
    <Box
      ref={onContainer}
      data-testid="explorer-minimap"
      aria-hidden="true"
      sx={{
        width: MINIMAP_WIDTH,
        height: MINIMAP_HEIGHT,
        borderRadius: 1,
        overflow: 'hidden',
        border: `1px solid ${theme.palette.divider}`,
        bgcolor: alpha(theme.palette.background.paper, 0.92),
        boxShadow: theme.shadows[2],
        // The plugin's own canvas fills the frame.
        '& canvas': { display: 'block' },
      }}
    />
  );
}
