// =============================================================================
// Kaldi-compatible log-mel filterbank for the voiceprint model (issue #823)
// =============================================================================
//
// Matches kaldi-native-fbank as sherpa-onnx configures it for speaker
// embeddings: 16 kHz, 25 ms window / 10 ms shift, povey window, preemphasis
// 0.97, remove DC offset, dither 0, snip_edges=false, 80 mel bins, low 20 Hz,
// high -400 (7600 Hz), power spectrum, natural log. Validated against
// kaldi-native-fbank (max abs difference about 7e-5; the spec pins < 1e-3 on a
// synthetic fixture). Dependency-free.
//
// CAM++ takes samples in [-1, 1] (normalize_samples = 1: NO 32768 scaling) and
// global-mean cepstral normalisation (`subtractGlobalMean`).
// =============================================================================

const SR = 16000;
const FLEN = 400;
const FSHIFT = 160;
const NFFT = 512;
const NBINS = 80;
const LOW = 20;
const HIGH = SR / 2 - 400;
const EPS = 1.1920928955078125e-7; // FLT_EPSILON, Kaldi's log floor

/**
 * Filterbank features: `numFrames` rows of `dim` values, row-major.
 *
 * @stability experimental
 */
export interface Fbank {
  /** The features, `numFrames * dim` values, row-major. */
  feats: Float32Array;
  /** The number of frames. */
  numFrames: number;
  /** The values per frame (80 mel bins). */
  dim: number;
}

/**
 * What {@link computeFbank} takes.
 *
 * @stability experimental
 */
export interface FbankOptions {
  /** Multiply samples by 32768 first (Kaldi `normalize_samples = 0`). CAM++ does not: default false. */
  scale32768?: boolean;
}

const window = new Float64Array(FLEN);
for (let i = 0; i < FLEN; i += 1) window[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FLEN - 1)), 0.85);

const mel = (f: number): number => 1127 * Math.log(1 + f / 700);

const melBanks: { first: number; w: Float64Array }[] = (() => {
  const nfftBins = NFFT / 2;
  const fftBinWidth = SR / NFFT;
  const melLow = mel(LOW);
  const melHigh = mel(HIGH);
  const delta = (melHigh - melLow) / (NBINS + 1);
  const banks: { first: number; w: Float64Array }[] = [];
  for (let b = 0; b < NBINS; b += 1) {
    const l = melLow + b * delta;
    const c = l + delta;
    const r = c + delta;
    let first = -1;
    const w: number[] = [];
    for (let i = 0; i < nfftBins; i += 1) {
      const m = mel(fftBinWidth * i);
      if (m > l && m < r) {
        const v = m <= c ? (m - l) / (c - l) : (r - m) / (r - c);
        if (first < 0) first = i;
        w.push(v);
      }
    }
    banks.push({ first, w: Float64Array.from(w) });
  }
  return banks;
})();

// Radix-2 FFT of size NFFT (the real signal is the real part of a complex input).
const cosT = new Float64Array(NFFT / 2);
const sinT = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i += 1) {
  cosT[i] = Math.cos((2 * Math.PI * i) / NFFT);
  sinT[i] = -Math.sin((2 * Math.PI * i) / NFFT);
}
const rev = new Uint16Array(NFFT);
for (let i = 0, j = 0; i < NFFT; i += 1) {
  rev[i] = j;
  let bit = NFFT >> 1;
  while (j & bit) {
    j ^= bit;
    bit >>= 1;
  }
  j |= bit;
}

function powerSpectrum(frame: Float64Array, re: Float64Array, im: Float64Array, out: Float64Array): void {
  for (let i = 0; i < NFFT; i += 1) {
    re[rev[i] as number] = i < FLEN ? (frame[i] as number) : 0;
    im[rev[i] as number] = 0;
  }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1;
    const step = NFFT / size;
    for (let s = 0; s < NFFT; s += size) {
      for (let k = 0; k < half; k += 1) {
        const a = s + k;
        const b = a + half;
        const c = cosT[k * step] as number;
        const d = sinT[k * step] as number;
        const tr = (re[b] as number) * c - (im[b] as number) * d;
        const ti = (re[b] as number) * d + (im[b] as number) * c;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
    }
  }
  for (let i = 0; i <= NFFT / 2; i += 1) out[i] = (re[i] as number) ** 2 + (im[i] as number) ** 2;
}

/**
 * Computes the 80-bin Kaldi log-mel filterbank of 16 kHz mono audio.
 *
 * @param samples - 16 kHz mono samples in [-1, 1].
 * @param opts - `scale32768` for models trained on int16-scaled input (not CAM++).
 * @returns the features (`numFrames` is `floor((n + 80) / 160)`, edges reflected, so 0 for empty input).
 *
 * @stability experimental
 */
export function computeFbank(samples: Float32Array, opts: FbankOptions = {}): Fbank {
  const n = samples.length;
  const numFrames = Math.floor((n + FSHIFT / 2) / FSHIFT);
  const feats = new Float32Array(numFrames * NBINS);
  const frame = new Float64Array(FLEN);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const pw = new Float64Array(NFFT / 2 + 1);
  const k = opts.scale32768 ? 32768 : 1;
  for (let f = 0; f < numFrames; f += 1) {
    const start = f * FSHIFT + FSHIFT / 2 - FLEN / 2;
    for (let i = 0; i < FLEN; i += 1) {
      let s = start + i;
      while (s < 0 || s >= n) s = s < 0 ? -s - 1 : 2 * n - 1 - s; // Kaldi reflection
      frame[i] = (samples[s] as number) * k;
    }
    let mean = 0;
    for (let i = 0; i < FLEN; i += 1) mean += frame[i] as number;
    mean /= FLEN;
    for (let i = 0; i < FLEN; i += 1) frame[i] = (frame[i] as number) - mean;
    for (let i = FLEN - 1; i > 0; i -= 1) frame[i] = (frame[i] as number) - 0.97 * (frame[i - 1] as number);
    frame[0] = (frame[0] as number) - 0.97 * (frame[0] as number);
    for (let i = 0; i < FLEN; i += 1) frame[i] = (frame[i] as number) * (window[i] as number);
    powerSpectrum(frame, re, im, pw);
    for (let b = 0; b < NBINS; b += 1) {
      const { first, w } = melBanks[b] as { first: number; w: Float64Array };
      let e = 0;
      for (let j = 0; j < w.length; j += 1) e += (w[j] as number) * (pw[first + j] as number);
      feats[f * NBINS + b] = Math.log(Math.max(e, EPS));
    }
  }
  return { feats, numFrames, dim: NBINS };
}

/**
 * Subtracts each dimension's mean over all frames, in place (global-mean CMN).
 *
 * @param fbank - the features; modified.
 * @returns the same object.
 *
 * @stability experimental
 */
export function subtractGlobalMean(fbank: Fbank): Fbank {
  const { feats, numFrames, dim } = fbank;
  if (numFrames === 0) return fbank;
  const m = new Float64Array(dim);
  for (let f = 0; f < numFrames; f += 1) for (let d = 0; d < dim; d += 1) m[d] = (m[d] as number) + (feats[f * dim + d] as number);
  for (let d = 0; d < dim; d += 1) m[d] = (m[d] as number) / numFrames;
  for (let f = 0; f < numFrames; f += 1) for (let d = 0; d < dim; d += 1) feats[f * dim + d] = (feats[f * dim + d] as number) - (m[d] as number);
  return fbank;
}
