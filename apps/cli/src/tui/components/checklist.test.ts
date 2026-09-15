import { describe, expect, it } from 'vitest';

import { NARROW_COLUMNS, TINY_COLUMNS } from '../layout.js';
import { checklistRows, type ChecklistItem, type ChecklistStatus } from './checklist.js';

// Glyph, colour and truncation as data (tui/screens/deploy.test.ts's rule).

function item(status: ChecklistStatus, extra: Partial<ChecklistItem> = {}): ChecklistItem {
  return { id: status, title: `A ${status} check`, status, ...extra };
}

describe('checklistRows', () => {
  it('maps every status to its two-column glyph', () => {
    const rows = checklistRows(
      (['pending', 'running', 'pass', 'warn', 'fail', 'skip'] as const).map((status) => item(status)),
      80,
    );

    expect(rows.map((row) => row.glyph)).toEqual(['··', '··', 'OK', '!!', 'XX', '--']);
    for (const row of rows) expect(row.glyph).toHaveLength(2);
  });

  it('maps every status to its colour', () => {
    const rows = checklistRows(
      (['pending', 'running', 'pass', 'warn', 'fail', 'skip'] as const).map((status) => item(status)),
      80,
    );

    expect(rows.map((row) => row.color)).toEqual([undefined, 'cyan', 'green', 'yellow', 'red', undefined]);
    expect(rows.map((row) => row.dim)).toEqual([true, false, false, false, false, true]);
  });

  it('animates only the running row', () => {
    const rows = checklistRows([item('running'), item('pass')], 80);

    expect(rows.map((row) => row.spinner)).toEqual([true, false]);
  });

  it('appends the detail after the title', () => {
    const [row] = checklistRows([item('pass', { detail: 'Docker 27.1' })], 80);

    expect(row?.text).toBe('A pass check — Docker 27.1');
  });

  it('shows the remedy under a failed item and under a warning', () => {
    const rows = checklistRows(
      [
        item('fail', { remedy: 'apt install gh' }),
        item('warn', { remedy: 'ufw enable' }),
        item('pass', { remedy: 'should never show' }),
        item('pending', { remedy: 'nor this' }),
      ],
      80,
    );

    expect(rows[0]?.remedy).toBe('   ↳ apt install gh');
    expect(rows[1]?.remedy).toBe('   ↳ ufw enable');
    expect(rows[2]?.remedy).toBeUndefined();
    expect(rows[3]?.remedy).toBeUndefined();
  });

  it('has no remedy line for a failure without one', () => {
    expect(checklistRows([item('fail')], 80)[0]?.remedy).toBeUndefined();
  });

  it('truncates the detail to NARROW_COLUMNS', () => {
    const [row] = checklistRows([item('fail', { detail: 'x'.repeat(200) })], NARROW_COLUMNS);

    // Two glyph columns plus a space, then the text.
    expect(row?.text).toHaveLength(NARROW_COLUMNS - 3);
    expect(row?.text.endsWith('…')).toBe(true);
    expect(`${row?.glyph} ${row?.text}`).toHaveLength(NARROW_COLUMNS);
  });

  it('truncates the detail to TINY_COLUMNS', () => {
    const [row] = checklistRows([item('fail', { detail: 'x'.repeat(200) })], TINY_COLUMNS);

    expect(row?.text).toHaveLength(TINY_COLUMNS - 3);
    expect(`${row?.glyph} ${row?.text}`).toHaveLength(TINY_COLUMNS);
  });

  it('never truncates the remedy, because it is a command to paste', () => {
    const remedy = 'docker run --rm -v /opt/infra/proxy/letsencrypt:/etc/letsencrypt certbot/certbot renew';
    const [row] = checklistRows([item('fail', { remedy })], TINY_COLUMNS);

    expect(row?.remedy).toContain(remedy);
  });

  it('leaves a short row alone', () => {
    const [row] = checklistRows([item('pass')], 80);

    expect(row?.text).toBe('A pass check');
  });
});
