/**
 * `useAskStream` — the live view of ONE assistant turn (#380, #379's stream).
 *
 * Connects only while the message it is given is an assistant message whose
 * status is `pending` or `streaming`; a `complete` or `failed` message never
 * opens a connection — its row already says everything the stream could.
 *
 * SEEDED FROM THE ROW. A page opened mid-answer already holds the buffer so
 * far (`GET` returns `content`) and the steps recorded so far (`toolCalls`);
 * both are the starting state, and the connection resumes AFTER that content
 * (`connectAskStream`'s `resume`), so nothing is fetched or shown twice.
 *
 * Unmounting, or the message changing, closes the connection. That never
 * cancels the turn: `ask.respond` finishes whether or not anybody is watching
 * (CLAUDE.md, Notes rule 1), and remounting resumes from the row.
 */

import { useEffect, useRef, useState } from 'react';

import { connectAskStream } from '../services/askStream';
import type { AskStreamErrorClass } from '../services/askStream';
import type { AskCitation, AskFinishReason, AskMessage, AskToolCall } from '../services/ask';

export type AskStreamStatus = 'idle' | 'streaming' | 'done' | 'error';

export interface AskStreamErrorState {
  errorClass: AskStreamErrorClass;
  reason: string | null;
}

export interface AskStreamState {
  /** The message this state describes, or `null` when idle. */
  messageId: string | null;
  content: string;
  steps: AskToolCall[];
  status: AskStreamStatus;
  citations: AskCitation[];
  finishReason: AskFinishReason | null;
  error: AskStreamErrorState | null;
}

export interface UseAskStreamOptions {
  onDone?: (messageId: string, done: { content: string; citations: AskCitation[]; finishReason: AskFinishReason }) => void;
  onError?: (messageId: string, error: AskStreamErrorState & { content: string }) => void;
  /** Bump to reconnect to the same message (after the reader's duration cap). */
  reconnectKey?: number;
}

const IDLE: AskStreamState = {
  messageId: null,
  content: '',
  steps: [],
  status: 'idle',
  citations: [],
  finishReason: null,
  error: null,
};

/** Whether a message is one the stream should attach to. */
export function isRunningAssistantMessage(message: AskMessage | null | undefined): message is AskMessage {
  return Boolean(
    message && message.role === 'assistant' && (message.status === 'pending' || message.status === 'streaming'),
  );
}

/**
 * Merge steps by `index`, ordered by it. The first report of an index wins: a
 * reconnect re-sends every step, and a recorded step never changes.
 */
export function mergeSteps(current: readonly AskToolCall[], incoming: readonly AskToolCall[]): AskToolCall[] {
  const byIndex = new Map<number, AskToolCall>();
  for (const step of [...current, ...incoming]) {
    if (!byIndex.has(step.index)) byIndex.set(step.index, step);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

export function useAskStream(
  message: AskMessage | null | undefined,
  options: UseAskStreamOptions = {},
): AskStreamState {
  const running = isRunningAssistantMessage(message);
  const messageId = running ? message.id : null;

  const [state, setState] = useState<AskStreamState>(() =>
    running
      ? { ...IDLE, messageId: message.id, content: message.content, steps: message.toolCalls, status: 'streaming' }
      : IDLE,
  );

  // The latest message and callbacks, read inside the effect without making
  // every re-render of the row a reconnect.
  const messageRef = useRef(message);
  messageRef.current = message;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const reconnectKey = options.reconnectKey ?? 0;

  useEffect(() => {
    if (!messageId) {
      setState(IDLE);
      return undefined;
    }
    const seed = messageRef.current;
    const seedContent = seed?.id === messageId ? seed.content : '';
    const seedSteps = seed?.id === messageId ? seed.toolCalls : [];
    let content = seedContent;

    setState({
      ...IDLE,
      messageId,
      content: seedContent,
      steps: seedSteps,
      status: 'streaming',
    });

    const connection = connectAskStream(
      messageId,
      {
        onContent: (full) => {
          content = full;
          setState((prev) => (prev.messageId === messageId ? { ...prev, content: full } : prev));
        },
        onStep: (step) => {
          setState((prev) =>
            prev.messageId === messageId ? { ...prev, steps: mergeSteps(prev.steps, [step]) } : prev,
          );
        },
        onDone: ({ citations, finishReason }) => {
          setState((prev) =>
            prev.messageId === messageId ? { ...prev, status: 'done', citations, finishReason } : prev,
          );
          optionsRef.current.onDone?.(messageId, { content, citations, finishReason });
        },
        onError: (error) => {
          setState((prev) => (prev.messageId === messageId ? { ...prev, status: 'error', error } : prev));
          optionsRef.current.onError?.(messageId, { ...error, content });
        },
      },
      { content: seedContent, knownStepIndexes: seedSteps.map((step) => step.index) },
    );

    return () => connection.close();
  }, [messageId, reconnectKey]);

  return state.messageId === messageId ? state : IDLE;
}

export default useAskStream;
