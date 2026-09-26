/**
 * `AskMessageBubble` — one message of an Ask conversation (#380).
 *
 * A USER message is the question, right-aligned, as plain text (never
 * markdown — it is what the user typed, and rendering `**` they meant
 * literally would be rewriting them).
 *
 * An ASSISTANT message is the answer, left-aligned, rendered through
 * `MarkdownView` (react-markdown, no raw HTML) with `remarkAskCitations`
 * turning its markers into chips once the turn is complete:
 *
 *   - `evidence` → `EvidenceChip` (#373), numbered by first appearance;
 *   - `entity`   → `EntityCitationChip`;
 *   - `document` → `DocumentCitationChip`;
 *   - invalid or unknown markers → removed, and counted in a caption.
 *
 * Captions under a complete answer, per spec §21.3: removed citations, an
 * uncited answer's caution, and "Stopped early" for a capped turn.
 *
 * STREAMING is announced ONCE: the bubble is an `aria-live="polite"` region
 * held `aria-busy` while text arrives, so a screen reader reads the finished
 * answer instead of every token.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Components } from 'react-markdown';

import { EvidenceChip } from '../graph/EvidenceChip';
import { MarkdownView } from '../notes/MarkdownView';
import type { AskCitation, AskMessage, AskToolCall } from '../../services/ask';
import type { AskStreamState } from '../../hooks/useAskStream';
import { AskToolSteps } from './AskToolSteps';
import { DocumentCitationChip } from './DocumentCitationChip';
import { EntityCitationChip } from './EntityCitationChip';
import remarkAskCitations, { stripTrailingPartialMarker, summarizeAskCitations } from './remarkAskCitations';
import {
  ASK_UNCITED_COPY,
  askErrorClassCopy,
  askFinishReasonCopy,
  askUnverifiedCopy,
} from './askErrorCopy';

export interface AskMessageBubbleProps {
  message: AskMessage;
  /** The live stream, when THIS message is the one streaming. */
  live?: AskStreamState | null;
  /** Failed assistant turns: re-send the preceding question as a new turn. */
  onRetry?: () => void;
  retryDisabled?: boolean;
  /** Expand the tool steps regardless of the default (visual baselines). */
  stepsDefaultExpanded?: boolean;
}

/**
 * An answer that says it found nothing. It cites nothing BECAUSE there was
 * nothing, so the "treat with care" caution would be noise under it.
 */
export function isNotFoundAnswer(content: string, steps: readonly AskToolCall[]): boolean {
  if (steps.length > 0 && steps.every((step) => step.error !== null || step.resultCount === 0)) return true;
  return /\b(couldn[’']?t|could not|can[’']?t|cannot|didn[’']?t|did not) find\b|\bno (relevant )?(information|results|records|mentions)\b|\bnothing (relevant|about|on)\b/i.test(
    content,
  );
}

function prop(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** The `span` override: a citation node becomes its chip; any other span renders as one. */
const CITATION_COMPONENTS: Components = {
  span: ({ node, children, ...rest }) => {
    const properties = (node?.properties ?? {}) as Record<string, unknown>;
    const kind = prop(properties.dataAskCitation);
    const id = prop(properties.dataAskId);
    if (!kind || !id) return <span {...rest}>{children}</span>;
    const label = prop(properties.dataAskLabel);
    if (kind === 'evidence') {
      const number = Number(prop(properties.dataAskNumber) ?? '1');
      return <EvidenceChip evidenceId={id} index={number} />;
    }
    if (kind === 'entity') return <EntityCitationChip entityId={id} label={label} />;
    if (kind === 'document') {
      const documentKind = prop(properties.dataAskDocumentKind);
      const start = prop(properties.dataAskStartMs);
      return (
        <DocumentCitationChip
          documentId={id}
          documentKind={documentKind === 'note' || documentKind === 'transcript' ? documentKind : null}
          label={label}
          startMs={start !== null && Number.isFinite(Number(start)) ? Number(start) : null}
        />
      );
    }
    return null;
  },
};

function Caption({ children }: { children: ReactNode }) {
  return (
    <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.5 }}>
      {children}
    </Typography>
  );
}

function AnswerMarkdown({ content, citations }: { content: string; citations: readonly AskCitation[] }) {
  const plugins = useMemo(() => [[remarkAskCitations, { citations }] as [typeof remarkAskCitations, { citations: readonly AskCitation[] }]], [citations]);
  return (
    <MarkdownView remarkPlugins={plugins} components={CITATION_COMPONENTS}>
      {content}
    </MarkdownView>
  );
}

const bubbleSx = {
  px: 2,
  py: 1.5,
  borderRadius: 2,
  maxWidth: { xs: '100%', sm: '85%' },
  minWidth: 0,
  overflowWrap: 'anywhere',
} as const;

export function AskMessageBubble({ message, live, onRetry, retryDisabled, stepsDefaultExpanded }: AskMessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Box
          sx={{
            ...bubbleSx,
            bgcolor: 'action.selected',
            color: 'text.primary',
            whiteSpace: 'pre-wrap',
          }}
        >
          <Typography variant="body2" component="p">
            {message.content}
          </Typography>
        </Box>
      </Box>
    );
  }

  return <AssistantBubble message={message} live={live} onRetry={onRetry} retryDisabled={retryDisabled} stepsDefaultExpanded={stepsDefaultExpanded} />;
}

function AssistantBubble({ message, live, onRetry, retryDisabled, stepsDefaultExpanded }: AskMessageBubbleProps) {
  const isLive = Boolean(live && live.messageId === message.id && live.status !== 'idle');
  const streaming = isLive ? live!.status === 'streaming' : message.status === 'pending' || message.status === 'streaming';
  const content = isLive ? live!.content : message.content;
  const steps = isLive ? live!.steps : message.toolCalls;
  const failed = message.status === 'failed' || (isLive && live!.status === 'error');
  const complete = !streaming && !failed;
  const citations = complete ? (isLive && live!.status === 'done' ? live!.citations : message.citations) : [];
  const finishReason = isLive && live!.finishReason ? live!.finishReason : message.finishReason;
  const errorClass = isLive && live!.error ? live!.error.errorClass : message.errorClass;

  const shown = streaming ? stripTrailingPartialMarker(content) : content;
  const answerStarted = shown.trim().length > 0;
  const summary = useMemo(() => summarizeAskCitations(content, citations), [content, citations]);

  const unverified = complete ? askUnverifiedCopy(summary.invalidCount) : null;
  const uncited =
    complete && answerStarted && summary.validCount === 0 && !isNotFoundAnswer(content, steps) ? ASK_UNCITED_COPY : null;
  const stopped = complete ? askFinishReasonCopy(finishReason) : null;

  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
      <Box
        sx={{ ...bubbleSx, bgcolor: 'background.paper', border: 1, borderColor: 'divider', width: { xs: '100%', sm: 'auto' } }}
        aria-live="polite"
        aria-busy={streaming}
        data-testid="ask-answer"
      >
        <AskToolSteps
          steps={steps}
          running={streaming}
          answerStarted={answerStarted}
          defaultExpanded={stepsDefaultExpanded}
        />

        {streaming && !answerStarted && steps.length === 0 && (
          <Stack spacing={0.5} aria-label="Thinking">
            <Typography variant="body2" color="text.secondary">
              Thinking…
            </Typography>
            <Skeleton width="80%" />
            <Skeleton width="55%" />
          </Stack>
        )}

        {answerStarted && <AnswerMarkdown content={shown} citations={citations} />}

        {unverified && <Caption>{unverified}</Caption>}
        {uncited && <Caption>{uncited}</Caption>}
        {stopped && <Caption>{stopped}</Caption>}

        {failed && (
          <Alert
            severity="error"
            variant="outlined"
            sx={{ mt: answerStarted ? 1 : 0 }}
            action={
              onRetry ? (
                <Button color="inherit" size="small" onClick={onRetry} disabled={retryDisabled}>
                  Try again
                </Button>
              ) : undefined
            }
          >
            {askErrorClassCopy(errorClass)}
          </Alert>
        )}
      </Box>
    </Box>
  );
}

export default AskMessageBubble;
