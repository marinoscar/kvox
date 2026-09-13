// =============================================================================
// Terminal output: stream discipline, colour detection, JSON rendering
// (issue #144, epic #110)
// =============================================================================
//
// This module exists so that the ONE rule the `api` command lives or dies by
// is implemented once instead of being remembered at every call site:
//
//   STDOUT CARRIES THE RESPONSE BODY AND NOTHING ELSE.
//   Status lines, spinners, warnings and errors go to STDERR.
//
// That rule is not a style preference. `appctl api GET /api/users --raw | jq`
// and `appctl api GET /api/users --raw > users.json` are the two things the
// command is FOR (#144), and a single stray byte on stdout — a spinner frame,
// an ANSI reset sequence, a "200 OK" line — makes `jq` exit with a parse error
// and makes the saved file unusable. The failure is total, not partial, and it
// is invisible until somebody's script breaks.
//
// The colour logic below is hand-rolled rather than delegated to `chalk` or
// `picocolors` on purpose. This package's dependency list is `commander` and
// nothing else (#140), and a package whose whole job is carrying a bearer
// token around should not grow transitive dependencies to make numbers yellow.
// The rules that actually matter — NO_COLOR, FORCE_COLOR, TERM=dumb, "is it
// even a terminal" — are about twenty lines.
// =============================================================================

/** Inputs to the colour decision, injectable so this is testable without a TTY. */
export interface ColourDecisionInput {
  /** `--no-color` sets this to false. `undefined` means the user said nothing. */
  requested?: boolean | undefined;
  /** Whether the destination stream is a terminal. */
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * Should output be coloured?
 *
 * Precedence, most specific first — each layer overrides the ones below it:
 *
 *   1. `--no-color`. An explicit flag about THIS invocation always wins.
 *   2. `NO_COLOR` (https://no-color.org). Present and non-empty disables
 *      colour for every tool that honours it; ignoring it is how a CLI ends
 *      up escaping-sequence-spamming somebody's accessibility setup.
 *   3. `FORCE_COLOR`. The escape hatch for the case a TTY check cannot detect:
 *      a CI runner that renders ANSI in its web log viewer while handing the
 *      process a pipe. `FORCE_COLOR=0` is the conventional "off" value.
 *   4. `TERM=dumb`. A terminal that has told us it cannot render sequences.
 *   5. Is it a TTY at all — the default, and the case that catches every pipe
 *      and every redirect without anyone having to configure anything.
 *
 * NOTE the caller's other obligation: `--raw` must not even ASK this question.
 * Raw output is machine input, and colour in it is corruption regardless of
 * how loudly FORCE_COLOR was set. `commands/api.ts` hard-codes `false` there
 * rather than routing the decision through here, so no environment variable on
 * any machine can break a pipeline.
 */
export function shouldUseColour(input: ColourDecisionInput): boolean {
  if (input.requested === false) return false;

  const noColor = input.env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;

  const forceColor = input.env['FORCE_COLOR'];
  if (forceColor !== undefined && forceColor !== '') return forceColor !== '0';

  if (input.env['TERM'] === 'dumb') return false;

  return input.isTTY;
}

// -----------------------------------------------------------------------------
// JSON rendering
// -----------------------------------------------------------------------------

/**
 * SGR codes, chosen from the 8-colour basic set on purpose.
 *
 * 256-colour and truecolour sequences look better and are silently wrong on a
 * terminal that does not support them — they print as literal garbage rather
 * than degrading. The basic set has worked everywhere for decades, and the
 * only thing this needs to do is make a key distinguishable from a value.
 *
 * Bright black (90) for punctuation and `null` is the one modern-ish choice;
 * it degrades to plain grey or plain white, never to garbage.
 *
 * Written as `\u001B` escapes rather than literal escape bytes so the source
 * file stays greppable, diffable and safe to paste.
 */
const SGR = {
  reset: '\u001B[0m',
  key: '\u001B[36m', // cyan
  string: '\u001B[32m', // green
  number: '\u001B[33m', // yellow
  boolean: '\u001B[35m', // magenta
  nul: '\u001B[90m', // bright black
  punctuation: '\u001B[90m',
} as const;

type Paint = (code: string, text: string) => string;

const painted: Paint = (code, text) => `${code}${text}${SGR.reset}`;
const plain: Paint = (_code, text) => text;

export interface FormatJsonOptions {
  colour: boolean;
  /** Spaces per level. Two, like `JSON.stringify(v, null, 2)`. */
  indent?: number | undefined;
}

/**
 * Pretty-print a parsed JSON value for a human, optionally coloured.
 *
 * WHY NOT `JSON.stringify(value, null, 2)` PLUS A REGEX RECOLOURING PASS —
 * which is the usual shortcut: a regex cannot tell a `"` that opens a string
 * from a `\"` inside one, so any value containing a quote, a colon or a brace
 * (a JSON blob stored in a `system_settings` JSONB column, say, or an error
 * `details` field) gets mis-highlighted, and mis-highlighting looks exactly
 * like corrupted data. Walking the parsed structure cannot make that mistake,
 * because it never has to guess what a character means.
 *
 * The escaping of every scalar still goes through `JSON.stringify`, so the
 * UNCOLOURED output of this function is byte-identical to
 * `JSON.stringify(value, null, 2)`. That equality is worth keeping: it means
 * the pretty form and the `--raw` form can never disagree about what the data
 * actually was, only about whitespace.
 */
export function formatJson(value: unknown, options: FormatJsonOptions): string {
  const paint = options.colour ? painted : plain;
  const indent = ' '.repeat(options.indent ?? 2);
  return render(value, indent, '', paint);
}

function render(value: unknown, indent: string, current: string, paint: Paint): string {
  if (value === null) return paint(SGR.nul, 'null');

  switch (typeof value) {
    case 'string':
      return paint(SGR.string, JSON.stringify(value));
    case 'number':
      // `JSON.stringify` renders a non-finite number as `null`, which is what
      // JSON requires; going through it keeps that behaviour rather than
      // printing `Infinity`, which is not JSON and would not survive a round
      // trip through the `--raw` form.
      return paint(SGR.number, JSON.stringify(value) ?? 'null');
    case 'boolean':
      return paint(SGR.boolean, String(value));
    case 'undefined':
      // Unreachable from `JSON.parse` output, which is the only source this is
      // used on. Rendered as `null` rather than thrown so a future caller
      // passing a hand-built object cannot crash the CLI over cosmetics.
      return paint(SGR.nul, 'null');
    default:
      break;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return paint(SGR.punctuation, '[]');
    const inner = current + indent;
    const items = value.map((item) => `${inner}${render(item, indent, inner, paint)}`);
    return (
      paint(SGR.punctuation, '[') +
      '\n' +
      items.join(paint(SGR.punctuation, ',') + '\n') +
      '\n' +
      current +
      paint(SGR.punctuation, ']')
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return paint(SGR.punctuation, '{}');
    const inner = current + indent;
    const lines = entries.map(([key, item]) => {
      const renderedKey = paint(SGR.key, JSON.stringify(key));
      const separator = paint(SGR.punctuation, ':');
      return `${inner}${renderedKey}${separator} ${render(item, indent, inner, paint)}`;
    });
    return (
      paint(SGR.punctuation, '{') +
      '\n' +
      lines.join(paint(SGR.punctuation, ',') + '\n') +
      '\n' +
      current +
      paint(SGR.punctuation, '}')
    );
  }

  // A function, a symbol or a BigInt. Not producible by `JSON.parse`; rendered
  // rather than thrown for the same reason as `undefined` above.
  return paint(SGR.nul, JSON.stringify(String(value)));
}

// -----------------------------------------------------------------------------
// Status lines
// -----------------------------------------------------------------------------

/**
 * Reason phrases for the statuses this API actually returns on success.
 *
 * Deliberately not the full IANA table: `ApiClient.send()` only returns to its
 * caller on a 2xx (everything else has already become an ApiError), so four
 * entries cover every real case, and an unknown status simply prints its
 * number — which is the useful part anyway.
 */
const REASON_PHRASES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
};

/**
 * The one-line "what just happened" that goes to STDERR.
 *
 * On stderr and not stdout even though it is arguably part of the answer,
 * because it is not part of the DATA — see the header of this file. A user
 * reading a terminal sees it interleaved exactly where they expect; a pipe
 * never sees it at all.
 */
export function formatStatusLine(args: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}): string {
  const phrase = REASON_PHRASES[args.status];
  const status = phrase === undefined ? String(args.status) : `${args.status} ${phrase}`;
  return `  ${args.method} ${args.path} → ${status} (${Math.round(args.durationMs)}ms)\n`;
}

// -----------------------------------------------------------------------------
// Spinner
// -----------------------------------------------------------------------------

/** Braille frames: one character wide, so the erase below is exact. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const SPINNER_INTERVAL_MS = 80;

/**
 * How long a request must be in flight before a spinner appears.
 *
 * A local `GET /api/auth/me` answers in single-digit milliseconds, and a
 * spinner that draws and erases itself in that window is a flicker, not
 * feedback. Waiting a beat means it only ever appears when there is genuinely
 * something to wait for.
 */
const SPINNER_DELAY_MS = 150;

/**
 * Start a stderr spinner; returns the function that stops and erases it.
 *
 * THREE PROPERTIES THIS HAS TO GET RIGHT, all of which are silent when wrong:
 *
 *   1. It writes to STDERR ONLY. A spinner on stdout is the textbook way to
 *      corrupt `--raw` (#144 says so explicitly), and it would do so
 *      INTERMITTENTLY — only on requests slow enough to trigger it — which is
 *      the worst kind of bug to be handed in a report.
 *
 *   2. It is disabled whenever stderr is not a TTY. Carriage returns do not
 *      overwrite anything in a CI log; they accumulate into one enormous line
 *      that some viewers refuse to render at all. `commands/login.ts` carries
 *      the same rule for its polling status.
 *
 *   3. Both timers are `unref()`d. A referenced interval keeps the event loop
 *      alive, so a CLI that had already computed its exit code would sit there
 *      spinning instead of exiting. `unref` means the process ends the moment
 *      the real work is done, whatever the timer thinks.
 *
 * The returned stopper is idempotent and MUST be called from a `finally`, so a
 * thrown ApiError cannot leave a half-drawn frame in front of the error
 * message.
 */
export function createSpinner(
  label: string,
  options: { enabled: boolean; stream?: NodeJS.WriteStream | undefined },
): () => void {
  const stream = options.stream ?? process.stderr;

  if (!options.enabled || stream.isTTY !== true) {
    return () => {
      /* nothing was ever drawn, so there is nothing to erase */
    };
  }

  let frame = 0;
  let interval: NodeJS.Timeout | undefined;
  let drawn = false;

  const draw = (): void => {
    const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '';
    frame += 1;
    drawn = true;
    stream.write(`\r  ${glyph} ${label}`);
  };

  const start = setTimeout(() => {
    draw();
    interval = setInterval(draw, SPINNER_INTERVAL_MS);
    interval.unref();
  }, SPINNER_DELAY_MS);
  start.unref();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(start);
    if (interval !== undefined) clearInterval(interval);
    // Erased with spaces rather than an ANSI clear-line sequence: this only
    // ever runs on a TTY, but a terminal that does not implement `ESC[2K`
    // would print the escape literally, and overwriting with blanks cannot
    // fail anywhere. `+ 5` covers the leading two spaces, the glyph and the
    // space after it, with one to spare.
    if (drawn) stream.write(`\r${' '.repeat(label.length + 5)}\r`);
  };
}
