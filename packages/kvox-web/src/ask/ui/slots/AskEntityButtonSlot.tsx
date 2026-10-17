import type { ReactNode } from 'react';

import { useHasPermission, useKvoxHost } from '../../../core/headless/index.js';
import type { GraphEntityAskButtonProps } from '../../../graph/ui/index.js';
import { EntityAskButton } from '../components/EntityAskPanel.js';

/**
 * The "Ask about this entity" action of the graph entity page: fills the
 * `AskButton` slot of `GraphEntityPageSlots`.
 *
 * @remarks
 * Draws nothing unless the viewer holds `graph:read`, the exact string every
 * `/api/ask/*` route enforces, and connected knowledge is on (`graphEnabled` is
 * exactly `true`; unknown reads as off), so a host wires it unconditionally.
 *
 * @param props - The entity's label and the click handler the page owns.
 * @returns The action, or `null` when Ask is not available to the viewer.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function AskEntityButtonSlot({ entityLabel, onClick }: GraphEntityAskButtonProps): ReactNode {
  const graphEnabled = useKvoxHost().features().graphEnabled === true;
  const canRead = useHasPermission('graph:read');
  if (!graphEnabled || !canRead) return null;
  return <EntityAskButton label={entityLabel} onClick={onClick} />;
}
