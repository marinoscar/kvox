/**
 * The context-attachments field and its read-only list (#810).
 *
 * `ContextAttachmentsField` renders a {@link UseContextAttachmentsResult}: a keyboard-operable
 * "Attach files" button over a hidden multiple file input, a drop zone around it, and one row
 * per file with its kind, name, state and a remove button. All logic (upload, polling, the
 * limit, the error sentences) is the headless hook's; this file only draws it.
 *
 * `ContextAttachmentList` is the read-only list the "How this note was generated" panel and
 * the "Context sent to the AI" dialog show. There is no download route, so a row is a name,
 * not a link.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloseIcon from '@mui/icons-material/Close';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import { useId, useRef, useState } from 'react';
import type { DragEvent, ReactElement } from 'react';

import type { UseContextAttachmentsResult } from '../../headless/hooks/useContextAttachments.js';
import type { NoteContextAttachment, NoteContextAttachmentKind } from '../../headless/clients/notes.js';
import {
  MAX_CONTEXT_ATTACHMENTS,
  NOTE_CONTEXT_ATTACHMENT_ACCEPT,
} from '../../headless/utils/contextAttachments.js';
import type { ContextAttachmentItem } from '../../headless/utils/contextAttachments.js';
import { visuallyHidden } from '../visuallyHidden.js';

function KindIcon({ kind }: { kind: NoteContextAttachmentKind | null }): ReactElement {
  if (kind === 'image') return <ImageOutlinedIcon fontSize="small" aria-hidden />;
  if (kind === 'document') return <DescriptionOutlinedIcon fontSize="small" aria-hidden />;
  return <InsertDriveFileOutlinedIcon fontSize="small" aria-hidden />;
}

/** The file name, with its kind spoken first to a screen reader (the icon is decorative). */
function FileName({ kind, filename }: { kind: NoteContextAttachmentKind | null; filename: string }): ReactElement {
  return (
    <>
      <Box component="span" sx={visuallyHidden}>
        {`${kindLabel(kind)}: `}
      </Box>
      {filename}
    </>
  );
}

function kindLabel(kind: NoteContextAttachmentKind | null): string {
  return kind === 'image' ? 'Image' : kind === 'document' ? 'Document' : 'File';
}

function statusText(item: ContextAttachmentItem): string {
  switch (item.status) {
    case 'uploading':
      return 'Uploading…';
    case 'extracting':
      return 'Reading the document…';
    case 'failed':
      return item.error ?? 'This file could not be attached.';
    case 'ready':
    default:
      if (item.kind === 'image') return 'Ready · image';
      return item.characters !== null
        ? `Ready · ${item.characters.toLocaleString()} characters of text`
        : 'Ready';
  }
}

function StatusIndicator({ item }: { item: ContextAttachmentItem }): ReactElement {
  if (item.status === 'uploading' || item.status === 'extracting') {
    return <CircularProgress size={18} aria-hidden />;
  }
  if (item.status === 'failed') return <ErrorOutlineIcon color="error" fontSize="small" aria-hidden />;
  return <CheckCircleIcon color="success" fontSize="small" aria-hidden />;
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Props of {@link ContextAttachmentsField}.
 *
 * @stability experimental
 */
export interface ContextAttachmentsFieldProps {
  /** The state, from `useContextAttachments`. */
  attachments: UseContextAttachmentsResult;
  /** Disables adding and removing (while a submit is in flight). */
  disabled?: boolean;
  /** The field's label. Default "Attachments (optional)". */
  label?: string;
}

/**
 * Attach files to a note's context: a button, a drop zone, and a row per file.
 *
 * @param props - See {@link ContextAttachmentsFieldProps}.
 * @returns The field.
 * @stability experimental
 */
export function ContextAttachmentsField({
  attachments,
  disabled = false,
  label = 'Attachments (optional)',
}: ContextAttachmentsFieldProps): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isOver, setIsOver] = useState(false);
  const depth = useRef(0);
  const labelId = useId();
  const helpId = useId();
  const { items, addFiles, remove, remaining, notice, dismissNotice, blockingReason } = attachments;
  const full = remaining === 0;
  const canAdd = !disabled && !full;

  const onDragEnter = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depth.current += 1;
    if (canAdd) setIsOver(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = canAdd ? 'copy' : 'none';
  };
  const onDragLeave = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.stopPropagation();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setIsOver(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depth.current = 0;
    setIsOver(false);
    if (!canAdd) return;
    // A dropped folder arrives as a zero-byte entry with no type: leave it out.
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.size > 0 || file.type !== '');
    if (files.length > 0) addFiles(files);
  };

  return (
    <Box role="group" aria-labelledby={labelId} aria-describedby={helpId}>
      <Typography id={labelId} variant="subtitle2" component="h3" sx={{ mb: 1 }}>
        {label}
      </Typography>

      <Box
        data-testid="context-attachments-drop-zone"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        sx={{
          border: 1,
          borderStyle: 'dashed',
          borderColor: isOver ? 'primary.main' : 'divider',
          borderRadius: 1,
          bgcolor: isOver ? 'action.hover' : 'transparent',
          p: { xs: 1.5, sm: 2 },
          position: 'relative',
          transition: 'background-color 120ms, border-color 120ms',
        }}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 1, sm: 2 }}
          sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          <Button
            variant="outlined"
            startIcon={<AttachFileIcon />}
            onClick={() => inputRef.current?.click()}
            disabled={!canAdd}
          >
            Attach files
          </Button>
          <Typography variant="body2" color="text.secondary">
            {full
              ? `${MAX_CONTEXT_ATTACHMENTS} of ${MAX_CONTEXT_ATTACHMENTS} files attached`
              : `or drop files here · ${items.length} of ${MAX_CONTEXT_ATTACHMENTS}`}
          </Typography>
        </Stack>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={NOTE_CONTEXT_ATTACHMENT_ACCEPT}
          // Labelled and off-screen rather than `display: none`, like the document chooser on
          // the new-note form: the button above is what a pointer or keyboard user operates.
          aria-label="Choose context files"
          tabIndex={-1}
          disabled={!canAdd}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
          onChange={(event) => {
            const files = event.target.files;
            if (files && files.length > 0) addFiles(Array.from(files));
            // Cleared so choosing the same file again (after removing it) fires a change.
            event.target.value = '';
          }}
        />

        {items.length > 0 && (
          <List dense aria-label="Attached files" sx={{ mt: 1, py: 0 }}>
            {items.map((item) => (
              <ListItem
                key={item.key}
                disableGutters
                secondaryAction={
                  <IconButton
                    edge="end"
                    size="small"
                    aria-label={`Remove ${item.filename}`}
                    onClick={() => remove(item.key)}
                    disabled={disabled}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                }
                sx={{ pr: 5 }}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <KindIcon kind={item.kind} />
                </ListItemIcon>
                <ListItemText
                  primary={<FileName kind={item.kind} filename={item.filename} />}
                  secondary={statusText(item)}
                  slotProps={{
                    primary: { sx: { overflowWrap: 'anywhere' } },
                    secondary: {
                      color: item.status === 'failed' ? 'error' : 'text.secondary',
                      sx: { overflowWrap: 'anywhere' },
                    },
                  }}
                />
                <Box sx={{ display: 'flex', alignItems: 'center', ml: 1 }}>
                  <StatusIndicator item={item} />
                </Box>
              </ListItem>
            ))}
          </List>
        )}
      </Box>

      <Typography id={helpId} variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5, mx: 1.75 }}>
        Up to {MAX_CONTEXT_ATTACHMENTS} files: PDF, Word, PowerPoint, Markdown, text or images. Images need a
        model that can read images.
      </Typography>

      {notice && (
        <Alert severity="warning" onClose={dismissNotice} sx={{ mt: 1 }}>
          {notice}
        </Alert>
      )}

      <Typography
        role="status"
        aria-live="polite"
        variant="caption"
        color={blockingReason ? 'warning.main' : 'text.secondary'}
        component="p"
        sx={{ mt: blockingReason ? 0.5 : 0, mx: 1.75 }}
      >
        {blockingReason ?? ''}
      </Typography>
    </Box>
  );
}

/**
 * Props of {@link ContextAttachmentList}.
 *
 * @stability experimental
 */
export interface ContextAttachmentListProps {
  /** The attachments, in the order the model saw them. */
  attachments: readonly NoteContextAttachment[];
  /** The list's accessible name. Default "Attached files". */
  label?: string;
}

/**
 * A read-only list of context attachments: an icon by kind and the file name.
 *
 * @param props - See {@link ContextAttachmentListProps}.
 * @returns The list, or nothing when there are no attachments.
 * @stability experimental
 */
export function ContextAttachmentList({
  attachments,
  label = 'Attached files',
}: ContextAttachmentListProps): ReactElement | null {
  if (attachments.length === 0) return null;
  return (
    <List dense disablePadding aria-label={label}>
      {attachments.map((attachment) => (
        <ListItem key={attachment.objectId} disableGutters sx={{ py: 0.25 }}>
          <ListItemIcon sx={{ minWidth: 32 }}>
            <KindIcon kind={attachment.kind} />
          </ListItemIcon>
          <ListItemText
            primary={<FileName kind={attachment.kind} filename={attachment.filename} />}
            slotProps={{ primary: { variant: 'body2', sx: { overflowWrap: 'anywhere' } } }}
          />
        </ListItem>
      ))}
    </List>
  );
}
