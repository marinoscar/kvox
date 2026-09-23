/**
 * "How this note was generated" — issue #109, epic #45.
 *
 * =============================================================================
 * ⚠ THE CONTEXT TEXT IS RENDERED NOWHERE ELSE IN THIS APPLICATION
 * =============================================================================
 *
 * `notes.context_text` is free text the user typed at `/notes/new`, it is
 * placed AHEAD of the source in the prompt for this note and every regeneration
 * of it, and until this component existed it was written once and never shown
 * again. A user reading a note six weeks later had no way to find out what they
 * had told the model — which is the single most likely explanation for a note
 * that says something surprising, and the one fact `NoteProvenance`'s sentence
 * cannot carry. That absence is the reason this panel exists; every other field
 * here is on screen because it belongs in the same answer.
 *
 * =============================================================================
 * COLLAPSED BY DEFAULT, AND THAT IS NOT A HEDGE
 * =============================================================================
 *
 * `NoteProvenance` is the sentence a reader must not have to go looking for —
 * the source, the template and the date, always visible, never in a menu (see
 * its own header). This panel is the LONG FORM of the same question: a template
 * has instructions that can run to twenty thousand characters, and putting them
 * above the note would bury the thing the page is for.
 *
 * So the two are deliberately not the same control. The sentence is always
 * there; the detail is one press away, under a heading that says what pressing
 * it gets you. A disclosure `Button` rather than an `Accordion` because the
 * whole header is the affordance and MUI's accordion summary would give us a
 * second focusable surface (the expand icon) that does the same thing.
 *
 * =============================================================================
 * EVERY BRANCH SAYS SOMETHING TRUE ABOUT THE TEMPLATE
 * =============================================================================
 *
 * A template can be deleted, archived, built-in, or simply not the caller's to
 * read any more (`useNoteTemplateDetail`'s `missing`, which is a 404 or a 403
 * and NOT an error). None of those makes the note less valid, so none of them
 * renders as a failure: each gets its own sentence, and the rows that describe
 * a recipe nobody can read are omitted rather than drawn empty. A panel that
 * showed "Instructions: —" would be asserting that the template had none.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { CopyButton } from '../common/CopyButton';

import type { UseNoteTemplateDetailResult } from '../../hooks/useNoteTemplates';
import type { Note } from '../../services/notes';
import { NOTE_OUTPUT_FORMAT_LABELS } from '../../services/noteTemplates';
import type { NoteTemplate } from '../../services/noteTemplates';
import { noteSourceFallbackLabel, noteSourcePath, noteSourceRef } from '../../utils/noteSource';

/**
 * The id `aria-controls` names.
 *
 * A constant rather than a `useId()`: exactly one of these panels is ever on a
 * note page, the value is part of the component's published contract (the
 * issue names it), and a generated id would make the relationship between the
 * button and its region unassertable by anything but a DOM walk.
 */
const PANEL_ID = 'note-generation-context';

export interface NoteGenerationContextProps {
  note: Note;
  /**
   * The source's own title, when it has been resolved.
   *
   * `null` is the ordinary case on the first frame and a permanent one for a
   * source the caller cannot read; both render the category noun, exactly as
   * `NoteProvenance` does and for the same reason — a uuid where a title
   * should be looks like the answer.
   */
  sourceName: string | null;
  template: NoteTemplate | null;
  templateState: UseNoteTemplateDetailResult['state'];
  /**
   * The sentence behind a `templateState` of `'error'`.
   *
   * Optional, and only ever read in that one state: a caller that has the
   * message should pass it, because the API's own wording is more useful than
   * anything this component could invent, and one that does not still gets a
   * true sentence.
   */
  templateError?: string | null;
  defaultExpanded?: boolean;
  /**
   * Opens the full "context sent to the AI" view (issue #308). Optional so a
   * caller that has no such view still renders the panel; without it the
   * button at the foot of the panel is not drawn.
   */
  onOpenContext?: () => void;
}

/**
 * One `dt`/`dd` pair, as two SIBLINGS.
 *
 * ⚠ NOT A WRAPPER COMPONENT RETURNING A `<div>`. A `dl` whose pairs are wrapped
 * loses the association a screen reader reads them by, so this returns a
 * fragment and the grid on the `dl` does the layout instead.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <Box component="dt" sx={{ m: 0, color: 'text.secondary', typography: 'body2' }}>
        {label}
      </Box>
      <Box component="dd" sx={{ m: 0, minWidth: 0, typography: 'body2' }}>
        {children}
      </Box>
    </>
  );
}

/**
 * A block of text the user or a template author wrote, shown as they wrote it.
 *
 * `pre-wrap` because both the instructions and the context are line-oriented —
 * collapsing their newlines would turn a numbered list of instructions into one
 * paragraph and misrepresent what the model was actually sent. Capped and
 * scrollable because a template's instructions may be twenty thousand
 * characters, and a panel that pushed the note off the screen would defeat the
 * reason it is collapsed in the first place.
 */
function TextBlock({
  children,
  copyText,
  copyLabel,
}: {
  children: React.ReactNode;
  copyText?: string;
  copyLabel?: string;
}) {
  const block = (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        whiteSpace: 'pre-wrap',
        maxHeight: 240,
        overflow: 'auto',
        borderRadius: 1,
        bgcolor: 'action.hover',
        p: 1,
      }}
    >
      {children}
    </Box>
  );

  if (copyText === undefined) return block;

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
      {block}
      <CopyButton text={copyText} label={copyLabel} variant="icon" size="small" />
    </Box>
  );
}

export function NoteGenerationContext({
  note,
  sourceName,
  template,
  templateState,
  templateError,
  defaultExpanded = false,
  onOpenContext,
}: NoteGenerationContextProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const ref = noteSourceRef(note);
  const path = noteSourcePath(note);
  const sourceLabel = ref ? (sourceName ?? noteSourceFallbackLabel(ref.type)) : null;

  return (
    <Paper variant="outlined" sx={{ mb: 2 }} data-testid="note-generation-context">
      <Button
        fullWidth
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls={PANEL_ID}
        // Left-aligned and un-capitalised: this is a heading that happens to be
        // pressable, not a call to action, and centring it would make it read
        // as the panel's primary control rather than as its title.
        sx={{
          justifyContent: 'space-between',
          textTransform: 'none',
          color: 'text.primary',
          px: 2,
          py: 1.5,
        }}
        endIcon={
          <ExpandMoreIcon
            sx={{
              transition: (theme) => theme.transitions.create('transform'),
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        }
      >
        <Typography variant="subtitle2" component="span">
          How this note was generated
        </Typography>
      </Button>

      {/* `unmountOnExit`: collapsed, this panel holds a link, a scroll region
          and up to two long text blocks — none of which a keyboard or screen
          reader user has asked for, and all of which would otherwise sit in the
          tab order behind a closed disclosure. */}
      <Collapse in={expanded} unmountOnExit>
        <Box
          id={PANEL_ID}
          component="dl"
          sx={{
            display: 'grid',
            // One column on a phone — a label above its value — and two where
            // there is room. `max-content` rather than a fixed width so the
            // longest label sets the gutter and nothing wraps mid-word.
            gridTemplateColumns: { xs: '1fr', sm: 'max-content 1fr' },
            columnGap: 2,
            rowGap: 1.5,
            m: 0,
            px: 2,
            pb: 2,
          }}
        >
          <Field label="Source">
            {sourceLabel === null ? (
              <Typography variant="body2" color="text.secondary" component="span">
                not recorded
              </Typography>
            ) : path ? (
              <Link component={RouterLink} to={path}>
                {sourceLabel}
              </Link>
            ) : (
              // ⚠ A DOCUMENT HAS NO PAGE, AND THAT IS NOT AN OVERSIGHT. An
              // uploaded source is a storage object `managed_by: 'notes'`, absent
              // from the generic storage list by construction, so this
              // application has no route that renders one — the same rule
              // `NoteProvenance` and `noteSourcePath` already document. It is
              // named, and not linked.
              <Typography component="span" sx={{ fontStyle: 'italic' }} variant="body2">
                {sourceLabel}
              </Typography>
            )}
          </Field>

          <Field label="Template">
            {note.templateId === null ? (
              // The API nulls the column when the row is gone for good, and
              // keeps the denormalised `templateName` — so a reader can still be
              // told WHICH template made this note, only that it is no longer
              // one they can use again.
              <Typography variant="body2" color="text.secondary" component="span">
                {note.templateName
                  ? `${note.templateName} — this template was deleted`
                  : 'This template was deleted'}
              </Typography>
            ) : templateState === 'loading' ? (
              <Skeleton width={180} aria-label="Loading the template" />
            ) : templateState === 'missing' ? (
              <Typography variant="body2" color="text.secondary" component="span">
                You no longer have access to this template
              </Typography>
            ) : templateState === 'error' ? (
              <Typography variant="body2" color="text.secondary" component="span">
                {templateError ?? 'This template could not be loaded'}
              </Typography>
            ) : (
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: 'wrap', alignItems: 'center' }}
              >
                <Typography variant="body2" component="span">
                  {template?.name ?? note.templateName}
                </Typography>
                {template?.builtIn && <Chip size="small" label="built-in" />}
                {/* Both chips can be on one row. They answer two different
                    questions — "can I edit this?" and "can I still choose it?"
                    — and picking one to suppress would hide an answer. */}
                {template?.isArchived && <Chip size="small" label="archived" />}
              </Stack>
            )}
          </Field>

          {/* The recipe itself, only when there is a row to read it off. Drawn
              empty, these rows would assert that the template had no
              instructions and no shape, which is a different claim from "we
              cannot see it". */}
          {template && (
            <>
              <Field label="Instructions">
                <TextBlock copyText={template.instructions} copyLabel="Copy instructions">
                  {template.instructions}
                </TextBlock>
              </Field>

              <Field label="Output format">
                {NOTE_OUTPUT_FORMAT_LABELS[template.outputFormat] ?? template.outputFormat}
              </Field>

              {template.structure.length > 0 && (
                <Field label="Structure">
                  {/* An ordered list because the order IS the content — a
                      template's sections are the shape of the note, in
                      sequence. */}
                  <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
                    {template.structure.map((section, index) => (
                      <li key={`${index}-${section}`}>{section}</li>
                    ))}
                  </Box>
                </Field>
              )}

              {template.tone !== null && <Field label="Tone">{template.tone}</Field>}
              {template.length !== null && <Field label="Length">{template.length}</Field>}
            </>
          )}

          <Field label="Context">
            {note.contextText ? (
              <TextBlock copyText={note.contextText} copyLabel="Copy context">
                {note.contextText}
              </TextBlock>
            ) : (
              // "None provided", not an empty cell: the absence of context is a
              // fact about how this note was generated, and a blank would read
              // as a field this panel failed to fill in.
              <Typography variant="body2" color="text.secondary" component="span">
                None provided
              </Typography>
            )}
          </Field>

          <Field label="Model">
            {note.model ?? (
              <Typography variant="body2" color="text.secondary" component="span">
                not recorded
              </Typography>
            )}
            {note.provider ? (
              <Typography variant="body2" color="text.secondary" component="span">
                {` · ${note.provider}`}
              </Typography>
            ) : null}
          </Field>
        </Box>

        {onOpenContext && (
          <Box sx={{ px: 2, pb: 2 }}>
            <Button
              variant="outlined"
              size="small"
              onClick={onOpenContext}
              disabled={note.currentGenerationId === null}
              aria-describedby={
                note.currentGenerationId === null ? `${PANEL_ID}-context-help` : undefined
              }
            >
              View full context sent to the AI
            </Button>
            {note.currentGenerationId === null && (
              <Typography
                id={`${PANEL_ID}-context-help`}
                variant="caption"
                color="text.secondary"
                component="p"
                sx={{ mt: 0.5 }}
              >
                Available once generation starts
              </Typography>
            )}
          </Box>
        )}
      </Collapse>
    </Paper>
  );
}

export default NoteGenerationContext;
