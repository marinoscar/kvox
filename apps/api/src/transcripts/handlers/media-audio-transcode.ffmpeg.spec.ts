import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import { TRANSCODE_JOB_TYPE } from '../job-types';
import { FfmpegService } from '../media/ffmpeg.service';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';
import { createFakeProvider } from './__fixtures__/fake-provider';
import { MediaAudioTranscodeHandler } from './media-audio-transcode.handler';

// =============================================================================
// `media.audio.transcode` end to end, WITH A REAL ffmpeg (issue #26)
// =============================================================================
//
// Everything else about this handler is tested against a mocked
// `FfmpegService`, which proves the decisions and proves nothing about the
// FILE. This suite is the other half: it runs the real binaries, on real
// bytes, and asserts the three properties a rendition has to have.
//
//   1. It is AAC in an MP4. (Playability — §7.1's rejected alternatives.)
//   2. `moov` PRECEDES `mdat`. (Seekability — the actual requirement.)
//   3. Its duration matches the source.
//
// ⚠ PROPERTY 2 IS THE ONE WORTH RUNNING A BINARY FOR. `+faststart` is a flag
// that ffmpeg accepts, warns about and silently ignores whenever the output is
// not seekable — so every unit-level assertion about the ARGUMENTS can pass
// while the produced file has `moov` at the end and cannot be scrubbed. The
// only thing that can tell the two apart is reading the bytes, and that is
// what `moovPrecedesMdat` below does.
//
// ⚠ THERE IS NO SKIP GUARD, DELIBERATELY. A suite that skips itself when
// ffmpeg is absent is a suite that has never run anywhere nobody checked, and
// this one is the only proof in the repository that the rendition is really
// seekable. `apps/api/Dockerfile`, `apps/cli/Dockerfile` and the CI workflow
// all install ffmpeg; if it is missing, this failing is the correct outcome.
// =============================================================================

const execFileAsync = promisify(execFile);

const TRANSCRIPT_ID = 'transcript-1';
const SOURCE_KEY = 'transcripts/transcript-1/source/input';

/** Seconds of test tone. Short enough to be quick, long enough to have frames. */
const FIXTURE_SECONDS = 2;

let workDir: string;
let wavFixture: string;
let aacFixture: string;

/**
 * `moov` before `mdat`, read from the bytes themselves.
 *
 * An MP4 is a flat sequence of length-prefixed boxes, so the four-byte type
 * tags appear literally in the file and their ORDER is the whole question. A
 * file whose `mdat` comes first makes a browser download everything before it
 * can seek anywhere at all.
 */
function moovPrecedesMdat(bytes: Buffer): boolean {
  const moov = bytes.indexOf('moov', 0, 'latin1');
  const mdat = bytes.indexOf('mdat', 0, 'latin1');

  expect(moov).toBeGreaterThanOrEqual(0);
  expect(mdat).toBeGreaterThanOrEqual(0);

  return moov < mdat;
}

/** `ffprobe` a produced file, as a reader of the rendition rather than as the handler. */
async function probeFile(path: string): Promise<{
  codec: string;
  channels: number;
  formatName: string;
  durationMs: number;
  bitrateKbps: number;
}> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-select_streams',
    'a:0',
    path,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams: { codec_name: string; channels: number; bit_rate?: string }[];
    format: { format_name: string; duration: string };
  };

  return {
    codec: parsed.streams[0].codec_name,
    channels: parsed.streams[0].channels,
    formatName: parsed.format.format_name,
    durationMs: Math.round(Number.parseFloat(parsed.format.duration) * 1000),
    bitrateKbps: Math.round(Number.parseFloat(parsed.streams[0].bit_rate ?? '0') / 1000),
  };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'transcode-ffmpeg-'));
  wavFixture = join(workDir, 'source.wav');
  aacFixture = join(workDir, 'source.m4a');

  // GENERATED, NOT COMMITTED. A binary fixture in git is bytes nobody can
  // review, produced by a version of ffmpeg nobody recorded; `sine` is two
  // seconds of a 440 Hz tone that this machine's own ffmpeg makes, so the
  // input is exactly as reproducible as the thing under test.
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${FIXTURE_SECONDS}`,
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    wavFixture,
  ]);

  // The remux candidate: already AAC, already MP4, already under 128 kbit/s.
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    wavFixture,
    '-ac',
    '1',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    aacFixture,
  ]);
}, 60_000);

describe('media.audio.transcode with a real ffmpeg', () => {
  let handler: MediaAudioTranscodeHandler;
  let uploaded: Map<string, string>;
  let recorded: jest.Mock;
  let transcriptUpdate: jest.Mock;
  let sourcePath: string;

  const job = (): Job =>
    ({
      id: 'job-7',
      type: TRANSCODE_JOB_TYPE,
      attempts: 1,
      subjectType: 'storage_object',
      subjectId: 'obj-1',
      payload: { transcriptId: TRANSCRIPT_ID, bitrateKbps: 64 },
    }) as unknown as Job;

  beforeEach(async () => {
    uploaded = new Map();
    recorded = jest.fn().mockResolvedValue({ id: 'rendition-1' });
    transcriptUpdate = jest.fn().mockResolvedValue({});

    const module = await Test.createTestingModule({
      providers: [
        MediaAudioTranscodeHandler,
        // THE REAL SERVICE. This is the only suite that uses it.
        FfmpegService,
        { provide: JobHandlerRegistry, useValue: { register: jest.fn() } },
        {
          provide: PrismaService,
          useValue: {
            transcript: {
              update: transcriptUpdate,
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
              findUnique: jest
                .fn()
                .mockResolvedValue({ transcriptionStatus: 'submitted', status: 'processing' }),
            },
            storageObject: {
              findUnique: jest.fn().mockImplementation(() =>
                Promise.resolve({
                  id: 'obj-1',
                  storageKey: SOURCE_KEY,
                  size: BigInt(1),
                  mimeType: 'audio/wav',
                }),
              ),
            },
          },
        },
        { provide: TranscriptObjectsService, useValue: { recordUploaded: recorded } },
        {
          provide: TranscriptPipelineService,
          useValue: {
            loadForJob: jest.fn().mockResolvedValue({
              id: TRANSCRIPT_ID,
              ownerId: 'user-1',
              title: 'A recording',
              status: 'processing',
              transcriptionStatus: 'submitted',
              playbackStatus: 'processing',
              sourceObjectId: 'obj-1',
              playbackObjectId: null,
              durationMs: null,
              deletedAt: null,
            }),
            markFailed: jest.fn().mockResolvedValue(true),
            enqueueSubmit: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: TranscriptionRuntimeService,
          useValue: {
            policy: jest.fn().mockResolvedValue({ playback: { bitrateKbps: 64 } }),
            activeProvider: jest
              .fn()
              .mockResolvedValue({ provider: createFakeProvider(), policy: {} }),
          },
        },
        {
          provide: STORAGE_PROVIDER,
          useValue: {
            // ⚠ A LOCAL PATH STANDS IN FOR THE PRESIGNED URL, and it works for
            // the same reason the real thing does: ffmpeg's `-i` takes either,
            // and the handler passes whatever it is handed straight into an
            // argv entry. What is being tested here is the conversion, not S3.
            getSignedDownloadUrl: jest.fn().mockImplementation(() => Promise.resolve(sourcePath)),
            upload: jest
              .fn()
              .mockImplementation(async (key: string, stream: Readable) => {
                const destination = join(workDir, `uploaded-${uploaded.size}.m4a`);
                const chunks: Buffer[] = [];

                await pipeline(stream, async function* (source) {
                  for await (const chunk of source) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
                    yield chunk;
                  }
                });

                await writeFile(destination, Buffer.concat(chunks));
                uploaded.set(key, destination);

                return {};
              }),
          },
        },
      ],
    }).compile();

    handler = module.get(MediaAudioTranscodeHandler);
  });

  it('turns a stereo WAV into a seekable mono AAC/m4a of the same length', async () => {
    sourcePath = wavFixture;

    await handler.process(job());

    const key = `transcripts/${TRANSCRIPT_ID}/renditions/job-7.m4a`;
    const path = uploaded.get(key);

    expect(path).toBeDefined();

    const bytes = readFileSync(path as string);
    const probe = await probeFile(path as string);

    // 1. AAC in an MP4.
    expect(probe.codec).toBe('aac');
    expect(probe.formatName).toContain('mp4');

    // Mono, from a stereo source: half the bytes for speech, for nothing lost.
    expect(probe.channels).toBe(1);

    // 2. ⚠ THE FASTSTART ASSERTION. See this file's header for why arguments
    // alone cannot prove this.
    expect(moovPrecedesMdat(bytes)).toBe(true);

    // 3. The same recording, not a truncated one.
    expect(probe.durationMs).toBeGreaterThanOrEqual(FIXTURE_SECONDS * 1000 - 100);
    expect(probe.durationMs).toBeLessThanOrEqual(FIXTURE_SECONDS * 1000 + 200);

    // Smaller than the PCM source by a wide margin — the other half of why a
    // rendition exists at all.
    expect(bytes.byteLength).toBeLessThan(readFileSync(wavFixture).byteLength / 2);

    // And what was recorded describes what was produced.
    const record = recorded.mock.calls[0][0];

    expect(record.mimeType).toBe('audio/mp4');
    expect(record.size).toBe(bytes.byteLength);
    expect(record.metadata).toMatchObject({
      producedBy: 'server',
      remuxed: false,
      channels: 1,
      codec: 'aac',
      bitrateKbps: 64,
    });
    expect(record.metadata.durationMs).toBeGreaterThan(1_900);

    expect(transcriptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ playbackStatus: 'ready' }),
      }),
    );
  }, 60_000);

  it('REMUXES an AAC/m4a already under 128 kbps rather than re-encoding it', async () => {
    sourcePath = aacFixture;

    await handler.process(job());

    const path = uploaded.get(`transcripts/${TRANSCRIPT_ID}/renditions/job-7.m4a`) as string;
    const bytes = readFileSync(path);
    const probe = await probeFile(path);

    // The stream was COPIED, so it is bit-for-bit the source's audio: same
    // codec, same channel count, and a size within a few hundred bytes of the
    // original (containers differ slightly, the samples do not).
    expect(recorded.mock.calls[0][0].metadata).toMatchObject({ remuxed: true });
    expect(probe.codec).toBe('aac');

    const source = await probeFile(aacFixture);

    expect(probe.channels).toBe(source.channels);
    expect(probe.bitrateKbps).toBe(source.bitrateKbps);
    expect(Math.abs(bytes.byteLength - readFileSync(aacFixture).byteLength)).toBeLessThan(4096);

    // A remux still has to be seekable — that is half of why it runs at all
    // rather than the source being served directly.
    expect(moovPrecedesMdat(bytes)).toBe(true);
  }, 60_000);

  it('fails with ffmpeg’s own words when the input is not media', async () => {
    sourcePath = join(workDir, 'not-audio.txt');
    await writeFile(sourcePath, 'this is not an audio file');

    // A named, permanent failure carrying the binary's diagnostics — that text
    // is the only thing that distinguishes this from an expired URL once it
    // reaches an operator as `Job.lastError`.
    await expect(handler.process(job())).rejects.toThrow(/ffprobe/i);
  }, 60_000);
});
