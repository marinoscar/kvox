/**
 * `AskThread` — a conversation's messages, oldest → newest (#380).
 *
 * PROPS AND CALLBACKS ONLY — no router, no data fetching — so the entity
 * panel (#381) mounts the same component in a drawer. The owner passes the
 * messages, the live stream of the running turn, and what "Load earlier" and
 * "Try again" should do.
 *
 * It is its own scroll container and STICKS TO THE BOTTOM while the user is
 * already there: new messages and streamed text keep the latest line in
 * view, but a user who scrolled up to reread something is left where they
 * are.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import { useLayoutEffect, useRef } from 'react';
import type { SxProps, Theme } from '@mui/material/styles';

import type { AskMessage } from '../../services/ask';
import type { AskStreamState } from '../../hooks/useAskStream';
import { AskMessageBubble } from './AskMessageBubble';

export interface AskThreadProps {
  messages: readonly AskMessage[];
  hasEarlier?: boolean;
  isLoadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  /** The running turn's live state (from `useAskConversation().stream`). */
  stream?: AskStreamState | null;
  /** "Try again" on a failed answer: re-send `content` (the question before it). */
  onRetry?: (content: string) => void;
  /** Disable "Try again" (a turn is running, or a send is in flight). */
  retryDisabled?: boolean;
  /** Expand every answer's tool steps (visual baselines). */
  stepsDefaultExpanded?: boolean;
  sx?: SxProps<Theme>;
}

/** Within this many pixels of the bottom counts as "at the bottom". */
const STICK_THRESHOLD_PX = 48;

/** The question a failed answer at `index` was answering. */
export function precedingQuestion(messages: readonly AskMessage[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return null;
}

export function AskThread({
  messages,
  hasEarlier = false,
  isLoadingEarlier = false,
  onLoadEarlier,
  stream,
  onRetry,
  retryDisabled = false,
  stepsDefaultExpanded,
  sx,
}: AskThreadProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  const liveLength = stream?.content.length ?? 0;
  const liveSteps = stream?.steps.length ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastMessageId, liveLength, liveSteps, messages.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  };

  return (
    <Box
      ref={scroller}
      onScroll={onScroll}
      component="section"
      aria-label="Conversation"
      // Focusable so a keyboard user can scroll it (axe: scrollable-region-focusable).
      tabIndex={0}
      sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', ...sx }}
    >
      <Stack spacing={2} sx={{ py: 1 }}>
        {hasEarlier && onLoadEarlier && (
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <Button
              size="small"
              onClick={onLoadEarlier}
              disabled={isLoadingEarlier}
              startIcon={isLoadingEarlier ? <CircularProgress size={14} aria-hidden /> : undefined}
            >
              Load earlier
            </Button>
          </Box>
        )}
        {messages.map((message, index) => {
          const question = message.role === 'assistant' ? precedingQuestion(messages, index) : null;
          return (
            <AskMessageBubble
              key={message.id}
              message={message}
              live={stream && stream.messageId === message.id ? stream : null}
              onRetry={onRetry && question !== null ? () => onRetry(question) : undefined}
              retryDisabled={retryDisabled}
              stepsDefaultExpanded={stepsDefaultExpanded}
            />
          );
        })}
      </Stack>
    </Box>
  );
}

export default AskThread;
