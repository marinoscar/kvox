import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';

import { PrismaService } from '../../prisma/prisma.service';
import { NOTE_GENERATE_MAX_RUNTIME_MS } from '../handlers/note-generate.handler';
import {
  NoteStreamCursor,
  toDeltaFrame,
  toDoneFrame,
  toErrorFrame,
  type NoteStreamErrorClass,
  type NoteStreamMessage,
} from './note-stream';

// =============================================================================
// The reader (issue #52, epic #45, docs/specs/notes.md §5.2)
// =============================================================================
//
// One open SSE connection is one subscription to the Observable this service
// builds. It re-reads a single `note_generations` row by primary key on a short
// interval and emits whatever text arrived since the last frame it sent.
//
// -----------------------------------------------------------------------------
// ⚠ IT IS A POLL. AN IN-PROCESS `EventEmitter` IS REJECTED — THREE COUNTS, ANY
//   ONE FATAL. DO NOT "OPTIMISE" THIS INTO A PUSH.
// -----------------------------------------------------------------------------
//
// This is the alternative every reader of this file will reach for first: have
// `note-generate.handler.ts` publish each delta to an emitter and have this
// controller subscribe. It is wrong, and it fails in ways that produce no error
// and nothing in a log:
//
//   1. IT BREAKS THE MOMENT THERE IS A SECOND API REPLICA. An `EventEmitter`
//      lives in one process's heap. `note.generate` is server-only, but that
//      only means no worker NODE may claim it — any API replica running the
//      worker can, and behind a load balancer with no sticky sessions there is
//      no reason the replica executing the job is also the one holding this
//      browser's connection. An emitter on replica A is invisible to a listener
//      on replica B: the stream simply hangs, forever, while the replica doing
//      the work reports a perfectly healthy generation.
//
//   2. IT CANNOT RESUME A RECONNECT. There is no `Last-Event-ID` equivalent for
//      an emitter because nothing is persisted to resume FROM. Every reconnect
//      would restart the client's view from empty — the precise failure the
//      epic's own success criterion rules out.
//
//   3. A LATE ATTACH SHOWS NOTHING. An emitter is a broadcast primitive, not a
//      log: it has no memory of anything emitted before a listener attached. A
//      user who opens the note one second after generation started would watch
//      a blank pane fill in from the middle. The only fix is to ALSO keep a
//      durable copy for replay — at which point the durable copy is the real
//      source of truth and the emitter is a redundant second one layered on it.
//
// Reading durable state buys all three for free. The cost is one indexed
// single-row read per interval for the seconds-to-minutes one generation lasts,
// which is the same trade `docs/specs/transcription.md` §5's weak-ETag polling
// already made, at a shorter interval because a token stream has to read as
// live in a way a settings row does not.
//
// -----------------------------------------------------------------------------
// THE STREAM IS ADDITIVE. NOTHING HERE WRITES ANYTHING.
// -----------------------------------------------------------------------------
//
// Every method on this service is a read. The generation completes, the note is
// committed and the version is written by `note.generate` alone, whether or not
// a connection ever existed, stayed open, or was read
// (`note-generation.service.ts`'s header states the same property from the
// writer's side). A bug in this file can cost a user a live view; it cannot
// cost them a note.
// =============================================================================

/** Milliseconds between reads of the row. Spec §5.2 asks for ~150–300 ms. */
export const DEFAULT_STREAM_POLL_INTERVAL_MS = 250;

/**
 * How often an idle connection is sent a comment line.
 *
 * Same 25 s, for the same reason, as the notification stream's own heartbeat:
 * it sits comfortably under the shortest idle timeout in common use (30 s) and
 * under nginx's `proxy_read_timeout`, with room for a scheduling delay. It
 * matters MORE here than there, because the gap this stream has to survive is
 * routine rather than exceptional — a model can think for tens of seconds
 * before its first token, and an SSE connection that has sent nothing is
 * indistinguishable, to everything between the browser and this process, from a
 * dead one.
 *
 * A COMMENT (`: …`), never an event: comment lines are consumed by the client's
 * parser and never surface as a frame, so a heartbeat can never be mistaken for
 * a delta by a consumer that forgot to check the event name.
 */
export const DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Slack on top of the job's own timeout before a connection gives up.
 *
 * The cap has to be LONGER than `note.generate` can legitimately run, or a
 * healthy long generation would have its stream torn down at the finish line;
 * and it has to be FINITE, or one wedged job pins a connection (and a Postgres
 * poll every 250 ms) forever. One minute of margin covers the gap between the
 * job's own deadline and the reaper actually settling the row.
 */
export const STREAM_DURATION_CAP_MARGIN_MS = 60_000;

/** The hard ceiling on one connection. Derived, never a second free number. */
export const DEFAULT_STREAM_DURATION_CAP_MS =
  NOTE_GENERATE_MAX_RUNTIME_MS + STREAM_DURATION_CAP_MARGIN_MS;

/** The three numbers and the clock one connection runs on. */
export interface NoteStreamTuning {
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  durationCapMs: number;
  /** Reads the wall clock. Injected so a test drives the cap exactly. */
  now: () => number;
}

/**
 * DI token for overriding {@link NoteStreamTuning}.
 *
 * Registered with `{}` in `NotesModule` — so the defaults below are what ships
 * — and present at all only because a spec cannot override a provider a module
 * never declared. Nothing in production supplies a value.
 */
export const NOTE_STREAM_TUNING = 'NOTE_STREAM_TUNING';

/** What the poll reads. Deliberately the smallest row that answers everything. */
interface GenerationSnapshot {
  status: string;
  content: string;
  errorClass: string | null;
  errorDetail: string | null;
  note: { currentVersion: number } | null;
}

@Injectable()
export class NoteGenerationStreamService {
  private readonly logger = new Logger(NoteGenerationStreamService.name);

  private readonly tuning: NoteStreamTuning;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(NOTE_STREAM_TUNING)
    tuning: Partial<NoteStreamTuning> = {},
  ) {
    this.tuning = {
      pollIntervalMs: tuning.pollIntervalMs ?? DEFAULT_STREAM_POLL_INTERVAL_MS,
      heartbeatIntervalMs:
        tuning.heartbeatIntervalMs ?? DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS,
      durationCapMs: tuning.durationCapMs ?? DEFAULT_STREAM_DURATION_CAP_MS,
      now: tuning.now ?? (() => Date.now()),
    };
  }

  /**
   * Tail one generation from `fromOffset` until it settles.
   *
   * COLD AND PER-SUBSCRIBER: everything is allocated inside the subscribe
   * function, so a connection created and never subscribed (a client that
   * vanished during setup) starts no timer and holds no resource.
   *
   * @param generationId an id the caller has ALREADY been authorised for.
   *        `NoteGenerationAccessService` is the only correct source; this
   *        method performs no access check of its own and must never be handed
   *        an id straight off a request.
   * @param fromOffset the client's position, from `Last-Event-ID`. Everything
   *        after it is replayed immediately, before live tailing begins — which
   *        is what makes a late attach and an early one converge on the same
   *        text through ONE code path, with no "is it still running?" branch.
   */
  stream(generationId: string, fromOffset = 0): Observable<NoteStreamMessage> {
    const { pollIntervalMs, heartbeatIntervalMs, durationCapMs, now } = this.tuning;

    return new Observable<NoteStreamMessage>((observer) => {
      const cursor = new NoteStreamCursor(fromOffset);
      const startedAt = now();

      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;

      // An immediate comment, before anything else. NOT DECORATION: it commits
      // the response headers, which `SseStream` otherwise defers until the
      // first message — so a client attaching to a model that has not produced
      // a token yet could not tell "connected and waiting" from "still
      // connecting", and a buffering proxy would hold a zero-byte response open
      // through its own idle timeout.
      observer.next({ comment: 'connected' });

      const heartbeat = setInterval(() => {
        observer.next({ comment: 'heartbeat' });
      }, heartbeatIntervalMs);

      // `unref` so an open connection can never be the reason this process
      // refuses to exit — without it one idle tab makes every `docker compose
      // down` wait out its stop grace period. `?.` because a fake-timer
      // environment need not implement it.
      heartbeat.unref?.();

      const finish = (): void => {
        closed = true;
        observer.complete();
      };

      const fail = (
        errorClass: NoteStreamErrorClass,
        reason: string | null,
      ): void => {
        observer.next(
          toErrorFrame({
            status: 'failed',
            offset: cursor.position,
            errorClass,
            reason,
          }),
        );
        finish();
      };

      const schedule = (): void => {
        if (closed) return;

        pollTimer = setTimeout(() => {
          void poll();
        }, pollIntervalMs);
        pollTimer.unref?.();
      };

      const poll = async (): Promise<void> => {
        if (closed) return;

        let row: GenerationSnapshot | null;

        try {
          row = await this.read(generationId);
        } catch (error) {
          // A TRANSIENT READ FAILURE MUST NOT CLOSE THE STREAM. The durable
          // state is untouched and the next poll is 250 ms away; tearing the
          // connection down would turn one blipped query into a visible
          // "generation failed" for a generation that is fine. The duration cap
          // still bounds how long this can go on.
          this.logger.warn(
            `Poll for note generation ${generationId} failed: ${describe(error)}`,
          );
          schedule();

          return;
        }

        // The client may have gone away while that read was in flight.
        if (closed) return;

        if (!row) {
          // Termination 4: the row is gone — a preview's TTL sweep took it, or
          // the parent note was purged. There is nothing left to tail and
          // nothing left to carry an error class.
          fail('gone', 'This generation is no longer available.');

          return;
        }

        const delta = cursor.advance(row.content);

        if (delta) observer.next(toDeltaFrame(delta));

        // Termination 1: terminal status. The delta above is emitted FIRST, in
        // this same poll, so the last text written before the job settled is
        // never stranded behind the frame that closes the stream.
        if (row.status === 'succeeded') {
          observer.next(
            toDoneFrame({
              status: 'succeeded',
              offset: cursor.position,
              currentVersion: row.note?.currentVersion ?? null,
            }),
          );
          finish();

          return;
        }

        if (row.status === 'failed') {
          fail(toErrorClass(row.errorClass), row.errorDetail);

          return;
        }

        // Termination 3: the hard duration cap. The job is presumably wedged or
        // was reaped; this is a CLIENT-FACING SAFETY NET layered on top of the
        // queue's own recovery, never a substitute for it — nothing here
        // touches the job row.
        if (now() - startedAt >= durationCapMs) {
          fail(
            'timeout',
            'This generation is taking longer than expected. Reload the note to check on it.',
          );

          return;
        }

        schedule();
      };

      // The first poll is IMMEDIATE, not one interval away. It is what makes a
      // late attach answer "here is the whole buffer, and it is done" in a
      // single round trip instead of after a pointless quarter-second wait.
      void poll();

      // Termination 2: the client disconnected (tab closed, navigation,
      // network drop). Nest unsubscribes on the raw socket's `close`, which
      // runs this — and NOTHING ABOUT THE JOB IS AFFECTED. It keeps running and
      // keeps flushing; this is the literal mechanism behind "closing the tab
      // loses nothing".
      //
      // Idempotent by construction (`clearInterval`/`clearTimeout` are both
      // safe to run twice) because RxJS is not the only thing that can trigger
      // it, and a teardown that must run exactly once is one that eventually
      // runs zero times.
      return () => {
        closed = true;
        clearInterval(heartbeat);
        if (pollTimer) clearTimeout(pollTimer);
      };
    });
  }

  /** One indexed read by primary key — the whole cost of the poll. */
  private async read(generationId: string): Promise<GenerationSnapshot | null> {
    const row = await this.prisma.noteGeneration.findUnique({
      where: { id: generationId },
      select: {
        status: true,
        content: true,
        errorClass: true,
        errorDetail: true,
        // `currentVersion` is what `done` carries, and it has to be read in the
        // SAME statement as the terminal status: read separately, a commit
        // landing between the two reads would publish a `done` naming the
        // version BEFORE the one this generation just produced.
        note: { select: { currentVersion: true } },
      },
    });

    return (row as GenerationSnapshot | null) ?? null;
  }
}

/**
 * A stored `error_class` as the wire's own union.
 *
 * Total over anything the column could hold, including a class added by a later
 * build: an unrecognised value becomes `other`, which is exactly what it means
 * to a client. The two wire-only classes (`timeout`, `gone`) can never arrive
 * here because no code path writes them to the column.
 */
function toErrorClass(stored: string | null): NoteStreamErrorClass {
  return stored === 'auth' || stored === 'refusal' || stored === 'rate_limit'
    ? stored
    : 'other';
}

/** A thrown value as one log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
