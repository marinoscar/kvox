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

import { useKvoxHost } from '../../../core/headless/index.js';
import { connectAskStream } from '../clients/askStream.js';
import type { AskStreamErrorClass } from '../clients/askStream.js';
import type { AskCitation, AskFinishReason, AskMessage, AskToolCall } from '../clients/ask.js';

/**
 * Where the live view of a turn is.
 *
 * @stability experimental
 */
export type AskStreamStatus = 'idle' | 'streaming' | 'done' | 'error';

/**
 * Why a streamed turn failed.
 *
 * @stability experimental
 */
export interface AskStreamErrorState {
  /** What the failure is blamed on (the wire-only `gone` included). */
  errorClass: AskStreamErrorClass;
  /** `stream_duration_cap` when the reader gave up; the provider's words otherwise. */
  reason: string | null;
}

/**
 * The live view of ONE assistant turn.
 *
 * @stability experimental
 */
export interface AskStreamState {
  /** The message this state describes, or `null` when idle. */
  messageId: string | null;
  /** The whole answer so far. */
  content: string;
  /** The tool steps so far, ordered by index. */
  steps: AskToolCall[];
  /** Where the turn is. */
  status: AskStreamStatus;
  /** The resolved citations, once the turn is done. */
  citations: AskCitation[];
  /** Why the turn ended, once it is done. */
  finishReason: AskFinishReason | null;
  /** The failure, once the turn failed. */
  error: AskStreamErrorState | null;
}

/**
 * Options of {@link useAskStream}.
 *
 * @stability experimental
 */
export interface UseAskStreamOptions {
  /** The turn completed; `done` carries the final buffer, citations and finish reason. */
  onDone?: (messageId: string, done: { content: string; citations: AskCitation[]; finishReason: AskFinishReason }) => void;
  /** The turn failed, the row vanished, or the reader gave up. */
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

/**
 * Whether a message is one the stream should attach to.
 *
 * @param message - Any message, or none.
 * @returns `true` for an assistant message that is `pending` or `streaming`.
 *
 * @stability experimental
 */
export function isRunningAssistantMessage(message: AskMessage | null | undefined): message is AskMessage {
  return Boolean(
    message && message.role === 'assistant' && (message.status === 'pending' || message.status === 'streaming'),
  );
}

/**
 * Merges steps by `index`, ordered by it. The first report of an index wins: a
 * reconnect re-sends every step, and a recorded step never changes.
 *
 * @param current - The steps held.
 * @param incoming - The steps just reported.
 * @returns The merged, ordered steps.
 *
 * @stability experimental
 */
export function mergeSteps(current: readonly AskToolCall[], incoming: readonly AskToolCall[]): AskToolCall[] {
  const byIndex = new Map<number, AskToolCall>();
  for (const step of [...current, ...incoming]) {
    if (!byIndex.has(step.index)) byIndex.set(step.index, step);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * The live view of one assistant turn.
 *
 * @param message - The message to follow; anything but a running assistant message is idle.
 * @param options - Callbacks and the reconnect key.
 * @returns The live state.
 *
 * @stability experimental
 */
export function useAskStream(
  message: AskMessage | null | undefined,
  options: UseAskStreamOptions = {},
): AskStreamState {
  const host = useKvoxHost();
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
  // The host is read when a connection opens, not a reason to open another one:
  // the answer keeps streaming if the app rebuilds its host object mid-turn.
  const hostRef = useRef(host);
  hostRef.current = host;

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
      hostRef.current,
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
