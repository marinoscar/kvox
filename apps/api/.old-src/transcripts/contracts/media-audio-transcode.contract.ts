// =============================================================================
// `media.audio.transcode` — the result a node posts back (issue #26, epic #19)
// =============================================================================
//
// THE TRUST BOUNDARY FOR THE PLAYBACK RENDITION. Every field below arrives
// from a machine this deployment may not own, over HTTP, from a build that may
// be older than this server's. `NodesService.submitResult` parses a body
// against this schema and `MediaAudioTranscodeHandler.persistNodeResult`
// writes whatever survives into `transcripts.duration_ms` and a managed
// `storage_objects` row — so a field this schema accepts is a field that lands
// in the database and is later shown to a user.
//
// -----------------------------------------------------------------------------
// WHAT IS DELIBERATELY *NOT* HERE: THE STORAGE KEY
// -----------------------------------------------------------------------------
//
// `db-backup-run.contract.ts` carries a `storageKey` the node reports back,
// because a backup's key is recorded on a row the node's own upload URL
// request created. This one does not, and the difference is worth stating: the
// rendition's key is a pure function of `(transcriptId, jobId)`
// (`renditionStorageKey`), both of which the SERVER already holds on the job
// row. Asking the node for it would add a field whose only possible correct
// value the server can compute — and whose incorrect values would have to be
// detected and refused. A field nobody can usefully supply is a field better
// not accepted.
//
// -----------------------------------------------------------------------------
// WHY `bytes` IS A `number` AND NOT A DECIMAL STRING
// -----------------------------------------------------------------------------
//
// `db.backup.run` sends its byte count as a string because a `pg_dump` of a
// real database routinely runs to many gigabytes and lands in a 64-bit column,
// where a JSON number stops being exact above 2^53 — so the corruption would
// fall on exactly the largest backups. This artifact cannot get near that: it
// is mono AAC at 64–96 kbit/s, so a TEN-HOUR recording — the longest any
// provider in this build accepts — is a few hundred megabytes.
// `Number.MAX_SAFE_INTEGER` is nine petabytes. A bounded integer is exact
// here and needs no parse, no format validation and no conversion at every
// read.
//
// -----------------------------------------------------------------------------
// WHY `remuxed` IS A FIELD AND NOT AN INFERENCE
// -----------------------------------------------------------------------------
//
// The server could guess it — an output whose codec and channel count match
// the input's was probably copied. It could also be wrong, and the cost of
// being wrong is an audit trail that says a file was re-encoded when it was
// not. The executor KNOWS which of the two branches it took, and a fact the
// producer holds is cheaper and more honest to send than to reconstruct.
// =============================================================================

import { z } from 'zod';

/**
 * What a node reports after converting a transcript's audio for playback.
 *
 * Every field describes THE FILE IT UPLOADED, not the file it was given: a
 * remux copies the source stream, so `codec`/`channels`/`bitrateKbps` are the
 * source's; a re-encode produces mono AAC at the target, so they are the
 * target's. `renditionFacts()` in `transcripts/media/audio-transcode.ts` is the
 * server-side function that makes the same distinction, and the two paths are
 * asserted to agree.
 */
export const mediaAudioTranscodeResultSchema = z.object({
  /**
   * Size of the uploaded rendition. See the header for why this is a number.
   *
   * `.min(1)`, not `.min(0)`: a zero-byte rendition is not a small file, it is
   * an ffmpeg run that produced nothing — and accepting it would set
   * `playback_status: ready` on a transcript whose audio element plays
   * silence, which is strictly worse than a failed job.
   */
  bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),

  /**
   * Duration of the audio, in whole milliseconds, as the node's `ffprobe`
   * measured it.
   *
   * THE SERVER ACTS ON THIS NUMBER: it is written to `transcripts.duration_ms`
   * and checked against the active provider's `maxDurationMs` before any audio
   * is submitted for transcription. Bounded at 48 hours — a recording longer
   * than two days is a probe reading a corrupt header, not a meeting, and a
   * nonsense duration that passed validation would silently fail every
   * transcript against a provider limit it never really exceeded.
   */
  durationMs: z.number().int().min(0).max(48 * 60 * 60 * 1000),

  /** `ffprobe`'s `codec_name` for the stream that was written (e.g. `aac`). */
  codec: z.string().trim().min(1).max(32),

  /** Bitrate of the written stream, in kbit/s. Bounded at the schema's own ceiling. */
  bitrateKbps: z.number().int().min(1).max(320),

  /** Channel count of the written stream. `1` for every re-encode; 8 is a ceiling. */
  channels: z.number().int().min(1).max(8),

  /** True when the source stream was copied rather than re-encoded. */
  remuxed: z.boolean(),
});

/** The parsed, trusted result — the only shape `persistNodeResult` may write. */
export type MediaAudioTranscodeResult = z.infer<typeof mediaAudioTranscodeResultSchema>;
