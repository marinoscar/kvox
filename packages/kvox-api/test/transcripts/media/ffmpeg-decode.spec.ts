import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { FfmpegError, FfmpegService } from '../../../src/transcripts/media/ffmpeg.service.js';
import { resolveTranscriptsOptions } from '../../../src/transcripts/transcripts.options.js';

// =============================================================================
// FfmpegService.decodePcm16kMono (#825)
// =============================================================================
//
// Two halves.
//
//   1. The spawn contract, against a FAKE binary (a shell script handed over as `ffmpegPath`):
//      the argument vector, what is read back from stdout, the output cap and the timeout, and
//      that a signed URL never reaches a thrown message. Runs everywhere a POSIX shell exists.
//
//   2. A real ffmpeg on a GENERATED TONE (no speech, no fixtures): the windows are really
//      selected and joined back to back at 16 kHz mono. Gated on the binary being installed,
//      because the speaker-voice feature itself degrades to a `no_ffmpeg` skip without it.
// =============================================================================

const execFileAsync = promisify(execFile);

const SIGNED = 'https://store.example.test/o/rec.m4a?X-Amz-Signature=SECRETSIGNATURE&X-Amz-Credential=KEYID';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kvox-decode-spec-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A shell script standing in for ffmpeg: records its argv, prints `body`, exits with `exit`. */
function fakeBinary(name: string, body: string): { path: string; argv: () => string[] } {
  const path = join(dir, name);
  const record = join(dir, `${name}.argv`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, argv: () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').slice(0, -1) : []) };
}

const service = (ffmpegPath: string) => new FfmpegService(resolveTranscriptsOptions({ media: { ffmpegPath } }));

/** The error a promise rejects with; fails the spec when it resolves instead. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject');
}

describe('decodePcm16kMono (fake binary)', () => {
  it('builds the argument vector: aselect over the joined windows, 16 kHz mono signed 16-bit to stdout', async () => {
    const fake = fakeBinary('ok', `printf '\\000\\000'`);
    await service(fake.path).decodePcm16kMono({
      input: SIGNED,
      windows: [
        { startMs: 0, endMs: 1500 },
        { startMs: 3000, endMs: 4250 },
      ],
      timeoutMs: 10_000,
    });

    expect(fake.argv()).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      SIGNED,
      '-vn',
      '-map',
      '0:a:0',
      '-af',
      'aselect=between(t\\,0.000\\,1.500)+between(t\\,3.000\\,4.250),asetpts=N/SR/TB',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      'pipe:1',
    ]);
  });

  it('passes the URL as ONE argument: no shell, so `&` and `?` stay in the argument', async () => {
    const fake = fakeBinary('one-arg', `printf '\\000\\000'`);
    await service(fake.path).decodePcm16kMono({ input: SIGNED, windows: [{ startMs: 0, endMs: 1000 }], timeoutMs: 10_000 });
    expect(fake.argv().filter((a) => a.includes('SECRETSIGNATURE'))).toEqual([SIGNED]);
  });

  it('drops windows that are not finite or not forward, and clamps a negative start to 0', async () => {
    const fake = fakeBinary('filter', `printf '\\000\\000'`);
    await service(fake.path).decodePcm16kMono({
      input: '/tmp/a.wav',
      windows: [
        { startMs: Number.NaN, endMs: 1000 },
        { startMs: 2000, endMs: 2000 },
        { startMs: 3000, endMs: 2000 },
        { startMs: Number.POSITIVE_INFINITY, endMs: 9000 },
        { startMs: -500, endMs: 1000 },
      ],
      timeoutMs: 10_000,
    });
    const select = fake.argv()[fake.argv().indexOf('-af') + 1];
    expect(select).toBe('aselect=between(t\\,0.000\\,1.000),asetpts=N/SR/TB');
  });

  it('returns an empty array without spawning anything when no window is usable', async () => {
    const fake = fakeBinary('never', `printf '\\000\\000'`);
    const svc = service(fake.path);
    await expect(svc.decodePcm16kMono({ input: 'x', windows: [], timeoutMs: 1000 })).resolves.toHaveLength(0);
    await expect(
      svc.decodePcm16kMono({ input: 'x', windows: [{ startMs: 5, endMs: 5 }], timeoutMs: 1000 }),
    ).resolves.toHaveLength(0);
    expect(fake.argv()).toEqual([]);
  });

  it('reads little-endian signed 16-bit PCM back into floats in [-1, 1]', async () => {
    // 0x0000, 0x4000, 0x8000, 0x7fff
    const fake = fakeBinary('pcm', `printf '\\000\\000\\000\\100\\000\\200\\377\\177'`);
    const samples = await service(fake.path).decodePcm16kMono({ input: 'x', windows: [{ startMs: 0, endMs: 1000 }], timeoutMs: 10_000 });
    expect(Array.from(samples)).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it('ignores a trailing odd byte', async () => {
    const fake = fakeBinary('odd', `printf '\\000\\100\\001'`);
    const samples = await service(fake.path).decodePcm16kMono({ input: 'x', windows: [{ startMs: 0, endMs: 1000 }], timeoutMs: 10_000 });
    expect(samples).toHaveLength(1);
  });

  it('caps the output at the windows total plus one second: more than that fails, never buffers on', async () => {
    // 1 s of window -> (1 s + 1 s slack) * 32 000 B/s = 64 000 B. The fake prints 200 000.
    const fake = fakeBinary('flood', `head -c 200000 /dev/zero`);
    const failure = await rejection(
      service(fake.path).decodePcm16kMono({ input: SIGNED, windows: [{ startMs: 0, endMs: 1000 }], timeoutMs: 10_000 }),
    );
    expect(failure).toBeInstanceOf(FfmpegError);
    expect(failure.message).not.toContain('SECRETSIGNATURE');
  });

  it('accepts output right up to the cap', async () => {
    const fake = fakeBinary('cap', `head -c 64000 /dev/zero`);
    const samples = await service(fake.path).decodePcm16kMono({ input: 'x', windows: [{ startMs: 0, endMs: 1000 }], timeoutMs: 10_000 });
    expect(samples).toHaveLength(32_000);
  });

  describe('a signed URL never appears in a thrown error', () => {
    const decode = (path: string, timeoutMs = 10_000) =>
      rejection(service(path).decodePcm16kMono({ input: SIGNED, windows: [{ startMs: 0, endMs: 1000 }], timeoutMs }));

    it('when ffmpeg exits non-zero and echoes the URL on stderr', async () => {
      const fake = fakeBinary('fails', `echo "Error opening input: ${SIGNED}: 403 Forbidden" >&2\nexit 1`);
      const failure = await decode(fake.path);
      expect(failure).toBeInstanceOf(FfmpegError);
      expect(failure.message).toContain('403 Forbidden');
      expect(failure.message).toContain('<url>');
      expect(failure.message).not.toContain('SECRETSIGNATURE');
      expect(failure.message).not.toContain('KEYID');
      expect(failure.message).not.toContain('store.example.test');
    });

    it('when ffmpeg dies silently (the node error message would be the whole command line)', async () => {
      const fake = fakeBinary('silent', 'exit 3');
      const failure = await decode(fake.path);
      expect(failure).toBeInstanceOf(FfmpegError);
      expect(failure.message).not.toContain('SECRETSIGNATURE');
      expect(failure.message).not.toContain('store.example.test');
    });

    it('when it runs out of time', async () => {
      const fake = fakeBinary('hang', 'sleep 30');
      const failure = await decode(fake.path, 300);
      expect(failure).toBeInstanceOf(FfmpegError);
      expect(failure.message).not.toContain('SECRETSIGNATURE');
      expect(failure.message).not.toContain('store.example.test');
    });

    it('when the binary is not installed', async () => {
      const failure = await decode(join(dir, 'does-not-exist'));
      expect(failure).toBeInstanceOf(FfmpegError);
      expect(failure.message).toContain('is not installed');
      expect(failure.message).not.toContain('SECRETSIGNATURE');
    });

    it('bounds what stderr contributes', async () => {
      const fake = fakeBinary('chatty', `head -c 20000 /dev/zero | tr '\\0' 'e' >&2\nexit 1`);
      const failure = await decode(fake.path);
      expect(failure.message.length).toBeLessThan(2200);
    });
  });
});

// -----------------------------------------------------------------------------
// A real ffmpeg
// -----------------------------------------------------------------------------

function ffmpegInstalled(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeWithFfmpeg = ffmpegInstalled() ? describe : describe.skip;

/** Zero crossings per second of a mono signal: a cheap pitch proxy for a pure tone. */
function crossingsPerSecond(samples: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i += 1) if ((samples[i - 1]! < 0) !== (samples[i]! < 0)) crossings += 1;
  return (crossings * 16_000) / (to - from);
}

describeWithFfmpeg('decodePcm16kMono (real ffmpeg, generated tone)', () => {
  let tone: string;
  const real = new FfmpegService();

  beforeAll(async () => {
    // 3 s of 440 Hz then 3 s of 880 Hz, at 44.1 kHz stereo: ffmpeg must resample and downmix.
    tone = join(dir, 'tone.wav');
    await execFileAsync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=44100',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3:sample_rate=44100',
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1,aformat=channel_layouts=stereo[out]',
      '-map', '[out]', tone,
    ]);
  });

  it('decodes the selected windows back to back at 16 kHz mono, in range', async () => {
    const samples = await real.decodePcm16kMono({
      input: tone,
      windows: [
        { startMs: 500, endMs: 1500 },
        { startMs: 4000, endMs: 5000 },
      ],
      timeoutMs: 30_000,
    });

    // 2 s at 16 kHz, within a few frames of window-edge rounding.
    expect(Math.abs(samples.length - 32_000)).toBeLessThan(1_600);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it('joins the windows in time order: the 440 Hz window first, then the 880 Hz one', async () => {
    const samples = await real.decodePcm16kMono({
      input: tone,
      windows: [
        { startMs: 500, endMs: 1500 },
        { startMs: 4000, endMs: 5000 },
      ],
      timeoutMs: 30_000,
    });
    const half = Math.floor(samples.length / 2);
    const low = crossingsPerSecond(samples, 800, half - 800);
    const high = crossingsPerSecond(samples, half + 800, samples.length - 800);

    // A pure tone crosses zero twice per cycle.
    expect(low).toBeGreaterThan(800);
    expect(low).toBeLessThan(960);
    expect(high).toBeGreaterThan(1650);
    expect(high).toBeLessThan(1850);
  });

  it('returns nothing for a window past the end of the recording', async () => {
    const samples = await real.decodePcm16kMono({ input: tone, windows: [{ startMs: 20_000, endMs: 21_000 }], timeoutMs: 30_000 });
    expect(samples).toHaveLength(0);
  });

  it('a failing real spawn names no signed URL', async () => {
    const failure = await rejection(
      real.decodePcm16kMono({
        input: 'http://127.0.0.1:9/rec.m4a?X-Amz-Signature=SECRETSIGNATURE',
        windows: [{ startMs: 0, endMs: 1000 }],
        timeoutMs: 30_000,
      }),
    );
    expect(failure).toBeInstanceOf(FfmpegError);
    expect(failure.message).not.toContain('SECRETSIGNATURE');
  });
});
