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
 * `GET /api/notes/{id}` denormalises `sourceName` beside `templateName` since
 * #192, so the name arrives WITH the note and there is no second request and no
 * first frame without it. But it is nullable, and permanently so for a source
 * that has been deleted or that the caller may no longer read — an unshared
 * transcript, say. In that case this renders the category noun: "a transcript",
 * "another note", "an uploaded document".
 *
 * A NOUN, NEVER AN ID. A uuid where a title should be is worse than the
 * category alone, because it looks like the answer.
 *
 * =============================================================================
 * A DOCUMENT IS NOT A PAGE — IT IS A DOWNLOAD (#732)
 * =============================================================================
 *
 * An uploaded source document is a storage object `managed_by: 'notes'` — absent
 * from the generic storage list by construction — so this application has no
 * route that renders one, and `noteSourcePath` returns `null` for it. What it
 * CAN do is hand the original file back: the file name is a button named
 * "Download" plus the file name, which asks `GET /api/notes/{id}/source` for a
 * short-lived signed URL and opens it exactly as `NoteExportDialog` opens an
 * export's
 * `downloadUrl` — `window.open(url, '_blank', 'noopener,noreferrer')`, never a
 * fetch of the bytes, because the attachment name is signed into the URL. That
 * path already works in the browser and in KVox Desktop.
 *
 * It is a BUTTON, not a link: there is no URL until it is asked for, and the one
 * it gets expires in fifteen minutes. A failure is said inline under the
 * sentence; a 404 means the file is no longer there to give.
 *
 * =============================================================================
 * A KEPT DOCUMENT WAS IMPORTED, NOT GENERATED (#730)
 * =============================================================================
 *
 * A document kept as the note ("Keep it as my note", or a library import) has a
 * document source and no template: no model wrote its text from a recipe, so
 * the verb is "Imported from", and the file's name is the source named.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { getNoteSourceDownload } from '../../headless/clients/notes.js';
import type { Note } from '../../headless/clients/notes.js';
import {
  noteSourceFallbackLabel,
  noteSourcePath,
  noteSourceRef,
} from '../../headless/utils/noteSource.js';
import { KvoxApiError, formatShortDate, useKvoxHost } from '../../../core/headless/index.js';

/** The inline copy for a source download that failed. */
function sourceDownloadErrorText(err: unknown): string {
  if (err instanceof KvoxApiError && err.status === 404) {
    return 'The original file is no longer available.';
  }
  return 'The original file could not be downloaded. Try again.';
}

export interface NoteProvenanceProps {
  note: Note;
  /**
   * The source's own title — `note.sourceName`, which the caller passes in.
   *
   * ⚠ Still a PROP rather than read off `note` here, because the page that owns
   * the note is the right place to decide what it means, and this component is
   * rendered from more than one shape. `null` is a permanent answer for a
   * source that is gone or no longer readable; it renders the category noun.
   */
  sourceName?: string | null;
}

export function NoteProvenance({ note, sourceName }: NoteProvenanceProps) {
  const ref = noteSourceRef(note);
  const path = noteSourcePath(note);
  const label = ref ? (sourceName ?? noteSourceFallbackLabel(ref.type)) : null;
  const imported = note.sourceType === 'document' && !note.templateId && !note.templateName;
  const verb = imported ? 'Imported' : 'Generated';
  const downloadable = note.sourceType === 'document' && Boolean(note.sourceObjectId);

  const host = useKvoxHost();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // An answer that lands after unmount (the user navigated away) is dropped.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const noteId = note.id;
  const downloadSource = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const { url } = await getNoteSourceDownload(host, noteId);
      if (!alive.current) return;
      // The same mechanism as NoteExportDialog: hand the browser the signed URL
      // rather than fetching the bytes — the filename is signed into the URL's
      // own disposition. See the header.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      if (alive.current) setDownloadError(sourceDownloadErrorText(err));
    } finally {
      if (alive.current) setDownloading(false);
    }
  }, [host, noteId]);

  return (
    <>
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
        {label ? `${verb} from ` : `${verb} `}
        {label &&
          (path ? (
            <Link component={RouterLink} to={path}>
              {label}
            </Link>
          ) : downloadable ? (
            <Link
              component="button"
              type="button"
              variant="body2"
              onClick={() => void downloadSource()}
              disabled={downloading}
              aria-label={`Download ${label}`}
              aria-busy={downloading || undefined}
              data-testid="note-source-download"
              sx={{
                fontStyle: 'italic',
                verticalAlign: 'baseline',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.25,
              }}
            >
              {label}
              <FileDownloadOutlinedIcon aria-hidden fontSize="inherit" />
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
      {downloadError && (
        <Alert severity="error" sx={{ mt: 1 }} data-testid="note-source-download-error">
          {downloadError}
        </Alert>
      )}
    </>
  );
}
