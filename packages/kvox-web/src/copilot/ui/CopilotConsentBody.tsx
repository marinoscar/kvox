import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  COPILOT_CONSENT_COPY,
  copilotRuntimeDownloadNote,
} from '../headless/index.js';
import { openExternalUrl } from './openExternal.js';

/**
 * Props of {@link CopilotConsentBody}.
 *
 * @stability experimental
 */
export interface CopilotConsentBodyProps {
  /** Show the runtime download sentence (the runtime is missing). */
  showRuntimeDownload: boolean;
  /** The download size to state; defaults to the packaged approximation. */
  runtimeDownloadSize?: string;
  /** Open a link through the host (Desktop: the system browser). */
  onOpenExternal?: (url: string) => void;
}

/**
 * The consent text of `COPILOT_CONSENT_COPY` as the body of the consent dialog.
 *
 * @stability experimental
 */
export function CopilotConsentBody({
  showRuntimeDownload,
  runtimeDownloadSize,
  onOpenExternal,
}: CopilotConsentBodyProps) {
  return (
    <Stack spacing={1.5}>
      {COPILOT_CONSENT_COPY.points.map((point) => (
        <div key={point.heading}>
          <Typography variant="subtitle2" component="h3">
            {point.heading}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {point.text}
          </Typography>
        </div>
      ))}
      {showRuntimeDownload ? (
        <div>
          <Typography variant="subtitle2" component="h3">
            Download size
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {copilotRuntimeDownloadNote(runtimeDownloadSize)}
          </Typography>
        </div>
      ) : null}
      <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }} aria-label="GitHub terms and privacy">
        {COPILOT_CONSENT_COPY.links.map((link) => (
          <li key={link.href}>
            <Typography variant="body2">
              <Link
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  if (onOpenExternal) {
                    event.preventDefault();
                    openExternalUrl(link.href, onOpenExternal);
                  }
                }}
              >
                {link.label}
              </Link>
            </Typography>
          </li>
        ))}
      </Stack>
    </Stack>
  );
}
