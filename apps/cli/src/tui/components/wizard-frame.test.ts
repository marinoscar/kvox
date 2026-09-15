import { describe, expect, it } from 'vitest';

import { NARROW_COLUMNS, TINY_COLUMNS } from '../layout.js';
import { contentWidth, FRAME_CHROME_COLUMNS } from './content-width.js';
import { truncateEnd } from './truncate.js';
import { RAIL_SEPARATOR, stepRail } from './wizard-frame.js';
import type { WizardStep } from './wizard-state.js';

// No ink-testing-library (tui/screens/deploy.test.ts): the rail is asserted
// as the data `stepRail` derives, which is exactly what the component draws.

const STEPS: WizardStep[] = [
  { id: 'domain', title: 'Domain' },
  { id: 'database', title: 'Database' },
  { id: 'review', title: 'Review' },
];

describe('stepRail', () => {
  it('draws a rail at full width with the current step marked', () => {
    const rail = stepRail(STEPS, 1, 80);

    expect(rail.mode).toBe('rail');
    if (rail.mode !== 'rail') return;
    expect(rail.segments.map((segment) => segment.title)).toEqual(['1 Domain', '2 Database', '3 Review']);
    expect(rail.segments.map((segment) => segment.state)).toEqual(['done', 'current', 'todo']);
  });

  it('falls back to the one-line form when the rail would not fit', () => {
    const many: WizardStep[] = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, title: `Step number ${i + 1}` }));

    const rail = stepRail(many, 1, NARROW_COLUMNS + 4);

    expect(rail).toEqual({ mode: 'line', text: 'Step 2 of 9 — Step number 2' });
  });

  it('uses "Step n of N — title" below NARROW_COLUMNS', () => {
    expect(stepRail(STEPS, 1, NARROW_COLUMNS - 1)).toEqual({ mode: 'line', text: 'Step 2 of 3 — Database' });
  });

  it('draws no rail below TINY_COLUMNS', () => {
    // The current step's content only.
    expect(stepRail(STEPS, 1, TINY_COLUMNS - 1)).toEqual({ mode: 'none' });
  });

  it('draws no rail for an empty step list', () => {
    expect(stepRail([], 0, 80)).toEqual({ mode: 'none' });
  });

  it('clamps an out-of-range current index', () => {
    expect(stepRail(STEPS, 7, 40)).toEqual({ mode: 'line', text: 'Step 3 of 3 — Review' });
    expect(stepRail(STEPS, -2, 40)).toEqual({ mode: 'line', text: 'Step 1 of 3 — Domain' });
  });

  it('measures the rail exactly as it is joined', () => {
    // The rail fits at precisely its own length plus the frame chrome, and
    // not one column narrower — pins that the measured string IS the drawn one.
    // Titles long enough that the boundary sits inside the full tier.
    const wide: WizardStep[] = [
      { id: 'a', title: 'Domain and certificate' },
      { id: 'b', title: 'Database connection' },
      { id: 'c', title: 'Review and confirm' },
    ];
    const text = wide.map((step, i) => `${i + 1} ${step.title}`).join(RAIL_SEPARATOR);
    const exact = text.length + FRAME_CHROME_COLUMNS;
    expect(exact).toBeGreaterThanOrEqual(NARROW_COLUMNS);

    expect(stepRail(wide, 0, exact).mode).toBe('rail');
    expect(stepRail(wide, 0, exact - 1).mode).toBe('line');
  });
});

describe('contentWidth', () => {
  it('subtracts the frame chrome only where the frame is drawn', () => {
    expect(contentWidth(80)).toBe(80 - FRAME_CHROME_COLUMNS);
    expect(contentWidth(NARROW_COLUMNS)).toBe(NARROW_COLUMNS - FRAME_CHROME_COLUMNS);
    expect(contentWidth(NARROW_COLUMNS - 1)).toBe(NARROW_COLUMNS - 1);
    expect(contentWidth(TINY_COLUMNS - 5)).toBe(TINY_COLUMNS - 5);
  });

  it('never reports less than one column', () => {
    expect(contentWidth(0)).toBe(1);
  });
});

describe('truncateEnd', () => {
  it('leaves text that fits alone', () => {
    expect(truncateEnd('abc', 3)).toBe('abc');
  });

  it('cuts to the width and ends in an ellipsis', () => {
    expect(truncateEnd('abcdef', 4)).toBe('abc…');
    expect(truncateEnd('abcdef', 4)).toHaveLength(4);
  });

  it('draws nothing in no space, and only the ellipsis in one column', () => {
    expect(truncateEnd('abc', 0)).toBe('');
    expect(truncateEnd('abc', 1)).toBe('…');
  });
});
