import { execFile } from 'node:child_process';

// =============================================================================
// Running `ffprobe`/`ffmpeg` on a WORKER NODE  (issue #26, epic #19)
// =============================================================================
//
// The node-side counterpart of `apps/api/src/transcripts/media/`, and the
// rules below are the server's rules because they are properties of FFMPEG,
// not of whichever process happens to be running it.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A SECOND IMPLEMENTATION AND NOT AN IMPORT
// -----------------------------------------------------------------------------
//
// Exactly the argument `pg-dump.ts` next door makes, and it applies unchanged:
// `apps/cli` is a standalone binary that runs on a machine with no API source
// tree, so importing `apps/api` would drag `@nestjs/*`, Prisma's client and
// the whole settings graph onto a worker node whose entire job is to run one
// child process. A fourth workspace package for forty lines of argv is a
// permanent tax that `packages/shared/index.js` already documents the cost of.
//
// So the DUPLICATION IS DELIBERATE AND BOUNDED, and what the two sides must
// agree on is THE FILE, not the code that produces it:
//
//   * mono AAC in an MP4 (`-ac 1 -c:a aac`), because a browser plays that
//     everywhere and a second channel doubles the bytes of speech for nothing;
//   * `-movflags +faststart`, because seekability — not playability — is the
//     requirement (spec §7.1), and without it a browser must download a
//     three-hour recording before it can seek anywhere in it;
//   * the remux rule: already-AAC, already-MP4, already at or under 128 kbit/s
//     is copied rather than re-encoded.
//
// Change one of those here and this node's renditions stop matching the
// server's. Nothing would report an error; the transcripts would simply behave
// differently depending on which machine happened to claim the job.
//
// -----------------------------------------------------------------------------
// ⚠ `+faststart` NEEDS A SEEKABLE OUTPUT, SO THE EXECUTOR WRITES A TEMP FILE
// -----------------------------------------------------------------------------
//
// The tempting shape for a node is `ffmpeg | PUT`, exactly as `db.backup.run`
// streams `pg_dump` straight into object storage. It is WRONG here, and not by
// a little: faststart works by rewriting the header once the stream is
// finished, which requires seeking backwards in the output. ffmpeg cannot do
// that to a socket, so on a pipe it warns and silently produces a file with
// `moov` at the END — a rendition that uploads perfectly, plays fine from the
// start, and cannot be seeked. That is the one defect the job exists to
// prevent, and it would be invisible to every check either side performs.
// =============================================================================

/** The binaries. `ffmpeg` ships `ffprobe`; `capabilities.ts` probes for both. */
export const FFMPEG_COMMAND = 'ffmpeg';
export const FFPROBE_COMMAND = 'ffprobe';

/** Container/codec the rendition always is. Mirrors the server's constants. */
export const RENDITION_CONTENT_TYPE = 'audio/mp4';

/** Target bitrate when the job payload names none. Mirrors the server default. */
export const DEFAULT_PLAYBACK_BITRATE_KBPS = 64;

/** The bounds the server's settings schema enforces, restated for clamping. */
export const MIN_PLAYBACK_BITRATE_KBPS = 16;
export const MAX_PLAYBACK_BITRATE_KBPS = 320;

/** At or below this, an AAC-in-MP4 input is copied rather than re-encoded. */
export const REMUX_MAX_BITRATE_KBPS = 128;

/** How long a probe may take before it is abandoned as a failure. */
export const PROBE_TIMEOUT_MS = 2 * 60 * 1000;

/** Most stderr carried into an error message. */
export const STDERR_LIMIT = 2000;

const MP4_FAMILY = ['mp4', 'm4a', 'mov', 'isom', '3gp'];
const TARGET_CODEC = 'aac';

/** What a probe tells us about an input. Mirrors the server's `AudioProbe`. */
export interface AudioProbe {
  durationMs: number;
  codec: string;
  channels: number;
  bitrateKbps: number;
  formatName: string;
}

/** Remux or re-encode, plus the bitrate a re-encode targets. */
export interface TranscodePlan {
  remux: boolean;
  bitrateKbps: number;
}

/** The spawn seam, so the executor's tests need no ffmpeg on the machine. */
export type RunFn = (command: string, args: string[], timeoutMs: number) => Promise<string>;

/** A spawn failed, carrying the binary's own words. */
export class FfmpegError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/** Clamp a payload-supplied target into the range the server's schema allows. */
export function resolveTargetBitrateKbps(configured: unknown): number {
  const value =
    typeof configured === 'number'
      ? configured
      : typeof configured === 'string'
        ? Number.parseFloat(configured)
        : Number.NaN;

  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PLAYBACK_BITRATE_KBPS;

  return Math.min(
    MAX_PLAYBACK_BITRATE_KBPS,
    Math.max(MIN_PLAYBACK_BITRATE_KBPS, Math.round(value)),
  );
}

/**
 * Read `ffprobe -print_format json` output.
 *
 * TOTAL OVER A DOCUMENT NOBODY CONTROLS, with one exception: a file with NO
 * AUDIO STREAM is a permanent property of the upload (a video with no
 * soundtrack, a file that is not media) and is worth failing loudly rather
 * than handing ffmpeg a `0:a:0` mapping it will reject.
 */
export function parseFfprobe(raw: string): AudioProbe {
  let document: unknown;

  try {
    document = JSON.parse(raw) as unknown;
  } catch {
    throw new FfmpegError(
      FFPROBE_COMMAND,
      'ffprobe did not return JSON. The input is most likely not an audio or video file.',
    );
  }

  const root = asRecord(document);
  const format = asRecord(root.format);
  const streams: unknown[] = Array.isArray(root.streams) ? root.streams : [];

  if (streams.length === 0) {
    throw new FfmpegError(
      FFPROBE_COMMAND,
      'This file contains no audio stream, so there is nothing to convert for playback.',
    );
  }

  const stream = asRecord(streams[0]);
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

/**
 * Remux or re-encode? Three conditions, all required.
 *
 * ⚠ A BITRATE OF ZERO IS NOT "SMALL ENOUGH". `ffprobe` reports no bitrate for
 * some inputs, and treating unknown as `0` would copy a file nobody has
 * measured — plausibly a 320 kbit/s stereo master — on a missing field.
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
 * What the produced file actually is.
 *
 * A remux COPIES the source stream, so the output's codec, channels and
 * bitrate are the INPUT's; a re-encode produces mono AAC at the target.
 * Reporting the target for a copied stream would put a number in the server's
 * database that describes nothing.
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

/** `ffprobe` arguments for one input. Mirrors the server's `ffprobeArgs`. */
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

/** `ffmpeg` arguments for one conversion. Mirrors the server's `ffmpegArgs`. */
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
 * Spawn one binary and return its stdout.
 *
 * `execFile`, NEVER `exec`: there is no shell, so nothing about a filename or
 * a URL needs quoting and nothing in one can become a command. A failure
 * carries the binary's own stderr, trimmed — that text is the only thing that
 * distinguishes "no audio track" from "disk full" once it reaches the server
 * as a job failure report.
 */
export function runFfmpegTool(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        maxBuffer: 16 * 1024 * 1024,
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').trim().slice(-STDERR_LIMIT) || error.message;
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';

          reject(
            new FfmpegError(
              command,
              missing
                ? `"${command}" is not installed on this machine. Install ffmpeg (it ships ffprobe too) or drop this job type from --types.`
                : `${command} failed: ${detail}`,
            ),
          );

          return;
        }

        resolve(String(stdout ?? ''));
      },
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOf(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;

  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
