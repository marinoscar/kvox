/**
 * What the web edition adds to the graph entity page (issue #503, epic #498).
 *
 * "Ask about this entity" belongs to the ask slice, which depends on the graph
 * slice, so the packaged `GraphEntityPage` takes it through slots. The action and
 * the panel are this app's `components/ask/EntityAskPanel` until issue 7.6 moves
 * Ask into the package. The page keeps the `?ask=` parameter, so a reload reopens
 * the same conversation; these wrappers only draw the two pieces.
 */

import type {
  GraphEntityAskButtonProps,
  GraphEntityAskPanelProps,
  GraphEntityPageSlots,
} from '@marinoscar/kvox-web/graph/ui';

import { EntityAskButton, EntityAskPanel } from '../components/ask/EntityAskPanel';
import { useAiTasksConfig } from '../hooks/useAiTasksConfig';

function AskButton({ entityLabel, onClick }: GraphEntityAskButtonProps) {
  return <EntityAskButton label={entityLabel} onClick={onClick} />;
}

function AskPanel({
  entityId,
  entityLabel,
  entityType,
  open,
  onClose,
  conversationId,
  onConversationChange,
}: GraphEntityAskPanelProps) {
  const { config } = useAiTasksConfig();
  return (
    <EntityAskPanel
      open={open}
      onClose={onClose}
      entity={{ id: entityId, label: entityLabel, type: entityType }}
      conversationId={conversationId}
      onConversationChange={onConversationChange}
      config={config}
    />
  );
}

/** The Ask action and panel of the entity page. */
export const appGraphEntityPageSlots: GraphEntityPageSlots = {
  AskButton,
  AskPanel,
};
