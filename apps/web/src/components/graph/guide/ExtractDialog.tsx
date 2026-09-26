/**
 * Extract — or re-extract — a note into a graph proposal, with a chosen
 * model, the cost shown first, and "Guide the graph" (#368, epic #346;
 * ontology.md §6, §19, §20).
 *
 * MODEL (§20 "Task models"). The picker lists only what `GET /api/ai/config`
 * permits AND can return structured output — a model without the flag is
 * treated as capable (an older API), the server's 409
 * `model_lacks_capability` being the backstop. It defaults to the
 * administrator's `graph.extract` task model. The dialog never sends a
 * free-text model id, and sends `model` only when the user chose a
 * different one, so the admin's choice keeps applying to an unchanged run.
 *
 * ESTIMATE. `GET /api/graph/extract/estimate` on open and on every model
 * change (debounced). A prompt that does not fit, or a caller with no key,
 * disables Extract with the reason — spending is never a surprise.
 *
 * GUIDANCE. `GuideGraphPanel` inside an accordion, pre-filled from the latest
 * proposal's `userGuidance`; `normalizeGuidance` decides what is sent.
 *
 * LAYOUT is this dialog's own `down('sm')` read — full screen on a phone —
 * the `NameSuggestionsPanel` pattern: one surface deciding its own shape,
 * never whether app chrome mounts (not a sixth breakpoint gate).
 */

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { AI_KEY_SETTINGS_PATH } from '../../ai/AiKeyRequired';
import { ModelSelect } from '../../notes/ModelSelect';
import { useAiConfig } from '../../../hooks/useAiConfig';
import { useGraphExtractEstimate } from '../../../hooks/useGraphExtractEstimate';
import { useGraphOntology } from '../../../hooks/useGraphOntology';
import { ApiError } from '../../../services/api';
import type { AiConfig, AiConfigModel } from '../../../services/ai';
import {
  extractBadRequest,
  graphConflictReason,
  requestExtraction,
} from '../../../services/graph';
import type {
  ExtractBadRequest,
  GraphConflictReason,
  ProposalItem,
  RequestExtractionInput,
  UserGuidance,
} from '../../../services/graph';
import { GuideGraphPanel } from './GuideGraphPanel';
import { EMPTY_GUIDANCE, hasGuidance, normalizeGuidance } from './guidance';

export interface ExtractDialogProps {
  open: boolean;
  onClose: () => void;
  noteId: string;
  mode: 'extract' | 're-extract';
  /** The latest proposal's `userGuidance`, pre-filled. */
  initialGuidance?: UserGuidance | null;
  /** The current draft's decided rows → warning copy. */
  pendingDecisions?: number;
  /** The sheet switches to its extracting state. */
  onStarted: (proposalId: string) => void;
  /**
   * Starts the run. Default: `requestExtraction` directly. The note page
   * passes its `useGraphProposal().requestExtract`, which also re-reads.
   */
  submit?: (noteId: string, body: RequestExtractionInput) => Promise<{ proposal: { id: string } }>;
  /** Proposal rows, to name pinned entities by their resolution candidates. */
  items?: readonly ProposalItem[];
}

export const EXTRACT_MODEL_HELPER = 'Runs on your own AI key. Choosing another model changes the cost.';

/** The models a run may use: permitted, and able to return structured output. */
export function extractionModels(config: AiConfig | null): AiConfigModel[] {
  return (config?.models ?? []).filter((model) => model.structuredOutput !== false);
}

/** The admin's `graph.extract` task model, else the default, else the first capable one. */
export function defaultExtractionModel(config: AiConfig | null): string {
  const models = extractionModels(config);
  const ids = models.map((model) => model.id);
  const task = config?.taskModels?.['graph.extract']?.model ?? null;
  if (task && ids.includes(task)) return task;
  if (config?.defaultModel && ids.includes(config.defaultModel)) return config.defaultModel;
  return ids[0] ?? '';
}

const keyLink = (
  <Link component={RouterLink} to={AI_KEY_SETTINGS_PATH}>
    Add your AI key
  </Link>
);

/** 409 `details.reason` → what the dialog says. */
export function extractConflictCopy(reason: GraphConflictReason | null): ReactNode | null {
  switch (reason) {
    case 'extraction_running':
      return 'An extraction is already running for this note.';
    case 'ai_key_missing':
      return <>You have no AI key for this provider. {keyLink} to extract.</>;
    case 'model_lacks_capability':
      return "This model can't produce structured output — choose another.";
    case 'graph_disabled':
      return 'Connected knowledge is switched off on this deployment.';
    case 'ai_not_configured':
      return 'AI is not set up on this deployment yet. Ask your administrator.';
    case 'note_not_ready':
      return 'This note is still being written. Extract it once it is ready.';
    default:
      return null;
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export function ExtractDialog({
  open,
  onClose,
  noteId,
  mode,
  initialGuidance,
  pendingDecisions = 0,
  onStarted,
  submit,
  items = [],
}: ExtractDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const { config, isLoading: configLoading } = useAiConfig();
  const { ontology, error: ontologyError } = useGraphOntology({ enabled: open });

  const models = useMemo(() => extractionModels(config), [config]);
  const defaultModel = useMemo(() => defaultExtractionModel(config), [config]);
  const [model, setModel] = useState('');
  const [guidance, setGuidance] = useState<UserGuidance>(EMPTY_GUIDANCE);
  const [guideOpen, setGuideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Pick<ExtractBadRequest, 'unknownTypes' | 'invalidPinnedIds'> | null>(null);

  // Reset whenever the dialog opens: a closed dialog holds nothing over.
  useEffect(() => {
    if (!open) return;
    const start = initialGuidance
      ? { ...EMPTY_GUIDANCE, ...initialGuidance, pinnedEntityIds: [...(initialGuidance.pinnedEntityIds ?? [])] }
      : EMPTY_GUIDANCE;
    setGuidance(start);
    setGuideOpen(hasGuidance(initialGuidance));
    setError(null);
    setModelError(null);
    setInvalid(null);
    setBusy(false);
  }, [initialGuidance, open]);

  useEffect(() => {
    if (open && defaultModel) setModel(defaultModel);
  }, [defaultModel, open]);

  const estimateState = useGraphExtractEstimate(noteId, model || null, {
    enabled: open && Boolean(model),
  });
  const { estimate } = estimateState;
  const chosenLabel = models.find((entry) => entry.id === model)?.label ?? model;

  const noKey = estimate?.keyConfigured === false || (estimate === null && config?.keyConfigured === false);
  const tooLarge = estimate?.fits === false;
  const estimateBlocks =
    estimateState.conflictReason !== null || estimateState.modelNotPermitted;
  const canSubmit =
    !busy && Boolean(model) && !noKey && !tooLarge && !estimateBlocks && !estimateState.isLoading;

  const start = async () => {
    setBusy(true);
    setError(null);
    setModelError(null);
    setInvalid(null);
    const body: RequestExtractionInput = {};
    if (model && model !== defaultModel) body.model = model;
    const normalized = normalizeGuidance(guidance, ontology);
    if (normalized) body.userGuidance = normalized;
    try {
      const result = submit ? await submit(noteId, body) : await requestExtraction(noteId, body);
      onStarted(result.proposal.id);
      onClose();
    } catch (err) {
      setBusy(false);
      const conflict = extractConflictCopy(graphConflictReason(err));
      if (conflict) {
        setError(conflict);
        return;
      }
      const bad = extractBadRequest(err);
      if (bad) {
        if (bad.modelNotPermitted) {
          setModelError("That model isn't permitted on this deployment");
          return;
        }
        if (bad.unknownTypes.length > 0 || bad.invalidPinnedIds.length > 0) {
          setInvalid({ unknownTypes: bad.unknownTypes, invalidPinnedIds: bad.invalidPinnedIds });
          setGuideOpen(true);
          setError('Some of your guidance no longer matches your graph — the highlighted entries.');
          return;
        }
        if (bad.budget) {
          setError(
            `This note is too long for ${chosenLabel}: about ${formatNumber(bad.budget.promptTokens)} tokens against a limit of ${formatNumber(bad.budget.availableInputTokens)}.`,
          );
          return;
        }
      }
      setError(err instanceof ApiError && err.message ? err.message : 'The extraction could not be started');
    }
  };

  const estimateLine = (() => {
    if (!model) return null;
    if (estimateState.isLoading) {
      return <Skeleton width="60%" aria-label="Estimating the cost" />;
    }
    if (estimateState.modelNotPermitted) return null;
    if (estimateState.conflictReason) {
      return <Alert severity="warning">{extractConflictCopy(estimateState.conflictReason)}</Alert>;
    }
    if (estimateState.error) {
      return <Alert severity="warning">{estimateState.error}</Alert>;
    }
    if (!estimate) return null;
    return (
      <Stack spacing={1}>
        <Typography variant="body2" color="text.secondary">
          {`About ${formatNumber(estimate.inputTokens)} input tokens · ${estimate.requests} ${
            estimate.requests === 1 ? 'request' : 'requests'
          }`}
        </Typography>
        {tooLarge && (
          <Alert severity="warning">
            {`This note is too long for ${chosenLabel}: about ${formatNumber(estimate.inputTokens)} tokens against a limit of ${formatNumber(estimate.availableInputTokens)}. Choose a model with a larger context window.`}
          </Alert>
        )}
        {estimate.keyConfigured === false && (
          <Alert severity="info">
            {keyLink} to extract. Counting the cost needs none, but running it does.
          </Alert>
        )}
      </Stack>
    );
  })();

  const title = mode === 're-extract' ? 'Extract again' : 'Extract to your graph';

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="graph-extract-title"
    >
      <DialogTitle id="graph-extract-title">{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            The AI reads this note and its transcript and proposes people, organizations, decisions and
            commitments. Nothing reaches your graph until you review it.
          </Typography>

          {mode === 're-extract' && pendingDecisions > 0 && (
            <Alert severity="warning">
              {`You've decided ${pendingDecisions} ${pendingDecisions === 1 ? 'row' : 'rows'} on the current draft. A new draft replaces it once it's ready.`}
            </Alert>
          )}

          {configLoading ? (
            <Skeleton variant="rounded" height={40} aria-label="Loading models" />
          ) : models.length === 0 ? (
            <Alert severity="info">No permitted model on this deployment can produce structured output.</Alert>
          ) : (
            <ModelSelect
              value={model}
              onChange={(next) => {
                setModel(next);
                setModelError(null);
              }}
              models={models}
              disabled={busy}
              error={Boolean(modelError) || estimateState.modelNotPermitted}
              helperText={
                modelError ??
                (estimateState.modelNotPermitted ? "That model isn't permitted on this deployment" : EXTRACT_MODEL_HELPER)
              }
            />
          )}

          <Box aria-live="polite">{estimateLine}</Box>

          <Accordion
            expanded={guideOpen}
            onChange={(_event, expanded) => setGuideOpen(expanded)}
            disableGutters
            variant="outlined"
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="graph-guide-panel" id="graph-guide-header">
              <Typography variant="subtitle2" component="span">
                Guide the graph
              </Typography>
            </AccordionSummary>
            <AccordionDetails id="graph-guide-panel">
              {ontology ? (
                <GuideGraphPanel
                  value={guidance}
                  onChange={setGuidance}
                  ontology={ontology}
                  disabled={busy}
                  invalid={invalid ?? undefined}
                  items={items}
                />
              ) : ontologyError ? (
                <Alert severity="error">{ontologyError}</Alert>
              ) : (
                <Skeleton variant="rounded" height={120} aria-label="Loading your graph schema" />
              )}
            </AccordionDetails>
          </Accordion>

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void start()} disabled={!canSubmit} loading={busy}>
          {mode === 're-extract' ? 'Extract again' : 'Extract'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ExtractDialog;
