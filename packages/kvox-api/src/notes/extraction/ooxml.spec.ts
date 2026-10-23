// =============================================================================
// .docx / .pptx extraction against fixtures built in the test (epic #708, #711)
// =============================================================================
// Packages are assembled with fflate's `zipSync` from small XML strings, so every
// case is "these parts in, this Markdown out" with no binary fixtures to rot.
// =============================================================================

import { DOCX_MIME_TYPE, PPTX_MIME_TYPE } from '@marinoscar/kvox-contract/notes';
import { strToU8, zipSync } from 'fflate';

import { normalizeDocumentMimeType } from './document-format.js';
import { documentToNoteBody } from './document-to-note.js';
import { extractDocxMarkdown } from './extract-docx.js';
import { extractPptxMarkdown } from './extract-pptx.js';
import { extractDocumentText } from './index.js';
import { decodeXmlEntities, parseXml } from './ooxml-xml.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function zip(parts: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)])));
}

const core = (title: string) =>
  `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`;

const run = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const doc = (body: string) => `<w:document ${W}><w:body>${body}</w:body></w:document>`;

const STYLES = `<w:styles ${W}>
<w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:styleId="Titre"><w:name w:val="Title"/></w:style>
<w:style w:styleId="Custom"><w:name w:val="Custom"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
</w:styles>`;

const NUMBERING = `<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const num = (numId: number, ilvl: number) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;

function docx(body: string, extra: Record<string, string> = {}): Uint8Array {
  return zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': doc(body), ...extra });
}

describe('xml reader', () => {
  it('decodes entities, CDATA, and ignores DOCTYPE/comments/PIs without expanding anything', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><!-- c --><a:r xmlns:a="u"><a:t>1 &amp; 2 &lt; &#65;&#x42; &e; <![CDATA[<raw & >]]></a:t></a:r>`,
    );
    expect(root.name).toBe('r');
    expect(root.children[0].text).toBe('1 & 2 < AB &e; <raw & >');
    expect(decodeXmlEntities('&quot;&apos;&gt;')).toBe('"\'>');
  });

  it('rejects unbalanced markup', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('<a>')).toThrow();
  });
});

describe('extractDocxMarkdown', () => {
  it('writes headings, emphasis, lists with levels, hyperlinks and the core title', () => {
    const body = [
      para(run('Doc'), '<w:pStyle w:val="Titre"/>'),
      para(run('Intro'), '<w:pStyle w:val="Heading2"/>'),
      para(run('plain ') + run('bold', '<w:b/>') + run(' ', '<w:b/>') + run('more', '<w:b/>') + run(' ital', '<w:i/>') + run(' off', '<w:b w:val="0"/>')),
      para(run('custom'), '<w:pStyle w:val="Custom"/>'),
      para(run('a'), num(1, 0)),
      para(run('a1'), num(1, 1)),
      para(run('one'), num(2, 0)),
      para(run('one-a'), num(2, 1)),
      para(run('two'), num(2, 0)),
      para(`<w:hyperlink r:id="rId9">${run('site')}</w:hyperlink>`),
      para('<w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins>' + run('added') + '</w:ins>' + run('x') + '<w:r><w:tab/><w:t>t</w:t></w:r>'),
      `<w:sdt><w:sdtContent>${para(run('inside sdt'))}</w:sdtContent></w:sdt>`,
    ].join('');
    const out = extractDocxMarkdown(
      docx(body, {
        'word/styles.xml': STYLES,
        'word/numbering.xml': NUMBERING,
        'word/_rels/document.xml.rels': `<Relationships xmlns="r"><Relationship Id="rId9" Type="${REL}/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>`,
        'docProps/core.xml': core('Core Title'),
      }),
    );
    expect(out.outcome).toBe('extracted');
    if (out.outcome !== 'extracted') return;
    expect(out.title).toBe('Core Title');
    expect(out.encoding).toBe('ooxml');
    expect(out.pageCount).toBeNull();
    expect(out.text).toBe(
      [
        '# Doc',
        '## Intro',
        'plain **bold more** *ital* off',
        '### custom',
        '- a\n  - a1\n1. one\n  1. one-a\n2. two',
        '[site](https://example.com)',
        'added' + 'x\tt',
        'inside sdt',
      ].join('\n\n'),
    );
  });

  it('writes a GFM table with escaped pipes, <br> joins and merged cells', () => {
    const cell = (inner: string, pr = '') => `<w:tc>${pr ? `<w:tcPr>${pr}</w:tcPr>` : ''}${inner}</w:tc>`;
    const table = `<w:tbl><w:tr>${cell(para(run('H1')))}${cell(para(run('H2')))}</w:tr><w:tr>${cell(para(run('a|b')) + para(run('c')))}${cell(para(run('d')))}</w:tr><w:tr>${cell(para(run('wide')), '<w:gridSpan w:val="2"/>')}</w:tr></w:tbl>`;
    const out = extractDocxMarkdown(docx(table));
    expect(out).toMatchObject({
      outcome: 'extracted',
      text: '| H1 | H2 |\n| --- | --- |\n| a\\|b<br>c | d |\n| wide |  |',
    });
  });

  it('is empty_document for a document with no text', () => {
    expect(extractDocxMarkdown(docx(para('')))).toMatchObject({ outcome: 'unextractable', reason: 'empty_document' });
  });

  it('is corrupt_file for a zip with no word/document.xml or broken XML', () => {
    expect(extractDocxMarkdown(zip({ 'a.txt': 'x' }))).toMatchObject({ reason: 'corrupt_file' });
    expect(extractDocxMarkdown(zip({ 'word/document.xml': '<w:document><w:body>' }))).toMatchObject({
      reason: 'corrupt_file',
    });
  });
});

function pptx(opts: { slides: Record<string, string>; order: string[]; notes?: Record<string, string>; extra?: Record<string, string> }) {
  const parts: Record<string, string> = {
    'ppt/presentation.xml': `<p:presentation ${A}><p:sldIdLst>${opts.order.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="r">${opts.order.map((f, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/${f}"/>`).join('')}</Relationships>`,
    ...opts.extra,
  };
  for (const [f, xml] of Object.entries(opts.slides)) parts[`ppt/slides/${f}`] = xml;
  for (const [f, xml] of Object.entries(opts.notes ?? {})) {
    parts[`ppt/notesSlides/${f}`] = xml;
    parts[`ppt/slides/_rels/${f.replace('notesSlide', 'slide')}.rels`] = `<Relationships xmlns="r"><Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/${f}"/></Relationships>`;
  }
  return zip(parts);
}

const ap = (text: string, lvl = 0) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ''}<a:r><a:t>${text}</a:t></a:r></a:p>`;
const sp = (ph: string | null, paras: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras}</p:txBody></p:sp>`;
const slide = (shapes: string) => `<p:sld ${A}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;

describe('extractPptxMarkdown', () => {
  it('orders by the slide list, writes titles, bullets with levels, tables and notes, and skips empty slides', () => {
    const table = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody>${ap('K')}</a:txBody></a:tc><a:tc><a:txBody>${ap('V')}</a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody>${ap('x')}</a:txBody></a:tc><a:tc><a:txBody>${ap('y')}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const out = extractPptxMarkdown(
      pptx({
        order: ['slide2.xml', 'slide3.xml', 'slide1.xml'],
        slides: {
          'slide1.xml': slide(sp('ctrTitle', ap('Last')) + sp('sldNum', ap('9'))),
          'slide2.xml': slide(sp('title', ap('First')) + sp(null, ap('top') + ap('nested', 1)) + table),
          'slide3.xml': slide(sp(null, '<a:p/>')),
        },
        notes: {
          'notesSlide2.xml': slide(sp('sldImg', ap('img')) + sp('body', ap('say hi') + ap('then bye'))),
        },
        extra: { 'docProps/core.xml': core('Deck') },
      }),
    );
    expect(out.outcome).toBe('extracted');
    if (out.outcome !== 'extracted') return;
    expect(out.pageCount).toBe(3);
    expect(out.title).toBe('Deck');
    expect(out.text).toBe(
      [
        '## Slide 1: First',
        '- top\n  - nested',
        '| K | V |\n| --- | --- |\n| x | y |',
        '> **Notes:** say hi\n> then bye',
        '## Slide 3: Last',
      ].join('\n\n'),
    );
  });

  it('is empty_document for a deck with no text', () => {
    expect(
      extractPptxMarkdown(pptx({ order: ['slide1.xml'], slides: { 'slide1.xml': slide('') } })),
    ).toMatchObject({ outcome: 'unextractable', reason: 'empty_document', pageCount: 1 });
  });
});

describe('package safety', () => {
  it('refuses a zip bomb as archive_too_large without inflating it', () => {
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(100 * 1024 * 1024) });
    expect(extractDocxMarkdown(bomb)).toMatchObject({ outcome: 'unextractable', reason: 'archive_too_large' });
  });

  it('refuses a high-ratio entry under the single-entry cap', () => {
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(20 * 1024 * 1024) });
    expect(extractDocxMarkdown(bomb)).toMatchObject({ reason: 'archive_too_large' });
  });

  it('refuses too many entries', () => {
    const files: Record<string, Uint8Array> = { 'word/document.xml': strToU8(doc(para(run('x')))) };
    for (let i = 0; i < 5001; i += 1) files[`m/${i}`] = new Uint8Array(0);
    expect(extractDocxMarkdown(zipSync(files, { level: 0 }))).toMatchObject({ reason: 'archive_too_large' });
  });

  it('flags the CFB header as unsupported_office_format and garbage as corrupt_file', () => {
    const cfb = new Uint8Array(64);
    cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(extractDocxMarkdown(cfb)).toMatchObject({ reason: 'unsupported_office_format' });
    expect(extractPptxMarkdown(cfb)).toMatchObject({ reason: 'unsupported_office_format' });
    const noise = new Uint8Array(500).map((_, i) => (i * 37 + 11) % 251);
    expect(extractDocxMarkdown(noise)).toMatchObject({ reason: 'corrupt_file' });
  });
});

describe('wiring', () => {
  it('normalizes the Office MIME types and dispatches to the extractors', async () => {
    expect(normalizeDocumentMimeType(`${DOCX_MIME_TYPE}; x=y`)).toBe(DOCX_MIME_TYPE);
    expect(normalizeDocumentMimeType(PPTX_MIME_TYPE)).toBe(PPTX_MIME_TYPE);
    const out = await extractDocumentText(docx(para(run('hello'))), DOCX_MIME_TYPE);
    expect(out).toMatchObject({ outcome: 'extracted', text: 'hello', encoding: 'ooxml' });
  });
});

describe('documentToNoteBody', () => {
  it('titles a docx by core title, then first heading, then file name', async () => {
    const withCore = await documentToNoteBody(docx(para(run('x')), { 'docProps/core.xml': core('  My  Title ') }), DOCX_MIME_TYPE, 'f.docx');
    expect(withCore).toMatchObject({ ok: true, title: 'My Title', bodyFormat: 'markdown', pageCount: null, encoding: 'ooxml' });

    const heading = await documentToNoteBody(
      docx(para(run('Plan', '<w:b/>'), '<w:pStyle w:val="Heading1"/>') + para(run('body')), { 'word/styles.xml': STYLES }),
      DOCX_MIME_TYPE,
      'f.docx',
    );
    expect(heading).toMatchObject({ ok: true, title: 'Plan' });

    const stem = await documentToNoteBody(docx(para(run('body'))), DOCX_MIME_TYPE, 'Quarterly report.docx');
    expect(stem).toMatchObject({ ok: true, title: 'Quarterly report' });
  });

  it('titles a pptx by its first slide title and reports the slide count', async () => {
    const bytes = pptx({ order: ['s.xml'], slides: { 's.xml': slide(sp('title', ap('Kickoff')) + sp(null, ap('a'))) } });
    expect(await documentToNoteBody(bytes, PPTX_MIME_TYPE, 'deck.pptx')).toMatchObject({
      ok: true,
      title: 'Kickoff',
      pageCount: 1,
    });
  });

  it('reads markdown and text through the note importer', async () => {
    const md = await documentToNoteBody(strToU8('# Heading\n\nSome text'), 'text/markdown', 'n.md');
    expect(md).toMatchObject({ ok: true, title: 'Heading', body: 'Some text', bodyFormat: 'markdown', encoding: 'utf-8' });
    const txt = await documentToNoteBody(strToU8('just words'), 'text/plain', 'notes.txt');
    expect(txt).toMatchObject({ ok: true, title: 'notes', body: 'just words' });
    expect(await documentToNoteBody(strToU8('   \n'), 'text/plain', 'e.txt')).toMatchObject({
      ok: false,
      reason: 'empty_note',
    });
  });

  it('maps extraction failures to a reason and a message', async () => {
    const out = await documentToNoteBody(docx(para('')), DOCX_MIME_TYPE, 'e.docx');
    expect(out).toMatchObject({ ok: false, reason: 'empty_document' });
    expect(out.ok ? '' : out.message.length).toBeGreaterThan(0);
  });
});
