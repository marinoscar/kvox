/**
 * `EntityEditDialog` — the manual entity edit (#355, spec §8's second named
 * exception to "nothing enters the graph except through a reviewed proposal").
 *
 * The attribute form is `SchemaForm` over the entity's TYPE from the effective
 * schema (`useGraphOntology`), never a per-type component (§13). Label and
 * aliases are edited here too; the TYPE is not — #355 refuses it, because a
 * type changes only through a proposal.
 *
 * The request is a DIFF, #355's merge contract: `label` only when changed, a
 * `props` key only when changed (`null` clears it), `addAliases`,
 * `removeAliasIds`. Errors are shown inline — a 400's `details.issues` land on
 * the field they name; anything else (a 409, a 422) is an Alert above the form.
 *
 * Full-screen on a phone: one page-level `down('sm')` read, not a sixth gate.
 */

import CloseIcon from '@mui/icons-material/Close';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useId, useMemo, useState } from 'react';

import { ApiError } from '../../services/api';
import { updateGraphEntity } from '../../services/graph';
import type { GraphEntityDetail, GraphEntityPatch, GraphOntology } from '../../services/graph';
import { SchemaForm } from './schema/SchemaForm';

export interface EntityEditDialogProps {
  open: boolean;
  entity: GraphEntityDetail;
  ontology: GraphOntology | null;
  onClose: () => void;
  onSaved: () => void;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Build #355's diff body. Exported for its own test. */
export function buildEntityPatch(
  entity: GraphEntityDetail,
  draft: { label: string; props: Record<string, unknown>; addAliases: string[]; removeAliasIds: string[] },
): GraphEntityPatch {
  const patch: GraphEntityPatch = {};
  const label = draft.label.trim();
  if (label && label !== entity.label) patch.label = label;

  const props: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(entity.props), ...Object.keys(draft.props)]);
  for (const key of keys) {
    const next = draft.props[key];
    if (!sameValue(entity.props[key], next)) {
      props[key] = next === undefined || next === '' ? null : next;
    }
  }
  if (Object.keys(props).length > 0) patch.props = props;

  const adds = draft.addAliases.map((alias) => alias.trim()).filter(Boolean);
  if (adds.length > 0) patch.addAliases = adds;
  if (draft.removeAliasIds.length > 0) patch.removeAliasIds = draft.removeAliasIds;
  return patch;
}

/** `details.issues[].path` → `{ key: message }`, first path segment. */
export function issuesToFieldErrors(details: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  const issues = (details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return errors;
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    const key = (Array.isArray(path) ? String(path[0] ?? '') : String(path ?? '')).split('.')[0];
    if (key && typeof message === 'string' && !(key in errors)) errors[key] = message;
  }
  return errors;
}

export function EntityEditDialog({ open, entity, ontology, onClose, onSaved }: EntityEditDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const titleId = useId();

  const [label, setLabel] = useState(entity.label);
  const [props, setProps] = useState<Record<string, unknown>>(entity.props);
  const [newAlias, setNewAlias] = useState('');
  const [addAliases, setAddAliases] = useState<string[]>([]);
  const [removeAliasIds, setRemoveAliasIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Every opening starts from the entity as it is now.
  useEffect(() => {
    if (!open) return;
    setLabel(entity.label);
    setProps(entity.props);
    setNewAlias('');
    setAddAliases([]);
    setRemoveAliasIds([]);
    setError(null);
    setFieldErrors({});
  }, [entity, open]);

  const attributes = useMemo(
    () => ontology?.entityTypes.find((type) => type.key === entity.type)?.attributes ?? [],
    [entity.type, ontology],
  );

  const addAlias = () => {
    const alias = newAlias.trim();
    if (!alias) return;
    if (!addAliases.includes(alias)) setAddAliases([...addAliases, alias]);
    setNewAlias('');
  };

  const save = async () => {
    const patch = buildEntityPatch(entity, { label, props, addAliases, removeAliasIds });
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      await updateGraphEntity(entity.id, patch);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(issuesToFieldErrors(err.details));
        setError(err.message || 'Could not save these changes');
      } else {
        setError('Could not save these changes');
      }
    } finally {
      setSaving(false);
    }
  };

  const keptAliases = entity.aliases.filter((alias) => !removeAliasIds.includes(alias.id));

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId} sx={{ pr: 6 }}>
        Edit {entity.label}
        <IconButton
          aria-label="Close"
          onClick={onClose}
          disabled={saving}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Name"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            helperText="The old name is kept as an alias."
            required
            fullWidth
            disabled={saving}
          />

          <Box>
            <Typography variant="subtitle2" component="h3" gutterBottom>
              Also known as
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
              {keptAliases.map((alias) => (
                <Chip
                  key={alias.id}
                  label={alias.alias}
                  onDelete={saving ? undefined : () => setRemoveAliasIds([...removeAliasIds, alias.id])}
                />
              ))}
              {addAliases.map((alias) => (
                <Chip
                  key={`new-${alias}`}
                  label={alias}
                  color="primary"
                  variant="outlined"
                  onDelete={saving ? undefined : () => setAddAliases(addAliases.filter((a) => a !== alias))}
                />
              ))}
              {keptAliases.length === 0 && addAliases.length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  No other names.
                </Typography>
              )}
            </Box>
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                label="Add another name"
                value={newAlias}
                onChange={(event) => setNewAlias(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addAlias();
                  }
                }}
                disabled={saving}
                sx={{ flexGrow: 1 }}
              />
              <Button onClick={addAlias} disabled={saving || !newAlias.trim()}>
                Add
              </Button>
            </Stack>
          </Box>

          <SchemaForm
            attributes={attributes}
            values={props}
            onChange={(key, value) => setProps((current) => ({ ...current, [key]: value }))}
            errors={fieldErrors}
            disabled={saving}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={saving || !label.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EntityEditDialog;
