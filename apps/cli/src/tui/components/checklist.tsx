import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactNode } from 'react';

import { useContentWidth } from './content-width.js';
import { truncateEnd } from './truncate.js';

// =============================================================================
// Checklist — the doctor / steps view  (issue #129, epic #118)
// =============================================================================
//
// SCREEN CONTRACT. Pure over props and takes no keys: the screen collects
// check results (or pipeline step results, through `DeployHooks`) into
// `items` and re-renders; this component only draws them. `width` defaults
// to the live content width so a row never wraps inside the frame; a screen
// laying the list out beside something else passes its own.
//
// The rows are derived by the pure `checklistRows(items, width)` so the
// glyph, colour and truncation rules are tested as data.
//
// GLYPHS are two ASCII columns, never one Unicode symbol, because a `✓` is
// exactly the glyph a terminal without the font renders as a box — and this
// runs over SSH on a server whose fonts nobody chose.
//
//   pending  ··   dim         not reached yet
//   running  ⠋    cyan        ink-spinner; `··` is its non-animated fallback
//   pass     OK   green
//   warn     !!   yellow      remedy shown under it
//   fail     XX   red         remedy shown under it, in the error colour
//   skip     --   dim
// =============================================================================

export type ChecklistStatus = 'pending' | 'running' | 'pass' | 'warn' | 'fail' | 'skip';

export interface ChecklistItem {
  id: string;
  title: string;
  status: ChecklistStatus;
  /** Appended after the title, truncated to the width. */
  detail?: string | undefined;
  /** The fix. Rendered under a failed (or warned) item; never truncated — it is a command. */
  remedy?: string | undefined;
}

export interface ChecklistRow {
  id: string;
  status: ChecklistStatus;
  /** Two columns. For `running`, the fallback shown when the spinner is not. */
  glyph: string;
  /** ink colour name, or undefined for the terminal's default. */
  color: string | undefined;
  dim: boolean;
  /** Whether to animate the glyph column. */
  spinner: boolean;
  /** `title — detail`, truncated so `glyph + ' ' + text` fits the width. */
  text: string;
  /** Indented remedy line, or undefined when there is none to show. */
  remedy: string | undefined;
}

export const CHECKLIST_GLYPHS: Record<ChecklistStatus, string> = {
  pending: '··',
  running: '··',
  pass: 'OK',
  warn: '!!',
  fail: 'XX',
  skip: '--',
};

export const CHECKLIST_COLORS: Record<ChecklistStatus, string | undefined> = {
  pending: undefined,
  running: 'cyan',
  pass: 'green',
  warn: 'yellow',
  fail: 'red',
  skip: undefined,
};

/** `glyph` plus one space; what the text column starts after. */
const GLYPH_COLUMNS = 3;
/** The remedy sits under the text column. */
const REMEDY_INDENT = '   ↳ ';

export function checklistRows(items: readonly ChecklistItem[], width: number): ChecklistRow[] {
  const textWidth = Math.max(0, Math.trunc(width) - GLYPH_COLUMNS);

  return items.map((item) => {
    const detail = item.detail === undefined || item.detail === '' ? '' : ` — ${item.detail}`;
    const showRemedy =
      (item.status === 'fail' || item.status === 'warn') && item.remedy !== undefined && item.remedy !== '';

    return {
      id: item.id,
      status: item.status,
      glyph: CHECKLIST_GLYPHS[item.status],
      color: CHECKLIST_COLORS[item.status],
      dim: item.status === 'pending' || item.status === 'skip',
      spinner: item.status === 'running',
      text: truncateEnd(`${item.title}${detail}`, textWidth),
      remedy: showRemedy ? `${REMEDY_INDENT}${item.remedy}` : undefined,
    };
  });
}

export interface ChecklistProps {
  items: readonly ChecklistItem[];
  /** Columns to fit each row in. Defaults to the frame's content width. */
  width?: number | undefined;
}

export function Checklist({ items, width }: ChecklistProps): ReactNode {
  const contentColumns = useContentWidth();
  const rows = checklistRows(items, width ?? contentColumns);

  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.id} flexDirection="column">
          <Box>
            <Text {...(row.color === undefined ? {} : { color: row.color })} dimColor={row.dim}>
              {row.spinner ? <Spinner type="dots" /> : row.glyph}
            </Text>
            <Text dimColor={row.dim}>
              {row.spinner ? '  ' : ' '}
              {row.text}
            </Text>
          </Box>
          {row.remedy === undefined ? null : (
            <Text color={row.status === 'fail' ? 'red' : 'yellow'}>{row.remedy}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
