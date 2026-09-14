/**
 * "Generated from *Q3 planning call* using *Executive summary*, 12 March" —
 * issue #58, epic #45.
 *
 * =============================================================================
 * ⚠ ON SCREEN, NOT IN A MENU. THIS IS THE EPIC'S PREMISE, NOT A DETAIL LINE.
 * =============================================================================
 *
 * `VISION.md`'s "Trust and Provenance" says a user must always be able to get
 * from a derived thing back to the evidence it was derived from. A note is
 * model output about a conversation this application did not witness, so the
 * single most important fact on the page — after the text itself — is what it
 * was made from, and the single most important control is the link that goes
 * there.
 *
 * That is why this is a sentence in the header rather than a "Details" menu, an
 * info icon or a tooltip: all three are affordances a reader has to already
 * suspect something before they use. The premise is that the reader should not
 * have to suspect.
 *
 * =============================================================================
 * WHY THE SOURCE MAY BE A NOUN RATHER THAN A NAME
 * =============================================================================
 *
 * `GET /api/notes/{id}` carries `sourceType` plus one id, and denormalises
 * `templateName` but NOT the source's name (see `useNoteSourceNames`' header
 * for why, and for what should replace it). So the name is resolved with a
 * second request and, until it lands — or forever, for a source the caller can
 * no longer read — this renders the category noun: "a transcript", "another
 * note", "an uploaded document".
 *
 * A NOUN, NEVER AN ID. A uuid where a title should be is worse than the
 * category alone, because it looks like the answer.
 *
 * =============================================================================
 * A DOCUMENT HAS NO LINK, AND THAT IS NOT AN OVERSIGHT
 * =============================================================================
 *
 * An uploaded source document is a storage object `managed_by: 'notes'` — absent
 * from the generic storage list by construction — so this application has no
 * route that renders one. `noteSourcePath` returns `null` for it and this
 * component names it without linking, rather than inventing a download link
 * that would hand the user back the file they uploaded instead of the evidence
 * they asked for.
 */

import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import type { Note } from '../../services/notes';
import { noteSourceFallbackLabel, noteSourcePath, noteSourceRef } from '../../utils/noteSource';
import { formatShortDate } from '../../utils/relativeTime';

export interface NoteProvenanceProps {
  note: Note;
  /**
   * The source's own title, when it has been resolved.
   *
   * `null` is the ordinary case on the first frame and a permanent one for a
   * source the caller cannot read; both render the category noun.
   */
  sourceName?: string | null;
}

export function NoteProvenance({ note, sourceName }: NoteProvenanceProps) {
  const ref = noteSourceRef(note);
  const path = noteSourcePath(note);
  const label = ref ? (sourceName ?? noteSourceFallbackLabel(ref.type)) : null;

  return (
    <Typography
      variant="body2"
      color="text.secondary"
      component="p"
      // A named region so a screen-reader user can find the provenance
      // deliberately, rather than only meeting it while reading past the title.
      data-testid="note-provenance"
    >
      {/* The verb is "Generated from", never "Source:" — the sentence has to
          say that a machine wrote this, which a label-and-value pair does
          not. */}
      {label ? 'Generated from ' : 'Generated '}
      {label &&
        (path ? (
          <Link component={RouterLink} to={path}>
            {label}
          </Link>
        ) : (
          <Typography component="span" sx={{ fontStyle: 'italic' }}>
            {label}
          </Typography>
        ))}
      {note.templateName ? (
        <>
          {' using '}
          <Typography component="span" sx={{ fontStyle: 'italic' }}>
            {note.templateName}
          </Typography>
        </>
      ) : null}
      {`, ${formatShortDate(note.createdAt)}`}
      {/* The model is named LAST and quietly. It is provenance — a reader
          comparing two notes needs to know they came from different models —
          but it is not what the sentence is about. */}
      {note.model ? ` · ${note.model}` : ''}
    </Typography>
  );
}

export default NoteProvenance;
