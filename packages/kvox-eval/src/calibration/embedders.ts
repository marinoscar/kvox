// =============================================================================
// Where calibration vectors come from (issue #681)
// =============================================================================
//
// No network and no model are needed to RUN the harness:
//
//   recordedVectors   a JSON file of `{ model, vectors: { <text>: number[] } }` that a host
//                     recorded with its real embedder (`kvox-eval calibrate --dump-texts`
//                     lists the texts to embed). This is how a catalog model is measured.
//   hashedNgramVectors  a deterministic stand-in: character trigrams hashed into a fixed
//                     width. NOT a semantic model; it is the harness's self-test and what
//                     the package's specs run on. `anisotropy` lifts every cosine towards 1
//                     the way a bge-style model's shared direction does, so the tests can
//                     show the recommended cut-offs follow the model's baseline.
// =============================================================================

import { readFileSync } from 'fs';

import { z } from 'zod';

import { normalizeForMatch } from './internals.js';
import { CalibrationSetError } from './calibration-set.js';

/**
 * One vector per text.
 *
 * @stability experimental
 */
export type VectorTable = ReadonlyMap<string, readonly number[]>;

const recordedSchema = z.object({
  model: z.string().min(1),
  dimensions: z.number().int().positive().optional(),
  vectors: z.record(z.string(), z.array(z.number().finite())),
});

/**
 * Reads vectors a host recorded with its own embedder.
 *
 * @param file - JSON `{ "model": "<id>", "vectors": { "<text>": [..] } }`.
 * @returns the model id and the vectors.
 * @throws {@link CalibrationSetError} on unreadable or malformed JSON.
 * @stability experimental
 */
export function recordedVectors(file: string): { model: string; vectors: VectorTable } {
  try {
    const parsed = recordedSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    return { model: parsed.model, vectors: new Map(Object.entries(parsed.vectors)) };
  } catch (error) {
    throw new CalibrationSetError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** FNV-1a, 32 bit. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Options of {@link hashedNgramVectors}.
 *
 * @stability experimental
 */
export interface HashedNgramOptions {
  /** Vector width (default 384). */
  dimensions?: number;
  /**
   * 0 (default) or more: the weight of one direction shared by every text. Raises the cosine of
   * unrelated texts the way a high-baseline model does; 0 is an isotropic stand-in.
   */
  anisotropy?: number;
}

/**
 * Deterministic stand-in vectors: signed character-trigram hashing, L2-normalized. Lexically close
 * texts get close vectors; there is no semantics in them.
 *
 * @param texts - the texts.
 * @param options - width and shared-direction weight.
 * @returns a vector per text.
 * @stability experimental
 */
export function hashedNgramVectors(texts: readonly string[], options: HashedNgramOptions = {}): VectorTable {
  const dimensions = options.dimensions ?? 384;
  const anisotropy = options.anisotropy ?? 0;
  const out = new Map<string, number[]>();
  for (const text of texts) {
    const v = new Array<number>(dimensions).fill(0);
    const padded = `  ${normalizeForMatch(text)} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      const h = fnv1a(padded.slice(i, i + 3));
      v[h % dimensions] += (h >>> 16) % 2 === 0 ? 1 : -1;
    }
    const norm = Math.hypot(...v) || 1;
    for (let i = 0; i < dimensions; i += 1) v[i] /= norm;
    if (anisotropy > 0) {
      // A fixed unit direction (the first axis), added with weight `anisotropy`, then renormalized.
      v[0] += anisotropy;
      const lifted = Math.hypot(...v) || 1;
      for (let i = 0; i < dimensions; i += 1) v[i] /= lifted;
    }
    out.set(text, v);
  }
  return out;
}
