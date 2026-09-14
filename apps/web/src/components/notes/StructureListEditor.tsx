/**
 * `note_templates.structure` — the ordered list of section headings, as an
 * editable ordered list. Issue #56, epic #45.
 *
 * =============================================================================
 * ORDER IS DATA, SO THE CONTROL HAS TO EXPOSE IT
 * =============================================================================
 *
 * The API's `structureSchema` says it outright: "Order is meaningful — it is
 * the order `assemblePrompt` numbers them in the system prompt." A textarea of
 * newline-separated headings would carry the order too, but it would give the
 * user no way to MOVE one without retyping two, and no way to see that the
 * order is the thing being edited. Move-up / move-down / remove per row is the
 * smallest control that makes the ordering visible and adjustable, and it is
 * keyboard-operable by construction — which a drag handle is not.
 *
 * EMPTY ROWS ARE ALLOWED WHILE TYPING AND DROPPED ON SUBMIT. The API refuses a
 * blank entry (`z.string().trim().min(1)`), but a freshly added row IS blank
 * for as long as it takes to type into it, and refusing it at the keystroke
 * would make the control unusable. `toInlineTemplate` / `toCreateInput` in
 * `services/noteTemplates.ts` do the dropping, once, on the way out.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';

import { MAX_SECTION_CHARS, MAX_STRUCTURE_SECTIONS } from '../../services/noteTemplates';

export interface StructureListEditorProps {
  sections: string[];
  onChange: (sections: string[]) => void;
  disabled?: boolean;
}

export function StructureListEditor({
  sections,
  onChange,
  disabled = false,
}: StructureListEditorProps) {
  const setAt = (index: number, value: string) => {
    const next = [...sections];
    next[index] = value;
    onChange(next);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= sections.length) return;
    const next = [...sections];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(sections.filter((_, i) => i !== index));
  };

  return (
    <Box>
      <Typography variant="subtitle2" component="h3" id="structure-label" gutterBottom>
        Structure
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        The sections this template produces, in order. Leave it empty to let the model
        choose its own headings.
      </Typography>

      {sections.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          No sections yet.
        </Typography>
      ) : (
        // A real `<ol>`, so the order a screen-reader user hears is the order
        // the prompt will number — and so "section 3 of 5" is announced without
        // this component having to say it.
        <Stack component="ol" aria-labelledby="structure-label" spacing={1} sx={{ p: 0, m: 0, mb: 1.5, listStyle: 'none' }}>
          {sections.map((section, index) => (
            // eslint-disable-next-line react/no-array-index-key -- the index IS
            // the identity here: entries are positional, reorderable and may
            // legitimately be duplicated or blank, so there is no stabler key.
            <Stack key={index} component="li" direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <TextField
                fullWidth
                size="small"
                label={`Section ${index + 1}`}
                value={section}
                onChange={(event) => setAt(index, event.target.value)}
                disabled={disabled}
                slotProps={{ htmlInput: { maxLength: MAX_SECTION_CHARS } }}
              />
              <IconButton
                aria-label={`Move section ${index + 1} up`}
                onClick={() => move(index, -1)}
                disabled={disabled || index === 0}
                size="small"
              >
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
              <IconButton
                aria-label={`Move section ${index + 1} down`}
                onClick={() => move(index, 1)}
                disabled={disabled || index === sections.length - 1}
                size="small"
              >
                <ArrowDownwardIcon fontSize="small" />
              </IconButton>
              <IconButton
                aria-label={`Remove section ${index + 1}`}
                onClick={() => remove(index)}
                disabled={disabled}
                size="small"
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      )}

      <Button
        startIcon={<AddIcon />}
        onClick={() => onChange([...sections, ''])}
        disabled={disabled || sections.length >= MAX_STRUCTURE_SECTIONS}
        size="small"
      >
        Add section
      </Button>
    </Box>
  );
}

export default StructureListEditor;
