import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';

import {
  DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS as CORE_STREAM_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STREAM_POLL_INTERVAL_MS as CORE_STREAM_POLL_INTERVAL_MS,
  KvoxRowStreamPoller,
  KvoxStreamCursor,
  STREAM_DURATION_CAP_MARGIN_MS as CORE_STREAM_DURATION_CAP_MARGIN_MS,
  toDeltaFrame,
  toDoneFrame,
  toErrorFrame,
  type KvoxStreamErrorClass,
  type KvoxStreamMessage,
} from '../../core/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';
import type { KvoxNotesDb } from '../data/notes-db.js';
import { NOTES_MODULE_OPTIONS, type ResolvedNotesOptions } from '../notes.options.js';
import { NOTE_GENERATE_MAX_RUNTIME_MS } from '../handlers/note-generate.handler.js';

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

// The poll interval, heartbeat and cap margin are `core/stream/row-stream-poller.ts`'s since issue #497 (the Ask
// stream shares them); they keep their names here.

/**
 * Milliseconds between reads of the row. Spec §5.2 asks for roughly 150 to 300 ms.
 *
 * @stability experimental
 */
export const DEFAULT_STREAM_POLL_INTERVAL_MS = CORE_STREAM_POLL_INTERVAL_MS;

/**
 * How often an idle connection is sent a comment line (25 s, under the shortest idle timeout in common use).
 *
 * @stability experimental
 */
export const DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS = CORE_STREAM_HEARTBEAT_INTERVAL_MS;

/**
 * Slack on top of the job's own timeout before a connection gives up.
 *
 * @stability experimental
 */
export const STREAM_DURATION_CAP_MARGIN_MS = CORE_STREAM_DURATION_CAP_MARGIN_MS;

/** The hard ceiling on one connection. Derived, never a second free number. */
/**
 * DEFAULT_STREAM_DURATION_CAP_MS.
 *
 * @stability experimental
 */
export const DEFAULT_STREAM_DURATION_CAP_MS =
  NOTE_GENERATE_MAX_RUNTIME_MS + STREAM_DURATION_CAP_MARGIN_MS;

/** The three numbers and the clock one connection runs on. */
/**
 * NoteStreamTuning: a shape the slice passes between its own services.
 *
 * @internal
 * @stability experimental
 */
export interface NoteStreamTuning {
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  durationCapMs: number;
  /** Reads the wall clock. Injected so a test drives the cap exactly. */
  now: () => number;
}

/**
 * DI token for overriding `NoteStreamTuning`.
 *
 * Registered with `{}` in `NotesModule` — so the defaults below are what ships
 * — and present at all only because a spec cannot override a provider a module
 * never declared. Nothing in production supplies a value.
 *
 * @stability experimental
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

/**
 * NoteGenerationStreamService: wiring the slice registers itself; a host configures it through `NotesModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteGenerationStreamService {
  private readonly logger = new Logger(NoteGenerationStreamService.name);

  private readonly tuning: NoteStreamTuning;

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb,
    @Optional()
    @Inject(NOTE_STREAM_TUNING)
    tuning: Partial<NoteStreamTuning> = {},
    @Optional()
    @Inject(NOTES_MODULE_OPTIONS)
    options?: ResolvedNotesOptions,
  ) {
    this.tuning = {
      pollIntervalMs: tuning.pollIntervalMs ?? DEFAULT_STREAM_POLL_INTERVAL_MS,
      heartbeatIntervalMs:
        tuning.heartbeatIntervalMs ?? DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS,
      durationCapMs: tuning.durationCapMs ?? options?.stream.maxDurationMs ?? DEFAULT_STREAM_DURATION_CAP_MS,
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
   * @param generationId - an id the caller has ALREADY been authorised for.
   *        `NoteGenerationAccessService` is the only correct source; this
   *        method performs no access check of its own and must never be handed
   *        an id straight off a request.
   * @param fromOffset - the client's position, from `Last-Event-ID`. Everything
   *        after it is replayed immediately, before live tailing begins — which
   *        is what makes a late attach and an early one converge on the same
   *        text through ONE code path, with no "is it still running?" branch.
   */
  stream(generationId: string, fromOffset = 0): Observable<KvoxStreamMessage> {
    const { pollIntervalMs, heartbeatIntervalMs, durationCapMs, now } = this.tuning;
    // One cursor per subscription: the poller allocates per subscriber, the cursor must too.
    const poller = new KvoxRowStreamPoller({ pollIntervalMs, heartbeatMs: heartbeatIntervalMs, durationCapMs, now });

    return new Observable<KvoxStreamMessage>((subscriber) => {
      const cursor = new KvoxStreamCursor(fromOffset);

      const failure = (errorClass: KvoxStreamErrorClass, reason: string | null): KvoxStreamMessage =>
        toErrorFrame({ status: 'failed', offset: cursor.position, errorClass, reason });

      return poller
        .stream<GenerationSnapshot>({
          read: () => this.read(generationId),
          onReadError: (error) => {
            this.logger.warn(`Poll for note generation ${generationId} failed: ${describe(error)}`);
          },
          // Termination 4: the row is gone, a preview's TTL sweep took it, or the parent
          // note was purged. Nothing is left to tail and nothing to carry an error class.
          onGone: (emit) => emit(failure('gone', 'This generation is no longer available.')),
          onRow: (row, emit) => {
            const delta = cursor.advance(row.content);

            if (delta) emit(toDeltaFrame(delta));

            // Termination 1: terminal status. The delta above is emitted FIRST, in this same
            // poll, so the last text written before the job settled is never stranded
            // behind the frame that closes the stream.
            if (row.status === 'succeeded') {
              emit(
                toDoneFrame({
                  status: 'succeeded',
                  offset: cursor.position,
                  currentVersion: row.note?.currentVersion ?? null,
                }),
              );

              return 'complete';
            }

            if (row.status === 'failed') {
              emit(failure(toErrorClass(row.errorClass), row.errorDetail));

              return 'failed';
            }

            return null;
          },
          // Termination 3: the hard duration cap. A CLIENT-FACING SAFETY NET on top of the
          // queue's own recovery, never a substitute for it.
          onCap: (emit) =>
            emit(
              failure(
                'timeout',
                'This generation is taking longer than expected. Reload the note to check on it.',
              ),
            ),
        })
        .subscribe(subscriber);
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
function toErrorClass(stored: string | null): KvoxStreamErrorClass {
  return stored === 'auth' || stored === 'refusal' || stored === 'rate_limit'
    ? stored
    : 'other';
}

/** A thrown value as one log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
