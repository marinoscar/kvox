/**
 * The markdown editor — issue #58, epic #45.
 *
 * =============================================================================
 * ⚠ A TEXTAREA, NOT A WYSIWYG, AND THAT IS A DESIGN DECISION
 * =============================================================================
 *
 * Markdown is the storage format (`notes.body`), the model's own output format,
 * and the source every exporter renders from (`notes/export/markdown-ast.ts`).
 * A rich-text layer in the middle would mean a lossy conversion in BOTH
 * directions on every save — markdown in, a document model, markdown back out —
 * for no capability this feature needs. #58 rejects it explicitly, and the
 * repository has a documented reluctance to add dependencies of that size.
 *
 * So the editor is the markdown, and the PREVIEW is how a user sees what it
 * will look like. Same renderer as the read view (`MarkdownView`), because a
 * preview drawn by a second renderer is a preview that can disagree with the
 * page it is previewing.
 *
 * =============================================================================
 * BOTH HALVES ARE KEYBOARD-OPERABLE, AND THE TOGGLE SAYS WHICH IS SHOWING
 * =============================================================================
 *
 * The toggle is a `ToggleButtonGroup` of two real buttons in a group with an
 * accessible name, so it is reachable by Tab and operable by Enter/Space —
 * rather than an icon button whose pressed state a screen reader cannot read.
 * `aria-pressed` comes from MUI's `selected`, so the state is announced rather
 * than only coloured.
 *
 * The textarea keeps its value when the preview is shown: switching to the
 * preview and back must not be a way to lose a paragraph. That is why the
 * preview is a SIBLING that replaces the textarea in the layout while the
 * component's own `value` prop stays the single source of truth — the parent
 * owns the draft, and this component never holds a second copy of it.
 */

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

import { MarkdownView } from './MarkdownView';

/** Which half of the editor is on screen. */
export type NoteEditorView = 'write' | 'preview';

export interface NoteBodyEditorProps {
  /** The draft markdown. The PARENT owns it — this component holds no copy. */
  value: string;
  onChange: (value: string) => void;
  view: NoteEditorView;
  onViewChange: (view: NoteEditorView) => void;
  /** While a save is in flight. The text stays readable, just not editable. */
  disabled?: boolean;
}

export function NoteBodyEditor({
  value,
  onChange,
  view,
  onViewChange,
  disabled = false,
}: NoteBodyEditorProps) {
  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}
      >
        <Typography variant="caption" color="text.secondary">
          This note is markdown. Headings, lists and tables all work.
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={view}
          // ⚠ `null` arrives when the user clicks the already-selected button;
          // ignoring it keeps a view always selected rather than leaving the
          // editor showing neither half.
          onChange={(_event, next: NoteEditorView | null) => {
            if (next) onViewChange(next);
          }}
          aria-label="Editor view"
        >
          <ToggleButton value="write" aria-label="Write">
            Write
          </ToggleButton>
          <ToggleButton value="preview" aria-label="Preview">
            Preview
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {view === 'write' ? (
        <TextField
          multiline
          fullWidth
          minRows={14}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          label="Note"
          // A monospace body, because the thing being edited is markup whose
          // alignment (tables, nested lists) carries meaning.
          slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: '0.875rem' } } }}
        />
      ) : (
        <Box
          data-testid="note-preview"
          sx={{ borderRadius: 1, border: 1, borderColor: 'divider', p: { xs: 2, sm: 3 } }}
        >
          {value.trim() ? (
            // ⚠ THE SAME RENDERER THE READ VIEW USES — raw HTML disabled, so a
            // `<script>` a user pastes into their own note is inert text here
            // exactly as model output is.
            <MarkdownView>{value}</MarkdownView>
          ) : (
            <Typography color="text.secondary">
              Nothing to preview yet — this note is empty.
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}

export default NoteBodyEditor;
