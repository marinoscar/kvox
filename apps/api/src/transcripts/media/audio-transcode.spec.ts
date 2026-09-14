import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import {
  DEFAULT_PLAYBACK_BITRATE_KBPS,
  ffmpegArgs,
  ffprobeArgs,
  parseFfprobe,
  planTranscode,
  REMUX_MAX_BITRATE_KBPS,
  RENDITION_MIME_TYPE,
  renditionFacts,
  renditionStorageKey,
  resolveTargetBitrateKbps,
  UnprobeableAudioError,
} from './audio-transcode';

// =============================================================================
// The playback rendition's decisions (issue #26)
// =============================================================================
//
// Every assertion here is about a rule that is made TWICE — once in this file
// and once, by hand, in `apps/cli/src/node/ffmpeg.ts` — so each one is also a
// written-down statement of what the CLI has to keep agreeing with.
// =============================================================================

const probe = (overrides: Partial<ReturnType<typeof baseProbe>> = {}) => ({
  ...baseProbe(),
  ...overrides,
});

function baseProbe() {
  return {
    durationMs: 60_000,
    codec: 'aac',
    channels: 1,
    bitrateKbps: 64,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  };
}

describe('parseFfprobe', () => {
  it('reads duration, codec, channels and bitrate from a real ffprobe document', () => {
    const raw = JSON.stringify({
      streams: [
        { codec_name: 'AAC', channels: 2, bit_rate: '128000', duration: '75.264000' },
      ],
      format: { format_name: 'mov,mp4,m4a', bit_rate: '130000', duration: '75.3' },
    });

    expect(parseFfprobe(raw)).toEqual({
      durationMs: 75_264,
      // Lower-cased, because the remux rule compares against `aac` and a
      // container that spelled it `AAC` would silently be re-encoded.
      codec: 'aac',
      channels: 2,
      bitrateKbps: 128,
      formatName: 'mov,mp4,m4a',
    });
  });

  it('falls back to the CONTAINER duration and bitrate when the stream declares none', () => {
    // A raw WAV is the everyday case: `ffprobe` reports no per-stream bitrate
    // for PCM, and reading that absence as zero would make the output's
    // reported bitrate a lie.
    const raw = JSON.stringify({
      streams: [{ codec_name: 'pcm_s16le', channels: 1 }],
      format: { format_name: 'wav', bit_rate: '256000', duration: '12.5' },
    });

    expect(parseFfprobe(raw)).toMatchObject({
      durationMs: 12_500,
      codec: 'pcm_s16le',
      bitrateKbps: 256,
    });
  });

  it('reads a missing duration as zero rather than NaN', () => {
    const raw = JSON.stringify({
      streams: [{ codec_name: 'opus', channels: 1 }],
      format: { format_name: 'ogg' },
    });

    expect(parseFfprobe(raw)).toMatchObject({ durationMs: 0, bitrateKbps: 0 });
  });

  it('refuses a document with no audio stream', () => {
    // Permanent property of the upload — a video with no soundtrack, or a file
    // that is not media at all. Failing here beats handing ffmpeg a `0:a:0`
    // mapping it will reject with a message nobody reads.
    const raw = JSON.stringify({ streams: [], format: { format_name: 'mp4' } });

    expect(() => parseFfprobe(raw)).toThrow(UnprobeableAudioError);
  });

  it('refuses output that is not JSON at all', () => {
    expect(() => parseFfprobe('ffprobe version 6.1.1\n')).toThrow(UnprobeableAudioError);
  });
});

describe('resolveTargetBitrateKbps', () => {
  it('matches the shipped default when nothing is configured', () => {
    // ⚠ THE DUPLICATION GUARD. This constant is repeated in this module (to
    // keep it free of the settings graph) and again in the CLI. If the shipped
    // default moves and this does not, every transcode quietly encodes at the
    // old rate.
    expect(DEFAULT_PLAYBACK_BITRATE_KBPS).toBe(
      DEFAULT_SYSTEM_SETTINGS.transcription.playback.bitrateKbps,
    );
    expect(resolveTargetBitrateKbps(undefined)).toBe(DEFAULT_PLAYBACK_BITRATE_KBPS);
    expect(resolveTargetBitrateKbps(null)).toBe(DEFAULT_PLAYBACK_BITRATE_KBPS);
    expect(resolveTargetBitrateKbps('nonsense')).toBe(DEFAULT_PLAYBACK_BITRATE_KBPS);
  });

  it('clamps to the range the settings schema allows instead of refusing', () => {
    expect(resolveTargetBitrateKbps(4)).toBe(16);
    expect(resolveTargetBitrateKbps(10_000)).toBe(320);
    expect(resolveTargetBitrateKbps(96)).toBe(96);
  });
});

describe('planTranscode', () => {
  it('remuxes AAC in an MP4 at or under the ceiling', () => {
    expect(planTranscode(probe({ bitrateKbps: REMUX_MAX_BITRATE_KBPS }), 64)).toEqual({
      remux: true,
      bitrateKbps: 64,
    });
  });

  it('re-encodes AAC above the ceiling', () => {
    expect(planTranscode(probe({ bitrateKbps: 192 }), 64).remux).toBe(false);
  });

  it('re-encodes a non-AAC codec however small it is', () => {
    expect(planTranscode(probe({ codec: 'opus', bitrateKbps: 32 }), 64).remux).toBe(false);
  });

  it('re-encodes AAC that is not in an MP4 container', () => {
    // Bare ADTS `.aac` plays in fewer places and cannot carry a `moov` atom at
    // all, so "already AAC" is not on its own a reason to copy it.
    expect(planTranscode(probe({ formatName: 'aac' }), 64).remux).toBe(false);
  });

  it('re-encodes when the bitrate is UNKNOWN rather than assuming it is small', () => {
    // Zero means "ffprobe did not say", not "tiny". Copying on a missing field
    // would pass a 320 kbit/s stereo master straight through.
    expect(planTranscode(probe({ bitrateKbps: 0 }), 64).remux).toBe(false);
  });
});

describe('renditionFacts', () => {
  it('describes a REMUX with the input stream, not the deployment target', () => {
    const input = probe({ channels: 2, bitrateKbps: 112 });

    expect(renditionFacts(input, { remux: true, bitrateKbps: 64 })).toEqual({
      codec: 'aac',
      channels: 2,
      bitrateKbps: 112,
    });
  });

  it('describes a RE-ENCODE as mono AAC at the target', () => {
    const input = probe({ codec: 'pcm_s16le', channels: 2, bitrateKbps: 1411 });

    expect(renditionFacts(input, { remux: false, bitrateKbps: 96 })).toEqual({
      codec: 'aac',
      channels: 1,
      bitrateKbps: 96,
    });
  });
});

describe('ffprobeArgs', () => {
  it('asks for JSON about the first audio stream, with the input last', () => {
    const args = ffprobeArgs('https://bucket.example/obj?X-Amz-Signature=abc&x=1');

    expect(args).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-select_streams',
      'a:0',
      'https://bucket.example/obj?X-Amz-Signature=abc&x=1',
    ]);
  });
});

describe('ffmpegArgs', () => {
  it('re-encodes to mono AAC with faststart', () => {
    const args = ffmpegArgs({
      input: 'in.wav',
      output: 'out.m4a',
      plan: { remux: false, bitrateKbps: 96 },
    });

    expect(args).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      'in.wav',
      '-vn',
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      'out.m4a',
    ]);
  });

  it('copies the stream for a remux and still moves the moov atom', () => {
    const args = ffmpegArgs({
      input: 'in.m4a',
      output: 'out.m4a',
      plan: { remux: true, bitrateKbps: 64 },
    });

    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
    expect(args).not.toContain('-b:a');
    // Seekability is the requirement even when nothing is re-encoded: a
    // perfectly good AAC file with `moov` at the end cannot be scrubbed.
    expect(args.join(' ')).toContain('-movflags +faststart');
  });

  it('never lets a URL reach a shell — the input is one argv entry', () => {
    const url = 'https://bucket.example/o?a=1&b=2;rm -rf /';
    const args = ffmpegArgs({ input: url, output: 'o.m4a', plan: { remux: false, bitrateKbps: 64 } });

    expect(args.filter((arg) => arg === url)).toHaveLength(1);
  });
});

describe('renditionStorageKey', () => {
  it('lives under the transcript prefix so `transcript.purge` sweeps it', () => {
    expect(renditionStorageKey('t-1', 'j-9')).toBe('transcripts/t-1/renditions/j-9.m4a');
  });

  it('is idempotent per job, which is what `deriveOutputKey` requires', () => {
    expect(renditionStorageKey('t-1', 'j-9')).toBe(renditionStorageKey('t-1', 'j-9'));
  });

  it('announces the container the MIME type promises', () => {
    expect(RENDITION_MIME_TYPE).toBe('audio/mp4');
    expect(renditionStorageKey('t', 'j').endsWith('.m4a')).toBe(true);
  });
});
