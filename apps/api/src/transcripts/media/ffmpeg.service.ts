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

import { execFile } from 'node:child_process';
import { Injectable, Logger } from '@nestjs/common';

import {
  type AudioProbe,
  ffmpegArgs,
  ffprobeArgs,
  parseFfprobe,
  type TranscodePlan,
} from './audio-transcode';

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

export interface FfmpegServiceOptions {
  ffmpegCommand?: string;
  ffprobeCommand?: string;
}

@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  private readonly ffmpeg: string;
  private readonly ffprobe: string;

  constructor(options: FfmpegServiceOptions = {}) {
    this.ffmpeg = options.ffmpegCommand ?? FFMPEG_COMMAND;
    this.ffprobe = options.ffprobeCommand ?? FFPROBE_COMMAND;
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
          const out = typeof stdout === 'string' ? stdout : stdout.toString();
          const err = typeof stderr === 'string' ? stderr : stderr.toString();

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
