/**
 * The note body editor — issue #58, epic #45; reworked by issue #334.
 *
 * =============================================================================
 * #58 CHOSE A TEXTAREA. #334 REVERSES THAT, AT THE USER'S REQUEST.
 * =============================================================================
 *
 * #58 shipped a markdown textarea plus a preview and rejected a WYSIWYG layer
 * explicitly: markdown is the storage format (`notes.body`), the model's own
 * output format and the source every exporter renders from
 * (`notes/export/markdown-ast.ts`), and a rich-text layer means a conversion
 * in both directions. Issue #334 reverses that decision at the user's request —
 * editing headings and lists by hand in raw markup was the friction — and adds
 * a Tiptap-based visual editor (`VisualMarkdownEditor`) as the default view.
 *
 * WHAT DID NOT CHANGE: markdown is still the storage and export format. The
 * visual editor is a VIEW over the same string the Markdown tab edits; there is
 * one draft, owned by the parent, and all three views read and write it.
 *
 * ⚠ ROUND-TRIP NORMALISATION. Tiptap re-serialises the whole document on an
 * edit, so the first visual edit may re-spell bullets (`*` → `-`), escaping or
 * blank lines elsewhere in the body. Merely OPENING the visual view never does
 * this — the draft becomes dirty only after a real edit (see
 * `VisualMarkdownEditor`'s header). The Markdown tab edits the source exactly,
 * byte for byte, for anyone who needs that.
 *
 * The Preview uses the same renderer as the read view (`MarkdownView`),
 * because a preview drawn by a second renderer can disagree with the page it
 * is previewing.
 *
 * =============================================================================
 * PLAIN-TEXT NOTES HAVE NO VIEWS
 * =============================================================================
 *
 * A note whose `bodyFormat` is `plain_text` has no markup to render or edit
 * visually, so the toggle is not shown at all: one textarea, in the body font
 * rather than monospace, because nothing about its alignment carries meaning.
 *
 * =============================================================================
 * THE TOGGLE IS KEYBOARD-OPERABLE AND SAYS WHICH VIEW IS SHOWING
 * =============================================================================
 *
 * A `ToggleButtonGroup` of real buttons with an accessible group name —
 * reachable by Tab, operable by Enter/Space, `aria-pressed` from `selected`.
 * Switching views never loses text: the parent's `value` is the only copy.
 */

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { lazy, Suspense } from 'react';

import { MarkdownView } from './MarkdownView';
import type { NoteBodyFormat } from '../../services/noteTemplates';

// Lazy: Tiptap and ProseMirror load only when somebody opens the editor, never
// on the read-only note page.
const VisualMarkdownEditor = lazy(() => import('./VisualMarkdownEditor'));

/**
 * Which view of the markdown draft is on screen. `'write'` is the raw
 * markdown textarea (labelled "Markdown"); the name predates #334 and is kept
 * to avoid churn.
 */
export type NoteEditorView = 'visual' | 'write' | 'preview';

export interface NoteBodyEditorProps {
  /** The draft body. The PARENT owns it — this component holds no copy. */
  value: string;
  onChange: (value: string) => void;
  view: NoteEditorView;
  onViewChange: (view: NoteEditorView) => void;
  /** The note's body format. Absent means `markdown`. */
  bodyFormat?: NoteBodyFormat;
  /** While a save is in flight. The text stays readable, just not editable. */
  disabled?: boolean;
}

export function NoteBodyEditor({
  value,
  onChange,
  view,
  onViewChange,
  bodyFormat = 'markdown',
  disabled = false,
}: NoteBodyEditorProps) {
  if (bodyFormat === 'plain_text') {
    return (
      <Box>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1.5 }}>
          This note is plain text — what you type is exactly what is saved.
        </Typography>
        <TextField
          multiline
          fullWidth
          minRows={14}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          label="Note"
        />
      </Box>
    );
  }

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          mb: 1.5,
        }}
      >
        <Typography variant="caption" color="text.secondary">
          This note is markdown. Headings, lists and tables all work.
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={view}
          // ⚠ `null` arrives when the user clicks the already-selected button;
          // ignoring it keeps a view always selected.
          onChange={(_event, next: NoteEditorView | null) => {
            if (next) onViewChange(next);
          }}
          aria-label="Editor view"
        >
          <ToggleButton value="visual" aria-label="Visual">
            Visual
          </ToggleButton>
          <ToggleButton value="write" aria-label="Markdown">
            Markdown
          </ToggleButton>
          <ToggleButton value="preview" aria-label="Preview">
            Preview
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {view === 'visual' ? (
        <Suspense
          fallback={
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress size={28} aria-label="Loading the editor" />
            </Box>
          }
        >
          <VisualMarkdownEditor value={value} onChange={onChange} disabled={disabled} />
        </Suspense>
      ) : view === 'write' ? (
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
