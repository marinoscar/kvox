import { diffLibraryManifest, type ExistingLibraryFile } from './note-library-diff.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function file(relativePath: string, over: Partial<ExistingLibraryFile> = {}): ExistingLibraryFile {
  return {
    relativePath,
    size: 10,
    mtimeMs: 1000,
    contentHash: HASH_A,
    status: 'imported',
    ...over,
  };
}

const complete = { complete: true };

describe('diffLibraryManifest', () => {
  it('uploads a new path', () => {
    const diff = diffLibraryManifest([], [{ path: 'a.md', size: 1, mtime: 1 }], complete);
    expect(diff.upload).toEqual(['a.md']);
    expect(diff.unchanged).toBe(0);
  });

  it('leaves a file with the same size and mtime unchanged', () => {
    const diff = diffLibraryManifest(
      [file('a.md')],
      [{ path: 'a.md', size: 10, mtime: 1000 }],
      complete
    );
    expect(diff).toMatchObject({
      upload: [],
      hashNeeded: [],
      unchanged: 1,
      unchangedPaths: ['a.md'],
    });
  });

  it('keeps a failed file unchanged when size and mtime are the same (retry is explicit)', () => {
    const diff = diffLibraryManifest(
      [file('a.md', { status: 'failed' }), file('b.md', { status: 'unsupported' })],
      [
        { path: 'a.md', size: 10, mtime: 1000 },
        { path: 'b.md', size: 10, mtime: 1000 },
      ],
      complete
    );
    expect(diff.unchanged).toBe(2);
    expect(diff.upload).toEqual([]);
  });

  it('asks for a hash when size or mtime moved and none was sent', () => {
    const diff = diffLibraryManifest(
      [file('a.md'), file('b.md')],
      [
        { path: 'a.md', size: 11, mtime: 1000 },
        { path: 'b.md', size: 10, mtime: 2000 },
      ],
      complete
    );
    expect(diff.hashNeeded).toEqual(['a.md', 'b.md']);
  });

  it('touches a file whose hash is the stored one', () => {
    const diff = diffLibraryManifest(
      [file('a.md')],
      [{ path: 'a.md', size: 10, mtime: 2000, sha256: HASH_A }],
      complete
    );
    expect(diff.touched).toEqual([{ path: 'a.md', size: 10, mtimeMs: 2000 }]);
    expect(diff.upload).toEqual([]);
  });

  it('uploads a file whose hash differs', () => {
    const diff = diffLibraryManifest(
      [file('a.md')],
      [{ path: 'a.md', size: 12, mtime: 2000, sha256: HASH_B }],
      complete
    );
    expect(diff.upload).toEqual(['a.md']);
    expect(diff.touched).toEqual([]);
  });

  it('uploads when a hash is sent but the file has none stored', () => {
    const diff = diffLibraryManifest(
      [file('a.md', { contentHash: null })],
      [{ path: 'a.md', size: 12, mtime: 2000, sha256: HASH_B }],
      complete
    );
    expect(diff.upload).toEqual(['a.md']);
  });

  it('marks a known path absent from a complete manifest as missing, once', () => {
    const diff = diffLibraryManifest(
      [file('a.md'), file('gone.md'), file('old.md', { status: 'missing' })],
      [{ path: 'a.md', size: 10, mtime: 1000 }],
      complete
    );
    expect(diff.missing).toEqual(['gone.md']);
  });

  it('never marks missing from a partial manifest', () => {
    const diff = diffLibraryManifest(
      [file('a.md'), file('b.md')],
      [{ path: 'a.md', size: 10, mtime: 1000 }],
      {
        complete: false,
      }
    );
    expect(diff.missing).toEqual([]);
  });

  it('treats a rename as missing plus new', () => {
    const diff = diffLibraryManifest(
      [file('old.md')],
      [{ path: 'new.md', size: 10, mtime: 1000 }],
      complete
    );
    expect(diff.missing).toEqual(['old.md']);
    expect(diff.upload).toEqual(['new.md']);
  });

  it('drops and reports invalid paths', () => {
    const diff = diffLibraryManifest(
      [],
      [
        { path: '../x.md', size: 1, mtime: 1 },
        { path: '/abs.md', size: 1, mtime: 1 },
        { path: 'ok.md', size: 1, mtime: 1 },
      ],
      complete
    );
    expect(diff.rejected).toEqual(['../x.md', '/abs.md']);
    expect(diff.upload).toEqual(['ok.md']);
  });

  it('normalises paths and lets the last duplicate win', () => {
    const diff = diffLibraryManifest(
      [file('dir/a.md')],
      [
        { path: 'dir/a.md', size: 99, mtime: 5 },
        { path: './dir\\a.md', size: 10, mtime: 1000 },
      ],
      complete
    );
    expect(diff.unchanged).toBe(1);
    expect(diff.hashNeeded).toEqual([]);
    expect(diff.missing).toEqual([]);
  });
});
