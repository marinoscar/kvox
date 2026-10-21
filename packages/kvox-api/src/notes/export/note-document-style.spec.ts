import type { MdSpan } from './markdown-ast.js';
import {
  NOTE_SPACING,
  NOTE_THEME,
  NOTE_TYPE,
  TASK_GLYPH,
  bulletGlyph,
  codeLanguageLabel,
  exportedLabel,
  headingColor,
  headingRule,
  kickerText,
  noteFooterText,
  orderedMarker,
  tableAlignment,
  tableColumnWeights,
} from './note-document-style.js';

const cell = (text: string): MdSpan[] => [{ text }];
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe('note-document-style', () => {
  it('exposes the scales', () => {
    expect(NOTE_TYPE.title).toBe(26);
    expect(NOTE_TYPE.body).toBe(10.5);
    expect(NOTE_SPACING.headingBefore[1]).toBe(18);
    expect(NOTE_SPACING.lineHeight).toBe(1.35);
    expect(TASK_GLYPH).toEqual({ done: '☑', open: '☐' });
  });

  it('colours and rules headings', () => {
    expect(headingColor(1)).toBe(NOTE_THEME.primaryDark);
    expect(headingColor(2)).toBe(NOTE_THEME.ink);
    expect(headingColor(3)).toBe(NOTE_THEME.primary);
    expect(headingColor(4)).toBe(NOTE_THEME.ink);
    expect(headingColor(5)).toBe(NOTE_THEME.muted);
    expect(headingColor(6)).toBe(NOTE_THEME.muted);
    expect(headingRule(1)).toBe(true);
    expect(headingRule(2)).toBe(false);
  });

  it('cycles bullets', () => {
    expect([0, 1, 2, 3, 4, 5].map(bulletGlyph)).toEqual(['•', '◦', '▪', '▫', '•', '◦']);
  });

  it('builds ordered markers', () => {
    expect(orderedMarker(3, 0)).toBe('3.');
    expect(orderedMarker(1, 1)).toBe('a.');
    expect(orderedMarker(26, 1)).toBe('z.');
    expect(orderedMarker(27, 1)).toBe('aa.');
    expect(orderedMarker(28, 1)).toBe('ab.');
    expect(orderedMarker(52, 1)).toBe('az.');
    expect(orderedMarker(53, 1)).toBe('ba.');
    expect(orderedMarker(4, 2)).toBe('iv.');
    expect(orderedMarker(1994, 2)).toBe('mcmxciv.');
    expect(orderedMarker(3999, 2)).toBe('mmmcmxcix.');
    expect(orderedMarker(2, 3)).toBe('2.');
  });

  it('weights table columns', () => {
    const w = tableColumnWeights({
      header: [cell('A'), cell('Description')],
      rows: [[cell('x'), cell('y'.repeat(200))]],
    });
    expect(sum(w)).toBeCloseTo(1);
    expect(w[0]).toBeGreaterThanOrEqual(0.08 - 1e-9);
    expect(w[1]).toBeGreaterThan(w[0]!);
    // cap: 200 chars counts as 60
    expect(w[1]).toBeLessThanOrEqual(60 / 61 + 1e-9);
  });

  it('floors small columns and handles empty tables', () => {
    const w = tableColumnWeights(
      { header: [cell('a'), cell('b'.repeat(60))], rows: [] },
      { minShare: 0.2 },
    );
    expect(w[0]).toBeCloseTo(0.2);
    expect(sum(w)).toBeCloseTo(1);
    expect(tableColumnWeights({ header: [], rows: [] })).toEqual([]);
    const e = tableColumnWeights({ header: [[], []], rows: [] });
    expect(sum(e)).toBeCloseTo(1);
  });

  it('resolves alignment', () => {
    expect(tableAlignment(null)).toBe('left');
    expect(tableAlignment('right')).toBe('right');
    expect(tableAlignment('center')).toBe('center');
  });

  it('labels code languages', () => {
    expect(codeLanguageLabel(null)).toBeNull();
    expect(codeLanguageLabel('  ')).toBeNull();
    expect(codeLanguageLabel('ts')).toBe('TS');
    expect(codeLanguageLabel('javascript extra')).toBe('JAVASCRIPT');
  });

  it('formats export labels', () => {
    expect(exportedLabel({ exportedAt: new Date('2026-09-12T10:00:00Z') })).toBe(
      'Exported Sep 12, 2026',
    );
    expect(kickerText({ templateName: 'Meeting notes' })).toBe('MEETING NOTES');
    expect(kickerText({ templateName: null })).toBe('NOTE');
    expect(noteFooterText(1, 3, 2, 'KVox')).toBe('Page 1 of 3 · Version 2 · Exported from KVox');
    expect(noteFooterText(1, 3, 2)).toMatch(/^Page 1 of 3 · Version 2 · Exported from .+/);
  });
});
