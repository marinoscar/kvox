import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';

import {
  DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STREAM_POLL_INTERVAL_MS,
  KvoxRowStreamPoller,
  KvoxStreamCursor,
  STREAM_DURATION_CAP_MARGIN_MS,
  toDeltaFrame,
} from '../../core/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';
import { ASK_RESPOND_MAX_RUNTIME_MS } from '../ask-limits.js';
import { parseAskCitations, parseAskToolCalls } from '../ask-message.mapper.js';
import type { KvoxAskDb } from '../data/ask-db.js';
import {
  ASK_STREAM_CAP_REASON,
  ASK_STREAM_GONE_REASON,
  StepCursor,
  toAskDoneFrame,
  toAskErrorFrame,
  toAskFinishReason,
  toAskStepFrame,
  toAskStreamErrorClass,
  toStepData,
  type AskStreamMessage,
} from './ask-stream.js';

// =============================================================================
// The Ask answer reader (issue #379, epic #348; docs/specs/ontology.md §21.4)
// =============================================================================
//
// One open SSE connection is one subscription to the Observable this service
// builds. It re-reads ONE `ask_messages` row by primary key every 250 ms and
// emits whatever the `ask.respond` job (#378) recorded since the last poll:
// new tool steps first, then new answer text, then — once the row settles —
// `done` or `error`.
//
// It is `NoteGenerationStreamService`'s loop with one more column read, and it
// is a POLL for all three of that file's reasons (a second API replica, resume,
// a late attach) — the job may run on any replica, and only the durable row is
// visible from all of them. Do not "optimise" it into an in-process push.
//
// NOTHING HERE WRITES ANYTHING (CLAUDE.md, Notes rule 1, applied to Ask). The
// answer, its steps and its citations are committed by `ask.respond` whether or
// not a connection ever existed; closing this stream cancels nothing.
// =============================================================================

/**
 * `ask.respond`'s `profile.maxRuntimeMs` (#378, spec §21.3: five minutes),
 * imported from the job's own limit so the stream cap can never fall below
 * the job it is watching.
 */
export const ASK_RESPOND_STREAM_RUNTIME_MS = ASK_RESPOND_MAX_RUNTIME_MS;

/** The hard ceiling on one connection: the job's runtime plus the notes margin. */
export const DEFAULT_ASK_STREAM_DURATION_CAP_MS =
  ASK_RESPOND_STREAM_RUNTIME_MS + STREAM_DURATION_CAP_MARGIN_MS;

/**
 * The three numbers and the clock one connection runs on — `NoteStreamTuning`'s shape.
 *
 * @stability experimental
 */
export interface AskStreamTuning {
  /** Milliseconds between reads of the answer row. */
  pollIntervalMs: number;
  /** Milliseconds between heartbeat comments. */
  heartbeatIntervalMs: number;
  /** The hard ceiling on one connection, in milliseconds. */
  durationCapMs: number;
  /** Reads the wall clock. Injected so a test drives the cap exactly. */
  now: () => number;
}

/**
 * DI token for overriding {@link AskStreamTuning}. Registered with `{}` in
 * `AskModule`, so the defaults ship; present only so a spec can override it —
 * exactly `NOTE_STREAM_TUNING`.
 *
 * @stability experimental
 */
export const ASK_STREAM_TUNING = 'ASK_STREAM_TUNING';

/** What the poll reads — the smallest row that answers every frame. */
interface MessageSnapshot {
  status: string;
  content: string;
  toolCalls: unknown;
  citations: unknown;
  promptTokens: number | null;
  completionTokens: number | null;
  errorClass: string | null;
  finishReason: string | null;
}

/**
 * AskMessageStreamService: wiring the slice registers itself; a host configures it through `AskModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class AskMessageStreamService {
  private readonly logger = new Logger(AskMessageStreamService.name);

  private readonly tuning: AskStreamTuning;

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxAskDb,
    @Optional()
    @Inject(ASK_STREAM_TUNING)
    tuning: Partial<AskStreamTuning> = {},
  ) {
    this.tuning = {
      pollIntervalMs: tuning.pollIntervalMs ?? DEFAULT_STREAM_POLL_INTERVAL_MS,
      heartbeatIntervalMs: tuning.heartbeatIntervalMs ?? DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS,
      durationCapMs: tuning.durationCapMs ?? DEFAULT_ASK_STREAM_DURATION_CAP_MS,
      now: tuning.now ?? (() => Date.now()),
    };
  }

  /**
   * Tail one assistant message from `fromOffset` until it settles.
   *
   * COLD AND PER-SUBSCRIBER, like the note stream: nothing is allocated until a
   * subscription exists, and unsubscribing (the client going away) clears both
   * timers.
   *
   * @param messageId - an id the caller has ALREADY been authorised for, through
   *        `AskAccessService.requireMessage`. This method checks nothing.
   * @param fromOffset - the client's position (`Last-Event-ID`). Everything after
   *        it is replayed on the first poll, and every recorded step is re-sent,
   *        so a late attach and an early one run the same code path.
   */
  stream(messageId: string, fromOffset = 0): Observable<AskStreamMessage> {
    const { pollIntervalMs, heartbeatIntervalMs, durationCapMs, now } = this.tuning;
    const poller = new KvoxRowStreamPoller({ pollIntervalMs, heartbeatMs: heartbeatIntervalMs, durationCapMs, now });

    return new Observable<AskStreamMessage>((subscriber) => {
      const cursor = new KvoxStreamCursor(fromOffset);
      const steps = new StepCursor();
      const startedAt = now();

      this.logger.debug({ msg: 'ask stream opened', messageId, fromOffset: cursor.position });

      const error = (errorClass: Parameters<typeof toAskErrorFrame>[0]['errorClass'], detail: string | null) =>
        toAskErrorFrame({ status: 'failed', offset: cursor.position, errorClass, reason: detail });

      /** New steps first: they happened before the text that follows them. */
      const emitProgress = (row: MessageSnapshot, emit: (message: AskStreamMessage) => void): void => {
        for (const call of steps.next(parseAskToolCalls(row.toolCalls))) {
          emit(toAskStepFrame(toStepData(call, cursor.position)));
        }

        const delta = cursor.advance(row.content);
        if (delta) emit(toDeltaFrame(delta));
      };

      return poller
        .stream<MessageSnapshot, AskStreamMessage>({
          read: () => this.read(messageId),
          // A transient read failure never closes the stream: the durable row is untouched and
          // the next poll is one interval away. The cap still bounds it.
          onReadError: (cause) => {
            this.logger.warn(
              `Poll for ask message ${messageId} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          },
          // The row is gone: its conversation was deleted (cascade). Nothing is left to tail
          // and nothing left to carry a stored class.
          onGone: (emit) => emit(error('gone', ASK_STREAM_GONE_REASON)),
          onRow: (row, emit) => {
            // `pending` has nothing to show yet, including a turn `ask.respond` reset to
            // `pending` after a rate limit, whose `tool_calls` it emptied. The cursor needs no
            // special case for that: text is only ever flushed after the reset point.
            if (row.status !== 'pending') emitProgress(row, emit);

            // Terminal status. Progress above is emitted FIRST in this same poll, so the last
            // text written before the job settled is never stranded behind the closing frame.
            if (row.status === 'complete') {
              emit(
                toAskDoneFrame({
                  status: 'succeeded',
                  offset: cursor.position,
                  citations: parseAskCitations(row.citations),
                  finishReason: toAskFinishReason(row.finishReason),
                  promptTokens: row.promptTokens,
                  completionTokens: row.completionTokens,
                }),
              );

              return 'complete';
            }

            if (row.status === 'failed') {
              emit(error(toAskStreamErrorClass(row.errorClass), null));

              return 'failed';
            }

            return null;
          },
          // The hard duration cap: a client-facing safety net, never a verdict on the job,
          // which may still finish; the client refetches the conversation.
          onCap: (emit) => emit(error('timeout', ASK_STREAM_CAP_REASON)),
          onClose: (reason) => {
            this.logger.debug({
              msg: 'ask stream closed',
              messageId,
              fromOffset,
              offset: cursor.position,
              steps: steps.size,
              reason,
              ms: now() - startedAt,
            });
          },
        })
        .subscribe(subscriber);
    });
  }

  /** One read by primary key — the whole cost of the poll. */
  private async read(messageId: string): Promise<MessageSnapshot | null> {
    const row = await this.prisma.askMessage.findUnique({
      where: { id: messageId },
      select: {
        status: true,
        content: true,
        toolCalls: true,
        citations: true,
        promptTokens: true,
        completionTokens: true,
        errorClass: true,
        finishReason: true,
      },
    });

    return (row as MessageSnapshot | null) ?? null;
  }
}
