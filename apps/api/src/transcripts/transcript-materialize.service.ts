// =============================================================================
// `materialize(transcriptId, version)` (issue #27, epic #19, spec §4.4)
// =============================================================================
//
// Rebuild what a transcript looked like at any version: load the nearest
// snapshot at or before it, then replay every later version's ops through THE
// EXACT SAME PURE REDUCERS the live edit path uses (`editing/reducers.ts`).
//
// -----------------------------------------------------------------------------
// WHY THE INVARIANT HOLDS BY CONSTRUCTION, AND WHAT THE TESTS ACTUALLY PROVE
// -----------------------------------------------------------------------------
//
// `materialize(currentVersion) == the live tables` is not a hopeful property.
// The live path applies a batch through `applyOps` and, inside ONE transaction,
// writes both the resulting state and the version-log entry describing it — so
// the tables are themselves the output of applying those ops in that order. The
// property test issue #27 requires therefore tests something narrower and more
// useful than "does replay work": that no reducer has a side effect the log
// does not capture, and that the persist path writes exactly what the reducer
// produced and nothing else.
//
// ⚠ THE REDUCERS RUN IN `replay` MODE HERE. A stale `rev` in a version log is
// not a concurrency outcome — these ops already applied cleanly once — so it is
// a corrupt history and it throws, rather than being skipped the way a live
// batch's conflict is. See `reducers.ts`'s header.
//
// -----------------------------------------------------------------------------
// A `restore` IS A JUMP, NOT AN OP
// -----------------------------------------------------------------------------
//
// `transcript_versions` rows of `kind: restore` carry `ops: [{op: 'restore',
// fromVersion}]`, and no pure reducer can execute that — replaying it means
// materializing ANOTHER version, which is a database read. So this service
// intercepts it: when a restore sits between the nearest snapshot and the
// target, the state at that restore is `materialize(fromVersion)` and the
// replay resumes from the version after it. Chains are bounded by
// `MAX_RESTORE_DEPTH` rather than trusted, because a history that somehow
// pointed a restore at itself would otherwise recurse until the stack ran out.
//
// -----------------------------------------------------------------------------
// THE ONE VERSION THAT CANNOT BE REBUILT FROM OPS, EVER
// -----------------------------------------------------------------------------
//
// Version 1 has `ops: []` — it is what the provider said, not a change to
// anything. There is no sequence of ops that produces it from nothing, so
// **version 1's snapshot is what makes history reachable at all**, which is
// exactly why spec §4.3 says a snapshot is taken for v1 unconditionally. Until
// that job has run, `materialize` can still answer for the CURRENT version (the
// live tables are that answer, by definition) and answers `409` for anything
// older — a temporary, self-healing state with an honest message, rather than a
// silent wrong answer assembled from an empty base.
// =============================================================================

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { gunzipSync, gzipSync } from 'node:zlib';

import { PrismaService } from '../prisma/prisma.service';
import {
  applyOps,
  recordedOpSchema,
  sortByOrdinal,
  type EditableSegment,
  type EditableSpeaker,
  type EditingState,
  type RecordedOp,
  type TimedWord,
} from './editing';
import { TranscriptObjectsService } from './transcript-objects.service';
import { TRANSCRIPT_NOT_FOUND_MESSAGE } from './transcript-access.service';

/** How many `restore → restore → …` hops a materialization will follow. */
export const MAX_RESTORE_DEPTH = 32;

/** The on-disk shape of a snapshot object. Versioned, so a reader can refuse. */
export const SNAPSHOT_FORMAT_VERSION = 1;

export interface SnapshotPayload {
  formatVersion: number;
  transcriptId: string;
  version: number;
  speakers: EditableSpeaker[];
  segments: EditableSegment[];
}

/** The answer: a version number and the state the transcript had at it. */
export interface MaterializedTranscript {
  transcriptId: string;
  version: number;
  state: EditingState;
}

/** Which segments' word arrays a live-state load actually needs. */
export type WordsSelection = 'all' | ReadonlySet<string>;

/** The live state, plus the per-segment edit metadata the reducers do not carry. */
export interface LiveState {
  state: EditingState;
  /**
   * `editedAt` per segment id.
   *
   * Deliberately OUTSIDE `EditingState`: "who last hand-edited this line and
   * when" is an audit fact about the row, not content of the transcript, and
   * putting it in the reducer's state would mean either a clock inside a pure
   * function or a field every snapshot carries and every replay has to fake.
   */
  editedAt: Map<string, Date | null>;
}

@Injectable()
export class TranscriptMaterializeService {
  private readonly logger = new Logger(TranscriptMaterializeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: TranscriptObjectsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reading the live tables
  // ---------------------------------------------------------------------------

  /**
   * The current state, exactly as the reducers want it.
   *
   * `words` defaults to `'all'`. Pass the narrow set — `requiredWordSegmentIds`
   * of the batch about to be applied — to leave every other segment's array
   * empty, which is what keeps a "rename a speaker" batch from pulling ninety
   * thousand word timings through the driver. See `editing/editing-state.ts`.
   */
  async loadLiveState(
    transcriptId: string,
    words: WordsSelection = 'all',
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<LiveState> {
    const [speakers, segments] = await Promise.all([
      client.transcriptSpeaker.findMany({
        where: { transcriptId },
        orderBy: { colorIndex: 'asc' },
        select: { id: true, label: true, displayName: true, colorIndex: true, rev: true },
      }),
      client.transcriptSegment.findMany({
        where: { transcriptId },
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          speakerId: true,
          startMs: true,
          endMs: true,
          ordinal: true,
          text: true,
          wordsAlignment: true,
          confidence: true,
          origin: true,
          rev: true,
          editedAt: true,
          // ⚠ `words` IS SELECTED CONDITIONALLY, and this is the single line
          // that decides whether an op batch reads a megabyte or a gigabyte.
          words: words === 'all',
        },
      }),
    ]);

    const editedAt = new Map<string, Date | null>();

    const editable: EditableSegment[] = segments.map((row) => {
      editedAt.set(row.id, row.editedAt);

      return {
        id: row.id,
        speakerId: row.speakerId,
        startMs: row.startMs,
        endMs: row.endMs,
        ordinal: row.ordinal,
        text: row.text,
        words: words === 'all' ? readTimedWords((row as { words?: unknown }).words) : [],
        wordsAlignment: row.wordsAlignment,
        confidence: row.confidence,
        origin: row.origin,
        rev: row.rev,
      };
    });

    // The narrow selection still needs the real arrays for the handful of
    // segments whose ops divide, concatenate or re-align them.
    if (words !== 'all' && words.size > 0) {
      const rows = await client.transcriptSegment.findMany({
        where: { transcriptId, id: { in: [...words] } },
        select: { id: true, words: true },
      });

      const byId = new Map(rows.map((row) => [row.id, readTimedWords(row.words)]));

      for (const segment of editable) {
        const loaded = byId.get(segment.id);

        if (loaded) segment.words = loaded;
      }
    }

    return { state: { speakers, segments: editable }, editedAt };
  }

  // ---------------------------------------------------------------------------
  // materialize
  // ---------------------------------------------------------------------------

  async materialize(
    transcriptId: string,
    version: number,
    depth = 0,
  ): Promise<MaterializedTranscript> {
    if (depth > MAX_RESTORE_DEPTH) {
      throw new ConflictException(
        `This version's history follows more than ${MAX_RESTORE_DEPTH} chained restores`,
      );
    }

    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: { id: true, currentVersion: true, deletedAt: true },
    });

    if (!transcript || transcript.deletedAt !== null) {
      throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);
    }

    if (version < 1 || version > transcript.currentVersion) {
      throw new NotFoundException(`Version ${version} does not exist for this transcript`);
    }

    const snapshot = await this.prisma.transcriptVersion.findFirst({
      where: { transcriptId, version: { lte: version }, snapshotObjectId: { not: null } },
      orderBy: { version: 'desc' },
      select: { version: true, snapshotObjectId: true },
    });

    // A restore AFTER the nearest snapshot is a cheaper and more accurate base
    // than the snapshot is: the state at a restore is, by definition, the state
    // at the version it restored from.
    const restore = await this.prisma.transcriptVersion.findFirst({
      where: {
        transcriptId,
        kind: 'restore',
        version: { lte: version, gt: snapshot?.version ?? 0 },
      },
      orderBy: { version: 'desc' },
      select: { version: true, restoredFromVersion: true, ops: true },
    });

    let base: number;
    let state: EditingState;

    if (restore) {
      const from = restore.restoredFromVersion ?? readRestoreTarget(restore.ops);

      if (from === null) {
        throw new ConflictException(
          `Version ${restore.version} is a restore that does not say what it restored from`,
        );
      }

      state = (await this.materialize(transcriptId, from, depth + 1)).state;
      base = restore.version;
    } else if (snapshot?.snapshotObjectId) {
      state = await this.readSnapshot(snapshot.snapshotObjectId, transcriptId);
      base = snapshot.version;
    } else if (version === transcript.currentVersion) {
      // No snapshot anywhere at or before the target, but the target IS the
      // live state — which is the answer, with nothing to replay.
      return { transcriptId, version, state: (await this.loadLiveState(transcriptId)).state };
    } else {
      throw new ConflictException(
        `Version ${version} cannot be rebuilt yet: no snapshot has been written at or before ` +
          'it. The `transcript.snapshot` job takes one for version 1 and for every restore; ' +
          'retry once it has run.',
      );
    }

    if (base < version) {
      const rows = await this.prisma.transcriptVersion.findMany({
        where: { transcriptId, version: { gt: base, lte: version } },
        orderBy: { version: 'asc' },
        select: { version: true, ops: true },
      });

      for (const row of rows) {
        state = applyOps(state, parseRecordedOps(row.ops, row.version), { mode: 'replay' }).state;
      }
    }

    return { transcriptId, version, state: { ...state, segments: sortByOrdinal(state.segments) } };
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  /** The gzipped JSON body of a snapshot for `state` at `version`. */
  serializeSnapshot(transcriptId: string, version: number, state: EditingState): Buffer {
    const payload: SnapshotPayload = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      transcriptId,
      version,
      speakers: state.speakers,
      segments: state.segments,
    };

    return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  }

  /** Read a snapshot object back into a state, or fail loudly about why not. */
  private async readSnapshot(objectId: string, transcriptId: string): Promise<EditingState> {
    const stream = await this.objects.download(objectId);

    if (!stream) {
      throw new ConflictException(
        `The snapshot object ${objectId} for this transcript is missing from storage`,
      );
    }

    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }

    const payload = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8')) as SnapshotPayload;

    if (payload.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
      throw new ConflictException(
        `Snapshot ${objectId} is format ${payload.formatVersion}; this build reads ` +
          `${SNAPSHOT_FORMAT_VERSION}`,
      );
    }

    if (payload.transcriptId !== transcriptId) {
      // Belt and braces against a mis-linked `snapshot_object_id`: replaying
      // one transcript's ops onto another's state would produce a plausible,
      // entirely wrong document.
      throw new ConflictException(`Snapshot ${objectId} belongs to another transcript`);
    }

    this.logger.debug(`Materializing from snapshot ${objectId} (v${payload.version})`);

    return {
      speakers: payload.speakers,
      segments: sortByOrdinal(payload.segments),
    };
  }
}

/**
 * The word array off a segment's JSONB column, total over anything unexpected.
 *
 * Same discipline as `TranscriptsService.readWords`: the column is written by
 * this application but read back as `Prisma.JsonValue`, and a row written by an
 * older build must not crash an edit. Anything unrecognisable becomes no
 * timings, which re-aligns to `none` rather than throwing.
 */
export function readTimedWords(value: unknown): TimedWord[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];

    const record = entry as Record<string, unknown>;

    if (typeof record.t !== 'string') return [];
    if (typeof record.s !== 'number' || typeof record.e !== 'number') return [];

    return [
      { t: record.t, s: record.s, e: record.e, c: typeof record.c === 'number' ? record.c : null },
    ];
  });
}

/**
 * Parse one version's recorded ops.
 *
 * ⚠ STRICT, DELIBERATELY. A malformed op in the version log is not something to
 * skip past — skipping it produces a materialized version that silently differs
 * from what was saved, which is the exact failure spec §4.4's invariant exists
 * to make impossible. Better a loud 409 naming the version.
 */
export function parseRecordedOps(value: Prisma.JsonValue, version: number): RecordedOp[] {
  const parsed = recordedOpSchema.array().safeParse(value ?? []);

  if (!parsed.success) {
    throw new ConflictException(
      `Version ${version}'s operation log cannot be read: ${parsed.error.issues[0]?.message}`,
    );
  }

  return parsed.data;
}

/** `fromVersion` out of a restore version's ops, when the column is not set. */
function readRestoreTarget(ops: Prisma.JsonValue): number | null {
  if (!Array.isArray(ops)) return null;

  for (const entry of ops) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;

    const record = entry as Record<string, unknown>;

    if (record.op === 'restore' && typeof record.fromVersion === 'number') {
      return record.fromVersion;
    }
  }

  return null;
}
