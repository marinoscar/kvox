/**
 * The inspector's Ask tab (GIC-11, #672): the host's own Ask panel for the
 * selected entity.
 *
 * `kvox-web/graph` takes NO dependency on the ask slice: the panel arrives as
 * the `AskPanel` slot component (the same type the entity page takes, which the
 * web edition fills with the ask slice's `AskEntityPanelSlot`). Without the slot
 * the tab does not exist; with it, this tab opens the host's panel for the
 * entity and keeps the conversation it switched to.
 */

import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import { useState, type ComponentType } from 'react';

import type { GraphEntityAskPanelProps } from '../../../pages/GraphEntityPage.js';

/**
 * Props of {@link AskTab}.
 *
 * @stability experimental
 */
export interface AskTabProps {
  /** The host's Ask panel. */
  AskPanel: ComponentType<GraphEntityAskPanelProps>;
  /** The selected entity's id. */
  entityId: string;
  /** Its label. */
  entityLabel: string;
  /** Its type key. */
  entityType: string;
  /** A coarse pointer. */
  touch: boolean;
}

/**
 * The Ask tab: a button that opens the host's Ask panel about the selected entity.
 *
 * @stability experimental
 */
export function AskTab({ AskPanel, entityId, entityLabel, entityType, touch }: AskTabProps) {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, alignItems: 'flex-start' }}>
      <Typography variant="body2" color="text.secondary">
        Ask a question about {entityLabel}. Answers cite your own notes and transcripts.
      </Typography>
      <Button variant="contained" onClick={() => setOpen(true)} sx={{ minHeight: touch ? 44 : undefined }}>
        Ask about {entityLabel}
      </Button>
      <AskPanel
        entityId={entityId}
        entityLabel={entityLabel}
        entityType={entityType}
        open={open}
        onClose={() => setOpen(false)}
        conversationId={conversationId}
        onConversationChange={setConversationId}
      />
    </Box>
  );
}
