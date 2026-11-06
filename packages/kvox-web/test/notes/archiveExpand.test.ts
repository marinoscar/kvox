/**
 * ZIP expansion in the browser (#813): skip rules, limits, the central-directory flags,
 * and the streaming read. Every archive is built here with fflate; the content is invented.
 */

import { Zip, ZipDeflate, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { NoteArchiveError, expandZipArchive, isZipFile } from '../../src/notes/headless/index.js';

function zipFile(entries: Record<string, Uint8Array>, name = 'Project P1.zip'): File {
  return new File([zipSync(entries) as BlobPart], name, { type: 'application/zip' });
}

const text = (value: string) => strToU8(value);

/** Sets the "encrypted" bit of every central-directory record named `entry`. */
function markEncrypted(bytes: Uint8Array, entry: string): Uint8Array {
  const out = bytes.slice();
  const name = strToU8(entry);
  for (let at = 0; at + 46 < out.length; at += 1) {
    if (out[at] !== 0x50 || out[at + 1] !== 0x4b || out[at + 2] !== 0x01 || out[at + 3] !== 0x02) continue;
    const nameLength = out[at + 28]! | (out[at + 29]! << 8);
    const candidate = out.subarray(at + 46, at + 46 + nameLength);
    if (candidate.length === name.length && candidate.every((byte, i) => byte === name[i])) out[at + 8]! |= 0x01;
  }
  return out;
}

/** A streamed archive (data descriptors, no sizes in the local headers) with its central directory cut off. */
function streamedWithoutDirectory(entries: Record<string, Uint8Array>): File {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, data) => {
    if (err) throw err;
    chunks.push(data);
  });
  for (const [name, data] of Object.entries(entries)) {
    const entry = new ZipDeflate(name);
    zip.add(entry);
    entry.push(data, true);
  }
  zip.end();
  const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  for (let i = 0; i + 4 <= all.length; i += 1) {
    if (all[i] === 0x50 && all[i + 1] === 0x4b && all[i + 2] === 0x01 && all[i + 3] === 0x02) {
      return new File([all.slice(0, i) as BlobPart], 'streamed.zip');
    }
  }
  throw new Error('no central directory found');
}

describe('isZipFile', () => {
  it('knows a .zip by name and by its magic bytes', async () => {
    expect(await isZipFile(new File(['x'], 'notes.zip'))).toBe(true);
    const bytes = zipSync({ 'a.md': text('# A') });
    expect(await isZipFile(new File([bytes as BlobPart], 'bundle.bin'))).toBe(true);
    expect(await isZipFile(new File(['# heading'], 'a.md'))).toBe(false);
  });
});

describe('expandZipArchive', () => {
  it('takes the importable files with paths under the archive name, and skips the rest with reasons', async () => {
    const file = zipFile({
      'Meeting notes.md': text('# Meeting with Person A'),
      'docs/plan.txt': text('Plan for Project P1'),
      'docs/deep/spec.pdf': text('%PDF-1.4 invented'),
      'docs/': new Uint8Array(0),
      '__MACOSX/docs/._plan.txt': text('resource fork'),
      '.DS_Store': text('junk'),
      'docs/.hidden/secret.md': text('hidden'),
      'docs/~$draft.docx': text('lock'),
      'inner.zip': zipSync({ 'x.md': text('x') }),
      'photo.png': text('not really a png'),
      'empty.md': new Uint8Array(0),
      '../evil.md': text('climb'),
      '/abs.md': text('absolute'),
    });

    const result = await expandZipArchive(file);

    expect(result.files.map((entry) => entry.path).sort()).toEqual([
      'Project P1/Meeting notes.md',
      'Project P1/docs/deep/spec.pdf',
      'Project P1/docs/plan.txt',
    ]);
    const plan = result.files.find((entry) => entry.path.endsWith('plan.txt'))!;
    expect(plan.file.name).toBe('plan.txt');
    expect(plan.file.type).toBe('text/plain');
    expect(await plan.file.text()).toBe('Plan for Project P1');

    const reasons = Object.fromEntries(result.rejected.map((entry) => [entry.name, entry.reason]));
    expect(reasons).toMatchObject({
      '._plan.txt': 'system_file',
      '.DS_Store': 'system_file',
      'secret.md': 'system_file',
      '~$draft.docx': 'system_file',
      'inner.zip': 'nested_archive',
      'photo.png': 'in_archive_unsupported',
      'empty.md': 'empty',
      'evil.md': 'unsafe_path',
      'abs.md': 'unsafe_path',
    });
    // Directories are not files: neither taken nor reported.
    expect(result.rejected.some((entry) => entry.path.endsWith('docs/'))).toBe(false);
    expect(result.totals).toMatchObject({ accepted: 3, importable: 3, stopped: false });
  });

  it('normalises backslash paths', async () => {
    const result = await expandZipArchive(zipFile({ 'folder\\note.md': text('# n') }, 'win.zip'));
    expect(result.files.map((entry) => entry.path)).toEqual(['win/folder/note.md']);
  });

  it('reads in small chunks (the streaming path) with progress', async () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 20; i += 1) entries[`n${i}.md`] = text(`# Note ${i}\n${'line\n'.repeat(200)}`);
    const file = zipFile(entries);
    const progress: number[] = [];
    const result = await expandZipArchive(file, { chunkBytes: 256, onProgress: (read) => progress.push(read) });
    expect(result.files).toHaveLength(20);
    expect(progress.length).toBeGreaterThan(3);
    expect(progress[progress.length - 1]).toBe(file.size);
  });

  it('keeps at most maxEntries and counts the rest as importable', async () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 501; i += 1) entries[`note-${i}.md`] = text(`# ${i}`);
    const result = await expandZipArchive(zipFile(entries));
    expect(result.files).toHaveLength(500);
    expect(result.rejected.filter((entry) => entry.reason === 'archive_limit')).toHaveLength(1);
    expect(result.totals).toMatchObject({ accepted: 500, importable: 501 });
  });

  it('refuses an entry over maxEntryBytes from its declared size', async () => {
    const result = await expandZipArchive(zipFile({ 'big.txt': new Uint8Array(5000).fill(66), 'ok.md': text('ok') }), {
      maxEntryBytes: 1000,
    });
    expect(result.files.map((entry) => entry.file.name)).toEqual(['ok.md']);
    expect(result.rejected).toEqual([expect.objectContaining({ name: 'big.txt', reason: 'too_large' })]);
  });

  it('counts bytes while inflating when no size is known, and drops the entry past the limit', async () => {
    const file = streamedWithoutDirectory({
      'big.md': new Uint8Array(50_000).fill(67),
      'small.md': text('# small'),
    });
    const result = await expandZipArchive(file, { maxEntryBytes: 10_000 });
    expect(result.rejected).toEqual([expect.objectContaining({ name: 'big.md', reason: 'too_large' })]);
    expect(result.files.map((entry) => entry.file.name)).toEqual(['small.md']);
  });

  it('refuses a compression-ratio bomb', async () => {
    const result = await expandZipArchive(zipFile({ 'zeros.txt': new Uint8Array(2 * 1024 * 1024) }), {
      maxEntryBytes: 4 * 1024 * 1024,
    });
    expect(result.files).toHaveLength(0);
    expect(result.rejected).toEqual([expect.objectContaining({ name: 'zeros.txt', reason: 'archive_limit' })]);
  });

  it('stops at maxTotalBytes', async () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 10; i += 1) entries[`n${i}.md`] = new Uint8Array(1000).fill(65 + i);
    const result = await expandZipArchive(zipFile(entries), { maxTotalBytes: 3500 });
    expect(result.totals.stopped).toBe(true);
    expect(result.files).toHaveLength(3);
    expect(result.rejected[0]).toMatchObject({ reason: 'archive_limit' });
  });

  it('reports a password-protected entry as encrypted', async () => {
    const bytes = markEncrypted(zipSync({ 'locked.md': text('secret'), 'open.md': text('open') }), 'locked.md');
    const result = await expandZipArchive(new File([bytes as BlobPart], 'mixed.zip'));
    expect(result.files.map((entry) => entry.file.name)).toEqual(['open.md']);
    expect(result.rejected).toEqual([expect.objectContaining({ name: 'locked.md', reason: 'encrypted' })]);
  });

  it('throws NoteArchiveError for something that is not a ZIP', async () => {
    await expect(expandZipArchive(new File(['just some text'], 'fake.zip'))).rejects.toBeInstanceOf(NoteArchiveError);
  });

  it('throws NoteArchiveError over maxArchiveBytes without reading', async () => {
    await expect(expandZipArchive(zipFile({ 'a.md': text('a') }), { maxArchiveBytes: 10 })).rejects.toMatchObject({
      reason: 'archive_limit',
    });
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(expandZipArchive(zipFile({ 'a.md': text('a') }), { signal: controller.signal })).rejects.toBeTruthy();
  });
});
