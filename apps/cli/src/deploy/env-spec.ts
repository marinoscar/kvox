// =============================================================================
// .env.example IS the wizard's question list  (issue #174, epic #168)
// =============================================================================
//
// THIS REPOSITORY IS A TEMPLATE. Forks add variables, remove variables and
// rename them. A hardcoded list of questions in the CLI would be wrong the day
// after the fork, and every downstream repository would have to patch kvox
// before it could deploy itself - which is exactly the problem the shell
// scripts this epic replaces already have.
//
// So the questions are DERIVED from infra/compose/.env.example, which is
// already the specification: sections, defaults, and an explanatory comment
// above almost every key. A fork that adds SENTRY_DSN gets a sensible prompt
// with no change to this CLI.
//
// Everything here is pure. No filesystem, no prompting, no process.env. The
// one thing it does besides compute is REFUSE: serializeEnvFile throws on a
// value it cannot honestly write (issue #259, argued at assertWritableValue).
// =============================================================================

import { UsageError } from '../errors.js';

export interface EnvVarSpec {
  key: string;
  /** The section banner this key appeared under. '' before the first one. */
  section: string;
  /** Template value, with any trailing inline comment removed. */
  defaultValue: string;
  /** The comment lines immediately above the key, joined with newlines. */
  help: string;
  /** True when the key appeared commented out (`# KEY=value`). */
  optional: boolean;
  /** 1-based line in the source file, for error messages. */
  line: number;
}

/**
 * Splits a file into lines, tolerating Windows endings.
 *
 * MUST BE THE ONLY WAY THIS MODULE SPLITS LINES (issue #259). A bare
 * `split('\n')` leaves a trailing `\r` on every line of a CRLF file, and the
 * consequence is not the mangled value it looks like - it is TOTAL SILENT
 * DATA LOSS. In JavaScript, unlike most other languages, `.` does NOT match
 * `\r` (CR is a line terminator, so `.` excludes it alongside `\n`), and `$`
 * without the `m` flag matches only the very end of the input. So `ASSIGNMENT`
 * does not match `KEY=value\r` AT ALL: the line is skipped, and a CRLF `.env`
 * parses to an EMPTY map while reporting no error of any kind.
 *
 * A CRLF `.env.example` is worse still - no assignments, no banners, no help -
 * because `COMMENT` and `BANNER_RULE` miss for the same reason, so the wizard
 * has no questions to ask.
 *
 * Splitting on `'\n'` and then removing one trailing `\r` is used rather than
 * `split(/\r?\n/)` deliberately: it keeps array indices identical to the LF
 * case, which `parseEnvExample` reports as `line` and uses to look ahead at
 * the two lines of a section banner.
 */
function splitLines(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** `# ----` or `# ====` - the rules that fence a section title. */
const BANNER_RULE = /^#\s*[-=]{3,}\s*$/;

/** A comment line, capturing its text. */
const COMMENT = /^#\s?(.*)$/;

/** `KEY=value`. The key shape is what keeps prose from matching. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** `# KEY=value` - a commented-out assignment, i.e. an optional variable. */
const COMMENTED_ASSIGNMENT = /^#\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Removes a trailing `# comment` from a value.
 *
 * Docker Compose's env_file parser does NOT do this, which is why
 * `MAX_FILE_SIZE=10737418240  # 10GB in bytes` was a real bug (#170). A
 * generated .env must not reproduce it.
 *
 * Only a `#` PRECEDED BY WHITESPACE counts, and never one inside quotes: a
 * password may legitimately contain `#`, and `PASSWORD=a#b` means what it says.
 */
export function stripInlineComment(rawValue: string): string {
  let quote: string | undefined;

  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];

    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && index > 0 && /\s/.test(rawValue[index - 1] ?? '')) {
      return rawValue.slice(0, index).trimEnd();
    }
  }

  return rawValue.trimEnd();
}

/** Removes one matching pair of surrounding quotes, as Compose does. */
export function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parses a `.env.example` into an ordered spec.
 *
 * File order is preserved, because the order the template presents its
 * variables in was chosen by whoever wrote it and is a better question order
 * than anything this code could invent.
 */
export function parseEnvExample(contents: string): EnvVarSpec[] {
  const lines = splitLines(contents);
  const specs: EnvVarSpec[] = [];

  let section = '';
  let help: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    // A section title is a comment fenced by two rules. Consuming all three
    // together is what keeps the rules themselves out of the help text.
    if (BANNER_RULE.test(line)) {
      const titleLine = lines[index + 1] ?? '';
      const closing = lines[index + 2] ?? '';
      const title = COMMENT.exec(titleLine)?.[1]?.trim();

      if (
        title !== undefined &&
        title !== '' &&
        !BANNER_RULE.test(titleLine) &&
        BANNER_RULE.test(closing)
      ) {
        section = title;
        index += 2;
        help = [];
        continue;
      }

      // A lone rule - the top-of-file header block. Not a section.
      help = [];
      continue;
    }

    if (line.trim() === '') {
      // A blank line ends a comment block, so help text belongs to the key it
      // actually sits above rather than to something four paragraphs earlier.
      help = [];
      continue;
    }

    const assignment = ASSIGNMENT.exec(line);
    if (assignment !== null) {
      specs.push({
        key: assignment[1] as string,
        section,
        defaultValue: unquote(stripInlineComment(assignment[2] as string)),
        help: help.join('\n'),
        optional: false,
        line: index + 1,
      });
      help = [];
      continue;
    }

    const commented = COMMENTED_ASSIGNMENT.exec(line);
    if (commented !== null) {
      // A commented-out assignment is an OPTIONAL VARIABLE, not prose. Prose
      // rarely has `IDENTIFIER=` immediately after the `#`, which is what the
      // key shape in the pattern is doing.
      specs.push({
        key: commented[1] as string,
        section,
        defaultValue: unquote(stripInlineComment(commented[2] as string)),
        help: help.join('\n'),
        optional: true,
        line: index + 1,
      });
      help = [];
      continue;
    }

    const comment = COMMENT.exec(line);
    if (comment !== null) {
      help.push((comment[1] ?? '').trimEnd());
      continue;
    }

    help = [];
  }

  return specs;
}

/** Parses a real `.env` into key/value pairs. Comments and blanks ignored. */
export function parseEnvFile(contents: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const line of splitLines(contents)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const assignment = ASSIGNMENT.exec(line);
    if (assignment === null) continue;

    values.set(
      assignment[1] as string,
      unquote(stripInlineComment(assignment[2] as string)),
    );
  }

  return values;
}

/** The control characters a `.env` value can never carry. */
const CONTROL_CHARACTER_NAMES: ReadonlyMap<string, string> = new Map([
  ['\r', 'a carriage return (CR)'],
  ['\n', 'a line feed (LF)'],
]);

/**
 * Refuses to write a value carrying CR or LF. The safety net for issue #259.
 *
 * REFUSE RATHER THAN STRIP, for three reasons, in order of weight:
 *
 * 1. THE CAPABILITY DOES NOT EXIST, so refusing withholds nothing. A `.env`
 *    is a line-oriented format: every reader of it, this module included,
 *    splits on newlines before it looks at anything. A value containing one
 *    cannot round-trip through the file by construction - `KEY=a\nb` is
 *    written, read back as `KEY=a`, and `b` is silently discarded as an
 *    unparseable line. Stripping would not be preserving a value the format
 *    supports; it would be picking, quietly, which half of it to lose.
 *
 * 2. STRIPPING FAILS INVISIBLY, WHICH IS THE PROPERTY THAT CAUSED #259. The
 *    original bug was not that a carriage return existed - it was that
 *    `renderValue` QUOTED it, wrote it back looking deliberate, and nothing
 *    ever said so. A silent strip has the same shape: the operator reads a
 *    plausible-looking `.env`, never learns their input was altered, and
 *    debugs the resulting behaviour against a value they believe they set.
 *    A wrong value nobody is told about is worse than a refused install.
 *
 * 3. THE COST ASYMMETRY FAVOURS STOPPING. A refusal here is expensive - it
 *    can land after a four-minute build and cost a re-run. But the measured
 *    alternative is what #259 actually cost: an install reported as failed on
 *    a deployment that had been serving correctly for eleven hours, with a
 *    message (`Missing expected LF after header value`) pointing away from
 *    the cause. Cheap and loud beats expensive and silent.
 *
 * With `splitLines` above in place there is no parse path left that can
 * produce such a value, so in practice this fires only on an operator's own
 * `--answer`/`--answers-file` input (`ANSWER_FLAG` captures with `[\s\S]*`
 * and sanitises nothing) or on a fork's own code - both cases where a human
 * chose the value and should be told, not overruled.
 */
function assertWritableValue(key: string, value: string): void {
  for (const [character, name] of CONTROL_CHARACTER_NAMES) {
    const index = value.indexOf(character);
    if (index === -1) continue;

    throw new UsageError(
      `${key} contains ${name} at position ${index}, which cannot be written to a .env file.\n` +
        `A .env is line-oriented, so such a value cannot be read back as written - and a control\n` +
        `character that reaches a generated config (an nginx header, for one) makes the output\n` +
        `malformed in ways that are hard to trace back here.\n` +
        `Remove it from the value and re-run. If it came from --answer or --answers-file, check\n` +
        `that file's line endings: a CRLF file edited on Windows is the usual source.`,
    );
  }
}

/** Quotes only when the value would otherwise be re-read incorrectly. */
function renderValue(key: string, value: string): string {
  assertWritableValue(key, value);
  if (value === '') return '';
  // A `#` after whitespace would be re-read as a comment, and leading or
  // trailing whitespace would be silently kept. Quote in those cases only, so
  // the common case stays diffable against the template.
  if (/(^\s|\s$)/.test(value) || /\s#/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Renders a `.env`, keeping the template's section banners and key order.
 *
 * Diffability is the point: an operator should be able to compare a generated
 * .env against .env.example and see only their own answers.
 *
 * Throws `UsageError` naming the key if any value carries CR or LF - see
 * `assertWritableValue` for why that is a refusal rather than a repair.
 */
export function serializeEnvFile(
  values: ReadonlyMap<string, string>,
  specs: readonly EnvVarSpec[],
): string {
  const lines: string[] = [];
  const written = new Set<string>();
  let section: string | undefined;

  for (const spec of specs) {
    if (!values.has(spec.key)) continue;

    if (spec.section !== section) {
      section = spec.section;
      if (lines.length > 0) lines.push('');
      if (section !== '') {
        lines.push(`# ${'-'.repeat(77)}`);
        lines.push(`# ${section}`);
        lines.push(`# ${'-'.repeat(77)}`);
      }
    }

    lines.push(`${spec.key}=${renderValue(spec.key, values.get(spec.key) as string)}`);
    written.add(spec.key);
  }

  // Keys the template does not know about - a fork's own additions, or
  // something an operator added by hand. Carried through rather than dropped;
  // silently losing a value someone set is the worst thing this could do.
  const extra = [...values.keys()].filter((key) => !written.has(key));
  if (extra.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`# ${'-'.repeat(77)}`);
    lines.push('# Not in .env.example');
    lines.push(`# ${'-'.repeat(77)}`);
    for (const key of extra) {
      lines.push(`${key}=${renderValue(key, values.get(key) as string)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export interface EnvDiff {
  /** In the template, absent from the file. The drift `update` reports (#182). */
  missing: EnvVarSpec[];
  /** In the file, unknown to the template. Never dropped. */
  unknown: string[];
}

export function diffEnv(
  specs: readonly EnvVarSpec[],
  current: ReadonlyMap<string, string>,
): EnvDiff {
  const known = new Set(specs.map((spec) => spec.key));

  return {
    missing: specs.filter((spec) => !current.has(spec.key)),
    unknown: [...current.keys()].filter((key) => !known.has(key)),
  };
}
