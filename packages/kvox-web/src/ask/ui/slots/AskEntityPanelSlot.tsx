import type { ReactNode } from 'react';

import { useHasPermission, useKvoxHost } from '../../../core/headless/index.js';
import type { GraphEntityAskPanelProps } from '../../../graph/ui/index.js';
import { useAskAiConfig } from '../../headless/index.js';
import { EntityAskPanel } from '../components/EntityAskPanel.js';

/**
 * The Ask panel of the graph entity page: fills the `AskPanel` slot of
 * `GraphEntityPageSlots`. Reads the viewer's AI availability (models, the
 * `graph.agent` default, whether a key is saved) itself.
 *
 * @remarks
 * Draws nothing unless the viewer holds `graph:read` and connected knowledge is
 * on (`graphEnabled` exactly `true`), so a host wires it unconditionally. The
 * page owns the `?ask=` search parameter; this component only draws the panel.
 *
 * @param props - The entity, the open state and the conversation the page owns.
 * @returns The panel, or `null` when Ask is not available to the viewer.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function AskEntityPanelSlot(props: GraphEntityAskPanelProps): ReactNode {
  const graphEnabled = useKvoxHost().features().graphEnabled === true;
  const canRead = useHasPermission('graph:read');
  if (!graphEnabled || !canRead) return null;
  return <AskEntityPanelContent {...props} />;
}

/** Split out so the configuration is read only while the slot renders. */
function AskEntityPanelContent({
  entityId,
  entityLabel,
  entityType,
  open,
  onClose,
  conversationId,
  onConversationChange,
  scope,
}: GraphEntityAskPanelProps): ReactNode {
  const { config } = useAskAiConfig();
  return (
    <EntityAskPanel
      open={open}
      onClose={onClose}
      entity={{ id: entityId, label: entityLabel, type: entityType }}
      scope={scope}
      conversationId={conversationId}
      onConversationChange={onConversationChange}
      config={config}
    />
  );
}
