// =============================================================================
// Pieces .docx and .pptx extraction share (epic #708, issue #711)
// =============================================================================
//
// Relationship parts (`*.rels`), the package title (`docProps/core.xml`), the
// path arithmetic that resolves a relationship target, and the GFM table writer.
// Kept in one file so the two extractors cannot drift on how a table or a
// target is written.
//
// ⚠ PURE. No Nest, no I/O.
// =============================================================================

import { childrenNamed, descendant, parseXml } from './ooxml-xml.js';

/** One `<Relationship>` of a `.rels` part. */
export interface OoxmlRelationship {
  id: string;
  /** The relationship type URI (compare with `endsWith('/notesSlide')`). */
  type: string;
  target: string;
  external: boolean;
}

/** Reads a `.rels` part into a map by relationship id. Throws `OoxmlXmlError` if malformed. */
export function parseRelationships(xml: string | undefined): Map<string, OoxmlRelationship> {
  const map = new Map<string, OoxmlRelationship>();
  if (xml === undefined) return map;

  for (const rel of childrenNamed(parseXml(xml), 'Relationship')) {
    const id = rel.attrs['Id'];
    if (id === undefined) continue;
    map.set(id, {
      id,
      type: rel.attrs['Type'] ?? '',
      target: rel.attrs['Target'] ?? '',
      external: (rel.attrs['TargetMode'] ?? '').toLowerCase() === 'external',
    });
  }
  return map;
}

/**
 * Resolves a relationship target against the directory of the part that owns it.
 * `("ppt", "slides/slide1.xml")` and `("ppt/slides", "../slides/slide1.xml")` and
 * `("ppt", "/ppt/slides/slide1.xml")` all give `ppt/slides/slide1.xml`.
 */
export function resolvePartPath(baseDir: string, target: string): string {
  const parts = target.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** The package's `dc:title` from `docProps/core.xml`, trimmed, or `null`. Never throws. */
export function readCoreTitle(xml: string | undefined): string | null {
  if (xml === undefined) return null;
  try {
    const title = descendant(parseXml(xml), 'title')?.text.replace(/\s+/g, ' ').trim();
    return title ? title : null;
  } catch {
    return null;
  }
}

/** A cell's text made safe for a GFM table row: pipes escaped, newlines as `<br>`. */
export function escapeTableCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim();
}

/**
 * Writes rows of cell text as a GFM table: the first row is the header. Short rows are
 * padded to the widest. Returns `''` when every cell is empty.
 */
export function gfmTable(rows: readonly (readonly string[])[]): string {
  if (!rows.some((row) => row.some((cell) => cell.trim() !== ''))) return '';

  const width = Math.max(...rows.map((row) => row.length), 1);
  const line = (row: readonly string[]) => {
    const cells = Array.from({ length: width }, (_, index) => escapeTableCell(row[index] ?? ''));
    return `| ${cells.join(' | ')} |`;
  };

  const [header, ...body] = rows;
  return [line(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
}
