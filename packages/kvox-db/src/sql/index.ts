/**
 * Splits migration SQL into statements: comments are removed, quotes
 * (`'...'`, `"..."`) and dollar-quoted bodies (`$$ ... $$`, `$tag$ ... $tag$`)
 * are respected, and a semicolon outside them ends a statement.
 *
 * @param sql - The text of a `migration.sql`.
 * @returns The statements, trimmed, without their semicolon, empty ones dropped.
 * @stability experimental
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      current += ' ';
    } else if (c === "'" || c === '"') {
      current += c;
      i += 1;
      while (i < n) {
        current += sql[i];
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close < 0 ? n : close + tag[0].length;
        current += sql.slice(i, end);
        i = end;
      } else {
        current += c;
        i += 1;
      }
    } else if (c === ';') {
      statements.push(current.trim());
      current = '';
      i += 1;
    } else {
      current += c;
      i += 1;
    }
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements.filter((statement) => statement !== '');
}

const IDENT = '(?:"[^"]+"|[A-Za-z_][\\w$]*)';
const QUALIFIED = `${IDENT}(?:\\.${IDENT})?`;

function unquote(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1) : identifier.toLowerCase();
}

/** The last part of a possibly schema-qualified identifier, unquoted. */
function unqualify(qualified: string): string {
  const parts = qualified.match(new RegExp(IDENT, 'g')) ?? [qualified];
  return unquote(parts[parts.length - 1]!);
}

/** Splits on commas outside parentheses, brackets and quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const c of text) {
    if (quote) {
      current += c;
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === '(' || c === '[') {
      depth += 1;
      current += c;
    } else if (c === ')' || c === ']') {
      depth -= 1;
      current += c;
    } else if (c === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** The text inside the parenthesis opened at `open`, and what follows its closing one. */
function balanced(text: string, open: number): { inner: string; rest: string } | undefined {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), rest: text.slice(i + 1) };
    }
  }
  return undefined;
}

/**
 * An index a migration creates.
 *
 * @stability experimental
 */
export interface CreatedIndex {
  /** The index name, unquoted. */
  name: string;
  /** The table it is on, unquoted and without a schema. */
  table: string;
  /** Whether it is `UNIQUE`. */
  unique: boolean;
  /** The access method (`btree` when none is written). */
  method: string;
  /** The key columns, or `null` when a key element is an expression. */
  columns: string[] | null;
  /** Whether it has a `WHERE` clause. */
  partial: boolean;
}

const PLAIN_KEY = /^(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s+(?:ASC|DESC|NULLS\s+(?:FIRST|LAST)|[A-Za-z_]\w*_ops))*$/i;
const CREATE_INDEX = new RegExp(
  `^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(?:ONLY\\s+)?(${QUALIFIED})\\s*(?:USING\\s+(\\w+)\\s*)?\\(`,
  'i',
);

/**
 * Reads the indexes the statements create, in statement order.
 *
 * @param statements - Statements from {@link splitSqlStatements}.
 * @returns One entry per `CREATE [UNIQUE] INDEX`.
 * @stability experimental
 */
export function scanCreatedIndexes(statements: readonly string[]): CreatedIndex[] {
  const found: CreatedIndex[] = [];
  for (const statement of statements) {
    const create = CREATE_INDEX.exec(statement);
    if (!create) continue;
    const group = balanced(statement, create[0].length - 1);
    if (!group) continue;
    const elements = splitTopLevel(group.inner);
    const plain = elements.every((element) => PLAIN_KEY.test(element));
    found.push({
      name: unquote(create[2]!),
      table: unqualify(create[3]!),
      unique: Boolean(create[1]),
      method: (create[4] ?? 'btree').toLowerCase(),
      columns: plain ? elements.map((element) => unquote(element.split(/\s+/)[0]!)) : null,
      partial: /\bWHERE\b/i.test(group.rest),
    });
  }
  return found;
}

/**
 * The key columns a `pg_indexes.indexdef` string states, or `null` when a key
 * element is an expression (or the text is not an index definition).
 *
 * @param definition - A `CREATE [UNIQUE] INDEX ... USING method (...)` statement.
 * @returns The column names, unquoted.
 * @stability experimental
 */
export function columnsOfDefinition(definition: string): string[] | null {
  const open = definition.search(/\sUSING\s+\w+\s*\(/i);
  if (open < 0) return null;
  const group = balanced(definition, definition.indexOf('(', open));
  if (!group) return null;
  const elements = splitTopLevel(group.inner);
  if (!elements.every((element) => PLAIN_KEY.test(element))) return null;
  return elements.map((element) => unquote(element.split(/\s+/)[0]!));
}

/**
 * The tables a migration touches and the tables it makes foreign keys point at.
 *
 * @stability experimental
 */
export interface TouchedTables {
  /** Tables created, altered, dropped, indexed, triggered, commented on or written to. */
  targets: Set<string>;
  /** Tables named after `REFERENCES`. */
  references: Set<string>;
  /** Tables created by the migration itself. */
  created: Set<string>;
}

const TARGET_PATTERNS: readonly RegExp[] = [
  new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})`, 'i'),
  new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${QUALIFIED})`, 'i'),
  new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+[^]*?\\sON\\s+(?:ONLY\\s+)?(${QUALIFIED})`, 'i'),
  new RegExp(`^CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+[^]*?\\s(?:ON)\\s+(${QUALIFIED})`, 'i'),
  new RegExp(`^DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}\\s+ON\\s+(${QUALIFIED})`, 'i'),
  new RegExp(`^CREATE\\s+POLICY\\s+${IDENT}\\s+ON\\s+(${QUALIFIED})`, 'i'),
  new RegExp(`^COMMENT\\s+ON\\s+TABLE\\s+(${QUALIFIED})`, 'i'),
  new RegExp(`^COMMENT\\s+ON\\s+COLUMN\\s+(${QUALIFIED})\\.${IDENT}`, 'i'),
  new RegExp(`^INSERT\\s+INTO\\s+(${QUALIFIED})`, 'i'),
  new RegExp(`^UPDATE\\s+(?:ONLY\\s+)?(${QUALIFIED})`, 'i'),
  new RegExp(`^DELETE\\s+FROM\\s+(?:ONLY\\s+)?(${QUALIFIED})`, 'i'),
  new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(${QUALIFIED})`, 'i'),
];
const CREATE_TABLE = new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`, 'i');
const REFERENCES = new RegExp(`\\bREFERENCES\\s+(${QUALIFIED})`, 'gi');

/**
 * Finds the tables the statements touch. Statements about types, functions,
 * extensions and indexes by name alone are not table targets and are skipped.
 *
 * @param statements - Statements from {@link splitSqlStatements}.
 * @returns The target, referenced and created tables.
 * @stability experimental
 */
export function scanTouchedTables(statements: readonly string[]): TouchedTables {
  const targets = new Set<string>();
  const references = new Set<string>();
  const created = new Set<string>();
  for (const statement of statements) {
    const createTable = CREATE_TABLE.exec(statement);
    if (createTable) {
      const name = unqualify(createTable[1]!);
      created.add(name);
      targets.add(name);
    } else {
      for (const pattern of TARGET_PATTERNS) {
        const match = pattern.exec(statement);
        if (match) {
          targets.add(unqualify(match[1]!));
          break;
        }
      }
    }
    for (const reference of statement.matchAll(REFERENCES)) references.add(unqualify(reference[1]!));
  }
  return { targets, references, created };
}
