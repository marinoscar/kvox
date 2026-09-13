// =============================================================================
// .env.example IS the wizard's question list  (issue #174, epic #168)
// =============================================================================
//
// THIS REPOSITORY IS A TEMPLATE. Forks add variables, remove variables and
// rename them. A hardcoded list of questions in the CLI would be wrong the day
// after the fork, and every downstream repository would have to patch appctl
// before it could deploy itself - which is exactly the problem the shell
// scripts this epic replaces already have.
//
// So the questions are DERIVED from infra/compose/.env.example, which is
// already the specification: sections, defaults, and an explanatory comment
// above almost every key. A fork that adds SENTRY_DSN gets a sensible prompt
// with no change to this CLI.
//
// Everything here is pure. No filesystem, no prompting, no process.env.
// =============================================================================

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
  const lines = contents.split('\n');
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

  for (const line of contents.split('\n')) {
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

/** Quotes only when the value would otherwise be re-read incorrectly. */
function renderValue(value: string): string {
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

    lines.push(`${spec.key}=${renderValue(values.get(spec.key) as string)}`);
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
      lines.push(`${key}=${renderValue(values.get(key) as string)}`);
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
