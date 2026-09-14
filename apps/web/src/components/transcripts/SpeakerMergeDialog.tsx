/**
 * "Merge speakers" — issue #31, epic #19.
 *
 * The vision names one failure by name: the AI splits one person into
 * "Speaker 1" and "Speaker 3", and putting them back together must be the
 * easiest thing on the screen. This dialog is the DESKTOP half of that (tick
 * two or more in the Speakers panel, then Merge); the phone half is three taps
 * through `SpeakerActions` and deliberately has no dialog at all, because a
 * confirmation step that an Undo snackbar already covers is a tap spent on
 * nothing.
 *
 * =============================================================================
 * THE SURVIVING SPEAKER AND THE SURVIVING NAME ARE TWO DIFFERENT QUESTIONS
 * =============================================================================
 *
 * A merge re-points every source speaker's segments onto the target and deletes
 * the sources. Which row survives therefore decides which COLOUR most of the
 * transcript keeps — a speaker's `colorIndex` is stable for its lifetime and is
 * the cue that makes the transcript scannable at all. So the target is chosen
 * by the application, not the user: the selected speaker with the most segments
 * wins, which is the choice that repaints the fewest lines.
 *
 * The NAME is the user's question, and it is the only one the dialog asks. When
 * the chosen name is not the target's, the API's own `keepName: false` does
 * exactly the right thing — it adopts the FIRST `sourceIds` entry's name onto
 * the target — so the plan below puts that speaker first. That is why
 * `keepName` is always sent explicitly and never left to default.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useState } from 'react';

import type { TranscriptSpeaker } from '../../services/transcripts';

export interface SpeakerMergePlan {
  targetId: string;
  /** Sources in send order — the name-holder first when it is not the target. */
  sourceIds: string[];
  keepName: boolean;
}

/**
 * Turn "merge these, keep that name" into the op the API takes.
 *
 * Pure and exported because it is the one piece of merge logic worth asserting
 * directly: the colour-stability rule (biggest speaker survives) and the
 * `keepName` inversion are both invisible in a rendered dialog.
 */
export function planSpeakerMerge(
  selectedIds: readonly string[],
  segmentCounts: ReadonlyMap<string, number>,
  keepNameOfId: string,
  order: readonly string[],
): SpeakerMergePlan | null {
  const unique = [...new Set(selectedIds)];
  if (unique.length < 2) return null;

  let targetId = unique[0];
  for (const id of unique) {
    const count = segmentCounts.get(id) ?? 0;
    const best = segmentCounts.get(targetId) ?? 0;
    // Strictly greater, so a tie keeps the EARLIER speaker — `order` is the
    // API's own speaker order, which is stable across reads, so the same
    // selection always produces the same plan.
    if (count > best) targetId = id;
    else if (count === best && order.indexOf(id) < order.indexOf(targetId)) targetId = id;
  }

  const keepName = keepNameOfId === targetId;
  const sources = unique.filter((id) => id !== targetId);
  if (!keepName) {
    const index = sources.indexOf(keepNameOfId);
    if (index > 0) {
      sources.splice(index, 1);
      sources.unshift(keepNameOfId);
    }
  }

  return { targetId, sourceIds: sources, keepName };
}

interface SpeakerMergeDialogProps {
  open: boolean;
  /** The ticked speakers, in the panel's order. */
  selected: readonly TranscriptSpeaker[];
  segmentCounts: ReadonlyMap<string, number>;
  order: readonly string[];
  onClose: () => void;
  onMerge: (plan: SpeakerMergePlan) => void;
}

export function SpeakerMergeDialog({
  open,
  selected,
  segmentCounts,
  order,
  onClose,
  onMerge,
}: SpeakerMergeDialogProps) {
  const [keepNameOfId, setKeepNameOfId] = useState('');

  const suggested = useMemo(() => {
    const plan = planSpeakerMerge(
      selected.map((speaker) => speaker.id),
      segmentCounts,
      selected[0]?.id ?? '',
      order,
    );
    return plan?.targetId ?? selected[0]?.id ?? '';
  }, [order, segmentCounts, selected]);

  useEffect(() => {
    // Default to the name of the speaker that is going to survive anyway — the
    // no-surprise answer, and the one that leaves the transcript looking
    // exactly as it did apart from the lines that moved.
    if (open) setKeepNameOfId(suggested);
  }, [open, suggested]);

  if (selected.length < 2) return null;

  const total = selected.reduce(
    (sum, speaker) => sum + (segmentCounts.get(speaker.id) ?? 0),
    0,
  );

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Merge {selected.length} speakers</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          {total} {total === 1 ? 'segment' : 'segments'} will end up on one
          speaker. You can undo this straight afterwards.
        </DialogContentText>

        <FormControl>
          <FormLabel id="merge-keep-name">Which name should it keep?</FormLabel>
          <RadioGroup
            aria-labelledby="merge-keep-name"
            value={keepNameOfId}
            onChange={(event) => setKeepNameOfId(event.target.value)}
          >
            {selected.map((speaker) => {
              const count = segmentCounts.get(speaker.id) ?? 0;
              return (
                <FormControlLabel
                  key={speaker.id}
                  value={speaker.id}
                  control={<Radio />}
                  label={
                    <Box>
                      <Typography variant="body2" component="span">
                        {speaker.displayName}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        component="span"
                        sx={{ ml: 1 }}
                      >
                        {count} {count === 1 ? 'segment' : 'segments'}
                      </Typography>
                    </Box>
                  }
                />
              );
            })}
          </RadioGroup>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            const plan = planSpeakerMerge(
              selected.map((speaker) => speaker.id),
              segmentCounts,
              keepNameOfId,
              order,
            );
            if (plan) onMerge(plan);
            onClose();
          }}
        >
          Merge
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default SpeakerMergeDialog;
