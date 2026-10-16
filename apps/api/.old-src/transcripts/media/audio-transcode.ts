// =============================================================================
// The playback rendition's PURE half (issue #26, epic #19, spec §1.5.1 / §7.1)
// =============================================================================
//
// Everything about `media.audio.transcode` that is a DECISION rather than an
// effect: how an `ffprobe` document is read, whether the upload can be remuxed
// or has to be re-encoded, which arguments each of those two spawns, and where
// the result is stored.
//
// It is separated from the handler for one reason that matters more here than
// anywhere else in this module: THE SAME DECISIONS ARE MADE TWICE, on two
// machines, by two programs. The API server runs them in
// `media-audio-transcode.handler.ts`; a worker node runs them in
// `apps/cli/src/node/executors/media-audio-transcode.ts`, which is a different
// workspace that cannot import this file (see `jobs/contracts/README.md` for
// why a shared package is wrong for this repository). A fork changing the
// encoder settings has to change both, and the only defence against the two
// drifting is that each side keeps its rules in ONE named, tested place rather
// than inline in a spawn call. This is that place for the server.
//
// -----------------------------------------------------------------------------
// WHY THE OUTPUT IS AAC IN AN MP4 WITH `+faststart`, AND NOT SOMETHING BETTER
// -----------------------------------------------------------------------------
//
// Spec §7.1 states the requirement as SEEKABILITY, not playability, and the
// two have different answers. `moov` is the index saying where every frame
// lives; MP4 muxers write it LAST by default because its size is not known
// until the stream is finished. A browser handed such a file must download the
// entire thing before it can seek anywhere at all — on a three-hour recording
// over cellular data that is not "slow", it is "seeking does not work".
// `-movflags +faststart` runs a second pass that moves `moov` to the front,
// after which the browser reads a small header and issues HTTP Range requests
// for whatever position the user scrubs to.
//
// ⚠ THAT SECOND PASS IS WHY THE OUTPUT IS A FILE AND NOT A PIPE. faststart
// has to seek backwards in its own output to rewrite the header, so ffmpeg
// refuses it on a non-seekable destination (a socket, a pipe, a presigned PUT
// body) — it warns and silently produces a file with `moov` at the END, which
// is the exact defect this flag exists to prevent and which nothing downstream
// would notice. Both executors therefore write a temp file and upload it
// afterwards. Do not "optimise" either of them into a stream.
//
// Mono, because the recordings this application exists for are speech and a
// second channel doubles the bytes for nothing. AAC, because §7.1's rejected
// alternatives record that Opus/WebM support on iOS is inconsistent while AAC
// plays everywhere.
// =============================================================================

/** What the rendition is, everywhere: MP4 container, `.m4a` extension. */
export const RENDITION_MIME_TYPE = 'audio/mp4';

/** The extension the storage key ends in. Matches {@link RENDITION_MIME_TYPE}. */
export const RENDITION_EXTENSION = '.m4a';

/** `storage_objects.name` for every rendition. Managed objects are never listed. */
export const RENDITION_OBJECT_NAME = `playback${RENDITION_EXTENSION}`;

/**
 * Default target bitrate, in kbit/s, when the deployment has expressed none.
 *
 * Mirrors `DEFAULT_SYSTEM_SETTINGS.transcription.playback.bitrateKbps`. It is
 * repeated rather than imported so this file stays free of the settings graph
 * — and `audio-transcode.spec.ts` asserts the two agree, so the duplication
 * cannot drift silently.
 */
export const DEFAULT_PLAYBACK_BITRATE_KBPS = 64;

/** The bounds `transcriptionPlaybackSchema` enforces, restated for clamping. */
export const MIN_PLAYBACK_BITRATE_KBPS = 16;
export const MAX_PLAYBACK_BITRATE_KBPS = 320;

/**
 * At or below this, an AAC-in-MP4 upload is copied rather than re-encoded.
 *
 * 128 kbit/s is the point above which a file is big enough that shrinking it
 * is worth a generation of lossy loss; below it, re-encoding costs CPU and
 * audio quality to save very little, and the source is already the format the
 * browser wants. A file above the line is re-encoded down to the deployment's
 * target like any other input.
 */
export const REMUX_MAX_BITRATE_KBPS = 128;

/** Container names `ffprobe` reports for the MP4 family. */
const MP4_FAMILY = ['mp4', 'm4a', 'mov', 'isom', '3gp'];

/** The one audio codec a browser can be relied on to play everywhere. */
const TARGET_CODEC = 'aac';

/** What a probe tells us about an input. Every field is observed, never assumed. */
export interface AudioProbe {
  /** Rounded to whole milliseconds. `0` when the input declares no duration. */
  durationMs: number;
  /** `ffprobe`'s `codec_name` for the first audio stream, lower-cased. */
  codec: string;
  /** Channel count of that stream. `0` when it is not reported. */
  channels: number;
  /** Rounded to whole kbit/s, stream bitrate preferred over container bitrate. */
  bitrateKbps: number;
  /** `ffprobe`'s `format_name`, lower-cased (e.g. `mov,mp4,m4a,3gp,3g2,mj2`). */
  formatName: string;
}

/** Thrown when an `ffprobe` document describes no audio this job could convert. */
export class UnprobeableAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnprobeableAudioError';
  }
}

/**
 * Turn `ffprobe -print_format json` output into an {@link AudioProbe}.
 *
 * TOTAL OVER A DOCUMENT NOBODY CONTROLS. `ffprobe`'s JSON is a stable-ish
 * shape across versions but every field in it is optional in practice: a
 * streaming source reports no `duration`, a raw PCM WAV reports no container
 * `bit_rate`, a damaged file reports a `streams` array with nothing in it.
 * Each of those is read as "unknown" (`0`, `''`) rather than as a crash —
 * except the one case that genuinely cannot be worked around, which is a
 * document with NO AUDIO STREAM AT ALL. That is a permanent property of the
 * upload (a video with no soundtrack, a file that is not media), and it is
 * worth failing loudly and immediately rather than handing ffmpeg a `0:a:0`
 * mapping it will reject with a message nobody reads.
 */
export function parseFfprobe(raw: string): AudioProbe {
  let document: unknown;

  try {
    document = JSON.parse(raw) as unknown;
  } catch {
    throw new UnprobeableAudioError(
      'ffprobe did not return JSON. The upload is most likely not an audio or video file.',
    );
  }

  const root = asRecord(document);
  const format = asRecord(root.format);
  const streams = Array.isArray(root.streams) ? root.streams : [];
  const stream = asRecord(streams[0]);

  if (streams.length === 0) {
    throw new UnprobeableAudioError(
      'This file contains no audio stream, so there is nothing to convert for playback.',
    );
  }

  const durationSeconds = numberOf(stream.duration) || numberOf(format.duration);
  const bitsPerSecond = numberOf(stream.bit_rate) || numberOf(format.bit_rate);

  return {
    durationMs: Math.max(0, Math.round(durationSeconds * 1000)),
    codec: stringOf(stream.codec_name).toLowerCase(),
    channels: Math.max(0, Math.round(numberOf(stream.channels))),
    bitrateKbps: Math.max(0, Math.round(bitsPerSecond / 1000)),
    formatName: stringOf(format.format_name).toLowerCase(),
  };
}

/** What the encoder was asked to do, and what it therefore produced. */
export interface TranscodePlan {
  /** True when the streams are copied (`-c:a copy`) rather than re-encoded. */
  remux: boolean;
  /**
   * Target bitrate for a re-encode, in kbit/s.
   *
   * Carried even for a remux — where it is the deployment's target and not a
   * description of the output — so a caller never has to reach past the plan
   * for the number. `renditionFacts` is what turns a plan plus a probe into
   * the honest description of the FILE.
   */
  bitrateKbps: number;
}

/**
 * Clamp a configured target into the range the settings schema allows.
 *
 * A settings row written by an older build, or a `null` from a degraded read,
 * both mean "no opinion" — which is the default, not a failure. Out-of-range
 * numbers are clamped rather than rejected for the same reason: this function
 * runs inside a job that is otherwise ready to do useful work, and refusing to
 * transcode because somebody stored `1000` would be trading the rendition for
 * the lecture.
 */
export function resolveTargetBitrateKbps(configured: unknown): number {
  const value = numberOf(configured);

  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PLAYBACK_BITRATE_KBPS;

  return Math.min(
    MAX_PLAYBACK_BITRATE_KBPS,
    Math.max(MIN_PLAYBACK_BITRATE_KBPS, Math.round(value)),
  );
}

/**
 * Remux or re-encode?
 *
 * THREE CONDITIONS, ALL REQUIRED. The stream must already be AAC (the codec
 * every browser plays), it must already be in the MP4 family (the container
 * `+faststart` applies to), and it must be at or under
 * {@link REMUX_MAX_BITRATE_KBPS} (past which the file is worth shrinking).
 * Anything else is re-encoded.
 *
 * ⚠ A BITRATE OF ZERO IS NOT "SMALL ENOUGH". `ffprobe` reports no bitrate for
 * some inputs, and reading an unknown as `0` would remux a file nobody has
 * measured — plausibly a 320 kbit/s stereo master — on the strength of a
 * missing field. Unknown means re-encode, which is always safe.
 */
export function planTranscode(probe: AudioProbe, targetBitrateKbps: number): TranscodePlan {
  const bitrateKbps = resolveTargetBitrateKbps(targetBitrateKbps);

  const remux =
    probe.codec === TARGET_CODEC &&
    MP4_FAMILY.some((name) => probe.formatName.includes(name)) &&
    probe.bitrateKbps > 0 &&
    probe.bitrateKbps <= REMUX_MAX_BITRATE_KBPS;

  return { remux, bitrateKbps };
}

/**
 * What the produced file actually is, given the plan and the input.
 *
 * A remux COPIES the stream, so the output's codec, channel count and bitrate
 * are the INPUT's — reporting the deployment's 64 kbit/s mono target for a file
 * that is still 112 kbit/s stereo would put a number in the database that
 * describes nothing. A re-encode is the other way round: the output is mono
 * AAC at the target, whatever the input was.
 */
export function renditionFacts(
  probe: AudioProbe,
  plan: TranscodePlan,
): { codec: string; channels: number; bitrateKbps: number } {
  if (plan.remux) {
    return {
      codec: probe.codec || TARGET_CODEC,
      channels: probe.channels > 0 ? probe.channels : 1,
      bitrateKbps: probe.bitrateKbps,
    };
  }

  return { codec: TARGET_CODEC, channels: 1, bitrateKbps: plan.bitrateKbps };
}

/**
 * `ffprobe` arguments for one input, which may be a local path OR a URL.
 *
 * `-v error` keeps stderr to real failures so a caller can put it in
 * `Job.lastError` verbatim; `-print_format json` is what {@link parseFfprobe}
 * reads. `-select_streams a:0` narrows `streams` to the first audio stream,
 * which is the one `-map 0:a:0` will convert — probing every stream and
 * picking the audio one afterwards would be the same answer reached by a
 * second, avoidable rule.
 *
 * ⚠ THE INPUT IS ALWAYS THE LAST ARGUMENT AND IS NEVER SHELL-INTERPOLATED.
 * Both executors spawn with an argument vector (`execFile`, not `exec`), so a
 * presigned URL full of `&` and `=` needs no quoting and a filename cannot
 * become a command.
 */
export function ffprobeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-select_streams',
    'a:0',
    input,
  ];
}

/**
 * `ffmpeg` arguments for one conversion.
 *
 * Flag by flag, because every one of them is load-bearing:
 *
 *   `-nostdin`            a job has no terminal; without it ffmpeg can consume
 *                         the parent's stdin and hang forever waiting on a
 *                         prompt nobody will answer.
 *   `-hide_banner -loglevel error`
 *                         stderr becomes the error message and nothing else,
 *                         so it is small enough to store and quote.
 *   `-y`                  the output path already exists (the caller created
 *                         it); without this ffmpeg stops to ask.
 *   `-vn -map 0:a:0`      take the FIRST AUDIO STREAM and no video. Phone
 *                         recordings arrive as `.webm`/`.mp4` with a cover
 *                         image or a real video track, and a rendition that
 *                         carried it would be a video file the audio element
 *                         cannot stream.
 *   `-ac 1 -c:a aac -b:a` mono AAC at the deployment's target (§7.1).
 *   `-movflags +faststart` moves `moov` to the front. See the file header.
 */
export function ffmpegArgs(options: {
  input: string;
  output: string;
  plan: TranscodePlan;
}): string[] {
  const { input, output, plan } = options;

  const codecArgs = plan.remux
    ? ['-c:a', 'copy']
    : ['-ac', '1', '-c:a', 'aac', '-b:a', `${plan.bitrateKbps}k`];

  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vn',
    '-map',
    '0:a:0',
    ...codecArgs,
    '-movflags',
    '+faststart',
    output,
  ];
}

/**
 * Where a transcript's rendition lives.
 *
 * ⚠ IDEMPOTENT PER JOB, which is the one hard requirement
 * `JobHandler.deriveOutputKey` states: a node asks for its upload URL again
 * after a timed-out transfer or a restart, and a key that changed per call
 * would leave a second archive nothing points at. Both inputs are fixed on the
 * job row before this is ever called, so re-deriving cannot produce a
 * different answer.
 *
 * Under the transcript's own prefix rather than the data plane's default
 * `node-outputs/<jobId>/<uuid>`, because `transcript.purge` enumerates
 * `transcripts/<id>/` to remove every byte a deleted transcript ever owned —
 * a rendition outside that prefix would survive its transcript.
 */
export function renditionStorageKey(transcriptId: string, jobId: string): string {
  return `transcripts/${transcriptId}/renditions/${jobId}${RENDITION_EXTENSION}`;
}

// -----------------------------------------------------------------------------
// Reading a document nobody controls
// -----------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A JSON number OR a numeric string — `ffprobe` emits both, per field. */
function numberOf(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;

  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
