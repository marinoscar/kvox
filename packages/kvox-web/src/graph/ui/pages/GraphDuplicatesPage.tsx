/**
 * `/graph/duplicates` — Possible duplicates (#766; API `GET /api/graph/duplicates`).
 *
 * WHY IT EXISTS. Notes name the same person or organization in several ways
 * ("EY", "Ernst & Young"), and the graph ends up with two entities for one
 * thing. The API lists the pairs that probably are one entity (a fast name
 * pass plus the open resolution proposals); this page lets a person settle
 * each pair: Merge, Not the same, or Skip.
 *
 * WHAT THE PAGE DECIDES: nothing. The reasons are the API's, the merge and
 * "not the same" are the existing `POST /api/graph/entities/:id/merge` and
 * `POST /api/graph/distinct-pairs`, and "Find more duplicates" queues the
 * server's `kg.resolve` scan. The page only presents.
 *
 * GATES. The route is `graph:read`. Every action (merge, not the same, skip,
 * find more) is drawn only for `graph:write`, like the entity page's Edit and
 * Merge; the API enforces it.
 *
 * SKIP hides a pair for this browser session (`sessionStorage`, best effort).
 *
 * The header links to Synonyms (`/graph/synonyms`, #767), where a person
 * tells KVox which names mean the same thing.
 *
 * No breakpoint read: the two sides stack below `sm` through `sx` alone.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { useHasPermission } from '../../../core/headless/index.js';
import type { DuplicateEntity, DuplicatePair, DuplicateReason } from '../../headless/clients/graph.js';
import { useEntityMergeActions } from '../../headless/hooks/useEntityMerges.js';
import { useGraphEffectiveOntology } from '../../headless/hooks/useGraphAttributeDefs.js';
import { duplicatePairKey, useGraphDuplicates, useScanDuplicates } from '../../headless/hooks/useGraphDuplicates.js';
import { entityTypeLabel } from '../../headless/utils/graphDisplay.js';
import { entityPath } from '../components/EntityListRow.js';
import { mergeConfirmation } from '../components/MergeEntityDialog.js';
import { SynonymsLink } from '../components/SynonymsLink.js';
import { visuallyHidden } from '../visuallyHidden.js';

/** How many pairs the page reads: the API's ceiling. */
const PAGE_LIMIT = 200;
const SKELETON_CARDS = 3;
const SKIPPED_STORAGE_KEY = 'kvox.graph.duplicates.skipped';

/**
 * The words the page uses for each reason a pair is listed.
 *
 * @stability experimental
 */
export const DUPLICATE_REASON_COPY: Record<DuplicateReason, string> = {
  name_contained: 'Name contained in the other',
  initials: 'Initials match',
  alias_match: 'Same alias',
  similar_name: 'Similar spelling',
  synonym: 'Your synonyms',
  resolution_proposal: 'Suggested by KVox',
};

/**
 * The snackbar text after "Find more duplicates" queued a scan.
 *
 * @stability experimental
 */
export const DUPLICATES_SCAN_QUEUED_MESSAGE = 'Looking for duplicates… results appear here when the scan finishes';

/**
 * The snackbar text when a scan was already running and this request joined it.
 *
 * @stability experimental
 */
export const DUPLICATES_SCAN_RUNNING_MESSAGE = 'Already looking for duplicates… results appear here when the scan finishes';

/**
 * The survivor a merge keeps by default: the side with more mentions; a tie keeps `a`.
 *
 * @stability experimental
 */
export function defaultDuplicateSurvivor(pair: Pick<DuplicatePair, 'a' | 'b'>): DuplicateEntity {
  return pair.b.mentionCount > pair.a.mentionCount ? pair.b : pair.a;
}

function readSkipped(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(SKIPPED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeSkipped(keys: ReadonlySet<string>): void {
  try {
    window.sessionStorage.setItem(SKIPPED_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Best effort: the pair stays hidden until the page is left.
  }
}

function mentionsPhrase(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'mention' : 'mentions'}`;
}

function EntitySide({ entity, typeLabel }: { entity: DuplicateEntity; typeLabel: string }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Link
        component={RouterLink}
        to={entityPath(entity.id)}
        variant="subtitle1"
        sx={{ fontWeight: 600, overflowWrap: 'anywhere', display: 'inline-block' }}
      >
        {entity.label}
      </Link>
      <Typography variant="body2" color="text.secondary">
        {typeLabel} · {mentionsPhrase(entity.mentionCount)}
      </Typography>
      {entity.aliases.length > 0 && (
        <Box
          role="list"
          aria-label={`Other names of ${entity.label}`}
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}
        >
          {entity.aliases.map((alias) => (
            <Chip key={alias} size="small" variant="outlined" label={alias} role="listitem" />
          ))}
        </Box>
      )}
    </Box>
  );
}

interface PairCardProps {
  pair: DuplicatePair;
  typeLabel: string;
  canWrite: boolean;
  busy: boolean;
  onMerge: () => void;
  onDistinct: () => void;
  onSkip: () => void;
}

function PairCard({ pair, typeLabel, canWrite, busy, onMerge, onDistinct, onSkip }: PairCardProps) {
  const headingId = useId();
  return (
    <Paper component="article" variant="outlined" aria-labelledby={headingId} sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
      <Typography id={headingId} component="h2" sx={visuallyHidden}>
        {`${pair.a.label} and ${pair.b.label}`}
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 1.5, sm: 2 }} sx={{ minWidth: 0 }}>
        <EntitySide entity={pair.a} typeLabel={typeLabel} />
        <EntitySide entity={pair.b} typeLabel={typeLabel} />
      </Stack>
      <Box
        role="list"
        aria-label="Why these may be the same"
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1.5 }}
      >
        {pair.reasons.map((reason) => (
          <Chip key={reason} size="small" color="info" variant="outlined" label={DUPLICATE_REASON_COPY[reason]} role="listitem" />
        ))}
      </Box>
      {canWrite && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1.5 }}>
          <Button variant="contained" size="small" onClick={onMerge} disabled={busy}>
            Merge
          </Button>
          <Button variant="outlined" size="small" onClick={onDistinct} disabled={busy}>
            Not the same
          </Button>
          <Button size="small" onClick={onSkip} disabled={busy}>
            Skip
          </Button>
        </Stack>
      )}
    </Paper>
  );
}

interface MergePairDialogProps {
  pair: DuplicatePair | null;
  isSaving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (merged: DuplicateEntity, survivor: DuplicateEntity) => void;
}

function MergePairDialog({ pair: openPair, isSaving, error, onCancel, onConfirm }: MergePairDialogProps) {
  const titleId = useId();
  const [survivorId, setSurvivorId] = useState<string | null>(null);
  // The last pair stays drawn while the dialog's exit transition runs.
  const [pair, setPair] = useState<DuplicatePair | null>(openPair);

  useEffect(() => {
    if (!openPair) return;
    setPair(openPair);
    setSurvivorId(defaultDuplicateSurvivor(openPair).id);
  }, [openPair]);

  const survivor = pair && survivorId ? (survivorId === pair.a.id ? pair.a : pair.b) : null;
  const merged = pair && survivor ? (survivor.id === pair.a.id ? pair.b : pair.a) : null;

  return (
    <Dialog open={openPair !== null} onClose={() => !isSaving && onCancel()} fullWidth maxWidth="xs" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Merge these entities?</DialogTitle>
      <DialogContent dividers>
        {pair && survivorId && (
          <RadioGroup aria-label="Keep" value={survivorId} onChange={(event) => setSurvivorId(event.target.value)}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Keep
            </Typography>
            {[pair.a, pair.b].map((entity) => (
              <FormControlLabel
                key={entity.id}
                value={entity.id}
                control={<Radio />}
                label={`${entity.label} (${mentionsPhrase(entity.mentionCount)})`}
                sx={{ '& .MuiFormControlLabel-label': { overflowWrap: 'anywhere' } }}
              />
            ))}
          </RadioGroup>
        )}
        {survivor && merged && (
          <Alert severity="info" role="status" sx={{ mt: 1 }}>
            {mergeConfirmation(merged.label, survivor.label)}
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!survivor || !merged || isSaving}
          onClick={() => survivor && merged && onConfirm(merged, survivor)}
          startIcon={isSaving ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Merge
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface SnackState {
  message: string;
  /** The merge Undo reverses, when the snackbar offers it. */
  undoMergeId?: string;
}

/**
 * The `/graph/duplicates` page: the caller's possible-duplicate pairs, each to
 * merge, tell apart or skip, with a type filter and "Find more duplicates".
 *
 * @returns The page.
 *
 * @stability experimental
 */
export function GraphDuplicatesPage() {
  const canWrite = useHasPermission('graph:write');
  const list = useGraphDuplicates({ limit: PAGE_LIMIT });
  const { reload, removePair } = list;
  const { ontology } = useGraphEffectiveOntology();
  const actions = useEntityMergeActions();
  const scanner = useScanDuplicates();

  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(readSkipped);
  const [mergePair, setMergePair] = useState<DuplicatePair | null>(null);
  const [snack, setSnack] = useState<SnackState | null>(null);

  const visible = useMemo(() => list.pairs.filter((pair) => !skipped.has(duplicatePairKey(pair))), [list.pairs, skipped]);

  // Only the types present in the results, in the ontology's order, then any unknown ones.
  const typeOptions = useMemo(() => {
    const present = new Set(visible.map((pair) => pair.a.type));
    const ordered = (ontology?.entityTypes ?? []).filter((type) => present.has(type.key));
    const known = new Set(ordered.map((type) => type.key));
    return [
      ...ordered.map((type) => ({ key: type.key, label: type.pluralLabel })),
      ...[...present].filter((key) => !known.has(key)).map((key) => ({ key, label: key })),
    ];
  }, [ontology, visible]);

  // A filter whose type has no pair left falls back to All.
  const activeType = typeFilter && typeOptions.some((option) => option.key === typeFilter) ? typeFilter : null;
  const shown = activeType ? visible.filter((pair) => pair.a.type === activeType) : visible;

  const skip = useCallback((pair: DuplicatePair) => {
    setSkipped((current) => {
      const next = new Set(current);
      next.add(duplicatePairKey(pair));
      writeSkipped(next);
      return next;
    });
  }, []);

  const openMerge = (pair: DuplicatePair) => {
    actions.clearError();
    setMergePair(pair);
  };

  const confirmMerge = async (merged: DuplicateEntity, survivor: DuplicateEntity) => {
    if (!mergePair) return;
    const pair = mergePair;
    const result = await actions.merge(merged.id, survivor.id);
    if (!result) return;
    setMergePair(null);
    removePair(pair, merged.id);
    setSnack({ message: `Merged “${merged.label}” into “${survivor.label}”`, undoMergeId: result.merge.id });
  };

  const markDistinct = async (pair: DuplicatePair) => {
    const result = await actions.markDistinct(pair.a.id, pair.b.id);
    if (!result) return;
    removePair(pair);
    setSnack({ message: `Marked “${pair.a.label}” and “${pair.b.label}” as not the same` });
  };

  const undo = async (mergeId: string) => {
    setSnack(null);
    const result = await actions.reverse(mergeId);
    if (!result) return;
    setSnack({ message: 'Merge undone' });
    void reload();
  };

  const findMore = async () => {
    const result = await scanner.scan();
    if (!result) return;
    setSnack({ message: result.alreadyRunning ? DUPLICATES_SCAN_RUNNING_MESSAGE : DUPLICATES_SCAN_QUEUED_MESSAGE });
  };

  // A failed "not the same" or undo shows above the list; a failed merge stays in its dialog.
  const pageActionError = mergePair ? null : actions.error;

  const findMoreButton = (variant: 'outlined' | 'contained') =>
    canWrite ? (
      <Button
        variant={variant}
        onClick={() => void findMore()}
        disabled={scanner.isScanning}
        startIcon={scanner.isScanning ? <CircularProgress size={16} color="inherit" /> : undefined}
        sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        Find more duplicates
      </Button>
    ) : null;

  let body: ReactNode;
  if (list.isLoading) {
    body = (
      <Stack spacing={1.5} role="status" aria-busy="true" aria-label="Loading possible duplicates">
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <Skeleton key={index} variant="rounded" height={120} />
        ))}
      </Stack>
    );
  } else if (list.error) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void reload()}>
            Retry
          </Button>
        }
      >
        {list.error}
      </Alert>
    );
  } else if (visible.length === 0) {
    body = (
      <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 3 }, textAlign: 'center' }}>
        <Typography variant="subtitle1" component="h2" gutterBottom sx={{ fontWeight: 600 }}>
          No duplicates found
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: canWrite ? 2 : 0 }}>
          Nothing in your graph looks like the same person or organization twice.
        </Typography>
        {findMoreButton('contained')}
      </Paper>
    );
  } else {
    body = (
      <Stack spacing={1.5} aria-label="Possible duplicates" role="list">
        {shown.map((pair) => (
          <Box key={duplicatePairKey(pair)} role="listitem">
            <PairCard
              pair={pair}
              typeLabel={entityTypeLabel(pair.a.type, ontology)}
              canWrite={canWrite}
              busy={actions.isSaving}
              onMerge={() => openMerge(pair)}
              onDistinct={() => void markDistinct(pair)}
              onSkip={() => skip(pair)}
            />
          </Box>
        ))}
      </Stack>
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
            Possible duplicates
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Entities that may be the same person, organization or thing.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', flexShrink: 0 }}>
          <SynonymsLink />
          {!list.isLoading && visible.length > 0 && findMoreButton('outlined')}
        </Stack>
      </Stack>

      {scanner.error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={scanner.clearError}>
          {scanner.error}
        </Alert>
      )}
      {pageActionError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          onClose={actions.clearError}
        >
          {pageActionError}
        </Alert>
      )}

      {!list.isLoading && !list.error && typeOptions.length > 1 && (
        <Box
          role="group"
          aria-label="Filter by type"
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}
        >
          <Chip
            label="All"
            clickable
            color={activeType === null ? 'primary' : 'default'}
            variant={activeType === null ? 'filled' : 'outlined'}
            aria-pressed={activeType === null}
            onClick={() => setTypeFilter(null)}
          />
          {typeOptions.map((option) => (
            <Chip
              key={option.key}
              label={option.label}
              clickable
              color={activeType === option.key ? 'primary' : 'default'}
              variant={activeType === option.key ? 'filled' : 'outlined'}
              aria-pressed={activeType === option.key}
              onClick={() => setTypeFilter(option.key)}
            />
          ))}
        </Box>
      )}

      {body}

      {canWrite && (
        <MergePairDialog
          pair={mergePair}
          isSaving={actions.isSaving}
          error={mergePair ? actions.error : null}
          onCancel={() => setMergePair(null)}
          onConfirm={(merged, survivor) => void confirmMerge(merged, survivor)}
        />
      )}

      <Snackbar
        open={snack !== null}
        autoHideDuration={snack?.undoMergeId ? 10000 : 6000}
        onClose={(_event, reason) => {
          if (reason !== 'clickaway') setSnack(null);
        }}
        message={snack?.message ?? ''}
        action={
          snack?.undoMergeId ? (
            <Button color="inherit" size="small" onClick={() => void undo(snack.undoMergeId!)}>
              Undo
            </Button>
          ) : undefined
        }
      />
    </Box>
  );
}
