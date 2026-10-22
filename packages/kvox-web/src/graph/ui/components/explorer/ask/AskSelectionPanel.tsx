/**
 * The explorer's "Ask about this selection" surface (GIC-17, #678).
 *
 * It opens the host's Ask slot (the entity page's `AskPanel`, the same component the inspector's
 * Ask tab uses) pre-scoped with the selected entities and, for an edge, its evidence. The
 * explorer takes no dependency on the ask slice: the panel is a prop. Without the slot there is
 * no way to ask and the buttons are not drawn.
 *
 * On a phone the panel is the host's full-height sheet; closing it returns to the canvas with the
 * selection kept (the selection is page state this component never touches).
 */

import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import { useState, type ComponentType } from 'react';

import type { GraphEntityAskPanelProps } from '../../../pages/GraphEntityPage.js';
import type { AskSelectionScope } from './askScope.js';

/**
 * Props of {@link AskSelectionPanel}.
 *
 * @stability experimental
 */
export interface AskSelectionPanelProps {
  /** The host's Ask panel. */
  AskPanel: ComponentType<GraphEntityAskPanelProps>;
  /** What to ask about; `null` keeps the panel closed. */
  scope: AskSelectionScope | null;
  /** The user closed the panel. */
  onClose: () => void;
}

/**
 * Renders the host's Ask panel for a selection and keeps its conversation while it is open.
 *
 * @stability experimental
 */
export function AskSelectionPanel({ AskPanel, scope, onClose }: AskSelectionPanelProps) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  // The panel's last scope is kept while it closes, so the exit animation still has a subject.
  const [last, setLast] = useState<AskSelectionScope | null>(scope);
  if (scope && scope !== last) {
    setLast(scope);
    setConversationId(null);
  }
  const shown = scope ?? last;
  if (!shown) return null;
  return (
    <AskPanel
      entityId={shown.primaryId}
      entityLabel={shown.label}
      entityType={shown.primaryType}
      open={scope !== null}
      onClose={onClose}
      conversationId={conversationId}
      onConversationChange={setConversationId}
      scope={{ entityIds: shown.entityIds, evidenceIds: shown.evidenceIds }}
    />
  );
}

/**
 * Props of {@link AskSelectionButton}.
 *
 * @stability experimental
 */
export interface AskSelectionButtonProps {
  /** Starts the ask. */
  onClick: () => void;
  /** The evidence of an edge is being fetched, or the selection holds no entity. */
  disabled?: boolean;
  /** A coarse pointer makes the button 44px. */
  touch: boolean;
  /** What the button says; defaults to "Ask about this selection". */
  label?: string;
}

/**
 * The "Ask about this selection" button of the Selection view and the edge overview.
 *
 * @stability experimental
 */
export function AskSelectionButton({ onClick, disabled, touch, label = 'Ask about this selection' }: AskSelectionButtonProps) {
  return (
    <Button
      size="small"
      variant="outlined"
      startIcon={<QuestionAnswerOutlinedIcon />}
      onClick={onClick}
      disabled={disabled}
      sx={{ minHeight: touch ? 44 : undefined }}
    >
      {label}
    </Button>
  );
}

/**
 * The context-menu row that asks about the node (or the marked nodes).
 *
 * @stability experimental
 */
export function AskSelectionMenuItem({ onClick, label = 'Ask about this…' }: { onClick: () => void; label?: string }) {
  return (
    <MenuItem onClick={onClick}>
      <ListItemText>{label}</ListItemText>
    </MenuItem>
  );
}
