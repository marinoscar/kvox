import { describe, it, expect, vi } from 'vitest';

/**
 * The editor libraries are optional peers of the `notes/ui` entry ONLY.
 *
 * `@tiptap/*`, `react-markdown` and `remark-gfm` are not installed by a host
 * that uses just `notes/headless` (KVox Desktop's main process, a CLI), so that
 * entry has to load with every one of them missing. (`lazy-editor.test.ts`
 * covers the other half: `notes/ui` does not need `@tiptap/*` until somebody
 * opens the visual editor.)
 *
 * "Not installed" is simulated by making each module throw the error a missing
 * package throws when it is imported.
 */

function missing(name: string): never {
  throw new Error(`Cannot find package '${name}'`);
}

vi.mock('@tiptap/core', () => missing('@tiptap/core'));
vi.mock('@tiptap/react', () => missing('@tiptap/react'));
vi.mock('@tiptap/starter-kit', () => missing('@tiptap/starter-kit'));
vi.mock('@tiptap/extension-table', () => missing('@tiptap/extension-table'));
vi.mock('@tiptap/markdown', () => missing('@tiptap/markdown'));
vi.mock('react-markdown', () => missing('react-markdown'));
vi.mock('remark-gfm', () => missing('remark-gfm'));

describe('notes/headless without the editor libraries', () => {
  it('loads and exports its clients and hooks', async () => {
    const headless = await import('../../src/notes/headless/index.js');

    expect(headless.getNotes).toBeTypeOf('function');
    expect(headless.connectNoteStream).toBeTypeOf('function');
    expect(headless.useNotes).toBeTypeOf('function');
    expect(headless.useNote).toBeTypeOf('function');
    expect(headless.useNoteTemplates).toBeTypeOf('function');
    expect(headless.useNoteGenerationContext).toBeTypeOf('function');
    expect(headless.useTemplatePreview).toBeTypeOf('function');
  });
});
