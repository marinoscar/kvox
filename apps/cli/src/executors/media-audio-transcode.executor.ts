import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';

import { binaryCapability, registerJobRequirement, registerProbedBinary } from '@marinoscar/platform-cli/node';
import type { JobExecutionContext, JobExecutor } from '@marinoscar/platform-cli/node';

// =============================================================================
// `media.audio.transcode` on a WORKER NODE  (issue #26, epic #19; platform
// executor since #482)
// =============================================================================
//
// The node-side counterpart of `apps/api/src/transcripts/media/` and of
// `MediaAudioTranscodeHandler`. The engine around it (claim, lease renewal,
// input download, result and failure reports, the credential rule) is the
// platform's `@marinoscar/platform-cli`; this file is the part only this app
// knows: how to turn an upload into the playback rendition.
//
// The rules below are the server's rules because they are properties of
// FFMPEG, not of whichever process happens to be running it.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A SECOND IMPLEMENTATION AND NOT AN IMPORT
// -----------------------------------------------------------------------------
//
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

/** The binaries. `ffmpeg` ships `ffprobe`; both are registered below as probed binaries and required capabilities. */
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

// =============================================================================
// The executor — the playback rendition, on a worker node (#26)
// =============================================================================
//
// The SECOND real node-eligible type in this repository after `db.backup.run`
// (which is the platform's own executor). It is the simplest of the executors
// and that is the point: it holds no credential, touches no database, and
// needs nothing from the server except an input to read and a URL to write to.
//
//     download (the engine)  →  ffprobe  →  ffmpeg  →  PUT  →  report
//
// -----------------------------------------------------------------------------
// ⚠ `requiresInput = true`, UNLIKE `db.backup.run`
// -----------------------------------------------------------------------------
//
// The backup's input is the DATABASE, reached through a credential it fetches
// itself, so it declares `false` and asking for a download URL would 422. This
// one's input is an ordinary storage object, so the engine streams it to a
// temp file before `execute` is called and the whole presigned-download path
// is the framework's rather than this file's.
//
// ⚠ IT ALSO CONVERTS FROM THE LOCAL FILE RATHER THAN FROM THE URL, which the
// server path does not — the server hands ffmpeg a presigned GET directly.
// Both are correct for where they run: the server avoids spooling a
// multi-gigabyte upload onto an API box's disk, while a node has already been
// given the file by the engine and re-fetching it over HTTP would download the
// same bytes twice.
//
// -----------------------------------------------------------------------------
// ⚠ THE OUTPUT IS A TEMP FILE AND NOT A PIPE INTO THE PUT
// -----------------------------------------------------------------------------
//
// The ffmpeg section above states the reason in full: `+faststart` rewrites the
// header after the stream ends and therefore needs a SEEKABLE output, so on a
// socket ffmpeg silently produces a `moov`-last file that uploads perfectly
// and cannot be seeked. Do not "optimise" this into a stream — nothing on
// either side would notice, which is exactly what makes it dangerous.
//
// The file is removed in a `finally`, whatever happened. It sits next to the
// engine's own downloaded input, in the engine's temp directory, so a node
// that dies mid-job leaves both in one place for an operator to find.
// =============================================================================

/** Mirrors `mediaAudioTranscodeResultSchema` in `apps/api/src/jobs/contracts/`. */
export interface MediaAudioTranscodeResult {
  bytes: number;
  durationMs: number;
  codec: string;
  bitrateKbps: number;
  channels: number;
  remuxed: boolean;
}

export interface MediaAudioTranscodeExecutorOptions {
  /** The spawn seam, so the tests need no ffmpeg on the machine. */
  run?: RunFn | undefined;
  /** The upload seam. Defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch | undefined;
  /** Reads the produced file's size. Defaults to `fs.stat`. */
  sizeOf?: ((path: string) => Promise<number>) | undefined;
  /** Opens the produced file for upload. Defaults to `fs.createReadStream`. */
  openOutput?: ((path: string) => NodeJS.ReadableStream) | undefined;
  /** Removes the produced file. Defaults to `fs.rm`. */
  removeOutput?: ((path: string) => Promise<void>) | undefined;
}

export class MediaAudioTranscodeExecutor implements JobExecutor {
  readonly type = 'media.audio.transcode';

  /** The uploaded audio IS the work. Without it there is nothing to convert. */
  readonly requiresInput = true;

  constructor(private readonly options: MediaAudioTranscodeExecutorOptions = {}) {}

  async execute(context: JobExecutionContext): Promise<MediaAudioTranscodeResult> {
    const { job, nodeId, api, claimToken } = context;

    // Belt and braces: the engine already refuses a `requiresInput` job with no
    // download URL. Asserting it here too means the executor is safe to call
    // directly — which the TUI and a fork's own tests will do.
    if (context.inputPath === undefined || context.inputPath.length === 0) {
      throw new Error(
        `Job ${job.id} (${this.type}) reached the executor with no input file; the engine should have refused it.`,
      );
    }

    const run = this.options.run ?? runFfmpegTool;
    const input = context.inputPath;
    // Beside the engine's own temp input, so one directory holds everything a
    // half-finished job left behind.
    const output = `${input}.m4a`;

    try {
      const probe = parseFfprobe(await run(FFPROBE_COMMAND, ffprobeArgs(input), PROBE_TIMEOUT_MS));

      // ⚠ THE TARGET COMES FROM THE JOB, NOT FROM THIS MACHINE. A node reads no
      // system settings, so the server puts the deployment's
      // `transcription.playback.bitrateKbps` on the payload; a job enqueued by
      // an older build carries none and falls back to the shared default.
      const plan = planTranscode(probe, resolveTargetBitrateKbps(context.params.bitrateKbps));

      // Cooperative cancellation. A drain or a lost lease should stop a
      // multi-hour encode rather than finish work nobody will accept — checked
      // before the expensive call rather than only after it, because the
      // credential-free steps above can take seconds and both events can land
      // inside that window.
      this.throwIfAborted(context);

      // ⚠ NO TIMEOUT (`0`). Converting a six-hour recording legitimately runs
      // for a long time, and the thing that bounds it is the SERVER's
      // `maxRuntimeMs` for this type plus the lease derived from it. A second,
      // shorter clock on this side would kill long recordings for no reason
      // and could disagree with the one that matters.
      await run(FFMPEG_COMMAND, ffmpegArgs({ input, output, plan }), 0);

      this.throwIfAborted(context);

      const bytes = await this.sizeOf(output);

      if (bytes <= 0) {
        throw new FfmpegError(
          FFMPEG_COMMAND,
          `ffmpeg produced an empty rendition for job ${job.id}. The input is most likely truncated or not decodable.`,
        );
      }

      // THE SERVER CHOOSES THE KEY, always: this asks for one and never names
      // a destination of its own. A node-supplied key is refused with a 400
      // long before it could point a transcript at somebody else's bytes.
      const target = await api.uploadUrl(nodeId, job.id, RENDITION_CONTENT_TYPE, claimToken);

      if (typeof target.url !== 'string' || target.url.length === 0) {
        throw new Error(
          `The server returned no upload URL for job ${job.id}; the rendition was not stored.`,
        );
      }

      await this.upload(target.url, output, bytes, job.id);

      const facts = renditionFacts(probe, plan);

      const result: MediaAudioTranscodeResult = {
        bytes,
        durationMs: probe.durationMs,
        remuxed: plan.remux,
        ...facts,
      };

      context.log('playback rendition uploaded', {
        jobId: job.id,
        bytes: result.bytes,
        durationMs: result.durationMs,
        remuxed: result.remuxed,
      });

      return result;
    } finally {
      await this.removeOutput(output);
    }
  }

  /**
   * Single-shot PUT of the finished file.
   *
   * ⚠ `content-length` IS SET EXPLICITLY. The body is a stream, so undici
   * would otherwise send it chunked — and S3-compatible storage rejects a
   * chunked PUT against a URL that was presigned without it, with a signature
   * error that names nothing about chunking. The size is already known here
   * because the file is on disk, which is one more thing the temp file buys.
   *
   * ⚠ `duplex: 'half'` IS REQUIRED for a streaming body; without it undici
   * refuses the request outright at call time, which reads like a bad URL.
   */
  private async upload(url: string, path: string, bytes: number, jobId: string): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const body = this.options.openOutput
      ? this.options.openOutput(path)
      : createReadStream(path);

    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        'content-type': RENDITION_CONTENT_TYPE,
        'content-length': String(bytes),
      },
      body: body as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    if (!response.ok) {
      throw new Error(
        `Uploading the playback rendition for job ${jobId} failed with HTTP ${response.status}.`,
      );
    }
  }

  private throwIfAborted(context: JobExecutionContext): void {
    if (context.signal.aborted) {
      throw new Error(`Transcode of job ${context.job.id} was aborted`);
    }
  }

  private async sizeOf(path: string): Promise<number> {
    if (this.options.sizeOf !== undefined) return this.options.sizeOf(path);

    const stats = await stat(path);

    return stats.size;
  }

  /** Best effort: a file we cannot remove is a disk-space problem to log. */
  private async removeOutput(path: string): Promise<void> {
    try {
      if (this.options.removeOutput !== undefined) {
        await this.options.removeOutput(path);

        return;
      }

      await rm(path, { force: true });
    } catch {
      // Deliberately swallowed — see above.
    }
  }
}

// =============================================================================
// Registration  (module scope, as the platform's node README prescribes)
// =============================================================================
//
// BOTH binaries are required, and registered as probed binaries so `node
// doctor` and the startup self-test show their versions. `ffmpeg` ships
// `ffprobe` on every distribution that packages either, but a hand-built static
// `ffmpeg` that omitted `ffprobe` would satisfy a requirement naming only the
// first and then fail every job at the probe step.
//
// A node without them refuses to CLAIM `media.audio.transcode`, naming the
// missing capability, instead of claiming the job and failing it. This runs at
// import time so the registry is complete before `createCli` freezes it.
registerProbedBinary(FFMPEG_COMMAND, { versionArgs: ['-version'] });
registerProbedBinary(FFPROBE_COMMAND, { versionArgs: ['-version'] });
registerJobRequirement('media.audio.transcode', {
  required: [binaryCapability(FFMPEG_COMMAND), binaryCapability(FFPROBE_COMMAND)],
});

/** The executor `createCli({ nodeExecutors })` registers. */
export const mediaAudioTranscodeExecutor: JobExecutor = new MediaAudioTranscodeExecutor();
