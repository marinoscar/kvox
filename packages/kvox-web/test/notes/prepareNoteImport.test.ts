/**
 * The pre-flight manifest (#813): loose files and archives mixed, counts by kind, unique
 * paths across both, and the batch cap. Invented content only.
 */

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { checkNoteImportFiles, prepareNoteImport } from '../../src/notes/headless/index.js';

const zip = (entries: Record<string, string>, name: string) =>
  new File([zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]))) as BlobPart], name);

describe('prepareNoteImport', () => {
  it('mixes loose files and archive entries, counts them by kind, and skips with reasons', async () => {
    const manifest = await prepareNoteImport([
      new File(['# A'], 'a.md'),
      new File(['plain'], 'b.txt'),
      new File(['x'], 'tool.exe'),
      zip({ 'Org Alpha/report.pdf': '%PDF invented', 'Org Alpha/deck.pptx': 'pk', 'notes.markdown': '# N', 'x.png': 'p' }, 'bundle.zip'),
    ]);

    expect(manifest.accepted.map((entry) => entry.path)).toEqual([
      'a.md',
      'b.txt',
      'bundle/Org Alpha/report.pdf',
      'bundle/Org Alpha/deck.pptx',
      'bundle/notes.markdown',
    ]);
    expect(manifest.counts).toEqual({ pdf: 1, docx: 0, pptx: 1, md: 2, txt: 1 });
    expect(manifest.archives).toBe(1);
    expect(manifest.totalBytes).toBe(manifest.accepted.reduce((sum, entry) => sum + entry.size, 0));
    expect(manifest.rejected).toEqual([
      expect.objectContaining({ name: 'tool.exe', reason: 'unsupported' }),
      expect.objectContaining({ name: 'x.png', path: 'bundle/x.png', reason: 'in_archive_unsupported' }),
    ]);
    expect(manifest.refusal).toBeNull();
  });

  it('makes paths unique across loose files and archives', async () => {
    const manifest = await prepareNoteImport([
      new File(['1'], 'a.md'),
      new File(['2'], 'a.md'),
      zip({ 'a.md': '3' }, 'a.zip'),
      zip({ 'a.md': '4' }, 'a (copy).zip'),
    ]);
    expect(manifest.accepted.map((entry) => entry.path)).toEqual(['a.md', 'a (2).md', 'a/a.md', 'a (copy)/a.md']);
  });

  it('refuses more files than one batch takes, and says to split', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 4; i += 1) entries[`n${i}.md`] = `# ${i}`;
    const manifest = await prepareNoteImport([zip(entries, 'four.zip'), new File(['x'], 'loose.md')], { maxFiles: 3 });
    expect(manifest.refusal).toMatchObject({ reason: 'batch_too_large', found: 5, limit: 3 });
    expect(manifest.refusal!.message).toMatch(/split it/i);
  });

  it('reports an unreadable archive as one rejection', async () => {
    const manifest = await prepareNoteImport([new File(['not a zip at all'], 'broken.zip'), new File(['# ok'], 'ok.md')]);
    expect(manifest.accepted.map((entry) => entry.path)).toEqual(['ok.md']);
    expect(manifest.rejected).toEqual([expect.objectContaining({ name: 'broken.zip', reason: 'archive_unreadable' })]);
  });

  it('reports unpacking progress per archive', async () => {
    const seen: string[] = [];
    await prepareNoteImport([zip({ 'a.md': 'a' }, 'one.zip'), zip({ 'b.md': 'b' }, 'two.zip')], {
      onProgress: (p) => seen.push(`${p.archive} ${p.archiveIndex}/${p.archiveCount}`),
    });
    expect(seen).toContain('one.zip 1/2');
    expect(seen).toContain('two.zip 2/2');
  });

  it('leaves checkNoteImportFiles as it was: a ZIP is unsupported there', () => {
    const check = checkNoteImportFiles([new File(['x'], 'a.zip'), new File(['x'], 'a.md')]);
    expect(check.accepted.map((file) => file.name)).toEqual(['a.md']);
    expect(check.rejected).toEqual([expect.objectContaining({ reason: 'unsupported' })]);
  });
});
