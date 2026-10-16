import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';

import {
  DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STREAM_POLL_INTERVAL_MS,
  STREAM_DURATION_CAP_MARGIN_MS,
} from '../../notes/generation/note-generation-stream.service';
import { NoteStreamCursor, toDeltaFrame } from '../../notes/generation/note-stream';
import { PrismaService } from '../../prisma/prisma.service';
import { ASK_RESPOND_MAX_RUNTIME_MS } from '../ask-limits';
import { parseAskCitations, parseAskToolCalls } from '../ask-message.mapper';
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
  type AskStreamErrorClass,
  type AskStreamMessage,
} from './ask-stream';

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

/** The three numbers and the clock one connection runs on — `NoteStreamTuning`'s shape. */
export interface AskStreamTuning {
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  durationCapMs: number;
  /** Reads the wall clock. Injected so a test drives the cap exactly. */
  now: () => number;
}

/**
 * DI token for overriding {@link AskStreamTuning}. Registered with `{}` in
 * `AskModule`, so the defaults ship; present only so a spec can override it —
 * exactly `NOTE_STREAM_TUNING`.
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

/** Why a connection closed, for the debug log. */
type CloseReason = 'complete' | 'failed' | 'gone' | 'cap' | 'client';

@Injectable()
export class AskMessageStreamService {
  private readonly logger = new Logger(AskMessageStreamService.name);

  private readonly tuning: AskStreamTuning;

  constructor(
    private readonly prisma: PrismaService,
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
   * @param messageId an id the caller has ALREADY been authorised for, through
   *        `AskAccessService.requireMessage`. This method checks nothing.
   * @param fromOffset the client's position (`Last-Event-ID`). Everything after
   *        it is replayed on the first poll, and every recorded step is re-sent,
   *        so a late attach and an early one run the same code path.
   */
  stream(messageId: string, fromOffset = 0): Observable<AskStreamMessage> {
    const { pollIntervalMs, heartbeatIntervalMs, durationCapMs, now } = this.tuning;

    return new Observable<AskStreamMessage>((observer) => {
      const cursor = new NoteStreamCursor(fromOffset);
      const steps = new StepCursor();
      const startedAt = now();

      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;

      this.logger.debug({ msg: 'ask stream opened', messageId, fromOffset: cursor.position });

      // Commits the response headers immediately (see the note stream): a
      // client attaching to a still-`pending` turn must be able to tell
      // "connected and waiting" from "still connecting".
      observer.next({ comment: 'connected' });

      const heartbeat = setInterval(() => {
        observer.next({ comment: 'heartbeat' });
      }, heartbeatIntervalMs);
      heartbeat.unref?.();

      const log = (reason: CloseReason): void => {
        this.logger.debug({
          msg: 'ask stream closed',
          messageId,
          fromOffset,
          offset: cursor.position,
          steps: steps.size,
          reason,
          ms: now() - startedAt,
        });
      };

      const finish = (reason: CloseReason): void => {
        closed = true;
        clearInterval(heartbeat);
        log(reason);
        observer.complete();
      };

      const fail = (
        reason: CloseReason,
        errorClass: AskStreamErrorClass,
        detail: string | null,
      ): void => {
        observer.next(
          toAskErrorFrame({ status: 'failed', offset: cursor.position, errorClass, reason: detail }),
        );
        finish(reason);
      };

      const schedule = (): void => {
        if (closed) return;
        pollTimer = setTimeout(() => {
          void poll();
        }, pollIntervalMs);
        pollTimer.unref?.();
      };

      /** New steps first — they happened before the text that follows them. */
      const emitProgress = (row: MessageSnapshot): void => {
        for (const call of steps.next(parseAskToolCalls(row.toolCalls))) {
          observer.next(toAskStepFrame(toStepData(call, cursor.position)));
        }

        const delta = cursor.advance(row.content);
        if (delta) observer.next(toDeltaFrame(delta));
      };

      const poll = async (): Promise<void> => {
        if (closed) return;

        let row: MessageSnapshot | null;

        try {
          row = await this.read(messageId);
        } catch (error) {
          // A transient read failure never closes the stream: the durable row
          // is untouched and the next poll is 250 ms away. The cap still bounds it.
          this.logger.warn(
            `Poll for ask message ${messageId} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          schedule();
          return;
        }

        if (closed) return;

        if (!row) {
          // The row is gone — its conversation was deleted (cascade). Nothing
          // is left to tail and nothing left to carry a stored class.
          fail('gone', 'gone', ASK_STREAM_GONE_REASON);
          return;
        }

        // `pending` has nothing to show yet — including a turn #378 reset to
        // `pending` after a rate limit, whose `tool_calls` it emptied. The
        // cursor below needs no special case for that: text is only ever
        // flushed after the reset point, never before it.
        if (row.status !== 'pending') emitProgress(row);

        // Terminal status. Progress above is emitted FIRST in this same poll,
        // so the last text written before the job settled is never stranded
        // behind the frame that closes the stream.
        if (row.status === 'complete') {
          observer.next(
            toAskDoneFrame({
              status: 'succeeded',
              offset: cursor.position,
              citations: parseAskCitations(row.citations),
              finishReason: toAskFinishReason(row.finishReason),
              promptTokens: row.promptTokens,
              completionTokens: row.completionTokens,
            }),
          );
          finish('complete');
          return;
        }

        if (row.status === 'failed') {
          fail('failed', toAskStreamErrorClass(row.errorClass), null);
          return;
        }

        // The hard duration cap: a client-facing safety net, never a verdict
        // on the job, which may still finish — the client refetches the
        // conversation. Nothing here touches the job or the row.
        if (now() - startedAt >= durationCapMs) {
          fail('cap', 'timeout', ASK_STREAM_CAP_REASON);
          return;
        }

        schedule();
      };

      // The first poll is immediate: a settled turn answers in one round trip.
      void poll();

      // The client disconnected. Nothing about the job is affected.
      return () => {
        if (!closed) {
          closed = true;
          log('client');
        }
        clearInterval(heartbeat);
        if (pollTimer) clearTimeout(pollTimer);
      };
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
