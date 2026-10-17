/**
 * `EntityRelationDialog` — the manual relation edit (#586, part of spec §8's
 * manual-edit exception): set a Person's manager (`REPORTS_TO` → Person),
 * employer (`WORKS_FOR` → Organization) or a role (`HAS_ROLE` →
 * Organization, with a title and an optional business unit).
 *
 * The target is picked from the caller's own graph (`EntitySearchField`,
 * filtered to the type the relation allows). "Since" is optional — the API
 * defaults it to today — and a still-open edge of the same type is closed at
 * that date by the server, exactly as committing a proposal closes it. The
 * relation is cited "Set by hand".
 *
 * Accessible names (a host's end-to-end test drives them): the dialog is
 * titled with the action ("Set manager", "Set employer", "Add role"); the
 * target is a combobox named "Manager", "Employer" or "Organization"; a role
 * adds the text boxes "Title" and "Business unit"; "Since" is a date box;
 * the buttons are "Cancel" and "Save".
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import { useEffect, useId, useState } from 'react';

import type { GraphEntitySearchResult, ManualRelationType, SetEntityRelationResult } from '../../headless/clients/graph.js';
import { useEntityRelationEdits } from '../../headless/hooks/useEntityRelationEdits.js';
import { EntitySearchField } from './schema/EntitySearchField.js';

/**
 * How one manual relation edit is named on screen.
 *
 * @stability experimental
 */
export interface EntityRelationEditCopy {
  /** The button and dialog title: "Set manager", "Set employer", "Add role". */
  action: string;
  /** The target combobox's label: "Manager", "Employer", "Organization". */
  target: string;
  /** The entity types the target may be. */
  targetTypes: readonly string[];
}

/**
 * What each manual relation edit is called, and what it may point at.
 *
 * @stability experimental
 */
export const ENTITY_RELATION_EDITS: Record<ManualRelationType, EntityRelationEditCopy> = {
  REPORTS_TO: { action: 'Set manager', target: 'Manager', targetTypes: ['Person'] },
  WORKS_FOR: { action: 'Set employer', target: 'Employer', targetTypes: ['Organization'] },
  HAS_ROLE: { action: 'Add role', target: 'Organization', targetTypes: ['Organization'] },
};

/**
 * The props of {@link EntityRelationDialog}.
 *
 * @stability experimental
 */
export interface EntityRelationDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The Person the relation starts at. */
  entityId: string;
  /** Which relation to set. */
  type: ManualRelationType;
  /** Closes without saving. */
  onClose: () => void;
  /** Called with what the server wrote, once it is saved. */
  onSaved: (result: SetEntityRelationResult) => void;
}

/**
 * Set a manager, an employer or a role by hand.
 *
 * @param props - See {@link EntityRelationDialogProps}.
 * @returns The dialog.
 *
 * @stability experimental
 */
export function EntityRelationDialog({ open, entityId, type, onClose, onSaved }: EntityRelationDialogProps) {
  const copy = ENTITY_RELATION_EDITS[type];
  const titleId = useId();
  const { setRelation, isSaving, error, clearError } = useEntityRelationEdits(entityId);
  const [target, setTarget] = useState<GraphEntitySearchResult | null>(null);
  const [title, setTitle] = useState('');
  const [businessUnit, setBusinessUnit] = useState('');
  const [since, setSince] = useState('');

  useEffect(() => {
    if (!open) return;
    setTarget(null);
    setTitle('');
    setBusinessUnit('');
    setSince('');
    clearError();
  }, [open, type, clearError]);

  const isRole = type === 'HAS_ROLE';
  const ready = target !== null && (!isRole || title.trim().length > 0);

  const save = async () => {
    if (!target || !ready) return;
    const result = await setRelation({
      type,
      toId: target.id,
      ...(isRole
        ? { props: { title: title.trim(), ...(businessUnit.trim() ? { businessUnit: businessUnit.trim() } : {}) } }
        : {}),
      ...(since ? { validFrom: since } : {}),
    });
    if (result) onSaved(result);
  };

  return (
    <Dialog open={open} onClose={isSaving ? undefined : onClose} aria-labelledby={titleId} fullWidth maxWidth="sm">
      <DialogTitle id={titleId}>{copy.action}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <EntitySearchField
            label={copy.target}
            types={copy.targetTypes}
            excludeIds={[entityId]}
            value={target}
            onChange={setTarget}
            disabled={isSaving}
            autoFocus
          />
          {isRole && (
            <>
              <TextField
                label="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                disabled={isSaving}
                slotProps={{ htmlInput: { maxLength: 200 } }}
              />
              <TextField
                label="Business unit"
                value={businessUnit}
                onChange={(event) => setBusinessUnit(event.target.value)}
                disabled={isSaving}
                helperText="Optional"
                slotProps={{ htmlInput: { maxLength: 200 } }}
              />
            </>
          )}
          <TextField
            label="Since"
            type="date"
            value={since}
            onChange={(event) => setSince(event.target.value)}
            disabled={isSaving}
            helperText="Optional. Leave empty for today; an earlier one of this kind ends on this date."
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isSaving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={!ready || isSaving}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
