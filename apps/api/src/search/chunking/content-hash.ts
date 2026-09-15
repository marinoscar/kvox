// =============================================================================
// CONTENT ADDRESSING (issue #186, epic #165)
// =============================================================================
//
// Two hashes, one purpose: answering "has this changed?" without re-embedding
// anything to find out.
//
// `contentHash` is per chunk and is what makes an edit cheap — the chunks whose
// text did not move keep their hash, their stored embedding is still correct,
// and the `search.index` job of a later issue skips them.
//
// `fingerprintDocument` is per document and is what makes an UNEDITED document
// free: one string comparison against the stored
// `search_index_state.contentFingerprint` answers "is any of this stale?"
// without loading, comparing or even chunking N rows.
//
// ⚠ Both are pure — see `chunk.types.ts`'s header for why that is the
// requirement and not a nicety.
// =============================================================================

import { createHash } from 'node:crypto';

import type { Chunk } from './chunk.types';

/**
 * Domain tag mixed into the document fingerprint.
 *
 * It keeps a document fingerprint from ever colliding with a chunk hash (they
 * are both 64 hex characters and both live in the same database), and the `v1`
 * gives a future change to the fingerprint's construction somewhere to announce
 * itself instead of silently producing a different answer for the same corpus.
 */
const FINGERPRINT_DOMAIN = 'kvox.search.chunk-fingerprint.v1';

/**
 * sha256 of a chunk's text, hex-encoded. The content-addressing key.
 *
 * ⚠ HASH THE CHUNK'S FINAL TEXT, PREFIX INCLUDED — never the raw source region
 * it was cut from. The prefix is part of what gets embedded: a paragraph under
 * the title "Q3 Budget Review" and the byte-identical paragraph under "Offsite
 * Retro" are genuinely different embedding inputs, producing genuinely
 * different vectors, and must not share a hash. Hashing the source region
 * instead would make the two collide, and the second note would silently reuse
 * the first note's vector — a wrong answer with no failure anywhere to notice
 * it. The same holds for a transcript line reattributed from `Speaker A` to
 * `Alice`: the text a reader sees did not change, the text the model embeds
 * did.
 *
 * Stable across Node versions: sha256 is specified, `node:crypto` is a binding
 * to it, and the input is an explicitly UTF-8-encoded string. Nothing here
 * serializes an object, so nothing here can depend on object key order.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A single hash over a document's ordered chunk hashes, so that "has this
 * document changed at all" is ONE comparison rather than N.
 *
 * ⚠ ORDER MATTERS AND IS MEANT TO. Reordering a note's sections without
 * changing a word of it produces the same set of chunk hashes in a different
 * sequence, and that is a real change to the document: the chunk ordinals move,
 * so every stored row's position is stale even though no text needs
 * re-embedding. A commutative combiner (XOR, a sorted set) would call that
 * document unchanged. The hashes are therefore fed in order, each terminated by
 * a newline so that concatenation is unambiguous — fixed-width hex makes
 * ambiguity unreachable anyway, but a separator keeps that a property of the
 * format rather than of the current hash length.
 *
 * An empty document is not an error: it fingerprints to the hash of the domain
 * tag alone, which is stable and distinct from any document with chunks.
 *
 * Takes the narrowest thing it needs — anything carrying a `contentHash` — so a
 * caller holding rows read back from the database can fingerprint them without
 * reconstructing whole `Chunk` objects.
 */
export function fingerprintDocument(
  chunks: readonly Pick<Chunk, 'contentHash'>[],
): string {
  const hash = createHash('sha256');
  hash.update(FINGERPRINT_DOMAIN, 'utf8');
  hash.update('\n', 'utf8');
  for (const chunk of chunks) {
    hash.update(chunk.contentHash, 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}
