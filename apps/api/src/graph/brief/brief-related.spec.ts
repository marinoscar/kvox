import { RRF_K } from '../../search/search-fusion';
import { fuseRelatedSources, recencyFactor, relatedKey, type RelatedDoc } from './brief-related';

const NOW = new Date('2026-09-26T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const T = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function docs(entries: [string, string, Date | null][]): Map<string, RelatedDoc> {
  return new Map(entries.map(([kind, id, at]) => [relatedKey(kind as 'note', id), { title: `doc ${id}`, occurredAt: at }]));
}

describe('recencyFactor', () => {
  it('halves every 90 days and never decays an undated or future document', () => {
    expect(recencyFactor(NOW, NOW)).toBe(1);
    expect(recencyFactor(daysAgo(90), NOW)).toBeCloseTo(0.5);
    expect(recencyFactor(daysAgo(180), NOW)).toBeCloseTo(0.25);
    expect(recencyFactor(null, NOW)).toBe(1);
    expect(recencyFactor(new Date(NOW.getTime() + 1e9), NOW)).toBe(1);
  });
});

describe('fuseRelatedSources', () => {
  it('ranks agreement between the two arms above a single-arm first place (RRF, k=60)', () => {
    const d = docs([
      ['transcript', T(1), NOW],
      ['transcript', T(2), NOW],
      ['note', T(3), NOW],
    ]);
    const out = fuseRelatedSources({
      text: [
        { kind: 'transcript', id: T(1), title: 't1', snippetHtml: '<mark>Acme</mark>', startMs: 1500 },
        { kind: 'transcript', id: T(2), title: 't2', snippetHtml: null, startMs: null },
      ],
      graph: [
        { kind: 'note', id: T(3), confidence: 1 },
        { kind: 'transcript', id: T(2), confidence: 1 },
      ],
      docs: d,
      now: NOW,
    });
    // T1 and T3 are each first in one arm: an exact tie, broken by key (note < transcript).
    expect(out.map((r) => r.id)).toEqual([T(2), T(3), T(1)]);
    expect(out[0].score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 2));
    expect(out[1].score).toBeCloseTo(out[2].score);
    expect(out.map((r) => r.inGraph)).toEqual([true, true, false]);
    // Snippets come only from the text arm.
    expect(out[2]).toMatchObject({ snippetHtml: '<mark>Acme</mark>', startMs: 1500 });
    expect(out[1]).toMatchObject({ snippetHtml: null, startMs: null });
  });

  it('multiplies by recency after the fusion', () => {
    const d = docs([
      ['note', T(1), daysAgo(180)],
      ['note', T(2), NOW],
    ]);
    const out = fuseRelatedSources({
      text: [
        { kind: 'note', id: T(1), title: 'a', snippetHtml: null, startMs: null },
        { kind: 'note', id: T(2), title: 'b', snippetHtml: null, startMs: null },
      ],
      graph: [],
      docs: d,
      now: NOW,
    });
    expect(out.map((r) => r.id)).toEqual([T(2), T(1)]);
    expect(out[1].score).toBeCloseTo((1 / (RRF_K + 1)) * 0.25);
  });

  it('weights a graph hit by the mean confidence of its cited rows', () => {
    const d = docs([
      ['note', T(1), NOW],
      ['note', T(2), NOW],
    ]);
    const out = fuseRelatedSources({
      text: [],
      graph: [
        { kind: 'note', id: T(1), confidence: 0.2 },
        { kind: 'note', id: T(2), confidence: 0.9 },
      ],
      docs: d,
      now: NOW,
    });
    expect(out.map((r) => r.id)).toEqual([T(2), T(1)]);
    expect(out[1].score).toBeCloseTo((1 / (RRF_K + 1)) * 0.2);
  });

  it('drops documents the caller can no longer view, and caps the list at 8', () => {
    const hits = Array.from({ length: 12 }, (_, i) => ({ kind: 'note' as const, id: T(i + 1), title: 'x', snippetHtml: null, startMs: null }));
    const visible = docs(hits.filter((_, i) => i !== 0).map((h) => ['note', h.id, NOW]));
    const out = fuseRelatedSources({ text: hits, graph: [], docs: visible, now: NOW });
    expect(out).toHaveLength(8);
    expect(out.map((r) => r.id)).not.toContain(T(1));
  });
});
