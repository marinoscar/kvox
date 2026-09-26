/**
 * "Your attributes" — browse and define the user's own graph attributes
 * (#369, docs/specs/ontology.md §17.3).
 *
 * A type FILTER, never entity-type tabs (CLAUDE.md Settings UI rule 2: tabs
 * are for parallel content; one type's attributes are not a parallel view of
 * another's). For each type shown, its built-in attributes are listed
 * read-only first — so a user sees what already exists before adding a
 * duplicate — and their own definitions below, with Edit / Deprecate.
 *
 * DEPRECATE, NEVER DELETE: values are keyed by definition id, so a deletion
 * would orphan every value stored under it. `DELETE` on #355's route
 * deprecates; a deprecated row stays listed, muted, and can be restored.
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';

import { useGraphAttributeDefs } from '../../../hooks/useGraphAttributeDefs';
import { ATTRIBUTE_KIND_LABELS, SENSITIVITY_LABELS } from '../../../services/graph';
import type { AttributeDef, GraphOntology } from '../../../services/graph';
import { AttributeDefDialog, type AttributeEntityTypeOption } from './AttributeDefDialog';

const ALL_TYPES = '__all__';

interface AttributeDefsBrowserProps {
  /** The caller's effective ontology; `null` while it loads or if it failed. */
  ontology: GraphOntology | null;
}

export function AttributeDefsBrowser({ ontology }: AttributeDefsBrowserProps) {
  const { defs, isLoading, loadError, refresh, create, update, deprecate } =
    useGraphAttributeDefs();
  const [filter, setFilter] = useState(ALL_TYPES);
  const [dialog, setDialog] = useState<{ open: boolean; def: AttributeDef | null }>({
    open: false,
    def: null,
  });
  const [confirming, setConfirming] = useState<AttributeDef | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Entity types a user attribute can sit on: `storage: 'entity'`, live. */
  const entityTypes: AttributeEntityTypeOption[] = useMemo(
    () =>
      (ontology?.entityTypes ?? [])
        .filter((t) => t.storage === 'entity' && !t.deprecated)
        .map((t) => ({ key: t.key, label: t.label, sensitivityDefault: t.sensitivityDefault })),
    [ontology],
  );

  /** Every type to list: the schema's, plus any a definition names that it no longer has. */
  const listedTypes = useMemo(() => {
    const keys = entityTypes.map((t) => t.key);
    for (const def of defs) if (!keys.includes(def.entityType)) keys.push(def.entityType);
    return keys;
  }, [entityTypes, defs]);

  const typeLabel = (key: string) =>
    ontology?.entityTypes.find((t) => t.key === key)?.label ?? key;

  const shownTypes = filter === ALL_TYPES ? listedTypes : listedTypes.filter((k) => k === filter);

  async function handleDeprecate(def: AttributeDef) {
    setConfirming(null);
    setActionError(null);
    setBusyId(def.id);
    try {
      await deprecate(def.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not deprecate the attribute.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestore(def: AttributeDef) {
    setActionError(null);
    setBusyId(def.id);
    try {
      await update(def.id, { deprecated: false });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not restore the attribute.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{
          mb: 2,
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between',
        }}
      >
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="attribute-type-filter-label">Entity type</InputLabel>
          <Select
            labelId="attribute-type-filter-label"
            label="Entity type"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <MenuItem value={ALL_TYPES}>All types</MenuItem>
            {listedTypes.map((key) => (
              <MenuItem key={key} value={key}>
                {typeLabel(key)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          disabled={entityTypes.length === 0}
          onClick={() => setDialog({ open: true, def: null })}
        >
          Add attribute
        </Button>
      </Stack>

      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {loadError ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Alert>
      ) : isLoading ? (
        <Stack spacing={1} aria-label="Loading your attributes" role="progressbar">
          <Skeleton variant="rounded" height={48} />
          <Skeleton variant="rounded" height={48} />
          <Skeleton variant="rounded" height={48} />
        </Stack>
      ) : (
        <>
          {defs.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              No attributes of your own yet.
            </Typography>
          )}
          <Stack spacing={3}>
            {shownTypes.map((typeKey) => {
              const type = ontology?.entityTypes.find((t) => t.key === typeKey);
              const builtins = (type?.attributes ?? []).filter((a) => a.source !== 'user');
              const own = defs
                .filter((d) => d.entityType === typeKey)
                .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
              if (filter === ALL_TYPES && own.length === 0 && builtins.length === 0) return null;

              return (
                <Box key={typeKey} component="section" aria-label={typeLabel(typeKey)}>
                  <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
                    {typeLabel(typeKey)}
                  </Typography>

                  {builtins.length > 0 && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary" component="p">
                        Built in (read-only)
                      </Typography>
                      <Box
                        component="ul"
                        aria-label={`Built-in ${typeLabel(typeKey)} attributes`}
                        sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, listStyle: 'none', p: 0, m: 0, mt: 0.5 }}
                      >
                        {builtins.map((attribute) => (
                          <li key={attribute.key}>
                            <Chip size="small" variant="outlined" label={attribute.label} />
                          </li>
                        ))}
                      </Box>
                    </Box>
                  )}

                  {own.length > 0 ? (
                    <List dense aria-label={`Your ${typeLabel(typeKey)} attributes`}>
                      {own.map((def) => {
                        const deprecated = def.deprecatedAt !== null;
                        return (
                          <ListItem
                            key={def.id}
                            divider
                            sx={{ opacity: deprecated ? 0.6 : 1, pr: 12, flexWrap: 'wrap' }}
                            secondaryAction={
                              <Stack direction="row" spacing={0.5}>
                                <Tooltip title="Edit">
                                  <IconButton
                                    aria-label={`Edit ${def.label}`}
                                    onClick={() => setDialog({ open: true, def })}
                                    disabled={busyId === def.id}
                                  >
                                    <EditOutlinedIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                                {deprecated ? (
                                  <Tooltip title="Restore">
                                    <IconButton
                                      aria-label={`Restore ${def.label}`}
                                      onClick={() => void handleRestore(def)}
                                      disabled={busyId === def.id}
                                    >
                                      <UnarchiveOutlinedIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>
                                ) : (
                                  <Tooltip title="Deprecate">
                                    <IconButton
                                      aria-label={`Deprecate ${def.label}`}
                                      onClick={() => setConfirming(def)}
                                      disabled={busyId === def.id}
                                    >
                                      <ArchiveOutlinedIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>
                                )}
                              </Stack>
                            }
                          >
                            <ListItemText
                              primary={def.label}
                              slotProps={{ secondary: { component: 'div' } }}
                              secondary={
                                <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', rowGap: 0.5 }}>
                                  <Chip size="small" label={ATTRIBUTE_KIND_LABELS[def.kind] ?? def.kind} />
                                  {def.extractable && (
                                    <Chip size="small" color="primary" variant="outlined" label="Extracted" />
                                  )}
                                  {def.sensitivity && (
                                    <Chip
                                      size="small"
                                      variant="outlined"
                                      label={SENSITIVITY_LABELS[def.sensitivity]}
                                    />
                                  )}
                                  {deprecated && <Chip size="small" label="Deprecated" />}
                                </Stack>
                              }
                            />
                          </ListItem>
                        );
                      })}
                    </List>
                  ) : (
                    filter !== ALL_TYPES && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                        No {typeLabel(typeKey)} attributes of your own yet.
                      </Typography>
                    )
                  )}
                </Box>
              );
            })}
          </Stack>
        </>
      )}

      <AttributeDefDialog
        open={dialog.open}
        def={dialog.def}
        entityTypes={entityTypes}
        defaultEntityType={filter === ALL_TYPES ? undefined : filter}
        onClose={() => setDialog({ open: false, def: null })}
        onCreate={create}
        onUpdate={update}
      />

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        aria-labelledby="deprecate-attribute-title"
      >
        <DialogTitle id="deprecate-attribute-title">
          Deprecate {confirming?.label ?? 'attribute'}?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            Hidden from new proposals and forms. Existing values are kept.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(null)}>Cancel</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => confirming && void handleDeprecate(confirming)}
          >
            Deprecate
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default AttributeDefsBrowser;
