// =============================================================================
// Seeded RNG for the whole-graph layout (#371, epic #347; docs/specs/ontology.md §22)
// =============================================================================
//
// Louvain shuffles its visiting order and the random layout scatters initial
// positions — both through an injected `rng`. Feeding them `Math.random` would
// make the overview reshuffle on every recompute of an unchanged graph, which
// is one of the two reasons spec §22.3 rejects client-side layout. A seeded
// generator makes "the same graph yields the same picture" a property of the
// code, and `compute-layout.spec.ts` pins it.
//
// PURE: no clock, no global state. `mulberry32` is the well-known 32-bit
// generator (public domain, Tommy Ettinger) — tiny, fast, and good enough for
// shuffling and scattering; this is not a cryptographic use.
// =============================================================================

import { createHash } from 'node:crypto';

/** A `Math.random`-shaped generator: each call returns a float in `[0, 1)`. */
export type Rng = () => number;

/** Deterministic PRNG over a 32-bit state. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The first 32 bits of `sha256(str)`, as an unsigned integer seed. */
export function seedFrom(str: string): number {
  return createHash('sha256').update(str, 'utf8').digest().readUInt32BE(0);
}

/**
 * The seed string issue #371 fixes for a graph: `ownerId:nodeCount:edgeCount`.
 * Same owner, same shape → same picture; a changed graph gets a fresh seed.
 */
export function layoutSeed(ownerId: string, nodeCount: number, edgeCount: number): string {
  return `${ownerId}:${nodeCount}:${edgeCount}`;
}
