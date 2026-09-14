// =============================================================================
// The correction ops — the permanent vocabulary of a version (issue #27, §4.1)
// =============================================================================
//
// ⚠ EVERY STRING IN `OP_TYPES` IS PERMANENT, for the same reason `Job.type` is
// (see `../job-types.ts`): a recorded op is stored in `transcript_versions.ops`
// as JSONB and replayed by `materialize()` for as long as the transcript
// exists. Renaming one orphans every version already written under the old
// name, and there is no migration that can rewrite history without changing
// what history says.
//
// -----------------------------------------------------------------------------
// TWO VOCABULARIES: WHAT A CLIENT MAY SEND, AND WHAT IS WRITTEN DOWN
// -----------------------------------------------------------------------------
//
// They are deliberately not the same set, and the difference is the whole
// correctness argument for replay:
//
//   • `transcript.find_replace` is a REQUEST op and never a recorded one. It is
//     expanded server-side into concrete `segment.update_text` ops before the
//     version is written (spec §4.2), because a recorded find & replace would
//     replay THROUGH TODAY'S MATCHER — so a Unicode table update, a
//     case-folding fix, or a bug fix in word-boundary detection would silently
//     change what a version from last year says happened. Expanding first makes
//     a version's ops a self-contained description of exactly what changed,
//     immune to any future change in how matches are found.
//
//   • `restore` is a RECORDED op and never a request one. It is the marker a
//     `POST /:id/versions/:v/restore` leaves behind (spec §4.5), and it is the
//     one op the pure reducers cannot execute — replaying it means materializing
//     another version, which is a database read. `materialize()` handles it; the
//     reducers throw on it, loudly, rather than pretending.
//
//   • Server-assigned identity is filled in BEFORE recording, never at replay
//     time. `segment.split` records the `newSegmentId` it minted and the
//     `atWordIndex` it resolved a character offset to; `speaker.create` records
//     the `speakerId` and `colorIndex` it chose. A `randomUUID()` inside a
//     reducer would make every replay produce different ids, which is precisely
//     the "materialize a version and get something other than what was saved"
//     failure spec §4.4's invariant exists to rule out.
// =============================================================================

import { z } from 'zod';

/** Every op name this application knows. Permanent — see the header. */
export const OP_TYPES = {
  UPDATE_TEXT: 'segment.update_text',
  SET_SPEAKER: 'segment.set_speaker',
  SPLIT: 'segment.split',
  JOIN: 'segment.join',
  DELETE: 'segment.delete',
  RENAME_SPEAKER: 'speaker.rename',
  CREATE_SPEAKER: 'speaker.create',
  MERGE_SPEAKERS: 'speaker.merge',
  FIND_REPLACE: 'transcript.find_replace',
  RESTORE: 'restore',
} as const;

/** The most ops one batch may carry (spec §4.1). */
export const MAX_OPS_PER_BATCH = 200;

/** Longest text this application will store in one segment. */
export const MAX_SEGMENT_TEXT = 20_000;

/** Longest search or replacement string a find & replace may carry. */
export const MAX_FIND_LENGTH = 500;

/** Longest speaker display name. */
export const MAX_SPEAKER_NAME = 120;

// -----------------------------------------------------------------------------
// Recorded ops — what a version's `ops` array contains, forever
// -----------------------------------------------------------------------------

const uuid = z.string().uuid();
const rev = z.number().int().positive();

export const updateTextOpSchema = z.object({
  op: z.literal(OP_TYPES.UPDATE_TEXT),
  segmentId: uuid,
  rev,
  text: z.string().max(MAX_SEGMENT_TEXT),
});

export const setSpeakerOpSchema = z.object({
  op: z.literal(OP_TYPES.SET_SPEAKER),
  segmentId: uuid,
  rev,
  speakerId: uuid,
});

export const splitOpSchema = z.object({
  op: z.literal(OP_TYPES.SPLIT),
  segmentId: uuid,
  rev,
  /** Resolved from `atCharOffset` when the request used one. */
  atWordIndex: z.number().int().nonnegative(),
  /** The later half's speaker, when the split is also a speaker correction. */
  newSpeakerId: uuid.nullable().optional(),
  /** Minted by the server before recording — see the header. */
  newSegmentId: uuid,
});

export const joinOpSchema = z.object({
  op: z.literal(OP_TYPES.JOIN),
  segmentIds: z.tuple([uuid, uuid]),
  revs: z.tuple([rev, rev]),
});

export const deleteOpSchema = z.object({
  op: z.literal(OP_TYPES.DELETE),
  segmentId: uuid,
  rev,
});

export const renameSpeakerOpSchema = z.object({
  op: z.literal(OP_TYPES.RENAME_SPEAKER),
  speakerId: uuid,
  rev,
  displayName: z.string().trim().min(1).max(MAX_SPEAKER_NAME),
});

export const createSpeakerOpSchema = z.object({
  op: z.literal(OP_TYPES.CREATE_SPEAKER),
  /** Minted by the server before recording — see the header. */
  speakerId: uuid,
  displayName: z.string().trim().min(1).max(MAX_SPEAKER_NAME),
  /** Chosen by the server, so a replay paints the same colour. */
  colorIndex: z.number().int().nonnegative(),
});

export const mergeSpeakersOpSchema = z.object({
  op: z.literal(OP_TYPES.MERGE_SPEAKERS),
  sourceIds: z.array(uuid).min(1).max(50),
  targetId: uuid,
  /**
   * `true` (the default, spec §4.1) keeps the TARGET's current display name.
   * `false` adopts the FIRST `sourceIds` entry's name onto the target — for
   * the case where the surviving id is the duplicate the user wants renamed
   * away.
   */
  keepName: z.boolean().optional(),
});

export const restoreOpSchema = z.object({
  op: z.literal(OP_TYPES.RESTORE),
  fromVersion: z.number().int().positive(),
});

/** Everything a `transcript_versions.ops` array may contain. */
export const recordedOpSchema = z.discriminatedUnion('op', [
  updateTextOpSchema,
  setSpeakerOpSchema,
  splitOpSchema,
  joinOpSchema,
  deleteOpSchema,
  renameSpeakerOpSchema,
  createSpeakerOpSchema,
  mergeSpeakersOpSchema,
  restoreOpSchema,
]);

export type UpdateTextOp = z.infer<typeof updateTextOpSchema>;
export type SetSpeakerOp = z.infer<typeof setSpeakerOpSchema>;
export type SplitOp = z.infer<typeof splitOpSchema>;
export type JoinOp = z.infer<typeof joinOpSchema>;
export type DeleteSegmentOp = z.infer<typeof deleteOpSchema>;
export type RenameSpeakerOp = z.infer<typeof renameSpeakerOpSchema>;
export type CreateSpeakerOp = z.infer<typeof createSpeakerOpSchema>;
export type MergeSpeakersOp = z.infer<typeof mergeSpeakersOpSchema>;
export type RestoreOp = z.infer<typeof restoreOpSchema>;
export type RecordedOp = z.infer<typeof recordedOpSchema>;

/** The recorded ops the pure reducers can actually execute — everything but `restore`. */
export type ReducibleOp = Exclude<RecordedOp, RestoreOp>;

// -----------------------------------------------------------------------------
// Request ops — what `POST /:id/operations` accepts
// -----------------------------------------------------------------------------

/**
 * `segment.split` as a client sends it: the split point may be given either
 * way, and the new segment's id is the server's to choose.
 *
 * ⚠ EXACTLY ONE of `atWordIndex` / `atCharOffset`. Accepting both would leave
 * the server picking a winner, and a client that computed the two from
 * different renderings of the same segment would get a split at whichever one
 * this version happened to prefer.
 */
export const splitRequestSchema = z
  .object({
    op: z.literal(OP_TYPES.SPLIT),
    segmentId: uuid,
    rev,
    atWordIndex: z.number().int().nonnegative().optional(),
    atCharOffset: z.number().int().nonnegative().optional(),
    newSpeakerId: uuid.nullable().optional(),
  })
  .refine(
    (value) =>
      (value.atWordIndex === undefined) !== (value.atCharOffset === undefined),
    { message: 'Provide exactly one of atWordIndex or atCharOffset' },
  );

/** `speaker.create` as a client sends it: a name, and nothing else to choose. */
export const createSpeakerRequestSchema = z.object({
  op: z.literal(OP_TYPES.CREATE_SPEAKER),
  displayName: z.string().trim().min(1).max(MAX_SPEAKER_NAME),
});

/**
 * `transcript.find_replace` — a REQUEST op only. It is expanded into concrete
 * `segment.update_text` ops before anything is recorded (spec §4.2).
 */
export const findReplaceRequestSchema = z.object({
  op: z.literal(OP_TYPES.FIND_REPLACE),
  find: z.string().min(1).max(MAX_FIND_LENGTH),
  replace: z.string().max(MAX_FIND_LENGTH),
  matchCase: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  /** Restrict the replacement to one speaker's lines. */
  speakerId: uuid.nullable().optional(),
});

export type FindReplaceOp = z.infer<typeof findReplaceRequestSchema>;
export type SplitRequestOp = z.infer<typeof splitRequestSchema>;
export type CreateSpeakerRequestOp = z.infer<typeof createSpeakerRequestSchema>;

/**
 * Everything `POST /:id/operations` accepts.
 *
 * A plain `z.union`, not `z.discriminatedUnion`: `splitRequestSchema` carries a
 * `.refine`, and a refined object is a `ZodEffects` rather than a `ZodObject`,
 * which the discriminated union builder refuses to index. The union is small
 * and every member is keyed on a literal `op`, so the error messages stay
 * readable either way.
 */
export const requestOpSchema = z.union([
  updateTextOpSchema,
  setSpeakerOpSchema,
  splitRequestSchema,
  joinOpSchema,
  deleteOpSchema,
  renameSpeakerOpSchema,
  createSpeakerRequestSchema,
  mergeSpeakersOpSchema,
  findReplaceRequestSchema,
]);

export type RequestOp = z.infer<typeof requestOpSchema>;

/**
 * The segments whose `words[]` this batch genuinely needs loaded.
 *
 * Exactly three ops read a word array — `segment.update_text` re-aligns it,
 * `segment.split` divides it, `segment.join` concatenates two — and everything
 * else changes a field beside it. `TranscriptEditingService` loads words for
 * this set alone, which is what keeps a "rename the speaker" batch from
 * dragging ninety thousand word timings through the driver (see
 * `editing-state.ts`'s header).
 *
 * Call it on the EXPANDED op list: a `transcript.find_replace` names no segment
 * until it has been turned into concrete `segment.update_text` ops.
 */
export function requiredWordSegmentIds(ops: readonly RecordedOp[]): Set<string> {
  const ids = new Set<string>();

  for (const op of ops) {
    if (op.op === OP_TYPES.UPDATE_TEXT || op.op === OP_TYPES.SPLIT) {
      ids.add(op.segmentId);
    } else if (op.op === OP_TYPES.JOIN) {
      ids.add(op.segmentIds[0]);
      ids.add(op.segmentIds[1]);
    }
  }

  return ids;
}

/** Does this batch contain anything an audit event should record (issue #27)? */
export function isAuditableBatch(ops: readonly RecordedOp[], hadFindReplace: boolean): boolean {
  return hadFindReplace || ops.some((op) => op.op === OP_TYPES.MERGE_SPEAKERS);
}
