/**
 * The visual (WYSIWYG) note editor — issue #334.
 *
 * A VIEW OVER THE SAME MARKDOWN STRING, never a second source of truth. The
 * parent (`NoteBodyEditor`, and above it `NotePage`) owns the draft as a
 * markdown string; this component parses that string into a Tiptap document
 * and, on every REAL user edit, serialises the document back to markdown with
 * `@tiptap/markdown`'s `editor.getMarkdown()` and hands it up through
 * `onChange`. Markdown stays the storage and export format.
 *
 * =============================================================================
 * ⚠ OPENING THE EDITOR MUST NOT DIRTY THE DRAFT
 * =============================================================================
 *
 * Tiptap's serialiser is not byte-for-byte faithful to arbitrary input — it may
 * re-spell a `*` bullet as `-`, re-escape a character, or normalise blank
 * lines. If the initial parse emitted `onChange`, merely opening a note would
 * light up Save with a "change" the user never made. So:
 *
 * - the initial content is set without emitting;
 * - `onUpdate` only fires for document-changing transactions, i.e. real edits;
 * - an EXTERNAL change of `value` (the Markdown tab edited it, or the parent
 *   reset the draft) is applied with `emitUpdate: false`, and a value this
 *   editor itself just emitted is recognised and NOT re-applied — re-applying
 *   it would reset the cursor on every keystroke.
 *
 * The normalisation still happens on the first real edit — the whole body is
 * re-serialised then. Someone who needs the exact bytes edits in the Markdown
 * tab, which is a plain textarea over the source.
 *
 * Loaded lazily from `NoteBodyEditor` (`React.lazy`), so none of Tiptap or
 * ProseMirror is in the bundle a reader of a note downloads.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import Tooltip from '@mui/material/Tooltip';
import CodeIcon from '@mui/icons-material/Code';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import FormatQuoteIcon from '@mui/icons-material/FormatQuote';
import HorizontalRuleIcon from '@mui/icons-material/HorizontalRule';
import LinkIcon from '@mui/icons-material/Link';
import RedoIcon from '@mui/icons-material/Redo';
import StrikethroughSIcon from '@mui/icons-material/StrikethroughS';
import UndoIcon from '@mui/icons-material/Undo';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';

import { MARKDOWN_CONTAINER_SX } from './MarkdownView';

export interface VisualMarkdownEditorProps {
  /** The draft markdown. Owned by the parent. */
  value: string;
  /** Called with re-serialised markdown after a real user edit — never on load. */
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Element typography mirroring `MarkdownView`'s `COMPONENTS` map, so the
 * visual editor and the read view agree on what a heading or a paragraph looks
 * like. Tiptap renders raw elements, hence selectors rather than components.
 */
const EDITOR_SURFACE_SX = {
  ...MARKDOWN_CONTAINER_SX,
  '& .ProseMirror': {
    // ~14 rows of body text, matching the Markdown tab's textarea.
    minHeight: 280,
    outline: 'none',
    px: { xs: 1.5, sm: 2 },
    py: 1.5,
    overflowWrap: 'anywhere',
  },
  '& .ProseMirror > :first-of-type': { mt: 0 },
  '& h1': { typography: 'h6', mt: 2, mb: 1 },
  '& h2': { typography: 'subtitle1', mt: 2, mb: 1, fontWeight: 600 },
  '& h3': { typography: 'subtitle2', mt: 2, mb: 0.5, fontWeight: 600 },
  '& h4, & h5, & h6': { typography: 'subtitle2', mt: 1.5, mb: 0.5 },
  '& p': { typography: 'body2', mt: 0, mb: 1.5 },
  '& li': { typography: 'body2', mb: 0.5 },
  '& li > p': { mb: 0 },
  '& hr': { border: 0, borderTop: 1, borderColor: 'divider', my: 2 },
  '& a': { color: 'primary.main' },
  '& blockquote': {
    borderLeft: 3,
    borderColor: 'divider',
    pl: 2,
    my: 1.5,
    mx: 0,
    color: 'text.secondary',
  },
  '& pre code': { bgcolor: 'transparent', px: 0 },
  '& .selectedCell': { bgcolor: 'action.selected' },
} as const;

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  code: boolean;
  link: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

function readToolbarState(editor: Editor | null): ToolbarState {
  const is = (name: string, attrs?: Record<string, unknown>) =>
    editor ? editor.isActive(name, attrs) : false;
  return {
    bold: is('bold'),
    italic: is('italic'),
    strike: is('strike'),
    h1: is('heading', { level: 1 }),
    h2: is('heading', { level: 2 }),
    h3: is('heading', { level: 3 }),
    bulletList: is('bulletList'),
    orderedList: is('orderedList'),
    blockquote: is('blockquote'),
    code: is('code'),
    link: is('link'),
    canUndo: editor ? editor.can().undo() : false,
    canRedo: editor ? editor.can().redo() : false,
  };
}

interface ToolProps {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}

/** A toggleable tool — a ToggleButton, so `aria-pressed` is announced. */
function ToggleTool({ label, pressed = false, disabled, onClick, children }: ToolProps) {
  return (
    <Tooltip title={label}>
      <span>
        <ToggleButton
          value={label}
          size="small"
          selected={pressed}
          disabled={disabled}
          aria-label={label}
          // Keep the editor's selection: a mousedown on the button would
          // otherwise blur the editor before the command runs.
          onMouseDown={(event) => event.preventDefault()}
          onChange={(event) => onClick(event as MouseEvent<HTMLElement>)}
          sx={{ border: 0, px: 0.75, py: 0.5, minWidth: 32 }}
        >
          {children}
        </ToggleButton>
      </span>
    </Tooltip>
  );
}

/** A one-shot action (undo, rule) — nothing to press or unpress. */
function ActionTool({ label, disabled, onClick, children }: ToolProps) {
  return (
    <Tooltip title={label}>
      <span>
        <IconButton
          size="small"
          aria-label={label}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
        >
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
}

function HeadingGlyph({ level }: { level: 1 | 2 | 3 }) {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{ fontWeight: 700, fontSize: '0.8rem', lineHeight: '20px', width: 20 }}
    >
      H{level}
    </Box>
  );
}

export function VisualMarkdownEditor({
  value,
  onChange,
  disabled = false,
}: VisualMarkdownEditorProps) {
  // The callback and the last string this editor emitted, in refs so the
  // editor (created once) always reaches the current ones.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastValue = useRef(value);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Markdown has no underline, so a mark the user could apply here
        // would silently vanish on save.
        underline: false,
        link: { openOnClick: false, autolink: true },
      }),
      TableKit,
      Markdown,
    ],
    content: value,
    contentType: 'markdown',
    editable: !disabled,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Note body',
      },
    },
    // Fires only for document-changing transactions — typing, a toolbar
    // command, a paste — never for the initial parse. See the header.
    onUpdate: ({ editor: current }) => {
      // The serialiser ends every document with a blank line; a stored body
      // does not, so that tail is dropped rather than added on every save.
      const markdown = current.getMarkdown().replace(/\s+$/, '');
      lastValue.current = markdown;
      onChangeRef.current(markdown);
    },
  });

  // An EXTERNAL change (the Markdown tab, a reset) replaces the document
  // without emitting; our own echo is recognised and left alone.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastValue.current) return;
    lastValue.current = value;
    editor.commands.setContent(value, { emitUpdate: false, contentType: 'markdown' });
  }, [editor, value]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  const state =
    useEditorState({
      editor,
      selector: ({ editor: current }) => readToolbarState(current),
    }) ?? readToolbarState(null);

  // --- The link popover ------------------------------------------------------
  const [linkAnchor, setLinkAnchor] = useState<HTMLElement | null>(null);
  const [linkUrl, setLinkUrl] = useState('');

  const openLink = (event: MouseEvent<HTMLElement>) => {
    if (!editor) return;
    const current = editor.getAttributes('link').href as string | undefined;
    setLinkUrl(current ?? '');
    setLinkAnchor(event.currentTarget);
  };

  const closeLink = () => {
    setLinkAnchor(null);
    editor?.commands.focus();
  };

  const applyLink = () => {
    if (!editor) return;
    const href = linkUrl.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (href === '') chain.unsetLink().run();
    else chain.setLink({ href }).run();
    setLinkAnchor(null);
  };

  const off = disabled || !editor;
  const run = (fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => {
    if (!editor) return;
    fn(editor.chain().focus()).run();
  };

  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        '&:focus-within': { borderColor: 'primary.main' },
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <Stack
        direction="row"
        role="toolbar"
        aria-label="Formatting"
        sx={{
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 0.25,
          px: 0.5,
          py: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <ToggleTool label="Bold" pressed={state.bold} disabled={off} onClick={() => run((c) => c.toggleBold())}>
          <FormatBoldIcon fontSize="small" />
        </ToggleTool>
        <ToggleTool label="Italic" pressed={state.italic} disabled={off} onClick={() => run((c) => c.toggleItalic())}>
          <FormatItalicIcon fontSize="small" />
        </ToggleTool>
        <ToggleTool
          label="Strikethrough"
          pressed={state.strike}
          disabled={off}
          onClick={() => run((c) => c.toggleStrike())}
        >
          <StrikethroughSIcon fontSize="small" />
        </ToggleTool>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        {([1, 2, 3] as const).map((level) => (
          <ToggleTool
            key={level}
            label={`Heading ${level}`}
            pressed={state[`h${level}`]}
            disabled={off}
            onClick={() => run((c) => c.toggleHeading({ level }))}
          >
            <HeadingGlyph level={level} />
          </ToggleTool>
        ))}
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        <ToggleTool
          label="Bulleted list"
          pressed={state.bulletList}
          disabled={off}
          onClick={() => run((c) => c.toggleBulletList())}
        >
          <FormatListBulletedIcon fontSize="small" />
        </ToggleTool>
        <ToggleTool
          label="Numbered list"
          pressed={state.orderedList}
          disabled={off}
          onClick={() => run((c) => c.toggleOrderedList())}
        >
          <FormatListNumberedIcon fontSize="small" />
        </ToggleTool>
        <ToggleTool
          label="Quote"
          pressed={state.blockquote}
          disabled={off}
          onClick={() => run((c) => c.toggleBlockquote())}
        >
          <FormatQuoteIcon fontSize="small" />
        </ToggleTool>
        <ToggleTool label="Code" pressed={state.code} disabled={off} onClick={() => run((c) => c.toggleCode())}>
          <CodeIcon fontSize="small" />
        </ToggleTool>
        <ToggleTool label="Link" pressed={state.link} disabled={off} onClick={openLink}>
          <LinkIcon fontSize="small" />
        </ToggleTool>
        <ActionTool label="Horizontal rule" disabled={off} onClick={() => run((c) => c.setHorizontalRule())}>
          <HorizontalRuleIcon fontSize="small" />
        </ActionTool>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        <ActionTool label="Undo" disabled={off || !state.canUndo} onClick={() => run((c) => c.undo())}>
          <UndoIcon fontSize="small" />
        </ActionTool>
        <ActionTool label="Redo" disabled={off || !state.canRedo} onClick={() => run((c) => c.redo())}>
          <RedoIcon fontSize="small" />
        </ActionTool>
      </Stack>

      <Box sx={EDITOR_SURFACE_SX}>
        <EditorContent editor={editor} />
      </Box>

      <Popover
        open={Boolean(linkAnchor)}
        anchorEl={linkAnchor}
        onClose={closeLink}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Box
          component="form"
          sx={{ p: 1.5, display: 'flex', gap: 1, alignItems: 'center', width: { xs: 280, sm: 360 } }}
          onSubmit={(event) => {
            event.preventDefault();
            applyLink();
          }}
        >
          <TextField
            size="small"
            fullWidth
            autoFocus
            label="Link URL"
            placeholder="https://"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            helperText="Leave empty to remove the link."
          />
          <Button type="submit" size="small" variant="contained" sx={{ flexShrink: 0, alignSelf: 'flex-start', mt: 0.5 }}>
            Apply
          </Button>
        </Box>
      </Popover>
    </Box>
  );
}

export default VisualMarkdownEditor;
