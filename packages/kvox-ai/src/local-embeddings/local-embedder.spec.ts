import {
  clsPoolNormalize,
  createEmbedderFromParts,
  type EmbedderParts,
  truncateKeepingSep,
} from './local-embedder.js';

const CLS = 101;
const SEP = 102;

/** A fake model: hidden state of token t at position p is [t, p, 0...]; width 384. */
function fakeParts(calls: { dims: number[]; ids: bigint[]; mask: bigint[] }[]): EmbedderParts {
  class Tensor {
    constructor(public type: string, public data: BigInt64Array, public dims: number[]) {}
  }
  return {
    Tensor: Tensor as never,
    tokenizer: {
      encode: (text: string) => ({ ids: [CLS, ...Array.from(text, (c) => c.charCodeAt(0)), SEP] }),
    },
    session: {
      async run(feeds) {
        const ids = feeds.input_ids as Tensor;
        const mask = feeds.attention_mask as Tensor;
        calls.push({ dims: ids.dims, ids: Array.from(ids.data), mask: Array.from(mask.data) });
        const [n, seq] = ids.dims as [number, number];
        const data = new Float32Array(n * seq * 384);
        for (let b = 0; b < n; b += 1) {
          for (let p = 0; p < seq; p += 1) {
            data[(b * seq + p) * 384] = Number(ids.data[b * seq + p]);
            data[(b * seq + p) * 384 + 1] = p === 0 ? 3 : 100; // only CLS (p=0) may matter
          }
        }
        return { last_hidden_state: { data, dims: [n, seq, 384] } };
      },
    },
  };
}

describe('truncateKeepingSep', () => {
  it('leaves short input alone and keeps the final SEP when cutting', () => {
    expect(truncateKeepingSep([CLS, 5, SEP], 512)).toEqual([CLS, 5, SEP]);
    const long = [CLS, ...Array.from({ length: 700 }, (_, i) => 1000 + i), SEP];
    const cut = truncateKeepingSep(long);
    expect(cut).toHaveLength(512);
    expect(cut[0]).toBe(CLS);
    expect(cut[511]).toBe(SEP);
    expect(cut[510]).toBe(1000 + 509);
  });
});

describe('clsPoolNormalize', () => {
  it('takes token 0 and L2-normalises; a zero vector stays zero', () => {
    const data = [3, 4, 0, 9, 9, 9, 0, 0, 0, 7, 7, 7]; // batch 2, seq 2, hidden 3? use hidden 3 -> 12 numbers
    const [a, b] = clsPoolNormalize(data, 2, 2, 3);
    expect(a).toEqual([3 / 5, 4 / 5, 0]);
    expect(b).toEqual([0, 0, 0]);
  });
});

describe('createEmbedderFromParts', () => {
  it('pads with mask 0, truncates to 512 keeping SEP, CLS-pools and normalises', async () => {
    const calls: { dims: number[]; ids: bigint[]; mask: bigint[] }[] = [];
    const e = createEmbedderFromParts(fakeParts(calls), 'm');
    const vectors = await e.embed(['ab', 'x'.repeat(600), '']);
    expect(e.dimensions).toBe(384);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.dims).toEqual([3, 512]);
    // row 1 (long): last real token is SEP at 511
    expect(calls[0]!.ids[512 + 511]).toBe(BigInt(SEP));
    expect(calls[0]!.mask.slice(512, 1024).every((m) => m === 1n)).toBe(true);
    // row 0 ('ab' = CLS a b SEP): 4 real tokens then padding
    expect(calls[0]!.mask.slice(0, 6)).toEqual([1n, 1n, 1n, 1n, 0n, 0n]);
    expect(calls[0]!.ids[4]).toBe(0n);
    // empty string works: CLS SEP
    expect(calls[0]!.mask.slice(1024, 1027)).toEqual([1n, 1n, 0n]);
    for (const v of vectors) {
      expect(v).toHaveLength(384);
      expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    }
    // CLS value [101, 3] normalised
    expect(vectors[0]![0]).toBeCloseTo(101 / Math.hypot(101, 3), 6);
  });

  it('runs batches of at most 32 and keeps order; serialises calls; refuses after dispose', async () => {
    const calls: { dims: number[]; ids: bigint[]; mask: bigint[] }[] = [];
    const e = createEmbedderFromParts(fakeParts(calls), 'm');
    const out = await Promise.all([e.embed(Array.from({ length: 40 }, () => 'a')), e.embed(['b'])]);
    expect(out[0]).toHaveLength(40);
    expect(out[1]).toHaveLength(1);
    expect(calls.map((c) => c.dims[0])).toEqual([32, 8, 1]);
    await e.dispose();
    await expect(e.embed(['a'])).rejects.toThrow('disposed');
  });
});
