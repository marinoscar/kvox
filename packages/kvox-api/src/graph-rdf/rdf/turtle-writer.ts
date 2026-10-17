// =============================================================================
// A deterministic Turtle writer (issue #385, docs/specs/ontology.md §18.2, §18.4)
// =============================================================================
//
// WHY HAND-WRITTEN. The ontology artefacts are served from ordinary request
// handlers (`GET /api/graph/ontology.ttl`, `…/ontology.shacl.ttl`), and §18.4
// confines RDF libraries (`n3`, `jsonld`, `rdf-validate-shacl`) to the
// export/import JOB handlers — never the request path. Writing Turtle for a
// vocabulary is a small, closed problem, so it is solved here in plain code
// with no dependency, and the tests prove it by parsing every output with `n3`.
//
// DETERMINISTIC BY CONSTRUCTION. Identical input produces byte-identical output:
//   - prefixes are written sorted by prefix name;
//   - subjects are sorted by full IRI;
//   - predicates are sorted by full IRI, except `rdf:type`, written first as `a`;
//   - the objects of one predicate are sorted by their serialized form
//     (RDF lists keep their order — a list's order is its meaning);
//   - `xsd:boolean` and `xsd:integer` use Turtle's bare `true` / `1` syntax.
// Subjects given more than once are merged, and duplicate objects collapse, so
// a generator may describe one IRI from several places.
//
// ⚠ PURE. No Nest, no I/O, no logger.
// =============================================================================

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

export type TurtleTerm =
  | { readonly kind: 'iri'; readonly value: string }
  | { readonly kind: 'literal'; readonly value: string; readonly datatype?: string; readonly lang?: string }
  | { readonly kind: 'list'; readonly items: readonly TurtleTerm[] }
  | { readonly kind: 'bnode'; readonly props: readonly TurtlePredicate[] };

/** One predicate and its objects. */
export interface TurtlePredicate {
  readonly predicate: string;
  readonly objects: readonly TurtleTerm[];
}

export interface TurtleSubject {
  readonly subject: string;
  readonly props: readonly TurtlePredicate[];
}

export interface TurtleDocument {
  /** prefix name → namespace IRI. */
  readonly prefixes: Readonly<Record<string, string>>;
  readonly subjects: readonly TurtleSubject[];
}

// -----------------------------------------------------------------------------
// Term constructors
// -----------------------------------------------------------------------------

export const iri = (value: string): TurtleTerm => ({ kind: 'iri', value });

export function literal(value: string, options: { datatype?: string; lang?: string } = {}): TurtleTerm {
  if (options.datatype !== undefined && options.lang !== undefined) {
    throw new Error('turtle-writer: a literal is either typed or language-tagged, not both');
  }
  return { kind: 'literal', value, ...options };
}

export const list = (items: readonly TurtleTerm[]): TurtleTerm => ({ kind: 'list', items });

export const bnode = (props: readonly TurtlePredicate[]): TurtleTerm => ({ kind: 'bnode', props });

export const po = (predicate: string, ...objects: TurtleTerm[]): TurtlePredicate => ({ predicate, objects });

// -----------------------------------------------------------------------------
// Escaping
// -----------------------------------------------------------------------------

const hex = (code: number, width: number): string => code.toString(16).toUpperCase().padStart(width, '0');

/**
 * Escapes a string for a double-quoted Turtle literal: `\"`, `\\`, `\n`, `\r`,
 * `\t` by name, other control characters as `\uXXXX`, and every non-BMP code
 * point as `\UXXXXXXXX` so the output never depends on how a consumer decodes
 * surrogate pairs. A lone surrogate (not valid in any encoding) becomes U+FFFD.
 */
export function escapeLiteral(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = value[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${hex(code, 4)}`;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        out += `\\U${hex(cp, 8)}`;
        i++;
      } else {
        out += '\\uFFFD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) out += '\\uFFFD';
    else out += ch;
  }
  return out;
}

/**
 * Characters an IRI may not contain at all (controls, space, `<>"{}|^` and
 * backtick, backslash). Turtle cannot carry them even as `\uXXXX` escapes — a
 * conforming reader rejects that — and percent-encoding would silently name a
 * DIFFERENT IRI, so the writer refuses instead. Every IRI the generators
 * produce comes from `iris.ts`, which never builds one.
 */
const IRI_FORBIDDEN = /[\x00-\x20<>"{}|^`\\]/;

function writeIriRef(value: string): string {
  if (IRI_FORBIDDEN.test(value)) {
    throw new Error(`turtle-writer: ${JSON.stringify(value)} contains a character no IRI may contain`);
  }
  return `<${value}>`;
}

/**
 * A local name safe to abbreviate: starts with a letter or `_`, continues with
 * letters, digits, `_`, `-` and inner dots. Anything else (a `/`, a trailing
 * dot) is written as a full `<IRI>` rather than escaped, which every Turtle
 * reader accepts.
 */
const SAFE_LOCAL = /^(?:[A-Za-z_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?)?$/;

const LANG_TAG = /^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/;

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

class Writer {
  /** Namespaces, longest first, so the most specific prefix wins. */
  private readonly namespaces: Array<[string, string]>;

  constructor(prefixes: Readonly<Record<string, string>>) {
    for (const name of Object.keys(prefixes)) {
      if (!/^(?:[A-Za-z][A-Za-z0-9_-]*)?$/.test(name)) {
        throw new Error(`turtle-writer: '${name}' is not a valid prefix name`);
      }
    }
    this.namespaces = Object.entries(prefixes).sort(
      (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
  }

  iri(value: string): string {
    for (const [name, ns] of this.namespaces) {
      if (value.startsWith(ns)) {
        const local = value.slice(ns.length);
        if (SAFE_LOCAL.test(local)) return `${name}:${local}`;
      }
    }
    return writeIriRef(value);
  }

  predicate(value: string): string {
    return value === RDF_TYPE ? 'a' : this.iri(value);
  }

  literal(term: Extract<TurtleTerm, { kind: 'literal' }>): string {
    const quoted = `"${escapeLiteral(term.value)}"`;
    if (term.lang !== undefined) {
      if (!LANG_TAG.test(term.lang)) throw new Error(`turtle-writer: '${term.lang}' is not a language tag`);
      return `${quoted}@${term.lang.toLowerCase()}`;
    }
    // Turtle's own shorthand for the two datatypes it has literal syntax for.
    if (term.datatype === XSD_BOOLEAN && (term.value === 'true' || term.value === 'false')) return term.value;
    if (term.datatype === XSD_INTEGER && /^[+-]?\d+$/.test(term.value)) return term.value;
    if (term.datatype !== undefined && term.datatype !== XSD_STRING) {
      return `${quoted}^^${this.iri(term.datatype)}`;
    }
    return quoted;
  }

  /** A term on one line (blank nodes inline). Used inside lists and for sorting. */
  inline(term: TurtleTerm): string {
    switch (term.kind) {
      case 'iri':
        return this.iri(term.value);
      case 'literal':
        return this.literal(term);
      case 'list':
        return term.items.length === 0 ? '()' : `( ${term.items.map((t) => this.inline(t)).join(' ')} )`;
      case 'bnode': {
        const props = this.sortedProps(term.props);
        if (props.length === 0) return '[]';
        const body = props
          .map((p) => `${this.predicate(p.predicate)} ${p.objects.map((o) => this.inline(o)).join(', ')}`)
          .join(' ; ');
        return `[ ${body} ]`;
      }
    }
  }

  /** A term in object position, where a blank node spreads over several lines. */
  object(term: TurtleTerm, indent: string): string {
    if (term.kind !== 'bnode' || term.props.length === 0) return this.inline(term);
    const inner = `${indent}    `;
    const body = this.predicateLines(term.props, inner).join(' ;\n');
    return `[\n${body}\n${indent}]`;
  }

  predicateLines(props: readonly TurtlePredicate[], indent: string): string[] {
    return this.sortedProps(props).map((p) => {
      const objects = p.objects.map((o) => this.object(o, indent));
      // Several multi-line blank nodes chain as `], [`; anything else gets a line each.
      const separator = objects.some((o) => o.includes('\n')) ? ', ' : `,\n${indent}    `;
      return `${indent}${this.predicate(p.predicate)} ${objects.join(separator)}`;
    });
  }

  /**
   * Merges repeated predicates, removes duplicate objects, and orders both:
   * `rdf:type` first, then predicates by IRI; objects by their inline form
   * (list items keep their order inside the list).
   */
  sortedProps(props: readonly TurtlePredicate[]): TurtlePredicate[] {
    const byPredicate = new Map<string, Map<string, TurtleTerm>>();
    for (const p of props) {
      let objects = byPredicate.get(p.predicate);
      if (objects === undefined) {
        objects = new Map();
        byPredicate.set(p.predicate, objects);
      }
      for (const o of p.objects) objects.set(this.inline(o), o);
    }
    const rank = (predicate: string) => (predicate === RDF_TYPE ? 0 : 1);
    return [...byPredicate.entries()]
      .filter(([, objects]) => objects.size > 0)
      .sort(([a], [b]) => rank(a) - rank(b) || compare(a, b))
      .map(([predicate, objects]) => ({
        predicate,
        objects: [...objects.entries()].sort(([a], [b]) => compare(a, b)).map(([, term]) => term),
      }));
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Serializes a document to Turtle. Output ends with a single newline. */
export function writeTurtle(doc: TurtleDocument): string {
  const writer = new Writer(doc.prefixes);

  const prefixLines = Object.keys(doc.prefixes)
    .sort(compare)
    .map((name) => `@prefix ${name}: ${writeIriRef(doc.prefixes[name])} .`);

  const merged = new Map<string, TurtlePredicate[]>();
  for (const s of doc.subjects) {
    const existing = merged.get(s.subject);
    if (existing === undefined) merged.set(s.subject, [...s.props]);
    else existing.push(...s.props);
  }

  const blocks = [...merged.keys()]
    .sort(compare)
    .map((subject) => {
      const lines = writer.predicateLines(merged.get(subject) ?? [], '    ');
      return lines.length === 0 ? null : `${writer.iri(subject)}\n${lines.join(' ;\n')} .`;
    })
    .filter((block): block is string => block !== null);

  return [prefixLines.join('\n'), ...blocks].filter((part) => part.length > 0).join('\n\n') + '\n';
}
