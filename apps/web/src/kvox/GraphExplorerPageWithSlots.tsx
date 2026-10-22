import { AskEntityPanelSlot } from '@marinoscar/kvox-web/ask/ui';
import { GraphExplorerPage } from '@marinoscar/kvox-web/graph/ui';
import type { GraphExplorerPageSlots } from '@marinoscar/kvox-web/graph/ui';

/**
 * The Ask tab of the explorer's inspector: the ask slice's own panel slot, the
 * same component the entity page takes. It draws nothing unless the viewer holds
 * `graph:read` and connected knowledge is on, and the explorer hides the tab while
 * connected knowledge is off. Issue GIC-11 (#672), epic #661.
 */
const slots: GraphExplorerPageSlots = {
  AskPanel: AskEntityPanelSlot,
};

/**
 * `/graph/explore`: the packaged explorer with the ask slice's Ask panel in the inspector's Ask tab.
 */
export function GraphExplorerPageWithSlots() {
  return <GraphExplorerPage slots={slots} />;
}
