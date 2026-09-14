/**
 * "In progress" — everything the user is currently waiting on. Issue #32, epic #19.
 *
 * =============================================================================
 * THREE KINDS OF ROW, TWO SOURCES OF TRUTH, ONE SECTION
 * =============================================================================
 *
 * A recording on its way to becoming a transcript is in one of three states,
 * and only one of them is something the server knows about:
 *
 *   1. **A live upload** — bytes moving from this browser to object storage,
 *      owned by the app-wide upload manager (#22). The server sees a transcript
 *      in `uploading` and nothing else; the percentage, the speed and the
 *      pause button exist ONLY in this tab.
 *   2. **An interrupted upload** — a session persisted to IndexedDB by a visit
 *      that was reloaded, backgrounded out of existence, or crashed. The bytes
 *      are half-there in object storage and the `File` is gone, because a
 *      browser cannot hold a file handle across a reload. Resuming needs the
 *      user to pick the same file again.
 *   3. **Server-side processing** — the upload finished and the transcode /
 *      provider round trip is running. Nothing local is involved; the only
 *      source is `GET /api/transcripts/summary`.
 *
 * Merging them into one section is a deliberate product decision rather than a
 * layout convenience: the user asked ONE question ("is my recording ready
 * yet?"), and splitting the answer across "Uploads" and "Processing" makes them
 * check two places for one recording that will silently move from the first to
 * the second while they watch.
 *
 * ⚠ A LIVE UPLOAD AND ITS SERVER ROW ARE THE SAME RECORDING. While bytes are
 * moving, the transcript is in `uploading` and therefore appears in the
 * summary's `inProgress` too. `dedupe` below drops the server row whenever a
 * local upload names the same `transcriptId`, because the local row is strictly
 * better — it has a real percentage and working controls, where the server row
 * can only say "Uploading" with no idea how far along it is.
 *
 * =============================================================================
 * HIDDEN WHEN EMPTY, AND THAT MEANS ALL THREE
 * =============================================================================
 *
 * Returning `null` rather than rendering an empty "In progress (0)" heading:
 * the steady state of this application is that nothing is in flight, so a
 * permanently-empty section would be the FIRST thing on the page for almost
 * every visit, pushing the recent list below the fold on a phone for no reason.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useUploadManager } from '../../hooks/useUploadManager';
import type { ManagedUpload } from '../../hooks/useUploadManager';
import { UploadSessionMismatchError } from '../../services/uploadSessions';
import type { UploadSessionRecord } from '../../services/uploadSessions';
import type { TranscriptListItem } from '../../services/transcripts';
import {
  formatBytes,
  processingStageLabel,
  transcriptStatusDescriptor,
} from '../../utils/transcriptDisplay';

export interface InProgressSectionProps {
  /** The summary's `inProgress` list — server-side work, never local uploads. */
  items: TranscriptListItem[];
}

/** Phases that still need the network. A settled upload belongs in Recent. */
const LIVE_PHASES = new Set(['idle', 'uploading', 'paused', 'completing', 'failed']);

/**
 * Server rows that no live upload in this tab is already showing.
 *
 * Exported for its own test: the rule is one line and the failure it prevents
 * (the same recording listed twice, once with a progress bar and once without)
 * is the kind of thing that only shows up with a real upload running.
 */
export function dedupeServerItems(
  items: TranscriptListItem[],
  uploads: ManagedUpload[],
): TranscriptListItem[] {
  const localTranscriptIds = new Set(
    uploads.map((upload) => upload.transcriptId).filter((id): id is string => Boolean(id)),
  );
  return items.filter((item) => !localTranscriptIds.has(item.id));
}

/** One live upload: what it is, how far along, and the two controls it has. */
function UploadRow({ upload }: { upload: ManagedUpload }) {
  const navigate = useNavigate();
  const { pauseUpload, resumeUpload, cancelUpload } = useUploadManager();
  const { progress } = upload;

  const paused = progress.phase === 'paused';
  const failed = progress.phase === 'failed';

  // `waitingForNetwork` is NOT `paused` — the engine paused itself because the
  // browser went offline, and offering a Resume button there is offering a
  // control that cannot do anything. See `UploadProgress`'s own note.
  const detail = progress.waitingForNetwork
    ? 'Waiting for the network'
    : failed
      ? (progress.error ?? 'The upload failed')
      : `${formatBytes(progress.uploadedBytes)} of ${formatBytes(progress.totalBytes)}`;

  return (
    <Card variant="outlined" component="li" sx={{ listStyle: 'none' }}>
      <Box sx={{ p: 1.75 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" component="h3" noWrap sx={{ fontWeight: 600 }}>
              {upload.fileName}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="p">
              {paused ? 'Paused' : 'Uploading'} · {detail}
            </Typography>
          </Box>

          <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
            {paused ? (
              <Tooltip title="Resume">
                <IconButton
                  size="small"
                  aria-label={`Resume uploading ${upload.fileName}`}
                  onClick={() => resumeUpload(upload.id)}
                >
                  <PlayArrowIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="Pause">
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Pause uploading ${upload.fileName}`}
                    disabled={failed || progress.waitingForNetwork}
                    onClick={() => pauseUpload(upload.id)}
                  >
                    <PauseIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            <Tooltip title="Cancel">
              <IconButton
                size="small"
                aria-label={`Cancel uploading ${upload.fileName}`}
                onClick={() => void cancelUpload(upload.id)}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>

        <LinearProgress
          variant="determinate"
          value={progress.percent}
          // The bar is decorative here: the percentage it encodes is already
          // in the caption above as bytes, and an unlabelled progressbar
          // announces a second, meaningless element to a screen reader.
          aria-hidden
          sx={{ mt: 1, height: 6, borderRadius: 3 }}
        />

        {/* Only once there IS a transcript row to open. A local upload started
            from the New-transcript screen always has one; an upload adopted
            from a bare storage session may not yet. */}
        {upload.transcriptId && (
          <Button
            size="small"
            sx={{ mt: 0.5, ml: -1 }}
            onClick={() => navigate(`/transcripts/${upload.transcriptId}`)}
          >
            Open
          </Button>
        )}
      </Box>
    </Card>
  );
}

/**
 * One interrupted session: the "Resume upload" prompt.
 *
 * ⚠ THE FILE MUST BE RE-PICKED, AND THAT IS NOT A UX SHORTCUT WE TOOK. A
 * browser cannot persist a `File` across a reload — the handle dies with the
 * document — so the half-uploaded object in storage has no source to continue
 * from until the user points at the same file again. `resumeFromSession` throws
 * `UploadSessionMismatchError` when they pick a DIFFERENT one, which is the
 * check that stops part 7 of `interview.m4a` being written into the object
 * `standup.m4a` was half-way through.
 */
function SessionRow({ session }: { session: UploadSessionRecord }) {
  const { resumeFromSession } = useUploadManager();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPick = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      try {
        await resumeFromSession(session, file);
      } catch (err) {
        setError(
          err instanceof UploadSessionMismatchError
            ? err.message
            : 'That upload could not be resumed.',
        );
      }
    },
    [resumeFromSession, session],
  );

  return (
    <Card variant="outlined" component="li" sx={{ listStyle: 'none' }}>
      <Box sx={{ p: 1.75 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" component="h3" noWrap sx={{ fontWeight: 600 }}>
              {session.fileName}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="p">
              Interrupted · {formatBytes(session.size)} · choose the same file to
              continue where it stopped
            </Typography>
          </Box>
          <Button
            variant="outlined"
            size="small"
            sx={{ flexShrink: 0 }}
            onClick={() => inputRef.current?.click()}
          >
            Resume upload
          </Button>
        </Stack>

        <input
          ref={inputRef}
          type="file"
          hidden
          aria-label={`Choose ${session.fileName} again to resume`}
          onChange={(event) => void onPick(event.target.files?.[0])}
        />

        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </Box>
    </Card>
  );
}

/** One server-side item: the stage it is at, and a tap target that opens it. */
function ProcessingRow({ item }: { item: TranscriptListItem }) {
  const navigate = useNavigate();
  // The STAGE, not the status, is the headline here: everything in this section
  // is "processing" by definition, so a chip saying so is a chip carrying no
  // information. `processingStageLabel` falls back to the status word only when
  // it genuinely has nothing more specific to say.
  const stage = processingStageLabel(item) ?? transcriptStatusDescriptor(item.status).label;

  return (
    <Card variant="outlined" component="li" sx={{ listStyle: 'none' }}>
      <CardActionArea
        onClick={() => navigate(`/transcripts/${item.id}`)}
        sx={{ p: 1.75, display: 'block', minWidth: 0 }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" component="h3" noWrap sx={{ fontWeight: 600 }}>
              {item.title}
            </Typography>
          </Box>
          <Chip size="small" color="warning" variant="outlined" label={stage} />
        </Stack>
        <LinearProgress aria-hidden sx={{ mt: 1, height: 4, borderRadius: 2 }} />
      </CardActionArea>
    </Card>
  );
}

export function InProgressSection({ items }: InProgressSectionProps) {
  const { uploads, sessions } = useUploadManager();

  const liveUploads = uploads.filter((upload) => LIVE_PHASES.has(upload.progress.phase));
  // A session whose upload is running again in THIS tab is not interrupted any
  // more; without this the same recording shows a progress bar and a "Resume
  // upload" prompt at the same time.
  const liveObjectIds = new Set(liveUploads.map((upload) => upload.objectId));
  const interrupted = sessions.filter((session) => !liveObjectIds.has(session.objectId));
  const serverItems = dedupeServerItems(items, liveUploads);

  const total = liveUploads.length + interrupted.length + serverItems.length;
  if (total === 0) return null;

  return (
    <Box component="section" aria-labelledby="home-in-progress" sx={{ mb: { xs: 3, sm: 4 } }}>
      <Typography
        id="home-in-progress"
        variant="h6"
        component="h2"
        sx={{ mb: 1.5, fontWeight: 600 }}
      >
        In progress
      </Typography>

      <Stack component="ul" spacing={1.5} sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {liveUploads.map((upload) => (
          <UploadRow key={upload.id} upload={upload} />
        ))}
        {interrupted.map((session) => (
          <SessionRow key={session.objectId} session={session} />
        ))}
        {serverItems.map((item) => (
          <ProcessingRow key={item.id} item={item} />
        ))}
      </Stack>
    </Box>
  );
}

export default InProgressSection;
