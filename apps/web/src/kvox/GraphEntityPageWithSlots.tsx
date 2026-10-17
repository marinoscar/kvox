import { AskEntityButtonSlot, AskEntityPanelSlot } from '@marinoscar/kvox-web/ask/ui';
import { GraphEntityPage } from '@marinoscar/kvox-web/graph/ui';
import type { GraphEntityPageSlots } from '@marinoscar/kvox-web/graph/ui';

/**
 * The Ask action and panel of the entity page: the ask slice's own slot
 * components. They draw nothing unless the viewer holds `graph:read` and
 * connected knowledge is on, and the page keeps the `?ask=` parameter.
 */
const slots: GraphEntityPageSlots = {
  AskButton: AskEntityButtonSlot,
  AskPanel: AskEntityPanelSlot,
};

/**
 * `/graph/entities/:id`: the packaged entity page with the ask slice's Ask action
 * and panel. Issues #503 and #504, epic #498.
 */
export function GraphEntityPageWithSlots() {
  return <GraphEntityPage slots={slots} />;
}
