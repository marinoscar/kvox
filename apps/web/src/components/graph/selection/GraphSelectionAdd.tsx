/**
 * "Add to graph" from a text selection, end to end (#368, epic #346;
 * ontology.md §19): the selection hook over one container, the button, the
 * choice of draft, and the add dialog.
 *
 * TARGET PROPOSAL
 *   note page        the note's latest proposal (the page already holds it);
 *                    it must be a `draft`, else "Adding needs a draft" with
 *                    Extract….
 *   transcript page  `GET /api/graph/proposals?status=draft&transcriptId=` —
 *                    none → "Adding needs a draft" with Show notes; one → it;
 *                    several → a picker.
 *
 * The selection is FROZEN when the button is pressed: the dialog takes focus,
 * the live selection collapses, and the hook forgets it — the dialog keeps
 * what was selected.
 *
 * The caller decides whether this renders at all (`graph:write` and
 * `graphEnabled`, and not while the note is being edited). LAYOUT is this
 * component's own `down('sm')` read — the `NameSuggestionsPanel` pattern:
 * one surface choosing its own shape (a bottom bar and full-screen dialogs
 * on a phone), never whether app chrome mounts, so not a sixth breakpoint
 * gate.
 */

import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useCallback, useState } from 'react';
import type { RefObject } from 'react';

import { useGraphOntology } from '../../../hooks/useGraphOntology';
import { useTextSelection } from '../../../hooks/useTextSelection';
import type { GraphSelection, SelectionResolution } from '../../../hooks/useTextSelection';
import { ApiError } from '../../../services/api';
import { getProposal, listProposals } from '../../../services/graph';
import type { PatchProposalItemResult, ProposalDetail, ProposalSummary } from '../../../services/graph';
import { AddToGraphDialog } from './AddToGraphDialog';
import { SelectionAddButton } from './SelectionAddButton';
import { TargetProposalDialog } from './TargetProposalDialog';

export type GraphSelectionTarget =
  | { kind: 'note'; detail: ProposalDetail | null | undefined; onExtract: () => void }
  | { kind: 'transcript'; transcriptId: string; onShowNotes: () => void };

export interface GraphSelectionAddProps {
  containerRef: RefObject<HTMLElement | null>;
  resolve: (range: Range, container: HTMLElement) => SelectionResolution;
  enabled: boolean;
  target: GraphSelectionTarget;
  /** The row was added to `proposalId`; open the sheet on it. */
  onAdded: (result: PatchProposalItemResult, proposalId: string) => void;
  onReload?: () => void;
}

type Stage =
  | { step: 'idle' }
  | { step: 'choose'; selection: GraphSelection; drafts: ProposalSummary[] | null; error: string | null }
  | { step: 'add'; selection: GraphSelection; detail: ProposalDetail };

export function GraphSelectionAdd({ containerRef, resolve, enabled, target, onAdded, onReload }: GraphSelectionAddProps) {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  const [stage, setStage] = useState<Stage>({ step: 'idle' });
  const busy = stage.step !== 'idle';
  const { selection, refusal, clear } = useTextSelection(containerRef, resolve, { enabled: enabled && !busy });
  const { ontology } = useGraphOntology({ enabled: stage.step === 'add' });

  const close = useCallback(() => setStage({ step: 'idle' }), []);

  const openDraft = useCallback(async (frozen: GraphSelection, proposalId: string) => {
    try {
      const detail = await getProposal(proposalId);
      setStage({ step: 'add', selection: frozen, detail });
    } catch (err) {
      setStage({
        step: 'choose',
        selection: frozen,
        drafts: [],
        error: err instanceof ApiError && err.message ? err.message : 'That draft could not be loaded',
      });
    }
  }, []);

  const start = useCallback(
    async (frozen: GraphSelection) => {
      clear();
      if (target.kind === 'note') {
        const detail = target.detail;
        if (detail && detail.proposal.status === 'draft') {
          setStage({ step: 'add', selection: frozen, detail });
        } else {
          setStage({ step: 'choose', selection: frozen, drafts: [], error: null });
        }
        return;
      }
      setStage({ step: 'choose', selection: frozen, drafts: null, error: null });
      try {
        const { items } = await listProposals({ status: 'draft', transcriptId: target.transcriptId, limit: 20 });
        if (items.length === 1) {
          await openDraft(frozen, items[0].id);
          return;
        }
        setStage({ step: 'choose', selection: frozen, drafts: items, error: null });
      } catch (err) {
        setStage({
          step: 'choose',
          selection: frozen,
          drafts: [],
          error: err instanceof ApiError && err.message ? err.message : 'Your drafts could not be loaded',
        });
      }
    },
    [clear, openDraft, target],
  );

  return (
    <>
      {enabled && !busy && (
        <SelectionAddButton
          selection={selection}
          refusal={refusal}
          compact={compact}
          onAdd={(frozen) => void start(frozen)}
        />
      )}

      {stage.step === 'choose' && (
        <TargetProposalDialog
          open
          onClose={close}
          drafts={stage.drafts}
          error={stage.error}
          fullScreen={compact}
          onPick={(proposalId) => void openDraft(stage.selection, proposalId)}
          onExtract={
            target.kind === 'note'
              ? () => {
                  close();
                  target.onExtract();
                }
              : undefined
          }
          onShowNotes={
            target.kind === 'transcript'
              ? () => {
                  close();
                  target.onShowNotes();
                }
              : undefined
          }
        />
      )}

      {stage.step === 'add' && (
        <AddToGraphDialog
          open
          onClose={close}
          selection={stage.selection}
          proposalId={stage.detail.proposal.id}
          items={stage.detail.items}
          ontology={ontology}
          fullScreen={compact}
          onReload={onReload}
          onAdded={(result, proposalId) => {
            close();
            onAdded(result, proposalId);
          }}
        />
      )}
    </>
  );
}

export default GraphSelectionAdd;
