// =============================================================================
// PowerPoint (.pptx) to Markdown (epic #708, issue #711)
// =============================================================================
//
// ONE `## Slide N: Title` SECTION PER SLIDE, in PRESENTATION ORDER. The order is
// NOT the file names: `slide2.xml` can come first in the deck. `presentation.xml`
// lists the slides (`p:sldIdLst`) by relationship id, and the `.rels` part maps
// each id to its file, so that is the only order trusted.
//
//   title     the shape whose placeholder type is `title` or `ctrTitle`
//   body      every other text shape: one bullet per paragraph, indented by the
//             paragraph's `lvl`; tables (`a:tbl` in a graphic frame) become GFM
//   notes     the slide's notes page (relationship type `.../notesSlide`), the
//             body placeholder only, as `> **Notes:** ...` (the notes page's
//             slide-image and slide-number placeholders are not notes)
//   skipped   footer, date and slide-number placeholders; pictures; a slide with
//             no text at all (it keeps its number, so "Slide 7" is still slide 7)
//
// `pageCount` is the number of slides, including skipped ones.
//
// ⚠ PURE. No Nest, no I/O. A malformed XML part is `corrupt_file`, never a throw.
// =============================================================================

import type { OoxmlExtractionOutcome } from './extract-docx.js';
import { gfmTable, parseRelationships, readCoreTitle, resolvePartPath } from './ooxml-common.js';
import {
  child,
  childrenNamed,
  descendant,
  OoxmlXmlError,
  parseXml,
  type XmlElement,
} from './ooxml-xml.js';
import { openOoxmlPackage, partText } from './ooxml-zip.js';

const TITLE_TYPES = new Set(['title', 'ctrTitle']);
/** Placeholders that carry slide furniture, never content. */
const FURNITURE_TYPES = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);

interface Paragraph {
  level: number;
  text: string;
}

function paragraphText(p: XmlElement): string {
  let out = '';
  for (const node of p.children) {
    if (node.name === 'r') {
      out += child(node, 't')?.text ?? '';
    } else if (node.name === 'fld') {
      if (!(node.attrs['type'] ?? '').toLowerCase().startsWith('slidenum')) out += child(node, 't')?.text ?? '';
    } else if (node.name === 'br') {
      out += ' ';
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function shapeParagraphs(shape: XmlElement): Paragraph[] {
  const txBody = child(shape, 'txBody');
  const result: Paragraph[] = [];
  for (const p of childrenNamed(txBody, 'p')) {
    const text = paragraphText(p);
    if (text === '') continue;
    const lvl = Number.parseInt(child(p, 'pPr')?.attrs['lvl'] ?? '0', 10);
    result.push({ level: Number.isFinite(lvl) ? Math.max(0, Math.min(lvl, 8)) : 0, text });
  }
  return result;
}

function placeholderType(shape: XmlElement): string | null {
  const ph = descendant(child(shape, 'nvSpPr'), 'ph');
  return ph ? (ph.attrs['type'] ?? 'body') : null;
}

function renderTable(table: XmlElement): string {
  const rows = childrenNamed(table, 'tr').map((tr) =>
    childrenNamed(tr, 'tc').map((tc) =>
      childrenNamed(child(tc, 'txBody'), 'p')
        .map(paragraphText)
        .filter((text) => text !== '')
        .join('\n'),
    ),
  );
  return gfmTable(rows);
}

interface SlideContent {
  title: string | null;
  blocks: string[];
}

function readSlide(root: XmlElement): SlideContent {
  const titleParts: string[] = [];
  const blocks: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length > 0) blocks.push(bullets.join('\n'));
    bullets = [];
  };

  const visit = (tree: XmlElement) => {
    for (const node of tree.children) {
      if (node.name === 'sp') {
        const type = placeholderType(node);
        if (type !== null && FURNITURE_TYPES.has(type)) continue;
        const paragraphs = shapeParagraphs(node);
        if (type !== null && TITLE_TYPES.has(type)) {
          titleParts.push(paragraphs.map((p) => p.text).join(' '));
        } else {
          for (const p of paragraphs) bullets.push(`${'  '.repeat(p.level)}- ${p.text}`);
        }
      } else if (node.name === 'graphicFrame') {
        const table = descendant(node, 'tbl');
        if (table) {
          flush();
          const text = renderTable(table);
          if (text !== '') blocks.push(text);
        }
      } else if (node.name === 'grpSp') {
        visit(node);
      }
    }
  };

  const spTree = descendant(root, 'spTree');
  if (spTree) visit(spTree);
  flush();

  const title = titleParts.join(' ').replace(/\s+/g, ' ').trim();
  return { title: title === '' ? null : title, blocks };
}

function readNotes(root: XmlElement): string[] {
  const lines: string[] = [];
  const spTree = descendant(root, 'spTree');
  for (const sp of childrenNamed(spTree, 'sp')) {
    if (placeholderType(sp) !== 'body') continue;
    for (const p of shapeParagraphs(sp)) lines.push(p.text);
  }
  return lines;
}

/**
 * Turn a `.pptx` into Markdown, or into the reason it cannot be.
 *
 * @param bytes - the uploaded file.
 * @stability experimental
 */
export function extractPptxMarkdown(bytes: Uint8Array): OoxmlExtractionOutcome {
  const pkg = openOoxmlPackage(
    bytes,
    (name) =>
      name === 'ppt/presentation.xml' ||
      name === 'ppt/_rels/presentation.xml.rels' ||
      name === 'docProps/core.xml' ||
      /^ppt\/slides\/[^/]+\.xml$/.test(name) ||
      /^ppt\/slides\/_rels\/[^/]+\.rels$/.test(name) ||
      /^ppt\/notesSlides\/[^/]+\.xml$/.test(name),
  );
  if (!pkg.ok) return { outcome: 'unextractable', reason: pkg.reason, pageCount: null };

  const presentationXml = partText(pkg.files, 'ppt/presentation.xml');
  if (presentationXml === undefined) return { outcome: 'unextractable', reason: 'corrupt_file', pageCount: null };

  try {
    const rels = parseRelationships(partText(pkg.files, 'ppt/_rels/presentation.xml.rels'));
    const slideIds = childrenNamed(child(parseXml(presentationXml), 'sldIdLst'), 'sldId');
    const slidePaths: string[] = [];
    for (const slideId of slideIds) {
      const rel = rels.get(slideId.attrs['r:id'] ?? '');
      if (rel) slidePaths.push(resolvePartPath('ppt', rel.target));
    }

    const sections: string[] = [];
    slidePaths.forEach((path, index) => {
      const xml = partText(pkg.files, path);
      if (xml === undefined) return;
      const slide = readSlide(parseXml(xml));

      // The slide's notes page, through the slide's own relationships.
      const slideDir = path.slice(0, path.lastIndexOf('/'));
      const slideFile = path.slice(path.lastIndexOf('/') + 1);
      const slideRels = parseRelationships(partText(pkg.files, `${slideDir}/_rels/${slideFile}.rels`));
      let notes: string[] = [];
      for (const rel of slideRels.values()) {
        if (!rel.type.endsWith('/notesSlide')) continue;
        const notesXml = partText(pkg.files, resolvePartPath(slideDir, rel.target));
        if (notesXml !== undefined) notes = readNotes(parseXml(notesXml));
        break;
      }

      if (slide.title === null && slide.blocks.length === 0 && notes.length === 0) return;

      const parts = [slide.title === null ? `## Slide ${index + 1}` : `## Slide ${index + 1}: ${slide.title}`];
      parts.push(...slide.blocks);
      if (notes.length > 0) {
        parts.push(notes.map((line, n) => (n === 0 ? `> **Notes:** ${line}` : `> ${line}`)).join('\n'));
      }
      sections.push(parts.join('\n\n'));
    });

    const text = sections.join('\n\n').trim();
    if (text === '') {
      return { outcome: 'unextractable', reason: 'empty_document', pageCount: slidePaths.length };
    }

    return {
      outcome: 'extracted',
      text,
      pageCount: slidePaths.length,
      encoding: 'ooxml',
      title: readCoreTitle(partText(pkg.files, 'docProps/core.xml')),
    };
  } catch (error) {
    if (error instanceof OoxmlXmlError) return { outcome: 'unextractable', reason: 'corrupt_file', pageCount: null };
    throw error;
  }
}

/**
 * Same as {@link extractPptxMarkdown}, shaped like the other extractors (a promise).
 *
 * @stability experimental
 */
export function extractPptxText(bytes: Uint8Array): Promise<OoxmlExtractionOutcome> {
  return Promise.resolve(extractPptxMarkdown(bytes));
}
