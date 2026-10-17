import { GraphEntityPage } from '@marinoscar/kvox-web/graph/ui';

import { appGraphEntityPageSlots } from './graphEntityAskSlots';

/**
 * `/graph/entities/:id`: the packaged entity page with this app's Ask action and
 * panel. Issue #503, epic #498.
 */
export function GraphEntityPageWithSlots() {
  return <GraphEntityPage slots={appGraphEntityPageSlots} />;
}
