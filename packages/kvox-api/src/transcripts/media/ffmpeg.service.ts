// =============================================================================
// FfmpegService — the two spawns, and nothing else (issue #26, epic #19)
// =============================================================================
//
// The EFFECT half of `media.audio.transcode`'s server path. Its sibling
// `audio-transcode.ts` decides what to run; this runs it. The split exists so
// the handler's own suite can test every decision without a binary on the
// machine, and so the one suite that DOES need the binary
// (`media-audio-transcode.ffmpeg.spec.ts`) is the only place a real `ffmpeg`
// is required.
//
// -----------------------------------------------------------------------------
// `execFile`, NEVER `exec`
// -----------------------------------------------------------------------------
//
// The input this service is handed is frequently A PRESIGNED URL — a string
// containing `&`, `=`, `?` and a signature built out of arbitrary base64. Put
// that through a shell and the query string becomes several commands; quote it
// and you have invented an escaping rule that has to be right on two platforms.
// `execFile` takes an argument vector and spawns the binary directly, so there
// is no shell, no quoting and nothing to get wrong.
//
// -----------------------------------------------------------------------------
// A FAILURE CARRIES ffmpeg's OWN STDERR, TRIMMED
// -----------------------------------------------------------------------------
//
// `ffmpeg`'s diagnostics are the only thing that distinguishes "the presigned
// URL had expired" from "this WebM has no audio track" from "the disk is
// full", and every one of those reaches an operator as `Job.lastError` and
// nothing else. So the message is ffmpeg's, not ours — and it is bounded,
// because `lastError` is a database column and a truncated stack of ffmpeg
// progress lines is not worth storing in full. `-loglevel error` already keeps
// it short; the cap is for the case where it does not.
// =============================================================================

import { execFile, spawn } from 'node:child_process';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { TRANSCRIPTS_MODULE_OPTIONS, type ResolvedTranscriptsOptions } from '../transcripts.options.js';

import {
  type AudioProbe,
  ffmpegArgs,
  ffprobeArgs,
  parseFfprobe,
  type TranscodePlan,
} from './audio-transcode.js';

/** The binaries, named once. Overridable per instance for the suites. */
export const FFMPEG_COMMAND = 'ffmpeg';
export const FFPROBE_COMMAND = 'ffprobe';

/**
 * How long a probe may take.
 *
 * Generous because the input may be a presigned URL and `ffprobe` has to make
 * a real HTTP round trip to read the header — but bounded, because a probe
 * that hangs would hold a worker slot for the job's whole three-hour lease
 * while doing nothing at all.
 */
export const PROBE_TIMEOUT_MS = 2 * 60 * 1000;

/** Most stderr we will carry into an error message. */
export const STDERR_LIMIT = 2000;

/** A spawn failed. Carries the binary's own words; see the file header. */
export class FfmpegError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/**
 * FfmpegService: wiring the slice registers itself; a host configures it through `TranscriptsModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  /**
   * ⚠ NO CONSTRUCTOR ARGUMENTS, DELIBERATELY. An `options = {}` parameter
   * reads fine and makes this class UNCONSTRUCTIBLE BY NEST: the container
   * sees one parameter with no injection token and refuses the whole module
   * with "can't resolve dependencies … at index [0]" — at application start,
   * in every integration test, for a convenience nothing needed. The two
   * binaries are resolved through PATH, which is the seam an environment
   * already has.
   */
  private readonly ffmpeg: string;
  private readonly ffprobe: string;

  /**
   * @param options - the module's resolved options; absent, the binaries are looked
   *   up on the `PATH` (`ffmpeg`, `ffprobe`).
   */
  constructor(@Optional() @Inject(TRANSCRIPTS_MODULE_OPTIONS) options?: ResolvedTranscriptsOptions) {
    this.ffmpeg = options?.ffmpegPath ?? FFMPEG_COMMAND;
    this.ffprobe = options?.ffprobePath ?? FFPROBE_COMMAND;
  }

  /**
   * Measure an input, which may be a local path or a URL.
   *
   * ⚠ NO TIMEOUT ON THE TRANSCODE, BUT ONE HERE. The asymmetry is deliberate:
   * a probe reads a header and is done in seconds, so a probe that has not
   * answered in two minutes is stuck. A transcode of a six-hour recording
   * legitimately runs for an hour, and the thing that bounds it is the job's
   * own `maxRuntimeMs` (three hours) — a second, shorter clock here would kill
   * long recordings for no reason and the two numbers could disagree.
   */
  async probe(input: string): Promise<AudioProbe> {
    const { stdout } = await this.run(this.ffprobe, ffprobeArgs(input), PROBE_TIMEOUT_MS);

    return parseFfprobe(stdout);
  }

  /** Convert `input` into `output` according to `plan`. Throws to fail. */
  async transcode(options: {
    input: string;
    output: string;
    plan: TranscodePlan;
  }): Promise<void> {
    const args = ffmpegArgs(options);

    this.logger.debug(
      `Running ${this.ffmpeg} ${options.plan.remux ? '(remux)' : `(re-encode @ ${options.plan.bitrateKbps}k)`} ` +
        `into ${options.output}`,
    );

    await this.run(this.ffmpeg, args, 0);
  }

  /**
   * Decode the given time windows of an input into one 16 kHz mono float stream, for the
   * speaker-voice embedder (#825).
   *
   * Each window is cut with `atrim` (sample-accurate, unlike the frame-granular `aselect`, whose
   * output differs between ffmpeg versions) and the cuts are joined with `concat` in one
   * `-filter_complex`. Windows are sorted by start and overlapping ones merged, so the result is
   * the speech of one speaker in time order. The input may be a presigned URL; as everywhere here
   * the argument vector never reaches an error message.
   *
   * The stream is truncated to the expected sample count, so a little extra output is harmless; a
   * hard memory bound (twice the expected size plus 1 MiB) kills the process and throws.
   *
   * @param options - `input` is a local path or a signed URL, `windows` are `{ startMs, endMs }`
   * windows in any order (empty returns an empty array) and `timeoutMs` is a wall-clock bound on
   * the one spawn.
   * @returns samples in [-1, 1] at 16 kHz, at most the merged windows' total length.
   */
  async decodePcm16kMono(options: {
    input: string;
    windows: ReadonlyArray<{ startMs: number; endMs: number }>;
    timeoutMs: number;
  }): Promise<Float32Array> {
    const sorted = options.windows
      .filter((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs > w.startMs)
      .map((w) => ({ startMs: Math.max(0, w.startMs), endMs: w.endMs }))
      .sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
    const windows: Array<{ startMs: number; endMs: number }> = [];
    for (const w of sorted) {
      const last = windows[windows.length - 1];
      if (last && w.startMs <= last.endMs) last.endMs = Math.max(last.endMs, w.endMs);
      else windows.push({ ...w });
    }
    if (windows.length === 0) return new Float32Array(0);

    const sec = (ms: number): string => (ms / 1000).toFixed(3);
    const k = windows.length;
    const head = '[0:a:0]aresample=16000,aformat=channel_layouts=mono';
    let graph: string;
    if (k === 1) {
      const w = windows[0]!;
      graph = `${head},atrim=start=${sec(w.startMs)}:end=${sec(w.endMs)},asetpts=PTS-STARTPTS[out]`;
    } else {
      const parts = [`${head},asplit=${k}${windows.map((_, i) => `[s${i}]`).join('')}`];
      windows.forEach((w, i) => {
        parts.push(`[s${i}]atrim=start=${sec(w.startMs)}:end=${sec(w.endMs)},asetpts=PTS-STARTPTS[w${i}]`);
      });
      parts.push(`${windows.map((_, i) => `[w${i}]`).join('')}concat=n=${k}:v=0:a=1[out]`);
      graph = parts.join(';');
    }
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      options.input,
      '-vn',
      '-filter_complex',
      graph,
      '-map',
      '[out]',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      'pipe:1',
    ];

    const totalMs = windows.reduce((sum, w) => sum + (w.endMs - w.startMs), 0);
    // 16 samples per ms at 2 bytes each.
    const expectedSamples = Math.ceil(totalMs * 16);
    const expectedBytes = expectedSamples * 2;
    const hardCapBytes = expectedBytes * 2 + 1024 * 1024;
    const redact = (text: string): string => text.replace(/https?:\/\/\S+/g, '<url>');

    const raw = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let outBytes = 0;
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (error: FfmpegError | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) {
          child.kill('SIGKILL');
          reject(error);
        } else {
          resolve(Buffer.concat(out, outBytes));
        }
      };

      if (options.timeoutMs > 0) {
        timer = setTimeout(() => finish(new FfmpegError(this.ffmpeg, `${this.ffmpeg} failed: timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
      }

      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > hardCapBytes) {
          finish(new FfmpegError(this.ffmpeg, `${this.ffmpeg} failed: output exceeded ${hardCapBytes} bytes`));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Keep only the tail: it is all an error message may carry.
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT * 2);
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        // Never `error.message` for a spawn failure with args: it can carry the signed URL.
        finish(
          new FfmpegError(
            this.ffmpeg,
            error.code === 'ENOENT' ? `"${this.ffmpeg}" is not installed on this machine` : `${this.ffmpeg} failed: could not start`,
          ),
        );
      });
      child.on('close', (code, signal) => {
        if (code === 0) {
          finish(null);
          return;
        }
        const detail = stderr.trim().slice(-STDERR_LIMIT) || `exited with ${signal ?? `code ${code}`}`;
        finish(new FfmpegError(this.ffmpeg, `${this.ffmpeg} failed: ${redact(detail)}`));
      });
    });

    // The embedder needs at most the windows' length; anything beyond is dropped.
    const count = Math.min(Math.floor(raw.length / 2), expectedSamples);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) out[i] = raw.readInt16LE(i * 2) / 32768;
    return out;
  }

  /**
   * One spawn, promisified by hand rather than through `promisify(execFile)`.
   *
   * `promisify` rejects with an `Error` whose `message` is the command line —
   * which for a presigned URL means the SIGNED CREDENTIAL ends up in
   * `Job.lastError`, in the log, and in the admin job list. That is the whole
   * reason this is written out: the rejection below names the binary and
   * carries stderr, and never the argument vector.
   */
  private run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          // 16 MiB: `ffprobe -show_streams` on a file with many streams is the
          // only thing here that produces meaningful stdout, and it is small.
          maxBuffer: 16 * 1024 * 1024,
          ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
        },
        (error, stdout, stderr) => {
          // `execFile`'s overload resolution gives these `string` here (no
          // `encoding: 'buffer'`), but the values are read back from a child
          // process and a defensive `String()` costs nothing.
          const out = String(stdout ?? '');
          const err = String(stderr ?? '');

          if (error) {
            const detail = err.trim().slice(-STDERR_LIMIT) || error.message;
            const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';

            reject(
              new FfmpegError(
                command,
                missing
                  ? `"${command}" is not installed on this machine, so the playback rendition ` +
                    'cannot be produced here. Install ffmpeg (it ships ffprobe too), or let a ' +
                    'worker node that has it claim this job.'
                  : `${command} failed: ${detail}`,
              ),
            );

            return;
          }

          resolve({ stdout: out, stderr: err });
        },
      );
    });
  }
}
