import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';

import {
  ffmpegArgs,
  FFMPEG_COMMAND,
  FfmpegError,
  ffprobeArgs,
  FFPROBE_COMMAND,
  parseFfprobe,
  planTranscode,
  PROBE_TIMEOUT_MS,
  RENDITION_CONTENT_TYPE,
  renditionFacts,
  resolveTargetBitrateKbps,
  type RunFn,
  runFfmpegTool,
} from '../ffmpeg.js';
import { MissingJobInputError } from '../node-errors.js';
import type { JobExecutionContext, JobExecutor } from './index.js';

// =============================================================================
// `media.audio.transcode` — the playback rendition, on a worker node (#26)
// =============================================================================
//
// The node counterpart of `MediaAudioTranscodeHandler`, and the SECOND real
// node-eligible type in this repository after `db.backup.run`. It is the
// simplest of the three executors here and that is the point: it holds no
// credential, touches no database, and needs nothing from the server except an
// input to read and a URL to write to.
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
// `ffmpeg.ts`'s header states the reason in full: `+faststart` rewrites the
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
    const { job, nodeId, api } = context;

    // Belt and braces: the engine already refuses a `requiresInput` job with no
    // download URL. Asserting it here too means the executor is safe to call
    // directly — which the TUI and a fork's own tests will do.
    if (context.inputPath === undefined || context.inputPath.length === 0) {
      throw new MissingJobInputError(job.id, this.type);
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
      const target = await api.uploadUrl(nodeId, job.id, RENDITION_CONTENT_TYPE);

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
