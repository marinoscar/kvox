/**
 * `/transcripts/new` — choose audio, describe it, upload it. Issue #30, epic #19.
 *
 * =============================================================================
 * THE UPLOAD IS NOT OWNED BY THIS PAGE, AND THAT IS THE POINT
 * =============================================================================
 *
 * A two-hour recording takes minutes to hours to upload. The transfer is run by
 * the app-wide upload manager (#22), which is mounted around the whole
 * authenticated shell — so navigating away from this screen, or to a
 * notification, does not stop it. This page STARTS the upload and then merely
 * WATCHES it by id; everything it renders about progress is read out of the
 * manager's `uploads` array, never out of local state.
 *
 * That is why step 3 says "you can leave this page" and means it, and why
 * pause/resume/cancel are calls into the manager rather than handles this
 * component is holding.
 *
 * =============================================================================
 * ONE REQUEST CREATES BOTH ROWS
 * =============================================================================
 *
 * `POST /api/transcripts` returns the transcript AND an initialised multipart
 * upload, deliberately: creating one without the other leaves a transcript
 * stuck in `uploading` with nothing behind it. So the manager is handed that
 * `init` rather than being asked to make its own — see `StartUploadInput.init`.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepContent from '@mui/material/StepContent';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { KeepScreenAwakeToggle } from '../components/upload/KeepScreenAwakeToggle';
import { usePermissions } from '../hooks/usePermissions';
import { useIsMounted } from '../hooks/useIsMounted';
import { useUploadManager } from '../hooks/useUploadManager';
import { ApiError } from '../services/api';
import { createTranscript } from '../services/transcripts';
import { getTranscriptionConfig } from '../services/transcription';
import type { TranscriptionConfig } from '../services/transcription';
import {
  AUDIO_ACCEPT_ATTRIBUTE,
  SPEAKER_COUNT_OPTIONS,
  TRANSCRIPT_LANGUAGES,
  checkAudioDuration,
  checkAudioFile,
  formatEta,
  formatMegabytes,
  formatSpeed,
  probeAudioDurationMs,
  titleFromFileName,
} from './newTranscript';

export function NewTranscriptPage() {
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const { hasPermission } = usePermissions();
  const { uploads, startUpload, pauseUpload, resumeUpload, cancelUpload } =
    useUploadManager();

  const [config, setConfig] = useState<TranscriptionConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<string>('auto');
  const [speakers, setSpeakers] = useState<string>('auto');

  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [transcriptId, setTranscriptId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getTranscriptionConfig()
      .then((value) => {
        if (!cancelled && isMounted()) setConfig(value);
      })
      .catch(() => {
        // A failed probe is treated as "not configured": every path out of this
        // screen needs the ceilings it carries, and guessing at them would let
        // a user start a three-gigabyte upload the API will refuse.
        if (!cancelled && isMounted()) setConfig(null);
      })
      .finally(() => {
        if (!cancelled && isMounted()) setConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isMounted]);

  const upload = uploadId ? uploads.find((item) => item.id === uploadId) : undefined;

  // Navigation happens HERE, off the manager's own progress, rather than from
  // an `await` on the transfer: the user may have left and come back, and the
  // promise this page was awaiting would have gone with the unmount.
  useEffect(() => {
    if (!transcriptId || upload?.progress.phase !== 'completed') return;
    navigate(`/transcripts/${transcriptId}`, { replace: true });
  }, [navigate, transcriptId, upload?.progress.phase]);

  const acceptFile = useCallback(
    async (candidate: File) => {
      setFileError(null);
      const sizeCheck = checkAudioFile(candidate, config?.maxUploadBytes ?? 0);
      if (!sizeCheck.ok) {
        setFileError(sizeCheck.error);
        setFile(null);
        return;
      }

      setFile(candidate);
      setTitle((current) => current || titleFromFileName(candidate.name));

      // The duration probe is best-effort and SLOW-ish, so the file is accepted
      // first and only un-accepted if the probe actually answers "too long".
      // Blocking the wizard on it would stall on every container the browser
      // cannot parse — which is exactly the set the server-side transcode
      // exists for.
      setIsProbing(true);
      const durationMs = await probeAudioDurationMs(candidate);
      if (!isMounted()) return;
      setIsProbing(false);
      const durationCheck = checkAudioDuration(durationMs, config?.maxDurationMs ?? 0);
      if (!durationCheck.ok) {
        setFileError(durationCheck.error);
        setFile(null);
      }
    },
    [config?.maxDurationMs, config?.maxUploadBytes, isMounted],
  );

  const handleStart = useCallback(async () => {
    if (!file) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const created = await createTranscript({
        title: title.trim() || titleFromFileName(file.name),
        language: language === 'auto' ? null : language,
        speakersExpected: speakers === 'auto' ? null : Number(speakers),
        source: {
          name: file.name,
          size: file.size,
          // `undefined` rather than a guessed string: the API falls back to the
          // extension, which is the RIGHT answer for the `.m4a`/`.amr` files
          // whose browser-reported type is empty.
          mimeType: file.type || undefined,
        },
      });

      const started = await startUpload({
        file,
        transcriptId: created.transcript.id,
        init: {
          objectId: created.upload.objectId,
          uploadId: created.upload.uploadId,
          partSize: created.upload.partSize,
          totalParts: created.upload.totalParts,
          parts: created.upload.presignedUrls,
        },
      });

      if (!isMounted()) return;
      setTranscriptId(created.transcript.id);
      setUploadId(started.id);
    } catch (err) {
      if (!isMounted()) return;
      // 409 is the deployment's problem, not the user's, and saying "check your
      // file" for it would send them to fix something that is not broken.
      if (err instanceof ApiError && err.status === 409) {
        setStartError(
          'Transcription is not configured for this deployment, so the upload was not started.',
        );
      } else {
        setStartError(
          err instanceof ApiError ? err.message : 'The upload could not be started.',
        );
      }
    } finally {
      if (isMounted()) setIsStarting(false);
    }
  }, [file, isMounted, language, speakers, startUpload, title]);

  if (configLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Checking transcription availability" />
      </Box>
    );
  }

  if (!config?.available) {
    return (
      <Box sx={{ maxWidth: 700, mx: 'auto' }}>
        <Typography variant="h5" component="h1" gutterBottom>
          New transcript
        </Typography>
        <Alert severity="warning">
          <AlertTitle>Transcription is not set up yet</AlertTitle>
          No transcription provider is configured for this deployment, so
          recordings cannot be transcribed right now.
          {/* The admin link is gated on the permission the transcription
              settings controller actually enforces — `system_settings:read` —
              rather than on the admin role, so a contributor granted that
              permission gets the link and an admin who has had it revoked does
              not. Offering it to someone who would be redirected straight back
              is worse than not offering it. */}
          {hasPermission('system_settings:read') && (
            <Box sx={{ mt: 2 }}>
              <Button
                size="small"
                variant="outlined"
                onClick={() => navigate('/admin/settings/transcription')}
              >
                Open transcription settings
              </Button>
            </Box>
          )}
        </Alert>
      </Box>
    );
  }

  const activeStep = uploadId ? 2 : file ? 1 : 0;
  const progress = upload?.progress;

  return (
    <Box sx={{ maxWidth: 700, mx: 'auto' }}>
      <Typography variant="h5" component="h1" gutterBottom>
        New transcript
      </Typography>

      <Stepper activeStep={activeStep} orientation="vertical">
        {/* ------------------------------------------------------------------
            1. Choose audio
            ------------------------------------------------------------------ */}
        <Step>
          <StepLabel>Choose audio</StepLabel>
          <StepContent>
            {/* ONE `<input type="file">` SERVES BOTH INPUT METHODS. The drop
                zone is a label-like surface around it, so a phone (where there
                is nothing to drag from) still gets a plain, full-width tap
                target, and a keyboard user gets the input's own native
                activation rather than a div pretending to be a button. */}
            <Paper
              variant="outlined"
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                const dropped = event.dataTransfer?.files?.[0];
                if (dropped) void acceptFile(dropped);
              }}
              sx={{
                p: 3,
                textAlign: 'center',
                borderStyle: 'dashed',
                borderColor: isDragging ? 'primary.main' : 'divider',
                backgroundColor: isDragging ? 'action.hover' : undefined,
              }}
            >
              <UploadFileIcon color="action" sx={{ fontSize: 40 }} aria-hidden />
              <Typography sx={{ mt: 1 }}>
                Drag a recording here, or choose one from your device.
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p">
                Up to {formatMegabytes(config.maxUploadBytes)} · m4a, mp3, wav,
                flac, ogg, opus, aac, amr, webm, wma
              </Typography>
              <input
                type="file"
                accept={AUDIO_ACCEPT_ATTRIBUTE}
                aria-label="Choose an audio file"
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  if (chosen) void acceptFile(chosen);
                  // Cleared so re-picking the SAME file after a rejection still
                  // fires `change` — the input compares values, not intent.
                  event.target.value = '';
                }}
                style={{ display: 'block', margin: '16px auto 0' }}
              />
            </Paper>

            {isProbing && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                Checking the recording…
              </Typography>
            )}
            {fileError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {fileError}
              </Alert>
            )}
          </StepContent>
        </Step>

        {/* ------------------------------------------------------------------
            2. Details
            ------------------------------------------------------------------ */}
        <Step>
          <StepLabel>Details</StepLabel>
          <StepContent>
            <Stack spacing={2}>
              <TextField
                label="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                fullWidth
                slotProps={{ htmlInput: { maxLength: 200 } }}
              />

              <FormControl fullWidth>
                <InputLabel id="transcript-language">Language</InputLabel>
                <Select
                  labelId="transcript-language"
                  label="Language"
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                >
                  <MenuItem value="auto">Detect automatically</MenuItem>
                  {TRANSCRIPT_LANGUAGES.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl fullWidth>
                <InputLabel id="transcript-speakers">Expected speakers</InputLabel>
                <Select
                  labelId="transcript-speakers"
                  label="Expected speakers"
                  value={speakers}
                  onChange={(event) => setSpeakers(event.target.value)}
                >
                  <MenuItem value="auto">Work it out automatically</MenuItem>
                  {SPEAKER_COUNT_OPTIONS.map((count) => (
                    <MenuItem key={count} value={String(count)}>
                      {count}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              {/* NAMES THE PROVIDER, because "sent to a third party" is not
                  consent — the user is entitled to know WHICH one before they
                  upload, not after (spec §10). The label comes from the API's
                  own capability probe, so it cannot drift from the provider
                  that will actually receive the audio. */}
              <Alert severity="info" icon={false}>
                This recording will be uploaded and sent to{' '}
                <strong>{config.providerLabel ?? 'the configured provider'}</strong> for
                transcription. Deleting the transcript removes the audio and asks
                the provider to delete its copy.
              </Alert>

              {startError && <Alert severity="error">{startError}</Alert>}

              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  variant="contained"
                  onClick={() => void handleStart()}
                  disabled={!file || isStarting}
                >
                  {isStarting ? 'Starting…' : 'Start upload'}
                </Button>
                <Button
                  onClick={() => {
                    setFile(null);
                    setFileError(null);
                  }}
                  disabled={isStarting}
                >
                  Choose a different file
                </Button>
              </Box>
            </Stack>
          </StepContent>
        </Step>

        {/* ------------------------------------------------------------------
            3. Upload
            ------------------------------------------------------------------ */}
        <Step>
          <StepLabel>Upload</StepLabel>
          <StepContent>
            {progress ? (
              <Stack spacing={2}>
                <Box>
                  <LinearProgress
                    variant="determinate"
                    value={progress.percent}
                    aria-label="Upload progress"
                  />
                  <Typography variant="body2" sx={{ mt: 1 }} role="status">
                    {progress.percent}% · {formatSpeed(progress.bytesPerSecond)} ·{' '}
                    {progress.waitingForNetwork
                      ? 'Waiting for the network…'
                      : formatEta(progress.etaSeconds)}
                  </Typography>
                </Box>

                {progress.error && <Alert severity="error">{progress.error}</Alert>}

                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  {progress.phase === 'paused' ? (
                    <Button onClick={() => resumeUpload(uploadId!)}>Resume</Button>
                  ) : (
                    <Button
                      onClick={() => pauseUpload(uploadId!)}
                      disabled={progress.phase !== 'uploading'}
                    >
                      Pause
                    </Button>
                  )}
                  <Button color="error" onClick={() => void cancelUpload(uploadId!)}>
                    Cancel
                  </Button>
                </Box>

                <KeepScreenAwakeToggle />

                <Alert severity="info">
                  You can leave this page — the upload keeps going, and the
                  transcript opens automatically when it finishes.
                </Alert>
              </Stack>
            ) : (
              <Typography color="text.secondary">
                The upload has not started yet.
              </Typography>
            )}
          </StepContent>
        </Step>
      </Stepper>
    </Box>
  );
}

export default NewTranscriptPage;
