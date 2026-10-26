/**
 * `MergeEntityDialog` — "Merge into…" from an entity's page (#765, API #364).
 *
 * Search the caller's graph for another entity of the SAME type (the current
 * one is never offered), preview the two side by side (name, aliases, mention
 * and connection counts, read from the candidate's detail), choose which name
 * is kept, then merge. The default survivor is the one with more mentions; a
 * tie keeps the entity picked from the search, since the menu said "into".
 *
 * The other entity's name and aliases become aliases of the survivor, and the
 * merge can be undone (the page offers Undo). The dialog only merges; the page
 * decides where to go next through `onMerged`.
 *
 * "Also add these names to my synonyms" (#767, unchecked by default): after a
 * successful merge the dialog also creates a synonym group of the two names
 * for the entity's type (`POST /api/graph/synonyms`). The merge stands either
 * way; a refused synonym only reaches the page as `synonymsError`, for a
 * non-blocking snackbar.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useId, useRef, useState } from 'react';

import { createSynonym, getGraphEntity } from '../../headless/clients/graph.js';
import type { GraphEntityDetail, GraphEntitySearchResult, MergeEntityResult } from '../../headless/clients/graph.js';
import { graphErrorMessage } from '../../headless/hooks/graphHookUtils.js';
import { useEntityMergeActions } from '../../headless/hooks/useEntityMerges.js';
import { synonymErrorMessage } from '../../headless/hooks/useGraphSynonyms.js';
import { EntitySearchField } from './schema/EntitySearchField.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/** The two sides of a merge, as the page needs them afterwards. */
export interface MergeOutcome {
  /** The API's answer: the merge record (its id undoes it) and the survivor. */
  result: MergeEntityResult;
  /** The entity that became a tombstone. */
  merged: { id: string; label: string };
  /**
   * Set when the person asked to add the two names to their synonyms and that
   * failed: the sentence to show. The merge itself succeeded.
   */
  synonymsError?: string;
}

/**
 * The snackbar text when the merge worked but adding the names to the synonyms did not.
 *
 * @stability experimental
 */
export function mergeSynonymsFailedMessage(reason: string): string {
  return `Merged, but the names were not added to your synonyms. ${reason}`;
}

export interface MergeEntityDialogProps {
  open: boolean;
  /** The entity whose page opened the dialog. */
  entity: GraphEntityDetail;
  /** The display label of its type, e.g. "Person". */
  typeLabel: string;
  onClose: () => void;
  onMerged: (outcome: MergeOutcome) => void;
}

/** The survivor by default: more mentions wins; a tie keeps `candidate`. */
export function defaultSurvivorId(current: GraphEntityDetail, candidate: GraphEntityDetail): string {
  return current.counts.mentions > candidate.counts.mentions ? current.id : candidate.id;
}

/** The sentence the dialog confirms with. */
export function mergeConfirmation(mergedLabel: string, survivorLabel: string): string {
  return `“${mergedLabel}” will become an alias of “${survivorLabel}”.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function EntityPreview({ entity, keep }: { entity: GraphEntityDetail; keep: boolean }) {
  const aliases = entity.aliases.map((alias) => alias.alias);
  return (
    <Paper
      variant="outlined"
      data-testid={`merge-preview-${entity.id}`}
      sx={{ p: 1.5, flex: 1, minWidth: 0, borderColor: keep ? 'primary.main' : undefined, borderWidth: keep ? 2 : 1 }}
    >
      <FormControlLabel
        value={entity.id}
        control={<Radio />}
        label={`Keep “${entity.label}”`}
        sx={{ mr: 0, '& .MuiFormControlLabel-label': { overflowWrap: 'anywhere' } }}
      />
      <Typography variant="subtitle1" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
        {entity.label}
      </Typography>
      {aliases.length > 0 ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, my: 0.5 }} role="list" aria-label={`Names of ${entity.label}`}>
          {aliases.map((alias) => (
            <Chip key={alias} size="small" label={alias} role="listitem" />
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          No other names
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        {plural(entity.counts.mentions, 'mention', 'mentions')} · {plural(entity.counts.relations, 'connection', 'connections')}
      </Typography>
    </Paper>
  );
}

export function MergeEntityDialog({ open, entity, typeLabel, onClose, onMerged }: MergeEntityDialogProps) {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const titleId = useId();
  const actions = useEntityMergeActions();
  const { clearError } = actions;

  const [picked, setPicked] = useState<GraphEntitySearchResult | null>(null);
  const [candidate, setCandidate] = useState<GraphEntityDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [survivorId, setSurvivorId] = useState<string | null>(null);
  const [alsoSynonyms, setAlsoSynonyms] = useState(false);
  const [addingSynonyms, setAddingSynonyms] = useState(false);
  // Read for its counts when a candidate loads; a refresh of the page's entity
  // must not reload the candidate.
  const entityRef = useRef(entity);
  entityRef.current = entity;

  // A fresh dialog every time it opens, and for every entity.
  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setCandidate(null);
    setLoadError(null);
    setSurvivorId(null);
    setAlsoSynonyms(false);
    clearError();
  }, [clearError, entity.id, open]);

  // The candidate's detail: its aliases and counts for the preview.
  useEffect(() => {
    setCandidate(null);
    setLoadError(null);
    setSurvivorId(null);
    if (!picked) return;
    const controller = new AbortController();
    getGraphEntity(host, picked.id, controller.signal)
      .then((detail) => {
        if (!isMounted() || controller.signal.aborted) return;
        setCandidate(detail);
        setSurvivorId(defaultSurvivorId(entityRef.current, detail));
      })
      .catch((err: unknown) => {
        if (!isMounted() || controller.signal.aborted) return;
        setLoadError(graphErrorMessage(err, 'Could not load this entity'));
      });
    return () => controller.abort();
  }, [host, isMounted, picked]);

  const survivor = candidate && survivorId ? (survivorId === entity.id ? entity : candidate) : null;
  const merged = candidate && survivor ? (survivor.id === entity.id ? candidate : entity) : null;

  const submit = async () => {
    if (!survivor || !merged) return;
    const result = await actions.merge(merged.id, survivor.id);
    if (!result) return;
    const outcome: MergeOutcome = { result, merged: { id: merged.id, label: merged.label } };
    if (alsoSynonyms) {
      setAddingSynonyms(true);
      try {
        await createSynonym(host, { terms: [merged.label, survivor.label], entityType: entity.type });
      } catch (err) {
        outcome.synonymsError = mergeSynonymsFailedMessage(synonymErrorMessage(err, 'Something went wrong.'));
      } finally {
        if (isMounted()) setAddingSynonyms(false);
      }
    }
    onMerged(outcome);
  };

  const busy = actions.isSaving || addingSynonyms;

  const close = () => {
    if (busy) return;
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} fullScreen={fullScreen} fullWidth maxWidth="sm" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Merge “{entity.label}” into…</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Pick the {typeLabel} that is the same as “{entity.label}”. Its connections, facts and mentions come together
          under one name, and the other name is kept as an alias. You can undo a merge.
        </Typography>
        <EntitySearchField
          label={`Search ${typeLabel}`}
          types={[entity.type]}
          excludeIds={[entity.id]}
          value={picked}
          onChange={setPicked}
          disabled={busy}
          autoFocus
        />

        {picked && !candidate && !loadError && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={24} aria-label="Loading the preview" />
          </Box>
        )}
        {loadError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {loadError}
          </Alert>
        )}

        {candidate && survivorId && (
          <RadioGroup
            aria-label="Which name to keep"
            value={survivorId}
            onChange={(event) => setSurvivorId(event.target.value)}
            sx={{ mt: 2 }}
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <EntityPreview entity={entity} keep={survivorId === entity.id} />
              <EntityPreview entity={candidate} keep={survivorId === candidate.id} />
            </Stack>
          </RadioGroup>
        )}

        {survivor && merged && (
          <Alert severity="info" sx={{ mt: 2 }} role="status">
            {mergeConfirmation(merged.label, survivor.label)}
          </Alert>
        )}
        {survivor && merged && (
          <FormControlLabel
            sx={{ mt: 1, '& .MuiFormControlLabel-label': { overflowWrap: 'anywhere' } }}
            control={
              <Checkbox
                checked={alsoSynonyms}
                onChange={(event) => setAlsoSynonyms(event.target.checked)}
                disabled={busy}
              />
            }
            label="Also add these names to my synonyms"
          />
        )}
        {actions.error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {actions.error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={!survivor || busy}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Merge
        </Button>
      </DialogActions>
    </Dialog>
  );
}
