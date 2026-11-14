import { createVoiceprintEmbedderFromParts, VoiceprintAudioError, type VoiceprintEmbedderParts } from './voiceprint-embedder.js';

interface Call {
  dims: number[];
  length: number;
}

function fakeParts(calls: Call[], opts: { width?: number; omit?: boolean } = {}): VoiceprintEmbedderParts & { released: boolean } {
  class Tensor {
    constructor(public type: string, public data: Float32Array, public dims: number[]) {}
  }
  const parts = {
    released: false,
    Tensor: Tensor as never,
    session: {
      async run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number>; dims: readonly number[] }>> {
        const x = feeds.x as Tensor;
        calls.push({ dims: x.dims, length: x.data.length });
        if (opts.omit) return {};
        const width = opts.width ?? 512;
        const data = new Float32Array(width);
        data[0] = 3;
        data[1] = 4; // length 5 before normalisation
        return { embedding: { data, dims: [1, width] } };
      },
      release() {
        parts.released = true;
      },
    },
  };
  return parts;
}

const audio = (seconds: number): Float32Array => Float32Array.from({ length: Math.round(16000 * seconds) }, (_, i) => 0.2 * Math.sin(i / 9));

describe('createVoiceprintEmbedderFromParts', () => {
  it('feeds [1, T, 80] float32 features as `x` and returns a unit vector', async () => {
    const calls: Call[] = [];
    const e = createVoiceprintEmbedderFromParts(fakeParts(calls), 'campplus-en-voxceleb-16k');
    expect(e.model).toBe('campplus-en-voxceleb-16k');
    expect(e.dimensions).toBe(512);
    const v = await e.embed(audio(1));
    expect(calls[0]!.dims).toEqual([1, 100, 80]);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v).toHaveLength(512);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    expect(Math.hypot(...v)).toBeCloseTo(1);
  });

  it('rejects audio shorter than 0.5 s with a typed error, accepts exactly 0.5 s', async () => {
    const e = createVoiceprintEmbedderFromParts(fakeParts([]), 'm');
    const err = await e.embed(new Float32Array(7999)).catch((x) => x);
    expect(err).toBeInstanceOf(VoiceprintAudioError);
    expect(err.code).toBe('too_short');
    await expect(e.embed(new Float32Array(8000))).resolves.toHaveLength(512);
  });

  it('rejects a non-finite sample', async () => {
    const e = createVoiceprintEmbedderFromParts(fakeParts([]), 'm');
    const x = audio(1);
    x[5] = Number.NaN;
    const err = await e.embed(x).catch((r) => r);
    expect(err.code).toBe('invalid_samples');
  });

  it('serialises calls', async () => {
    let active = 0;
    let maxActive = 0;
    const parts = fakeParts([]);
    const run = parts.session.run.bind(parts.session);
    parts.session.run = async (f) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      const r = await run(f);
      active -= 1;
      return r;
    };
    const e = createVoiceprintEmbedderFromParts(parts, 'm');
    await Promise.all([e.embed(audio(1)), e.embed(audio(1)), e.embed(audio(1))]);
    expect(maxActive).toBe(1);
  });

  it('rejects a model of the wrong width or with no embedding output', async () => {
    await expect(createVoiceprintEmbedderFromParts(fakeParts([], { width: 192 }), 'm').embed(audio(1))).rejects.toThrow(/192 wide/);
    await expect(createVoiceprintEmbedderFromParts(fakeParts([], { omit: true }), 'm').embed(audio(1))).rejects.toThrow(/no embedding/);
  });

  it('releases the session on dispose and refuses later calls', async () => {
    const parts = fakeParts([]);
    const e = createVoiceprintEmbedderFromParts(parts, 'm');
    await e.dispose();
    expect(parts.released).toBe(true);
    await expect(e.embed(audio(1))).rejects.toThrow(/disposed/);
  });
});
