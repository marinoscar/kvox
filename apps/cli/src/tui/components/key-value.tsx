import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { useContentWidth } from './content-width.js';
import { truncateEnd } from './truncate.js';

// =============================================================================
// KeyValue — an aligned table of facts  (issue #129, epic #118)
// =============================================================================
//
// SCREEN CONTRACT. Pure over props, no keys. The review step of the install
// wizard and the About screen both hand it rows; the screen decides which
// rows are `masked`. A masked value renders as `••••••••` and the value is
// NOT in the rendered row at all — `renderRows` drops it, so a screen cannot
// leak a secret by rendering the row it built; the only way to show one is
// to not mark it masked.
//
// The label column is the widest key. When that would take more than a share
// of the width, or leave too little room beside it for a value, the WHOLE
// table stacks — each key on one line, its value indented on the next —
// rather than cutting keys or truncating values down to an ellipsis. A review
// table showing `POSTGRES_PA…  ••••••••` reviews nothing; stacked, every key
// and value is whole. Stacking is per table, not per row, so the rows that
// would have fit do not sit at a different indent from the ones that would not.
// =============================================================================

export interface KeyValueRow {
  key: string;
  value: string;
  /** Render `••••••••` and never the value. */
  masked?: boolean | undefined;
  /** Dim text after the value (the reason for a derived default, a unit). */
  note?: string | undefined;
}

export interface RenderedRow {
  key: string;
  /** The key, padded to the label column; the bare key when stacked. */
  label: string;
  /** The display value: the mask, or the value truncated to fit. */
  value: string;
  note: string | undefined;
  /** Value (and note) on the line after the key, when it would not fit beside. */
  stacked: boolean;
  /** Whether the note fits on the value's line; otherwise it gets its own. */
  noteInline: boolean;
}

/** Eight bullets regardless of the secret's length, so the length is not a hint either. */
export const MASKED_VALUE = '••••••••';

/** Between the label column and the value. */
const GUTTER = '  ';
/** Indent of a stacked value. */
const STACK_INDENT = '  ';
/** The label column never takes more than this share of the width. */
const LABEL_SHARE = 0.4;
/** Below this many columns for the value, stack instead. */
const MIN_VALUE_COLUMNS = 8;

export interface KeyValueLayout {
  /** Every row stacked: keys would be cut, or values would have no room. */
  stacked: boolean;
  /** The label column (the widest key); 0 when stacked. */
  labelWidth: number;
}

/** Whether these rows fit side by side at this width — the layout decision. */
export function keyValueLayout(rows: readonly KeyValueRow[], width: number): KeyValueLayout {
  const columns = Math.max(1, Math.trunc(width));
  const widest = rows.reduce((max, row) => Math.max(max, row.key.length), 0);
  const cap = Math.max(1, Math.floor(columns * LABEL_SHARE));
  const beside = columns - widest - GUTTER.length;

  if (widest > cap || beside < MIN_VALUE_COLUMNS) return { stacked: true, labelWidth: 0 };
  return { stacked: false, labelWidth: widest };
}

export function renderRows(rows: readonly KeyValueRow[], width: number): RenderedRow[] {
  const columns = Math.max(1, Math.trunc(width));
  const { stacked, labelWidth } = keyValueLayout(rows, columns);
  const valueWidth = stacked ? columns - STACK_INDENT.length : columns - labelWidth - GUTTER.length;

  return rows.map((row) => {
    const shown = row.masked === true ? MASKED_VALUE : row.value;
    const value = truncateEnd(shown, valueWidth);
    const note = row.note === undefined || row.note === '' ? undefined : row.note;
    const noteInline = note !== undefined && value.length + GUTTER.length + note.length <= valueWidth;

    return {
      key: row.key,
      label: stacked ? truncateEnd(row.key, columns) : row.key.padEnd(labelWidth),
      value,
      note,
      stacked,
      noteInline,
    };
  });
}

export interface KeyValueProps {
  rows: readonly KeyValueRow[];
  /** Columns to fit each row in. Defaults to the frame's content width. */
  width?: number | undefined;
}

export function KeyValue({ rows, width }: KeyValueProps): ReactNode {
  const contentColumns = useContentWidth();
  const rendered = renderRows(rows, width ?? contentColumns);

  return (
    <Box flexDirection="column">
      {rendered.map((row) => (
        <Box key={row.key} flexDirection="column">
          {row.stacked ? (
            <>
              <Text dimColor>{row.label}</Text>
              <Box>
                <Text>{STACK_INDENT}</Text>
                <Text>{row.value}</Text>
                {row.note !== undefined && row.noteInline ? <Text dimColor>{`${GUTTER}${row.note}`}</Text> : null}
              </Box>
            </>
          ) : (
            <Box>
              <Text dimColor>{row.label}</Text>
              <Text>{GUTTER}</Text>
              <Text>{row.value}</Text>
              {row.note !== undefined && row.noteInline ? <Text dimColor>{`${GUTTER}${row.note}`}</Text> : null}
            </Box>
          )}
          {row.note !== undefined && !row.noteInline ? (
            <Text dimColor>
              {STACK_INDENT}
              {row.note}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
