// =============================================================================
// Content addressing (issue #186, epic #165)
// =============================================================================

import { createHash } from 'node:crypto';

import { contentHash, fingerprintDocument } from './content-hash';

const hashes = (...values: string[]) =>
  values.map((contentHashValue) => ({ contentHash: contentHashValue }));

describe('contentHash', () => {
  it('is sha256 hex of the exact text', () => {
    expect(contentHash('hello')).toBe(
      createHash('sha256').update('hello', 'utf8').digest('hex'),
    );
    expect(contentHash('hello')).toHaveLength(64);
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    const text = 'Speaker A: the migration lands on Thursday.';
    expect(contentHash(text)).toBe(contentHash(text));
  });

  it('is a pinned value, so a change of construction cannot pass silently', () => {
    // The empty-string sha256 is a published constant. If this ever changes,
    // every stored chunk hash in every deployment has been invalidated, and
    // that should be a failing test rather than a quiet full re-embed.
    expect(contentHash('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('separates two chunks whose source text is identical but whose prefix is not', () => {
    // The whole reason the hash is taken over the FINAL text: these are
    // genuinely different embedding inputs and must not collide.
    const paragraph = 'We agreed to defer it until the numbers come back.';
    expect(contentHash(`Q3 Budget Review\n\n${paragraph}`)).not.toBe(
      contentHash(`Offsite Retro\n\n${paragraph}`),
    );
    expect(contentHash(`Alice: ${paragraph}`)).not.toBe(
      contentHash(`Bob: ${paragraph}`),
    );
  });

  it('encodes explicitly, so non-ASCII text hashes the same everywhere', () => {
    const text = 'réunion — 会議 — ✅';
    expect(contentHash(text)).toBe(
      createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    );
  });
});

describe('fingerprintDocument', () => {
  it('is stable for the same ordered hashes', () => {
    const chunks = hashes('aa', 'bb', 'cc');
    expect(fingerprintDocument(chunks)).toBe(fingerprintDocument(chunks));
    expect(fingerprintDocument(chunks)).toBe(
      fingerprintDocument(hashes('aa', 'bb', 'cc')),
    );
  });

  it('changes when any one chunk changes', () => {
    const before = fingerprintDocument(hashes('aa', 'bb', 'cc'));
    expect(fingerprintDocument(hashes('aa', 'bX', 'cc'))).not.toBe(before);
    expect(fingerprintDocument(hashes('aa', 'bb'))).not.toBe(before);
    expect(fingerprintDocument(hashes('aa', 'bb', 'cc', 'dd'))).not.toBe(before);
  });

  it('changes when chunks are only reordered', () => {
    // Reordering a note's sections without editing a word is a real change: the
    // ordinals move, so every stored row's position is stale. A commutative
    // combiner would call this document unchanged.
    expect(fingerprintDocument(hashes('aa', 'bb'))).not.toBe(
      fingerprintDocument(hashes('bb', 'aa')),
    );
  });

  it('is unambiguous about where one hash ends and the next begins', () => {
    expect(fingerprintDocument(hashes('ab', 'c'))).not.toBe(
      fingerprintDocument(hashes('a', 'bc')),
    );
  });

  it('gives an empty document a stable fingerprint rather than an error', () => {
    expect(fingerprintDocument([])).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintDocument([])).toBe(fingerprintDocument([]));
    expect(fingerprintDocument([])).not.toBe(fingerprintDocument(hashes('aa')));
  });

  it('never collides with a chunk hash of the same text', () => {
    // The domain tag is what keeps these two 64-hex-character values, stored in
    // the same database, from being confusable.
    expect(fingerprintDocument(hashes('aa'))).not.toBe(contentHash('aa\n'));
  });
});
