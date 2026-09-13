import { Box, Text, useStdout } from 'ink';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { CLI_DISPLAY_NAME } from '../branding.js';
import { CLI_VERSION } from '../package-info.js';

// =============================================================================
// Layout primitives and the narrow-terminal degrade  (issue #145, epic #110)
// =============================================================================
//
// Everything shared between screens lives here: the frame, the key hints, the
// terminal-size hook, and the after-unmount guard. Screens import from this
// file rather than reaching for `useStdout` themselves, so the degrade rules
// below are applied uniformly instead of being re-derived (differently) five
// times.
// =============================================================================

/**
 * Below this many columns the chrome is dropped.
 *
 * FIFTY-SIX because that is roughly what the widest fixed content needs — the
 * device-flow instruction panel, a `GET /api/users → 200 OK (41ms)` status
 * line — plus a two-column border and two of padding on each side. Narrower
 * than that and the border characters start consuming the content they are
 * meant to frame, which is worse than no border: yoga wraps mid-word inside a
 * box it cannot shrink, and the result is a smear of broken box-drawing
 * characters rather than a smaller version of the UI.
 *
 * The number is a THRESHOLD, not a minimum viable width: below it the UI keeps
 * working, it just stops drawing decoration. #145 asks for degrade, not
 * refusal — a user in a tmux split or an 80-column window halved is a normal
 * case, and a TUI that says "your terminal is too small" to someone who can
 * plainly see text on it is a TUI they stop using.
 */
export const NARROW_COLUMNS = 56;

/**
 * Below this, drop even the header and the padding.
 *
 * Thirty is about the width of a phone-sized SSH session. There is no useful
 * layout left at this size, only content, so that is all that is drawn.
 */
export const TINY_COLUMNS = 30;

/**
 * Assumed size when the terminal will not say.
 *
 * `stdout.columns` is `undefined` on a stream that is not a TTY and can be `0`
 * during a resize, while some terminal multiplexers report 0 for a pane that is
 * momentarily hidden. Yoga treats a width of 0 as "collapse everything", so a
 * single unlucky read would flatten the whole UI into a column of single
 * characters — briefly, and often enough to look like a rendering bug. Falling
 * back to the classic 80x24 keeps the layout stable through that.
 */
const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

export interface TerminalSize {
  columns: number;
  rows: number;
  /** `columns < NARROW_COLUMNS`. Drop borders and side padding. */
  narrow: boolean;
  /** `columns < TINY_COLUMNS`. Drop the header too; content only. */
  tiny: boolean;
}

/**
 * The current terminal size, updated on resize.
 *
 * ink re-renders on its own when the terminal is resized, but it does NOT
 * publish the new size as state — a component that read `stdout.columns` during
 * render would get the fresh value only because a re-render happened to be
 * scheduled, which is a coincidence rather than a subscription. Owning the
 * listener here makes the resize an explicit state change, which is what #145
 * asks for: the layout must actually respond, not merely survive.
 *
 * The listener is removed on unmount. `process.stdout` is a long-lived emitter
 * shared with the whole runtime, so a leaked listener here outlives the UI and
 * fires against unmounted components for the rest of the process's life.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const read = (): { columns: number; rows: number } => ({
    columns: normaliseDimension(stdout?.columns, FALLBACK_COLUMNS),
    rows: normaliseDimension(stdout?.rows, FALLBACK_ROWS),
  });

  const [size, setSize] = useState(read);

  useEffect(() => {
    if (!stdout) return;

    const onResize = (): void => {
      setSize({
        columns: normaliseDimension(stdout.columns, FALLBACK_COLUMNS),
        rows: normaliseDimension(stdout.rows, FALLBACK_ROWS),
      });
    };

    // Read once on mount as well: between the `useState` initialiser and this
    // effect the terminal may already have changed (it happens when the app is
    // launched from a script that resizes the window), and without this the UI
    // would hold a stale size until the NEXT resize.
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return {
    columns: size.columns,
    rows: size.rows,
    narrow: size.columns < NARROW_COLUMNS,
    tiny: size.columns < TINY_COLUMNS,
  };
}

function normaliseDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * A guard against writing state after unmount.
 *
 * EVERY SCREEN IN THIS TUI NEEDS IT, because every screen does network work
 * that outlives a keypress. The device-flow login polls for up to fifteen
 * minutes; a user who presses Esc, or Ctrl-C, is unmounted immediately while
 * the in-flight request keeps running and its `.then` still holds a setter for
 * a component that no longer exists. React 18+ no longer warns about this, so
 * the symptom is not a console message but a leak, and — once ink has torn the
 * renderer down — a possible throw from inside a reconciler that has already
 * stopped. `ee2078c fix(web): stop hooks writing state after unmount` is the
 * same bug in apps/web.
 *
 * Returns a getter rather than the ref itself so a caller cannot accidentally
 * capture `ref.current`'s value at closure-creation time, which would always be
 * `true` and defeat the whole thing.
 */
export function useIsMounted(): () => boolean {
  const mounted = useRef(true);

  useEffect(() => {
    // Reset on mount as well as clearing on unmount: React's StrictMode double
    // -invokes effects, and a ref left `false` by the first teardown would make
    // every subsequent update a no-op — a screen that renders once and then
    // never changes again.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return () => mounted.current;
}

// -----------------------------------------------------------------------------
// Chrome
// -----------------------------------------------------------------------------

export interface FrameProps {
  /** Screen name, shown in the header. */
  title: string;
  /** Key hints for the bottom line, e.g. `['↑↓ move', 'enter select']`. */
  hints?: string[];
  children: ReactNode;
}

/**
 * The window every screen sits in: a header, the content, and a hint line.
 *
 * THE DEGRADE IS THE INTERESTING PART. Three tiers, chosen by width:
 *
 *   full   (>= NARROW_COLUMNS)  bordered box, padding, header, hints
 *   narrow (>= TINY_COLUMNS)    no border, no side padding, header, hints
 *   tiny   (<  TINY_COLUMNS)    content only
 *
 * A bordered `Box` is NOT given an explicit width at any tier. Setting
 * `width={columns}` looks right and is a bug: ink measures the terminal itself,
 * and a box asked for exactly the full width has nowhere to put its own border,
 * so the right-hand edge wraps onto the next line and every frame ends with a
 * row of orphaned box characters. Letting the box size itself and constraining
 * only the CONTENT is what keeps the frame intact at every width.
 */
export function Frame({ title, hints, children }: FrameProps): ReactNode {
  const { narrow, tiny } = useTerminalSize();

  if (tiny) {
    return <Box flexDirection="column">{children}</Box>;
  }

  const body = (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color="cyan">
          {CLI_DISPLAY_NAME}
        </Text>
        <Text dimColor> v{CLI_VERSION}</Text>
        <Text dimColor> · </Text>
        <Text bold>{title}</Text>
      </Box>

      <Box flexDirection="column">{children}</Box>

      {hints !== undefined && hints.length > 0 ? <KeyHints hints={hints} /> : null}
    </Box>
  );

  if (narrow) return body;

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={2} paddingY={1} flexDirection="column">
      {body}
    </Box>
  );
}

/**
 * The bottom line of every screen.
 *
 * Always present, and always including the key that gets OUT. A full-screen app
 * that has captured the keyboard and does not say how to leave is the reason
 * people are wary of them; Esc and Ctrl-C are both listed on every screen for
 * exactly that reason, even where it looks redundant.
 *
 * Separators are dropped when narrow: at that width the hints wrap, and a
 * wrapped line beginning with a lone dot reads as corruption.
 */
export function KeyHints({ hints }: { hints: string[] }): ReactNode {
  const { narrow } = useTerminalSize();

  if (narrow) {
    return (
      <Box flexDirection="column">
        {hints.map((hint) => (
          <Text key={hint} dimColor>
            {hint}
          </Text>
        ))}
      </Box>
    );
  }

  return <Text dimColor>{hints.join('  ·  ')}</Text>;
}

/**
 * A labelled row: a fixed-width label and a value.
 *
 * The label column is padded rather than laid out with a `<Box width>` because
 * ink measures a Box in cells and these labels are ASCII — padding is exact,
 * one flex node cheaper per row, and immune to the width-collapse described in
 * `Frame`.
 */
export function Field({
  label,
  value,
  color,
  dim,
}: {
  label: string;
  value: string;
  color?: string | undefined;
  dim?: boolean | undefined;
}): ReactNode {
  return (
    <Box>
      <Text dimColor>{label.padEnd(FIELD_LABEL_WIDTH)}</Text>
      <Text
        {...(color === undefined ? {} : { color })}
        {...(dim === true ? { dimColor: true } : {})}
      >
        {value}
      </Text>
    </Box>
  );
}

const FIELD_LABEL_WIDTH = 10;

/**
 * An error, rendered the same way everywhere.
 *
 * `hint` is separate from `message` so the remedy is visually distinct from the
 * diagnosis. The messages this CLI produces already carry their own remedy
 * (see errors.ts), so `hint` is for the extra sentence a SCREEN can add and the
 * error itself cannot — "press r to try again".
 */
export function ErrorNotice({
  message,
  hint,
}: {
  message: string;
  hint?: string | undefined;
}): ReactNode {
  return (
    <Box flexDirection="column">
      <Text color="red" bold>
        ✖ {message}
      </Text>
      {hint === undefined ? null : <Text dimColor>{hint}</Text>}
    </Box>
  );
}
