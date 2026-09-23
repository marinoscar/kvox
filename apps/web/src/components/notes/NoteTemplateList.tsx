/**
 * The template list — the caller's own and the seeded built-ins, in one list.
 * Issue #56, epic #45.
 *
 * =============================================================================
 * ⚠ A BUILT-IN HAS NO EDIT AFFORDANCE — ABSENT, NOT DISABLED
 * =============================================================================
 *
 * This is the issue's own wording and it is a deliberate departure from the
 * usual "render it disabled so the layout stays even" instinct. A greyed-out
 * Edit button on a built-in row is a control the user cannot explain: it says
 * *this is a thing you could do, but not now*, invites a hunt for the
 * precondition, and the precondition does not exist — a built-in is immutable
 * under every role, permanently, and `PATCH` answers **403** to everybody.
 *
 * What the user actually wants is the path that DOES work, so the row offers it
 * instead: **Duplicate**, on every row including built-ins, which is precisely
 * how the API says a built-in is customised. The affordance that is present is
 * the one that succeeds.
 *
 * Archive follows the same rule for the same reason.
 *
 * =============================================================================
 * THE TWO KINDS ARE VISUALLY DISTINGUISHED, AND NOT BY THE ABSENT BUTTON
 * =============================================================================
 *
 * "Built-in" is a chip on the row, not merely the absence of controls: a user
 * must be able to tell WHY this row is different before they go looking for the
 * button that is not there. The chip carries a title/`aria-label` sentence
 * rather than one word, so the explanation is available to a screen reader too.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

import { NOTE_OUTPUT_FORMAT_LABELS } from '../../services/noteTemplates';
import type { NoteTemplate } from '../../services/noteTemplates';

export interface NoteTemplateListProps {
  templates: NoteTemplate[];
  busy: boolean;
  onEdit: (template: NoteTemplate) => void;
  onDuplicate: (template: NoteTemplate) => void;
  onArchive: (template: NoteTemplate) => void;
  /**
   * Hide a shown row, or show a hidden one (issue #311). Offered on EVERY row,
   * built-ins included: hiding is the viewer's preference, not an edit of the
   * template, so the "absent, not disabled" rule for Edit does not apply.
   */
  onToggleHidden?: (template: NoteTemplate) => void;
  /** Rows whose hide/show request is in flight; their toggle is disabled. */
  pendingIds?: ReadonlySet<string>;
}

export function NoteTemplateList({
  templates,
  busy,
  onEdit,
  onDuplicate,
  onArchive,
  onToggleHidden,
  pendingIds,
}: NoteTemplateListProps) {
  if (templates.length === 0) {
    return (
      <Typography color="text.secondary">
        No templates yet. Create one to describe the notes you want.
      </Typography>
    );
  }

  return (
    <Stack component="ul" spacing={2} sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {templates.map((template) => (
        <Paper key={template.id} component="li" variant="outlined" sx={{ p: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ alignItems: { sm: 'flex-start' } }}
          >
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                {/* A hidden row's name is secondary TEXT colour rather than a
                    faded row: opacity would drop the contrast of the controls
                    too, which still work. */}
                <Typography
                  variant="subtitle1"
                  component="h3"
                  color={template.hidden ? 'text.secondary' : undefined}
                >
                  {template.name}
                </Typography>
                {template.builtIn && (
                  <Chip
                    size="small"
                    label="Built-in"
                    // The chip is the EXPLANATION for the missing Edit button,
                    // so it carries a sentence rather than a word for anyone
                    // who cannot see the row's shape.
                    aria-label="Built-in template. Duplicate it to make an editable copy."
                    title="Built-in template. Duplicate it to make an editable copy."
                  />
                )}
                {template.isArchived && <Chip size="small" label="Archived" color="warning" />}
                {template.hidden && <Chip size="small" label="Hidden" variant="outlined" />}
              </Stack>

              {template.description && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {template.description}
                </Typography>
              )}

              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                {NOTE_OUTPUT_FORMAT_LABELS[template.outputFormat]}
                {template.structure.length > 0 &&
                  ` · ${template.structure.length} section${template.structure.length === 1 ? '' : 's'}`}
                {template.model && ` · ${template.model}`}
              </Typography>
            </Box>

            <Stack
              direction="row"
              spacing={1}
              sx={{ flexShrink: 0, flexWrap: 'wrap', alignItems: 'center' }}
            >
              {onToggleHidden && (
                <Tooltip
                  title={template.hidden ? 'Show in template pickers' : 'Hide from template pickers'}
                >
                  {/* The span keeps the tooltip working while the button is
                      disabled (MUI cannot attach listeners to a disabled one). */}
                  <span>
                    <IconButton
                      size="small"
                      aria-pressed={template.hidden}
                      aria-label={`${template.hidden ? 'Show' : 'Hide'} ${template.name}`}
                      onClick={() => onToggleHidden(template)}
                      disabled={pendingIds?.has(template.id) ?? false}
                    >
                      {template.hidden ? <VisibilityIcon /> : <VisibilityOffIcon />}
                    </IconButton>
                  </span>
                </Tooltip>
              )}
              {/* ⚠ ONLY on owned rows. See the header — a built-in's Edit is
                  absent, not disabled. */}
              {!template.builtIn && (
                <Button
                  size="small"
                  startIcon={<EditOutlinedIcon />}
                  onClick={() => onEdit(template)}
                  disabled={busy}
                >
                  Edit
                </Button>
              )}

              {/* On EVERY row, including built-ins: this is how a built-in is
                  customised, per the API's own `duplicate` description. */}
              <Button
                size="small"
                startIcon={<ContentCopyIcon />}
                onClick={() => onDuplicate(template)}
                disabled={busy}
              >
                Duplicate
              </Button>

              {!template.builtIn && !template.isArchived && (
                <Button
                  size="small"
                  color="warning"
                  startIcon={<ArchiveOutlinedIcon />}
                  onClick={() => onArchive(template)}
                  disabled={busy}
                >
                  Archive
                </Button>
              )}
            </Stack>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}

export default NoteTemplateList;
