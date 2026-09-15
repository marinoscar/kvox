import { describe, expect, it } from 'vitest';

import { NARROW_COLUMNS, TINY_COLUMNS } from '../layout.js';
import { keyValueLayout, MASKED_VALUE, renderRows, type KeyValueRow } from './key-value.js';

// Alignment and masking as data (tui/screens/deploy.test.ts's rule).

const ROWS: KeyValueRow[] = [
  { key: 'Domain', value: 'app.example.com' },
  { key: 'POSTGRES_PASSWORD', value: 'hunter2-the-real-one', masked: true },
  { key: 'Port', value: '3535', note: 'first free loopback port' },
];

describe('renderRows', () => {
  it('pads every label to the same column', () => {
    const rows = renderRows(ROWS, 80);
    const widths = new Set(rows.map((row) => row.label.length));

    expect(widths.size).toBe(1);
    expect([...widths][0]).toBe('POSTGRES_PASSWORD'.length);
    expect(rows[0]?.label).toBe('Domain'.padEnd('POSTGRES_PASSWORD'.length));
  });

  it('renders a masked value as bullets and never the value', () => {
    const rendered = renderRows(ROWS, 80);
    const masked = rendered[1];

    expect(masked?.value).toBe(MASKED_VALUE);
    expect(masked?.value).toBe('••••••••');
    expect(JSON.stringify(masked)).not.toContain('hunter2');
  });

  it('masks to the same eight bullets whatever the secret length', () => {
    const [short, long] = renderRows(
      [
        { key: 'a', value: 'x', masked: true },
        { key: 'b', value: 'x'.repeat(64), masked: true },
      ],
      80,
    );

    expect(short?.value).toBe(long?.value);
  });

  it('keeps the note inline when it fits', () => {
    const port = renderRows(ROWS, 80)[2];

    expect(port?.note).toBe('first free loopback port');
    expect(port?.noteInline).toBe(true);
    expect(port?.stacked).toBe(false);
  });

  it('fits the label, gutter and value inside NARROW_COLUMNS', () => {
    const rows = renderRows([{ key: 'Domain', value: 'x'.repeat(200) }], NARROW_COLUMNS);
    const [row] = rows;

    expect(row?.stacked).toBe(false);
    expect(`${row?.label}  ${row?.value}`).toHaveLength(NARROW_COLUMNS);
    expect(row?.value.endsWith('…')).toBe(true);
  });

  it('stacks the whole table rather than cutting a key that would not fit the label column', () => {
    // A review table showing "POSTGRES_PA…" reviews nothing.
    const layout = keyValueLayout([{ key: 'x'.repeat(60), value: 'v' }, { key: 'a', value: 'b' }], NARROW_COLUMNS);

    expect(layout.stacked).toBe(true);
    const rows = renderRows([{ key: 'x'.repeat(60), value: 'v' }, { key: 'a', value: 'b' }], 80);
    expect(rows.every((row) => row.stacked)).toBe(true);
  });

  it('stacks the value under the key at TINY_COLUMNS when it would not fit beside', () => {
    const [row] = renderRows([{ key: 'POSTGRES_PASSWORD', value: 'x'.repeat(40) }], TINY_COLUMNS);

    expect(row?.stacked).toBe(true);
    // The key is whole, and the value — indented by two — is within the width.
    expect(row?.label).toBe('POSTGRES_PASSWORD');
    expect(row?.value.length).toBeLessThanOrEqual(TINY_COLUMNS - 2);
  });

  it('lays short keys out side by side even at TINY_COLUMNS', () => {
    const [row] = renderRows([{ key: 'Port', value: '3535' }], TINY_COLUMNS);

    expect(row?.stacked).toBe(false);
    expect(row?.label).toBe('Port');
  });

  it('moves a note to its own line when it does not fit beside the value', () => {
    const [row] = renderRows([{ key: 'Port', value: '3535', note: 'x'.repeat(100) }], NARROW_COLUMNS);

    expect(row?.noteInline).toBe(false);
    expect(row?.note).toBe('x'.repeat(100));
  });

  it('drops an empty note rather than rendering an empty dim line', () => {
    expect(renderRows([{ key: 'a', value: 'b', note: '' }], 80)[0]?.note).toBeUndefined();
  });
});
