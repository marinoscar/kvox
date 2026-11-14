import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

import { computeFbank, subtractGlobalMean } from './fbank.js';
import { VOICEPRINT_DIMENSIONS, VOICEPRINT_MANIFEST, VOICEPRINT_SAMPLE_RATE } from './voiceprint-files.js';

// =============================================================================
// The on-device voiceprint embedder: onnxruntime-web (WASM) (issue #823)
// =============================================================================
//
// ⚠ BLOCKING. `session.run` executes the model on the calling thread and holds
// the event loop for its whole duration: about 4 s of CPU per 60 s of audio.
// RUN THIS OFF THE EVENT LOOP: use `createThreadedVoiceprintEmbedder`
// (`voiceprint-thread.ts`), a child process, or a dedicated utility process.
//
// Pipeline (CAM++): 16 kHz mono samples in [-1, 1] -> Kaldi 80-bin fbank (no
// 32768 scaling) -> global-mean normalisation -> session (`x`: float32
// [1, T, 80]) -> `embedding` [1, 512] -> L2-normalise.
//
// `onnxruntime-web` is an OPTIONAL peer, loaded lazily with `require` so that
// importing this entry costs nothing and a host that never fingerprints voices
// never installs it. The WASM binary is read with `fs` and handed to the
// runtime, so it works from inside an Electron `app.asar`.
//
// A voiceprint is biometric data. Nothing in this package transmits audio or
// vectors anywhere.
// =============================================================================

/**
 * The shortest audio accepted, in milliseconds.
 *
 * @stability experimental
 */
export const VOICEPRINT_MIN_AUDIO_MS = 500;

/**
 * Why audio was refused.
 *
 * @stability experimental
 */
export type VoiceprintAudioErrorCode = 'too_short' | 'invalid_samples';

/**
 * The typed error {@link VoiceprintEmbedder.embed} throws for audio it cannot use.
 *
 * @stability experimental
 */
export class VoiceprintAudioError extends Error {
  /** What is wrong with the audio. */
  readonly code: VoiceprintAudioErrorCode;

  constructor(code: VoiceprintAudioErrorCode, message: string) {
    super(message);
    this.name = 'VoiceprintAudioError';
    this.code = code;
  }
}

/**
 * What {@link createVoiceprintEmbedder} returns.
 *
 * @stability experimental
 */
export interface VoiceprintEmbedder {
  /** The model id (permanent once vectors are stored). */
  readonly model: string;
  /** The vector width. */
  readonly dimensions: 512;
  /**
   * Embeds 16 kHz mono audio in [-1, 1] into one unit-length 512-wide vector.
   * BLOCKS the event loop while the model runs; call it off the event loop.
   * Calls are serialised.
   *
   * @throws VoiceprintAudioError when the audio is shorter than 0.5 s or holds a non-finite sample.
   */
  embed(samples: Float32Array): Promise<Float32Array>;
  /** Releases the model. The embedder cannot be used afterwards. */
  dispose(): Promise<void>;
}

/**
 * What {@link createVoiceprintEmbedder} takes.
 *
 * @stability experimental
 */
export interface CreateVoiceprintEmbedderOptions {
  /** The installed model directory (`downloadVoiceprintModel(...).path`); it holds `model.onnx`. */
  modelPath: string;
  /** WASM threads. Default 1. */
  numThreads?: number;
}

/**
 * The part of an `onnxruntime-web` tensor constructor this module uses.
 *
 * @stability experimental
 */
export interface VoiceprintTensorCtor {
  new (type: 'float32', data: Float32Array, dims: number[]): unknown;
}

/**
 * One session output tensor.
 *
 * @stability experimental
 */
export interface VoiceprintOutput {
  /** The flattened values. */
  data: ArrayLike<number>;
  /** The shape. */
  dims: readonly number[];
}

/**
 * The part of an `onnxruntime-web` session this module uses.
 *
 * @stability experimental
 */
export interface VoiceprintSession {
  /**
   * Runs the model.
   *
   * @param feeds - the `x` tensor, float32 `[1, T, 80]`.
   * @returns the named outputs; `embedding` is `[1, 512]`.
   */
  run(feeds: Record<string, unknown>): Promise<Record<string, VoiceprintOutput>>;
  /** Frees the model's memory. */
  release?(): Promise<void> | void;
}

/**
 * Everything the embedding maths needs, so a test can supply fakes.
 *
 * @stability experimental
 */
export interface VoiceprintEmbedderParts {
  /** The loaded model session. */
  session: VoiceprintSession;
  /** The runtime's tensor constructor. */
  Tensor: VoiceprintTensorCtor;
}

/**
 * The embedder over already-loaded parts. {@link createVoiceprintEmbedder}
 * loads the real ones; tests pass fakes.
 *
 * @param parts - the session and tensor constructor.
 * @param model - the model id to report.
 * @returns the embedder.
 *
 * @stability experimental
 */
export function createVoiceprintEmbedderFromParts(parts: VoiceprintEmbedderParts, model: string): VoiceprintEmbedder {
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const run = async (samples: Float32Array): Promise<Float32Array> => {
    if (disposed) throw new Error('The voiceprint embedder was disposed.');
    if (samples.length < (VOICEPRINT_SAMPLE_RATE * VOICEPRINT_MIN_AUDIO_MS) / 1000) {
      throw new VoiceprintAudioError('too_short', `Voiceprint audio must be at least ${VOICEPRINT_MIN_AUDIO_MS} ms.`);
    }
    for (let i = 0; i < samples.length; i += 1) {
      if (!Number.isFinite(samples[i])) throw new VoiceprintAudioError('invalid_samples', 'Voiceprint audio holds a non-finite sample.');
    }
    const fb = subtractGlobalMean(computeFbank(samples));
    const result = await parts.session.run({ x: new parts.Tensor('float32', fb.feats, [1, fb.numFrames, fb.dim]) });
    const out = result.embedding;
    if (!out) throw new Error('The voiceprint model returned no embedding.');
    const width = out.dims[out.dims.length - 1] as number;
    if (width !== VOICEPRINT_DIMENSIONS) {
      throw new Error(`The voiceprint model is ${width} wide, expected ${VOICEPRINT_DIMENSIONS}.`);
    }
    const v = new Float32Array(width);
    let sum = 0;
    for (let i = 0; i < width; i += 1) {
      const x = out.data[i] as number;
      v[i] = x;
      sum += x * x;
    }
    const norm = Math.sqrt(sum);
    if (norm > 0) for (let i = 0; i < width; i += 1) v[i] = (v[i] as number) / norm;
    return v;
  };

  return {
    model,
    dimensions: 512,
    embed(samples) {
      const next = chain.then(() => run(samples));
      chain = next.catch(() => undefined);
      return next;
    },
    async dispose() {
      disposed = true;
      await chain;
      await parts.session.release?.();
    },
  };
}

/**
 * Loads the model and returns an embedder. See the file header: the embedder
 * BLOCKS the event loop; run it off the event loop.
 *
 * @param o - the installed model directory and optional thread count.
 * @returns the embedder.
 * @throws Error when `onnxruntime-web` is not installed or `model.onnx` is missing.
 *
 * @stability experimental
 */
export async function createVoiceprintEmbedder(o: CreateVoiceprintEmbedderOptions): Promise<VoiceprintEmbedder> {
  const ort = requirePeer('onnxruntime-web') as OrtModule;
  const wasmDist = dirname(require.resolve('onnxruntime-web'));
  ort.env.wasm.numThreads = o.numThreads ?? 1;
  ort.env.wasm.proxy = false;
  // Read through fs, never by URL: works from inside an Electron app.asar.
  ort.env.wasm.wasmBinary = fs.readFileSync(join(wasmDist, 'ort-wasm-simd-threaded.wasm'));

  const session = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(join(o.modelPath, 'model.onnx'))), {
    executionProviders: ['wasm'],
  });
  return createVoiceprintEmbedderFromParts({ session, Tensor: ort.Tensor }, VOICEPRINT_MANIFEST.model);
}

interface OrtModule {
  env: { wasm: { numThreads: number; proxy: boolean; wasmBinary: unknown } };
  InferenceSession: { create(model: Uint8Array, options?: unknown): Promise<VoiceprintSession> };
  Tensor: VoiceprintTensorCtor;
}

function requirePeer(name: string): unknown {
  try {
    return require(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `Voiceprints need the optional package "${name}". Install it next to @marinoscar/kvox-ai (npm install ${name}).`,
      );
    }
    throw err;
  }
}
