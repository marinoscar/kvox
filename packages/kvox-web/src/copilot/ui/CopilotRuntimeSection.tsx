import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { CopilotStatus } from '@marinoscar/kvox-contract/copilot';

import { COPILOT_RUNTIME_SIZE_TEXT } from '../headless/index.js';

/**
 * Props of {@link CopilotRuntimeSection}.
 *
 * @stability experimental
 */
export interface CopilotRuntimeSectionProps {
  /** The runtime part of the status. */
  runtime: CopilotStatus['runtime'];
  /** The download size to state. */
  sizeText?: string;
  /** Start the download; the button is hidden when omitted. */
  onDownload?: () => void;
  /** Cancel a running download; the button is hidden when omitted. */
  onCancel?: () => void;
  /** A download error already worded, or `null`. */
  error: string | null;
  /** A download call is in flight; disables the Download button only, never Cancel. */
  busy: boolean;
}

/**
 * The Copilot runtime line: missing (with the download size and a button),
 * downloading (a progress bar with Cancel) or in error.
 *
 * @stability experimental
 */
export function CopilotRuntimeSection({
  runtime,
  sizeText = COPILOT_RUNTIME_SIZE_TEXT,
  onDownload,
  onCancel,
  error,
  busy,
}: CopilotRuntimeSectionProps) {
  if (runtime.state === 'ready') return null;

  if (runtime.state === 'downloading') {
    const percent = runtime.progress === null ? null : Math.round(runtime.progress * 100);
    return (
      <Stack spacing={1}>
        <Typography variant="body2">
          {percent === null ? 'Downloading the Copilot runtime…' : `Downloading the Copilot runtime… ${percent}%`}
        </Typography>
        <LinearProgress
          aria-label="Copilot runtime download"
          variant={percent === null ? 'indeterminate' : 'determinate'}
          value={percent ?? undefined}
        />
        {onCancel ? (
          <div>
            {/* Never gated on `busy`: a port's download resolves only when it finishes, which is when Cancel is needed. */}
            <Button size="small" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        ) : null}
        {error ? <Alert severity="error">{error}</Alert> : null}
      </Stack>
    );
  }

  const isError = runtime.state === 'error';
  return (
    <Stack spacing={1}>
      <Alert severity={isError ? 'error' : 'info'}>
        {isError
          ? 'The Copilot runtime could not be installed or started. Download it again.'
          : `The Copilot runtime is not installed. Download it once (${sizeText}) before you sign in.`}
      </Alert>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {onDownload ? (
        <div>
          <Button variant="outlined" onClick={onDownload} disabled={busy}>
            {isError ? 'Try download again' : 'Download runtime'}
          </Button>
        </div>
      ) : null}
    </Stack>
  );
}
