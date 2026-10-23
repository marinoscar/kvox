// =============================================================================
// A small, safe XML reader for Office Open XML parts (epic #708, issue #711)
// =============================================================================
//
// WHY HAND-ROLLED. The parts a .docx or .pptx extractor reads (`document.xml`,
// `slideN.xml`, `.rels`, `core.xml`) are machine-written, well-formed XML with a
// tiny vocabulary: elements, attributes, text, CDATA, the five predefined
// entities and numeric references. A general XML library would add a dependency
// to every host for that, and the dangerous parts of XML (DTD-declared entities,
// external entities, entity expansion bombs) are exactly what this reader must
// NOT implement. So it is the smallest tokenizer that covers the vocabulary:
//
//   - `<!DOCTYPE ...>`, comments and processing instructions are SKIPPED, never
//     interpreted. An entity this reader does not know (`&foo;`) is left as the
//     literal text, so nothing is ever expanded beyond one character per
//     reference: no billion-laughs, no XXE, no file or network access.
//   - nesting depth is capped (a hostile 100000-deep `<a><a><a>...` would
//     otherwise exhaust a recursive consumer's stack).
//   - element names are reduced to their LOCAL name (`w:p` -> `p`), because the
//     consumers know which part they read; attribute names keep their prefix
//     (`r:id` is not `id`, and `p:sldId` carries both).
//
// A malformed document (unbalanced tags, EOF inside a tag) throws
// `OoxmlXmlError`; the extractors map that to `corrupt_file`.
//
// ⚠ PURE. No Nest, no I/O.
// =============================================================================

/**
 * One element of a parsed part.
 *
 * @stability experimental
 */
export interface XmlElement {
  /** The LOCAL name (the prefix removed): `w:p` is `p`. */
  name: string;
  /** Attributes by their qualified name (`w:val`, `r:id`), entity-decoded. */
  attrs: Record<string, string>;
  /** Child elements in document order. */
  children: XmlElement[];
  /** The element's own character data (direct text and CDATA, concatenated). */
  text: string;
}

/**
 * The part is not well-formed enough to read.
 *
 * @stability experimental
 */
export class OoxmlXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OoxmlXmlError';
  }
}

/** The deepest element nesting the reader accepts. Real Office parts stay under ~40. */
const MAX_DEPTH = 256;

const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decodes the five predefined entities and numeric references; anything else stays literal. */
export function decodeXmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw;

  return raw.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // Reject surrogates, NUL and out-of-range values rather than throw inside a replace.
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return '�';
      }
      return String.fromCodePoint(code);
    }
    return PREDEFINED[ref] ?? whole;
  });
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR.exec(source)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/**
 * Parses one XML part into a light tree and returns its root element.
 *
 * @param xml - the part, decoded to a string (a leading BOM is ignored).
 * @throws OoxmlXmlError when the part is not well-formed.
 * @stability experimental
 */
export function parseXml(xml: string): XmlElement {
  const src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const length = src.length;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;

  const appendText = (raw: string, literal: boolean) => {
    const top = stack[stack.length - 1];
    if (top && raw.length > 0) top.text += literal ? raw : decodeXmlEntities(raw);
  };

  while (i < length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      appendText(src.slice(i), false);
      break;
    }
    if (lt > i) appendText(src.slice(i, lt), false);
    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) throw new OoxmlXmlError('unterminated comment');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end === -1) throw new OoxmlXmlError('unterminated CDATA');
      appendText(src.slice(i + 9, end), true);
      i = end + 3;
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end === -1) throw new OoxmlXmlError('unterminated processing instruction');
      i = end + 2;
    } else if (src.startsWith('<!', i)) {
      // DOCTYPE: skipped, with its internal subset `[ ... ]` if any. Never interpreted.
      let depth = 0;
      let j = i + 2;
      for (; j < length; j += 1) {
        const ch = src[j];
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        else if (ch === '>' && depth <= 0) break;
      }
      if (j >= length) throw new OoxmlXmlError('unterminated declaration');
      i = j + 1;
    } else if (src[i + 1] === '/') {
      const end = src.indexOf('>', i + 2);
      if (end === -1) throw new OoxmlXmlError('unterminated end tag');
      const name = localName(src.slice(i + 2, end).trim());
      const open = stack.pop();
      if (!open || open.name !== name) throw new OoxmlXmlError(`unexpected end tag </${name}>`);
      i = end + 1;
    } else {
      // A start tag. Find its closing '>' while honouring quoted attribute values.
      let j = i + 1;
      let quote = '';
      for (; j < length; j += 1) {
        const ch = src[j];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
      }
      if (j >= length) throw new OoxmlXmlError('unterminated start tag');

      let inner = src.slice(i + 1, j);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);
      const space = inner.search(/\s/);
      const qualified = space === -1 ? inner : inner.slice(0, space);
      if (qualified.length === 0) throw new OoxmlXmlError('empty element name');

      const element: XmlElement = {
        name: localName(qualified),
        attrs: space === -1 ? {} : parseAttrs(inner.slice(space)),
        children: [],
        text: '',
      };

      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element);
      else if (root === null) root = element;
      else throw new OoxmlXmlError('more than one root element');

      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new OoxmlXmlError('elements nested too deeply');
        stack.push(element);
      }
      i = j + 1;
    }
  }

  if (stack.length > 0) throw new OoxmlXmlError(`unclosed element <${stack[stack.length - 1].name}>`);
  if (root === null) throw new OoxmlXmlError('no root element');

  return root;
}

/** The first direct child named `name`, or `undefined`. */
export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((c) => c.name === name);
}

/** Every direct child named `name`. */
export function childrenNamed(element: XmlElement | undefined, name: string): XmlElement[] {
  return element ? element.children.filter((c) => c.name === name) : [];
}

/** The first descendant (depth-first, document order) named `name`, or `undefined`. */
export function descendant(element: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!element) return undefined;
  for (const c of element.children) {
    if (c.name === name) return c;
    const deeper = descendant(c, name);
    if (deeper) return deeper;
  }
  return undefined;
}
