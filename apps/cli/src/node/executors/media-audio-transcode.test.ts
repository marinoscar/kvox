import { describe, expect, it, vi } from 'vitest';

import { FFMPEG_COMMAND, FFPROBE_COMMAND, parseFfprobe, planTranscode } from '../ffmpeg.js';
import type { NodeApi, UploadUrlResult } from '../node-api.js';
import { MissingJobInputError } from '../node-errors.js';
import type { JobExecutionContext } from './index.js';
import { MediaAudioTranscodeExecutor } from './media-audio-transcode.js';

// =============================================================================
// `media.audio.transcode` on a node  (issue #26, epic #19)
// =============================================================================
//
// The assertions this file exists for, in order of how quietly they would
// break:
//
//   1. `-movflags +faststart` IS ALWAYS PASSED, on both branches. It is the
//      one flag whose absence produces a file that uploads perfectly and
//      cannot be seeked, which is the entire reason this job type exists.
//   2. THE SERVER CHOOSES THE KEY. The executor asks for an upload URL and
//      reports what it was given; it never names a destination of its own.
//   3. THE TARGET BITRATE COMES FROM THE JOB PAYLOAD, because a node reads no
//      system settings and a locally-chosen default would silently disagree
//      with the server's.
//   4. The temp output is removed even when the job fails.
//
// No ffmpeg and no network: the `run` and `fetch` seams are the same shape
// `db-backup-run.test.ts` uses for `spawn`, and for the same reason.
// =============================================================================

const UPLOAD: UploadUrlResult = {
  url: 'https://bucket.example/transcripts/t-1/renditions/job-1.m4a?X-Amz-Signature=abc',
  key: 'transcripts/t-1/renditions/job-1.m4a',
  expiresIn: 900,
  expiresAt: '2026-09-14T02:15:00.000Z',
};

/** A WAV: PCM, no MP4 container — the re-encode branch. */
const WAV_PROBE = JSON.stringify({
  streams: [{ codec_name: 'pcm_s16le', channels: 2, duration: '75.264' }],
  format: { format_name: 'wav', bit_rate: '1411000', duration: '75.264' },
});

/** Already AAC in an MP4 at 96 kbps — the remux branch. */
const AAC_PROBE = JSON.stringify({
  streams: [{ codec_name: 'aac', channels: 2, bit_rate: '96000', duration: '75.264' }],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '75.264' },
});

function harness(
  options: {
    probeOutput?: string;
    bytes?: number;
    params?: Record<string, unknown>;
    runImpl?: (command: string, args: string[], timeoutMs: number) => Promise<string>;
    uploadStatus?: number;
  } = {},
) {
  const runCalls: { command: string; args: string[]; timeoutMs: number }[] = [];
  const removed: string[] = [];
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const controller = new AbortController();

  const run = vi.fn(async (command: string, args: string[], timeoutMs: number) => {
    runCalls.push({ command, args, timeoutMs });

    if (options.runImpl !== undefined) return options.runImpl(command, args, timeoutMs);

    return command === FFPROBE_COMMAND ? (options.probeOutput ?? WAV_PROBE) : '';
  });

  const uploads: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    uploads.push({ url, init });

    return { ok: (options.uploadStatus ?? 200) < 400, status: options.uploadStatus ?? 200 };
  });

  const api = {
    uploadUrl: vi.fn(async () => UPLOAD),
  } as unknown as NodeApi;

  const context: JobExecutionContext = {
    job: { id: 'job-1', type: 'media.audio.transcode' } as JobExecutionContext['job'],
    params: options.params ?? { transcriptId: 't-1', bitrateKbps: 96 },
    inputPath: '/tmp/worker/job-1.abc.input',
    input: { objectId: 'obj-1', size: '10000000', mimeType: 'audio/wav' },
    api,
    nodeId: 'node-1',
    signal: controller.signal,
    log: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
  };

  const executor = new MediaAudioTranscodeExecutor({
    run,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    sizeOf: async () => options.bytes ?? 512_000,
    openOutput: () => 'FILE-BODY' as unknown as NodeJS.ReadableStream,
    removeOutput: async (path) => {
      removed.push(path);
    },
  });

  return { executor, context, api, controller, run, runCalls, uploads, removed, logs };
}

describe('MediaAudioTranscodeExecutor', () => {
  it('requires its input object — the uploaded audio IS the work', () => {
    // Unlike `db.backup.run`, whose input is the database and which therefore
    // declares `false`; asking for a download URL there 422s.
    expect(new MediaAudioTranscodeExecutor().requiresInput).toBe(true);
    expect(new MediaAudioTranscodeExecutor().type).toBe('media.audio.transcode');
  });

  it('refuses a job with no input path, by name', async () => {
    const { executor, context } = harness();

    await expect(
      executor.execute({ ...context, inputPath: undefined }),
    ).rejects.toBeInstanceOf(MissingJobInputError);
  });

  it('probes the local file, re-encodes to mono AAC with faststart, and uploads', async () => {
    const { executor, context, runCalls, uploads, api } = harness();

    const result = await executor.execute(context);

    const probe = runCalls.find((call) => call.command === FFPROBE_COMMAND);
    const convert = runCalls.find((call) => call.command === FFMPEG_COMMAND);

    // From the LOCAL file the engine already downloaded, not a second HTTP
    // fetch of the same bytes.
    expect(probe?.args.at(-1)).toBe('/tmp/worker/job-1.abc.input');

    expect(convert?.args).toContain('-ac');
    expect(convert?.args.join(' ')).toContain('-c:a aac');
    // ⚠ ASSERTION 1. Without this the rendition is not seekable, and nothing
    // on either side of the wire would notice.
    expect(convert?.args.join(' ')).toContain('-movflags +faststart');
    // The output is a FILE beside the input, never a pipe: faststart rewrites
    // the header after the stream ends and needs to seek backwards to do it.
    expect(convert?.args.at(-1)).toBe('/tmp/worker/job-1.abc.input.m4a');
    // No timeout on the encode — the server's `maxRuntimeMs` and the lease
    // derived from it are what bound a multi-hour conversion.
    expect(convert?.timeoutMs).toBe(0);

    // ⚠ ASSERTION 2. The key is asked for, never chosen.
    expect(api.uploadUrl).toHaveBeenCalledWith('node-1', 'job-1', 'audio/mp4');
    expect(uploads[0]?.url).toBe(UPLOAD.url);
    expect(uploads[0]?.init.method).toBe('PUT');
    // Explicit length: undici would otherwise send a stream chunked, and
    // S3-compatible storage rejects a chunked PUT against a URL presigned
    // without it, with a signature error that names nothing about chunking.
    expect((uploads[0]?.init.headers as Record<string, string>)['content-length']).toBe('512000');
    expect((uploads[0]?.init as { duplex?: string }).duplex).toBe('half');

    expect(result).toEqual({
      bytes: 512_000,
      durationMs: 75_264,
      codec: 'aac',
      bitrateKbps: 96,
      channels: 1,
      remuxed: false,
    });
  });

  it('takes the target bitrate from the JOB PAYLOAD, not from this machine', async () => {
    // ⚠ ASSERTION 3. A node reads no system settings; the server puts the
    // deployment's `transcription.playback.bitrateKbps` on the job so the two
    // executors cannot produce different files for one job.
    const { executor, context, runCalls } = harness({
      params: { transcriptId: 't-1', bitrateKbps: 128 },
    });

    const result = await executor.execute(context);

    expect(runCalls.find((c) => c.command === FFMPEG_COMMAND)?.args.join(' ')).toContain(
      '-b:a 128k',
    );
    expect(result.bitrateKbps).toBe(128);
  });

  it('falls back to the shared default for a job enqueued before #26', async () => {
    const { executor, context, runCalls } = harness({ params: { transcriptId: 't-1' } });

    await executor.execute(context);

    expect(runCalls.find((c) => c.command === FFMPEG_COMMAND)?.args.join(' ')).toContain(
      '-b:a 64k',
    );
  });

  it('remuxes an AAC/m4a under the ceiling, and reports the COPIED stream', async () => {
    const { executor, context, runCalls } = harness({ probeOutput: AAC_PROBE });

    const result = await executor.execute(context);

    const args = runCalls.find((c) => c.command === FFMPEG_COMMAND)?.args.join(' ') ?? '';

    expect(args).toContain('-c:a copy');
    expect(args).not.toContain('-b:a');
    // A remux still needs faststart — a perfectly good AAC file with moov at
    // the end cannot be scrubbed either.
    expect(args).toContain('-movflags +faststart');

    // The copied stream is still stereo at 96 kbps; reporting the deployment's
    // target here would put a number in the server's database that describes
    // nothing.
    expect(result).toMatchObject({ remuxed: true, channels: 2, bitrateKbps: 96, codec: 'aac' });
  });

  it('refuses a zero-byte rendition rather than reporting a successful silence', async () => {
    const { executor, context, uploads } = harness({ bytes: 0 });

    await expect(executor.execute(context)).rejects.toThrow(/empty rendition/i);
    expect(uploads).toHaveLength(0);
  });

  it('reports a failed upload with its status', async () => {
    const { executor, context } = harness({ uploadStatus: 403 });

    await expect(executor.execute(context)).rejects.toThrow(/HTTP 403/);
  });

  it('stops on abort rather than finishing work nobody will accept', async () => {
    const { executor, context, controller, uploads } = harness({
      runImpl: async (command) => {
        if (command === FFPROBE_COMMAND) return WAV_PROBE;
        controller.abort();

        return '';
      },
    });

    await expect(executor.execute(context)).rejects.toThrow(/aborted/i);
    expect(uploads).toHaveLength(0);
  });

  it('removes the temp output whether the job succeeded or failed', async () => {
    const ok = harness();
    await ok.executor.execute(ok.context);
    expect(ok.removed).toEqual(['/tmp/worker/job-1.abc.input.m4a']);

    const bad = harness({ uploadStatus: 500 });
    await expect(bad.executor.execute(bad.context)).rejects.toThrow();
    expect(bad.removed).toEqual(['/tmp/worker/job-1.abc.input.m4a']);
  });

  it('logs the rendition without ever naming the presigned URL', async () => {
    const { executor, context, logs } = harness();

    await executor.execute(context);

    expect(logs[0]).toMatchObject({ message: 'playback rendition uploaded' });
    expect(JSON.stringify(logs)).not.toContain('X-Amz-Signature');
  });

  it('reports a file with no audio stream as a permanent, named failure', async () => {
    const { executor, context } = harness({
      probeOutput: JSON.stringify({ streams: [], format: { format_name: 'mp4' } }),
    });

    await expect(executor.execute(context)).rejects.toThrow(/no audio stream/i);
  });
});

// =============================================================================
// The duplication guard
// =============================================================================
//
// `ffmpeg.ts` restates, by hand, the rules `apps/api/src/transcripts/media
// /audio-transcode.ts` owns. The two cannot import each other (a worker node
// has no API source tree), so the only defence against drift is that both
// sides assert the SAME facts about the SAME inputs. These mirror the
// `planTranscode` cases in the API's `audio-transcode.spec.ts` exactly; a
// change to one side that is not made to the other fails there or here.
// =============================================================================
describe('the remux rule, restated (must match the API suite)', () => {
  const probe = (overrides: Record<string, unknown> = {}) =>
    parseFfprobe(
      JSON.stringify({
        streams: [
          {
            codec_name: 'aac',
            channels: 1,
            bit_rate: '64000',
            duration: '60',
            ...overrides,
          },
        ],
        format: {
          format_name: (overrides.format_name as string) ?? 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '60',
        },
      }),
    );

  it('remuxes AAC in an MP4 at or under 128 kbps', () => {
    expect(planTranscode(probe({ bit_rate: '128000' }), 64).remux).toBe(true);
  });

  it('re-encodes above the ceiling, a non-AAC codec, a non-MP4 container, or an unknown bitrate', () => {
    expect(planTranscode(probe({ bit_rate: '192000' }), 64).remux).toBe(false);
    expect(planTranscode(probe({ codec_name: 'opus', bit_rate: '32000' }), 64).remux).toBe(false);
    expect(planTranscode(probe({ format_name: 'aac' }), 64).remux).toBe(false);
    expect(planTranscode(probe({ bit_rate: undefined }), 64).remux).toBe(false);
  });
});
