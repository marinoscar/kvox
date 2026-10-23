import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  KvoxFileAccessError,
  createBrowserFileAccess,
  filesFromDirectoryInput,
  scanFolder,
  sha256Hex,
} from '../../src/core/headless/index.js';
import type {
  BrowserDirectoryHandleLike,
  BrowserFileHandleLike,
  KvoxFileEntry,
} from '../../src/core/headless/index.js';

// -----------------------------------------------------------------------------
// A fake FileSystemDirectoryHandle tree
// -----------------------------------------------------------------------------

type Tree = { [name: string]: string | Tree };

function fileHandle(name: string, content: string, mtime: number): BrowserFileHandleLike {
  return {
    kind: 'file',
    name,
    getFile: async () => new File([content], name, { lastModified: mtime }),
  };
}

function dirHandle(
  name: string,
  tree: Tree,
  permission: { query?: PermissionState; request?: PermissionState } = { query: 'granted' },
): BrowserDirectoryHandleLike & { requestPermission: ReturnType<typeof vi.fn> } {
  const children = new Map<string, BrowserDirectoryHandleLike | BrowserFileHandleLike>();
  let mtime = 1_700_000_000_000;
  for (const [child, value] of Object.entries(tree)) {
    children.set(child, typeof value === 'string' ? fileHandle(child, value, mtime++) : dirHandle(child, value));
  }
  const handle = {
    kind: 'directory' as const,
    name,
    async *values() {
      yield* children.values();
    },
    async getDirectoryHandle(child: string) {
      const found = children.get(child);
      if (found?.kind !== 'directory') throw new DOMException('missing', 'NotFoundError');
      return found;
    },
    async getFileHandle(child: string) {
      const found = children.get(child);
      if (found?.kind !== 'file') throw new DOMException('missing', 'NotFoundError');
      return found;
    },
    queryPermission: async () => permission.query ?? 'prompt',
    requestPermission: vi.fn(async () => permission.request ?? 'denied'),
    async isSameEntry(other: BrowserDirectoryHandleLike) {
      return other === handle;
    },
  };
  return handle;
}

const TREE: Tree = {
  'Plan.MD': '# plan',
  'notes.txt': 'hello',
  'image.png': 'png',
  README: 'no extension',
  '.hidden.md': 'hidden',
  '.git': { 'HEAD.md': 'x' },
  node_modules: { 'pkg.md': 'x' },
  '2024': { 'q1.pdf': 'pdf', deeper: { 'deck.PPTX': 'pptx', '.DS_Store': 'x' } },
};

const EXTENSIONS = ['md', 'markdown', 'txt', 'pdf', 'docx', 'pptx'] as const;

async function collect(iterable: AsyncIterable<KvoxFileEntry>): Promise<KvoxFileEntry[]> {
  const out: KvoxFileEntry[] = [];
  for await (const entry of iterable) out.push(entry);
  return out;
}

function handlePort(root: BrowserDirectoryHandleLike, extra: { indexedDB?: IDBFactory | null } = {}) {
  let n = 0;
  return createBrowserFileAccess({
    globals: { showDirectoryPicker: async () => root },
    indexedDB: extra.indexedDB === undefined ? null : extra.indexedDB,
    createId: () => `folder-${++n}`,
  });
}

describe('createBrowserFileAccess (File System Access)', () => {
  it('reports persistent folders and no watcher', () => {
    const port = handlePort(dirHandle('Notes', TREE));
    expect(port.capabilities).toEqual({ persistentFolders: true, watch: false, hashInHost: false });
    expect(port.watch).toBeUndefined();
  });

  it('enumerates recursively, filters by extension case-insensitively and skips hidden entries and node_modules', async () => {
    const port = handlePort(dirHandle('Notes', TREE));
    const ref = await port.pickFolder();
    expect(ref).toEqual({ id: 'folder-1', name: 'Notes' });

    const entries = await collect(port.enumerate(ref!, { extensions: EXTENSIONS }));
    expect(entries.map((e) => e.path).sort()).toEqual(['2024/deeper/deck.PPTX', '2024/q1.pdf', 'Plan.MD', 'notes.txt']);
    const notes = entries.find((e) => e.path === 'notes.txt')!;
    expect(notes.size).toBe(5);
    expect(typeof notes.mtime).toBe('number');
  });

  it('accepts extensions with a dot or in upper case', async () => {
    const port = handlePort(dirHandle('Notes', TREE));
    const ref = (await port.pickFolder())!;
    const entries = await collect(port.enumerate(ref, { extensions: ['.PDF'] }));
    expect(entries.map((e) => e.path)).toEqual(['2024/q1.pdf']);
  });

  it('works without IndexedDB: folders and library bindings live in memory', async () => {
    const port = handlePort(dirHandle('Notes', TREE), { indexedDB: null });
    const ref = (await port.pickFolder())!;
    expect(await port.listFolders()).toEqual([ref]);

    await port.setLibraryFolder('lib-1', ref);
    expect(await port.getLibraryFolder('lib-1')).toEqual(ref);
    await port.setLibraryFolder('lib-1', null);
    expect(await port.getLibraryFolder('lib-1')).toBeNull();

    await port.setLibraryFolder('lib-2', ref);
    await port.forgetFolder(ref);
    expect(await port.listFolders()).toEqual([]);
    expect(await port.getLibraryFolder('lib-2')).toBeNull();
  });

  it('falls back to memory when the IndexedDB factory throws', async () => {
    const broken = {
      open: () => {
        throw new Error('blocked');
      },
    } as unknown as IDBFactory;
    const port = handlePort(dirHandle('Notes', TREE), { indexedDB: broken });
    const ref = (await port.pickFolder())!;
    expect(await port.listFolders()).toEqual([ref]);
  });

  it('reuses the ref when the same folder is picked again', async () => {
    const root = dirHandle('Notes', TREE);
    const port = handlePort(root);
    const first = await port.pickFolder();
    const second = await port.pickFolder();
    expect(second).toEqual(first);
    expect(await port.listFolders()).toHaveLength(1);
  });

  it('resolves null when the user cancels the picker', async () => {
    const port = createBrowserFileAccess({
      globals: {
        showDirectoryPicker: async () => {
          throw new DOMException('cancelled', 'AbortError');
        },
      },
      indexedDB: null,
    });
    expect(await port.pickFolder()).toBeNull();
  });

  it('asks for read permission and refuses when it is denied', async () => {
    const root = dirHandle('Notes', TREE, { query: 'prompt', request: 'denied' });
    const port = handlePort(root);
    const ref = (await port.pickFolder())!;
    await expect(collect(port.enumerate(ref, { extensions: EXTENSIONS }))).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(root.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('proceeds once permission is granted on request', async () => {
    const root = dirHandle('Notes', TREE, { query: 'prompt', request: 'granted' });
    const port = handlePort(root);
    const ref = (await port.pickFolder())!;
    expect(await collect(port.enumerate(ref, { extensions: ['txt'] }))).toHaveLength(1);
  });

  it('reads and hashes a nested file by its relative path', async () => {
    const port = handlePort(dirHandle('Notes', TREE));
    const ref = (await port.pickFolder())!;
    const blob = await port.read(ref, '2024/q1.pdf');
    expect(await blob.text()).toBe('pdf');
    expect(await port.hash(ref, '2024/q1.pdf')).toBe(createHash('sha256').update('pdf').digest('hex'));
  });

  it('rejects an unknown path, a traversal and an unknown folder with typed errors', async () => {
    const port = handlePort(dirHandle('Notes', TREE));
    const ref = (await port.pickFolder())!;
    await expect(port.read(ref, 'nope.md')).rejects.toMatchObject({ code: 'not_found' });
    await expect(port.read(ref, '../etc/passwd')).rejects.toMatchObject({ code: 'not_found' });
    await expect(port.read({ id: 'x', name: 'x' }, 'notes.txt')).rejects.toBeInstanceOf(KvoxFileAccessError);
  });

  it('stops enumerating when the signal aborts', async () => {
    const port = handlePort(dirHandle('Notes', TREE));
    const ref = (await port.pickFolder())!;
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(collect(port.enumerate(ref, { extensions: EXTENSIONS, signal: controller.signal }))).rejects.toThrow(
      'stop',
    );
  });
});

describe('scanFolder', () => {
  it('collects every entry and reports progress', async () => {
    const port = handlePort(dirHandle('Notes', TREE));
    const ref = (await port.pickFolder())!;
    const progress = vi.fn();
    const entries = await scanFolder(port, ref, { extensions: EXTENSIONS, onProgress: progress });
    expect(entries).toHaveLength(4);
    expect(progress).toHaveBeenCalledTimes(4);
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ found: 4, bytes: entries.reduce((sum, e) => sum + e.size, 0) }),
    );
  });

  it('rejects when aborted mid-scan', async () => {
    const port = handlePort(dirHandle('Notes', TREE));
    const ref = (await port.pickFolder())!;
    const controller = new AbortController();
    await expect(
      scanFolder(port, ref, {
        extensions: EXTENSIONS,
        signal: controller.signal,
        onProgress: () => controller.abort(new Error('cancelled')),
      }),
    ).rejects.toThrow('cancelled');
  });
});

// -----------------------------------------------------------------------------
// The <input webkitdirectory> fallback
// -----------------------------------------------------------------------------

function relFile(relativePath: string, content: string): File {
  const file = new File([content], relativePath.split('/').pop()!, { lastModified: 42 });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

describe('filesFromDirectoryInput', () => {
  it('drops the picked folder name and normalises the rest', () => {
    const { name, files } = filesFromDirectoryInput([
      relFile('Notes/plan.md', 'a'),
      relFile('Notes/2024/q1.pdf', 'b'),
      relFile('Notes\\win\\x.txt', 'c'),
    ]);
    expect(name).toBe('Notes');
    expect(Array.from(files.keys())).toEqual(['plan.md', '2024/q1.pdf', 'win/x.txt']);
  });
});

describe('createBrowserFileAccess (directory input fallback)', () => {
  function pickWith(files: File[] | null) {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      expect(this.hasAttribute('webkitdirectory')).toBe(true);
      expect(this.multiple).toBe(true);
      if (files === null) {
        this.dispatchEvent(new Event('cancel'));
        return;
      }
      Object.defineProperty(this, 'files', { value: files });
      this.dispatchEvent(new Event('change'));
    });
    return click;
  }

  it('maps the picked files, filters them and is not persistent', async () => {
    const click = pickWith([
      relFile('Notes/plan.md', 'plan'),
      relFile('Notes/.obsidian/workspace.md', 'x'),
      relFile('Notes/node_modules/a.md', 'x'),
      relFile('Notes/sub/q1.PDF', 'pdf'),
      relFile('Notes/photo.jpg', 'jpg'),
    ]);
    try {
      const port = createBrowserFileAccess({ globals: { document }, createId: () => 'mem-1' });
      expect(port.capabilities.persistentFolders).toBe(false);
      const ref = await port.pickFolder();
      expect(ref).toEqual({ id: 'mem-1', name: 'Notes' });
      expect(document.querySelector('input[webkitdirectory]')).toBeNull();

      const entries = await collect(port.enumerate(ref!, { extensions: EXTENSIONS }));
      expect(entries).toEqual([
        { path: 'plan.md', size: 4, mtime: 42 },
        { path: 'sub/q1.PDF', size: 3, mtime: 42 },
      ]);
      expect(await (await port.read(ref!, 'plan.md')).text()).toBe('plan');
      expect(await port.hash(ref!, 'plan.md')).toBe(createHash('sha256').update('plan').digest('hex'));

      await port.setLibraryFolder('lib', ref);
      expect(await port.getLibraryFolder('lib')).toEqual(ref);
      await port.forgetFolder(ref!);
      expect(await port.getLibraryFolder('lib')).toBeNull();
    } finally {
      click.mockRestore();
    }
  });

  it('resolves null on cancel', async () => {
    const click = pickWith(null);
    try {
      const port = createBrowserFileAccess({ globals: { document } });
      expect(await port.pickFolder()).toBeNull();
    } finally {
      click.mockRestore();
    }
  });
});

describe('sha256Hex', () => {
  it('matches a known digest', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
