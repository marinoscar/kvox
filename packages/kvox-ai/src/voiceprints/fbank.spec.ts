import { computeFbank, subtractGlobalMean } from './fbank.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/voiceprint-fbank-reference.v1.json'), 'utf8')) as {
  samplesInt16: number[];
  numFrames: number;
  dim: number;
  frames: number[][];
};

describe('computeFbank', () => {
  it('matches the kaldi-native-fbank reference on a synthetic signal', () => {
    const x = Float32Array.from(fixture.samplesInt16, (s: number) => s / 32768);
    const fb = computeFbank(x, { scale32768: false });
    expect(fb.numFrames).toBe(fixture.numFrames);
    expect(fb.dim).toBe(fixture.dim);
    let max = 0;
    for (let f = 0; f < fixture.numFrames; f += 1) {
      for (let d = 0; d < fixture.dim; d += 1) {
        max = Math.max(max, Math.abs((fb.feats[f * fixture.dim + d] as number) - (fixture.frames[f] as number[])[d]!));
      }
    }
    expect(max).toBeLessThan(1e-3);
  });

  it('adds exactly 2 ln(32768) to every log-power value with scale32768', () => {
    const x = Float32Array.from(fixture.samplesInt16.slice(0, 1600), (s: number) => s / 32768);
    const a = computeFbank(x);
    const b = computeFbank(x, { scale32768: true });
    expect((b.feats[10] as number) - (a.feats[10] as number)).toBeCloseTo(2 * Math.log(32768), 3);
  });

  it('gives floor((n + 80) / 160) frames and none for empty input', () => {
    expect(computeFbank(new Float32Array(16000)).numFrames).toBe(100);
    expect(computeFbank(new Float32Array(0)).numFrames).toBe(0);
  });
});

describe('subtractGlobalMean', () => {
  it('leaves every dimension with a zero mean, in place', () => {
    const x = Float32Array.from({ length: 8000 }, (_, i) => 0.3 * Math.sin(i / 7));
    const fb = computeFbank(x);
    expect(subtractGlobalMean(fb)).toBe(fb);
    for (let d = 0; d < fb.dim; d += 1) {
      let m = 0;
      for (let f = 0; f < fb.numFrames; f += 1) m += fb.feats[f * fb.dim + d] as number;
      expect(Math.abs(m / fb.numFrames)).toBeLessThan(1e-4);
    }
  });
});
