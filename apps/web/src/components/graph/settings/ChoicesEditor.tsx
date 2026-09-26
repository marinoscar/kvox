/**
 * The choices of a `select` / `multi_select` attribute (#369, §17.3).
 *
 * A choice has a permanent stored `value` and a renameable `label`. The user
 * only ever types labels: a NEW choice's value is derived from its label when
 * the dialog submits (`choiceValuesFor`), and an EXISTING choice's value never
 * changes. Existing choices cannot be removed — #355 refuses it, because
 * values already stored under them would lose their label — so their remove
 * button is disabled with the reason as its label.
 */

import { Box, Button, FormHelperText, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';

import type { AttributeChoice } from '../../../services/graph';

/** One row being edited. `value` is null until a new choice is submitted. */
export interface ChoiceDraft {
  /** Local React key; never sent. */
  id: string;
  value: string | null;
  label: string;
  /** Already stored on the server: renameable, never removable. */
  locked: boolean;
}

let nextDraftId = 0;
export function newChoiceDraft(choice?: AttributeChoice, locked = false): ChoiceDraft {
  nextDraftId += 1;
  return {
    id: `choice-${nextDraftId}`,
    value: choice?.value ?? null,
    label: choice?.label ?? '',
    locked,
  };
}

function slug(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

/**
 * The wire choices for a list of drafts: existing values kept, new ones
 * derived from the label and made unique.
 */
export function choiceValuesFor(drafts: ChoiceDraft[]): AttributeChoice[] {
  const used = new Set(drafts.filter((d) => d.value !== null).map((d) => d.value as string));
  return drafts.map((draft, index) => {
    if (draft.value !== null) return { value: draft.value, label: draft.label.trim() };
    const base = slug(draft.label) || `choice_${index + 1}`;
    let value = base;
    for (let n = 2; used.has(value); n += 1) value = `${base}_${n}`;
    used.add(value);
    return { value, label: draft.label.trim() };
  });
}

/** A human-readable problem with the list, or null. */
export function choicesError(drafts: ChoiceDraft[]): string | null {
  if (drafts.length === 0) return 'Add at least one choice.';
  if (drafts.some((d) => d.label.trim() === '')) return 'Every choice needs a label.';
  const labels = drafts.map((d) => d.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) return 'Choices must be different from each other.';
  return null;
}

interface ChoicesEditorProps {
  choices: ChoiceDraft[];
  onChange: (next: ChoiceDraft[]) => void;
  error?: string | null;
  disabled?: boolean;
}

export function ChoicesEditor({ choices, onChange, error, disabled }: ChoicesEditorProps) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= choices.length) return;
    const next = [...choices];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <Box component="fieldset" sx={{ border: 0, p: 0, m: 0 }}>
      <Typography component="legend" variant="subtitle2" sx={{ mb: 1 }}>
        Choices
      </Typography>
      <Stack spacing={1}>
        {choices.map((choice, index) => (
          <Stack key={choice.id} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <TextField
              size="small"
              fullWidth
              label={`Choice ${index + 1}`}
              value={choice.label}
              disabled={disabled}
              slotProps={{ htmlInput: { maxLength: 80 } }}
              onChange={(event) => {
                const next = [...choices];
                next[index] = { ...choice, label: event.target.value };
                onChange(next);
              }}
            />
            <IconButton
              size="small"
              aria-label={`Move choice ${index + 1} up`}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              aria-label={`Move choice ${index + 1} down`}
              disabled={disabled || index === choices.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownwardIcon fontSize="small" />
            </IconButton>
            <Tooltip title={choice.locked ? 'Saved choices can be renamed but not removed' : ''}>
              {/* The span keeps the tooltip working on a disabled button. */}
              <span>
                <IconButton
                  size="small"
                  aria-label={
                    choice.locked
                      ? `Choice ${index + 1} is saved and cannot be removed`
                      : `Remove choice ${index + 1}`
                  }
                  disabled={disabled || choice.locked || choices.length <= 1}
                  onClick={() => onChange(choices.filter((c) => c.id !== choice.id))}
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        ))}
      </Stack>
      <Button
        size="small"
        startIcon={<AddIcon />}
        sx={{ mt: 1 }}
        disabled={disabled || choices.length >= 100}
        onClick={() => onChange([...choices, newChoiceDraft()])}
      >
        Add choice
      </Button>
      {error && <FormHelperText error>{error}</FormHelperText>}
    </Box>
  );
}

export default ChoicesEditor;
