/**
 * "Split here" — issue #31, epic #19.
 *
 * =============================================================================
 * WHY A DIALOG WITH A REAL CARET, AND NOT A SILENT SPLIT AT THE LAST CLICK
 * =============================================================================
 *
 * The obvious implementation is to remember where the caret was when the
 * overflow menu was opened and split there. It does not survive contact with
 * either surface: on a phone the menu is a bottom sheet opened from a button,
 * so there is no caret at all; on desktop, opening a menu blurs the field and
 * the remembered offset is from whenever the user last happened to click.
 *
 * So the split point is chosen HERE, in a field that shows the whole segment
 * and reports its own selection. It opens at the caret when there was one and
 * at the nearest word boundary to the middle otherwise, which is almost always
 * wrong and always obvious — the two halves are previewed underneath, so
 * "wrong" is something the user can see before committing rather than undo
 * afterwards.
 *
 * The second half's speaker is optional and defaults to "same as the first",
 * because the common split is one person's sentence wrongly glued to the next
 * and the SECOND common one is two people glued together.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { TranscriptSegment, TranscriptSpeaker } from '../../services/transcripts';

/**
 * The nearest space at or before `from`, so a default split never lands inside
 * a word. Falls back to `from` when the text has no space before it at all.
 */
export function nearestWordBoundary(text: string, from: number): number {
  const clamped = Math.max(0, Math.min(text.length, from));
  const before = text.lastIndexOf(' ', clamped);
  if (before > 0) return before + 1;
  const after = text.indexOf(' ', clamped);
  return after > 0 ? after + 1 : clamped;
}

interface SplitSegmentDialogProps {
  open: boolean;
  segment: TranscriptSegment | null;
  speakers: readonly TranscriptSpeaker[];
  /** The caret the editor last reported, when the row was being edited. */
  initialOffset?: number | null;
  onClose: () => void;
  onSplit: (atCharOffset: number, newSpeakerId: string | null) => void;
}

export function SplitSegmentDialog({
  open,
  segment,
  speakers,
  initialOffset,
  onClose,
  onSplit,
}: SplitSegmentDialogProps) {
  const [offset, setOffset] = useState(0);
  const [newSpeakerId, setNewSpeakerId] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open || !segment) return;
    const start =
      initialOffset && initialOffset > 0 && initialOffset < segment.text.length
        ? initialOffset
        : nearestWordBoundary(segment.text, Math.floor(segment.text.length / 2));
    setOffset(start);
    setNewSpeakerId('');
  }, [initialOffset, open, segment]);

  const syncCaret = useCallback(() => {
    const element = fieldRef.current;
    if (element) setOffset(element.selectionStart ?? 0);
  }, []);

  if (!segment) return null;

  const head = segment.text.slice(0, offset).trimEnd();
  const tail = segment.text.slice(offset).trimStart();
  // An empty half is not a split, it is a no-op with an extra row. The API
  // would accept it, which is exactly why the client should not send it.
  const valid = head.length > 0 && tail.length > 0;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Split this segment</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Put the cursor where the split should happen.
        </DialogContentText>
        <TextField
          inputRef={fieldRef}
          label="Segment text"
          value={segment.text}
          multiline
          fullWidth
          // Read-only rather than disabled: a disabled field is not focusable,
          // and the entire point is to place a caret in it.
          slotProps={{ htmlInput: { readOnly: true } }}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onClick={syncCaret}
        />

        <TextField
          select
          fullWidth
          margin="normal"
          label="Second part's speaker"
          value={newSpeakerId}
          onChange={(event) => setNewSpeakerId(event.target.value)}
        >
          <MenuItem value="">Same as the first part</MenuItem>
          {speakers.map((speaker) => (
            <MenuItem key={speaker.id} value={speaker.id}>
              {speaker.displayName}
            </MenuItem>
          ))}
        </TextField>

        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary">
            Preview
          </Typography>
          <Typography variant="body2" sx={{ mt: 0.5 }} data-testid="split-preview-first">
            {head || <em>(empty)</em>}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }} data-testid="split-preview-second">
            {tail || <em>(empty)</em>}
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!valid}
          onClick={() => {
            onSplit(offset, newSpeakerId || null);
            onClose();
          }}
        >
          Split
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default SplitSegmentDialog;
