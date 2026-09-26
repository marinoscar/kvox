/**
 * The alert above an Ask composer (#380, shared with the entity panel #381):
 * a refused send's own copy (a 409 reason, a 400 model refusal) with its fix
 * link, else — when the caller has no AI key yet — the standing "add your
 * key" hint, else nothing.
 *
 * A FUNCTION returning `ReactNode`, not a component: `AskComposer` renders
 * its `alert` slot only when it is truthy, and an element is always truthy.
 */

import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { askSendErrorCopy } from './askErrorCopy';
import type { AiConfig } from '../../services/ai';

export interface AskComposerAlertInput {
  /** The last send's failure, or `null`. */
  sendError: unknown;
  onDismiss: () => void;
  config: AiConfig | null | undefined;
}

export function askComposerAlert({ sendError, onDismiss, config }: AskComposerAlertInput): ReactNode {
  const copy = sendError ? askSendErrorCopy(sendError) : null;
  if (copy) {
    return (
      <Alert severity="warning" onClose={onDismiss}>
        {copy.message}
        {copy.link && (
          <>
            {' '}
            <Link component={RouterLink} to={copy.link.to}>
              {copy.link.label}
            </Link>
          </>
        )}
      </Alert>
    );
  }
  if (config && !config.keyConfigured) {
    return (
      <Alert severity="info">
        Add your AI key in Settings → AI.{' '}
        <Link component={RouterLink} to="/settings/ai">
          Open Settings → AI
        </Link>
      </Alert>
    );
  }
  return null;
}
