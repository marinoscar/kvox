/**
 * `/graph/synonyms` — the caller's personal synonyms (#767; API
 * `GET/POST /api/graph/synonyms`, `PATCH/DELETE /api/graph/synonyms/:id`).
 *
 * WHY IT EXISTS. People and companies go by several names ("OAC", "Org Alpha
 * Consulting"). A synonym group tells KVox those names mean the same thing; the
 * server uses the groups to match mentions to entities, to propose possible
 * duplicates and in graph search.
 *
 * WHAT THE PAGE DECIDES: nothing. The server normalizes, de-duplicates and
 * validates the names and the entity type; the page collects them and renders
 * the API's refusal reasons as sentences.
 *
 * GATES. The route is `graph:read`. Add, edit and delete are drawn only for
 * `graph:write`, like the duplicates page's actions; the API enforces it.
 *
 * No breakpoint read: rows wrap and the dialog fits a phone through `sx` alone.
 */

import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { SYNONYM_MAX_TERMS, SYNONYM_MIN_TERMS } from '@marinoscar/kvox-contract/graph';

import { useHasPermission } from '../../../core/headless/index.js';
import type { GraphOntology, SynonymGroup, SynonymGroupInput } from '../../headless/clients/graph.js';
import { useGraphEffectiveOntology } from '../../headless/hooks/useGraphAttributeDefs.js';
import { SYNONYM_ERROR_COPY, useGraphSynonyms } from '../../headless/hooks/useGraphSynonyms.js';

const SKELETON_ROWS = 3;
/** The longest name the API accepts. */
const MAX_TERM_LENGTH = 120;

/**
 * The page's subtitle.
 *
 * @stability experimental
 */
export const SYNONYMS_SUBTITLE =
  'Names that mean the same thing, like OAC = Org Alpha Consulting. KVox uses them to match people, companies and topics, to find duplicates, and in graph search.';

/**
 * The words a group reads as: its names joined by " = ".
 *
 * @stability experimental
 */
export function synonymGroupText(terms: readonly string[]): string {
  return terms.join(' = ');
}

/**
 * The label of a group's entity type: the ontology's plural label, the raw key when unknown, "Any type" for `null`.
 *
 * @stability experimental
 */
export function synonymTypeLabel(entityType: string | null, ontology: GraphOntology | null): string {
  if (entityType === null) return 'Any type';
  return ontology?.entityTypes.find((type) => type.key === entityType)?.pluralLabel ?? entityType;
}

/** Splits typed or pasted text on commas into trimmed, non-empty names. */
function splitTerms(text: string): string[] {
  return text
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/** Adds names, skipping a repeat (case and spacing ignored) and stopping at the API's ceiling. */
function addTerms(current: readonly string[], incoming: readonly string[]): string[] {
  const next = [...current];
  const seen = new Set(current.map((term) => term.toLocaleLowerCase()));
  for (const term of incoming) {
    const key = term.toLocaleLowerCase();
    if (seen.has(key) || next.length >= SYNONYM_MAX_TERMS) continue;
    seen.add(key);
    next.push(term);
  }
  return next;
}

/** The local check before a request; the server still decides. */
function localTermsError(terms: readonly string[]): string | null {
  if (terms.some((term) => term.length > MAX_TERM_LENGTH)) return SYNONYM_ERROR_COPY.synonyms_invalid_term ?? null;
  if (terms.length < SYNONYM_MIN_TERMS) return SYNONYM_ERROR_COPY.synonyms_too_few ?? null;
  return null;
}

function SynonymTerms({ terms }: { terms: readonly string[] }) {
  return (
    <Box role="list" aria-label="Names" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
      {terms.map((term, index) => (
        <Box key={`${term}-${index}`} role="listitem" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
          {index > 0 && (
            <Typography component="span" color="text.secondary" aria-hidden="true">
              =
            </Typography>
          )}
          <Chip label={term} size="small" sx={{ maxWidth: '100%' }} />
        </Box>
      ))}
    </Box>
  );
}

interface TypeOption {
  key: string;
  label: string;
}

interface SynonymDialogProps {
  open: boolean;
  /** The group being edited, or `null` to add one. */
  group: SynonymGroup | null;
  typeOptions: readonly TypeOption[];
  isSaving: boolean;
  /** The API's refusal, as a sentence. */
  error: string | null;
  onCancel: () => void;
  onSave: (input: SynonymGroupInput) => void;
}

function SynonymDialog({ open, group, typeOptions, isSaving, error, onCancel, onSave }: SynonymDialogProps) {
  const titleId = useId();
  const [terms, setTerms] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [entityType, setEntityType] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // A fresh form every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTerms(group ? [...group.terms] : []);
    setDraft('');
    setEntityType(group?.entityType ?? '');
    setLocalError(null);
  }, [group, open]);

  const options = useMemo(() => {
    const known = typeOptions.some((option) => option.key === entityType);
    return entityType && !known ? [...typeOptions, { key: entityType, label: entityType }] : typeOptions;
  }, [entityType, typeOptions]);

  const commitDraft = (): string[] => {
    const next = addTerms(terms, splitTerms(draft));
    setTerms(next);
    setDraft('');
    return next;
  };

  const onDraftChange = (value: string) => {
    setLocalError(null);
    if (!value.includes(',')) {
      setDraft(value);
      return;
    }
    // A comma (typed or pasted) commits everything before the last one.
    const parts = value.split(',');
    const rest = parts.pop() ?? '';
    setTerms((current) => addTerms(current, splitTerms(parts.join(','))));
    setDraft(rest.trimStart());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft();
    } else if (event.key === 'Backspace' && draft === '' && terms.length > 0) {
      setTerms((current) => current.slice(0, -1));
    }
  };

  const submit = () => {
    const next = commitDraft();
    const problem = localTermsError(next);
    setLocalError(problem);
    if (problem) return;
    onSave({ terms: next, entityType: entityType || null });
  };

  const shownError = localError ?? error;
  const atLimit = terms.length >= SYNONYM_MAX_TERMS;

  return (
    <Dialog open={open} onClose={() => !isSaving && onCancel()} fullWidth maxWidth="sm" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>{group ? 'Edit synonyms' : 'Add synonyms'}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Add two or more names that mean the same thing.
        </Typography>
        {terms.length > 0 && (
          <Box role="list" aria-label="Names to save" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1.5 }}>
            {terms.map((term) => (
              <Chip
                key={term}
                role="listitem"
                label={term}
                onDelete={isSaving ? undefined : () => setTerms((current) => current.filter((row) => row !== term))}
                deleteIcon={<CloseIcon aria-label={`Remove ${term}`} />}
                sx={{ maxWidth: '100%' }}
              />
            ))}
          </Box>
        )}
        <TextField
          label="Add a name"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => draft.trim() && commitDraft()}
          disabled={isSaving || atLimit}
          helperText={atLimit ? `A group holds up to ${SYNONYM_MAX_TERMS} names.` : 'Type a name and press Enter or a comma.'}
          fullWidth
          autoFocus
          slotProps={{ htmlInput: { maxLength: MAX_TERM_LENGTH + 1 } }}
        />
        <TextField
          select
          label="Type"
          value={entityType}
          onChange={(event) => setEntityType(event.target.value)}
          disabled={isSaving}
          helperText="Limit these synonyms to one type, or leave Any type."
          fullWidth
          sx={{ mt: 2 }}
        >
          <MenuItem value="">Any type</MenuItem>
          {options.map((option) => (
            <MenuItem key={option.key} value={option.key}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>
        {shownError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {shownError}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={submit}
          disabled={isSaving}
          startIcon={isSaving ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface DeleteDialogProps {
  group: SynonymGroup | null;
  isSaving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteSynonymDialog({ group: openGroup, isSaving, error, onCancel, onConfirm }: DeleteDialogProps) {
  const titleId = useId();
  // The last group stays drawn while the exit transition runs.
  const [group, setGroup] = useState<SynonymGroup | null>(openGroup);
  useEffect(() => {
    if (openGroup) setGroup(openGroup);
  }, [openGroup]);

  return (
    <Dialog open={openGroup !== null} onClose={() => !isSaving && onCancel()} fullWidth maxWidth="xs" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Delete these synonyms?</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ overflowWrap: 'anywhere' }}>
          {group
            ? `KVox will stop treating ${synonymGroupText(group.terms)} as the same name. Entities you already merged stay merged.`
            : ''}
        </DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={onConfirm}
          disabled={isSaving}
          startIcon={isSaving ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type EditorState = { mode: 'add' } | { mode: 'edit'; group: SynonymGroup };

/**
 * The `/graph/synonyms` page: the caller's synonym groups, each to edit or
 * delete, and "Add synonyms".
 *
 * @returns The page.
 *
 * @stability experimental
 */
export function GraphSynonymsPage() {
  const canWrite = useHasPermission('graph:write');
  const synonyms = useGraphSynonyms();
  const { ontology } = useGraphEffectiveOntology();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<SynonymGroup | null>(null);
  const [snack, setSnack] = useState<string | null>(null);

  const typeOptions = useMemo<TypeOption[]>(
    () => (ontology?.entityTypes ?? []).map((type) => ({ key: type.key, label: type.pluralLabel })),
    [ontology],
  );

  const openEditor = (next: EditorState) => {
    synonyms.clearActionError();
    setEditor(next);
  };

  const openDelete = (group: SynonymGroup) => {
    synonyms.clearActionError();
    setDeleting(group);
  };

  const save = async (input: SynonymGroupInput) => {
    if (!editor) return;
    const saved =
      editor.mode === 'edit' ? await synonyms.update(editor.group.id, input) : await synonyms.create(input);
    if (!saved) return;
    setEditor(null);
    setSnack(editor.mode === 'edit' ? 'Synonyms saved' : 'Synonyms added');
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const done = await synonyms.remove(deleting.id);
    if (!done) return;
    setDeleting(null);
    setSnack('Synonyms deleted');
  };

  const addButton = (variant: 'outlined' | 'contained') =>
    canWrite ? (
      <Button
        variant={variant}
        startIcon={<AddIcon />}
        onClick={() => openEditor({ mode: 'add' })}
        sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        Add synonyms
      </Button>
    ) : null;

  let body: ReactNode;
  if (synonyms.isLoading) {
    body = (
      <Stack spacing={1} role="status" aria-busy="true" aria-label="Loading your synonyms">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} variant="rounded" height={56} />
        ))}
      </Stack>
    );
  } else if (synonyms.error) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void synonyms.reload()}>
            Retry
          </Button>
        }
      >
        {synonyms.error}
      </Alert>
    );
  } else if (synonyms.groups.length === 0) {
    body = (
      <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 3 }, textAlign: 'center' }}>
        <Typography variant="subtitle1" component="h2" gutterBottom sx={{ fontWeight: 600 }}>
          No synonyms yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Tell KVox which names mean the same thing. For example:
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: canWrite ? 2 : 0 }} data-testid="synonyms-example">
          <SynonymTerms terms={['OAC', 'Org Alpha Consulting']} />
        </Box>
        {addButton('contained')}
      </Paper>
    );
  } else {
    body = (
      <Paper variant="outlined" sx={{ minWidth: 0 }}>
        <Box component="ul" aria-label="Synonyms" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {synonyms.groups.map((group, index) => {
            const text = synonymGroupText(group.terms);
            return (
              <Box
                component="li"
                key={group.id}
                aria-label={text}
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 1,
                  px: { xs: 1.5, sm: 2 },
                  py: 1.25,
                  borderTop: index === 0 ? 0 : 1,
                  borderColor: 'divider',
                  minWidth: 0,
                }}
              >
                <Box sx={{ flex: '1 1 240px', minWidth: 0 }}>
                  <SynonymTerms terms={group.terms} />
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    {synonymTypeLabel(group.entityType, ontology)}
                  </Typography>
                </Box>
                {canWrite && (
                  <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, ml: 'auto' }}>
                    <IconButton
                      aria-label={`Edit ${text}`}
                      onClick={() => openEditor({ mode: 'edit', group })}
                      disabled={synonyms.isSaving}
                    >
                      <EditOutlinedIcon />
                    </IconButton>
                    <IconButton
                      aria-label={`Delete ${text}`}
                      onClick={() => openDelete(group)}
                      disabled={synonyms.isSaving}
                    >
                      <DeleteOutlinedIcon />
                    </IconButton>
                  </Stack>
                )}
              </Box>
            );
          })}
        </Box>
      </Paper>
    );
  }

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', py: { xs: 2, sm: 3 }, minWidth: 0 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', mb: 2 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 600 }}>
            Synonyms
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {SYNONYMS_SUBTITLE}
          </Typography>
        </Box>
        {!synonyms.isLoading && !synonyms.error && synonyms.groups.length > 0 && addButton('outlined')}
      </Stack>

      {body}

      {canWrite && (
        <>
          <SynonymDialog
            open={editor !== null}
            group={editor?.mode === 'edit' ? editor.group : null}
            typeOptions={typeOptions}
            isSaving={synonyms.isSaving}
            error={editor ? synonyms.actionError : null}
            onCancel={() => setEditor(null)}
            onSave={(input) => void save(input)}
          />
          <DeleteSynonymDialog
            group={deleting}
            isSaving={synonyms.isSaving}
            error={deleting ? synonyms.actionError : null}
            onCancel={() => setDeleting(null)}
            onConfirm={() => void confirmDelete()}
          />
        </>
      )}

      <Snackbar
        open={snack !== null}
        autoHideDuration={6000}
        onClose={(_event, reason) => {
          if (reason !== 'clickaway') setSnack(null);
        }}
        message={snack ?? ''}
      />
    </Box>
  );
}
