import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { render } from './helpers.js';

/**
 * The visual editor is the only code that imports `@tiptap/*`, and it is loaded
 * with `React.lazy` the first time somebody edits a note. A host that renders
 * notes read-only (or edits in the markdown textarea) therefore never needs the
 * libraries, and the production build keeps them in a chunk of their own.
 *
 * "Not installed" is simulated by making each `@tiptap/*` module throw the error
 * a missing package throws when it is imported. `react-markdown` stays, because
 * the read view needs it.
 */

function missing(name: string): never {
  throw new Error(`Cannot find package '${name}'`);
}

vi.mock('@tiptap/core', () => missing('@tiptap/core'));
vi.mock('@tiptap/react', () => missing('@tiptap/react'));
vi.mock('@tiptap/starter-kit', () => missing('@tiptap/starter-kit'));
vi.mock('@tiptap/extension-table', () => missing('@tiptap/extension-table'));
vi.mock('@tiptap/markdown', () => missing('@tiptap/markdown'));

describe('notes/ui without @tiptap/*', () => {
  it('loads, and renders a note body, without ever importing the editor', async () => {
    const ui = await import('../../src/notes/ui/index.js');

    expect(ui.NotePage).toBeTypeOf('function');
    expect(ui.MarkdownView).toBeTypeOf('function');

    render(<ui.MarkdownView>{'# A heading\n\nSome **bold** text.'}</ui.MarkdownView>);

    expect(await screen.findByRole('heading', { name: 'A heading' })).toBeInTheDocument();
  });

  it('edits in the markdown textarea without the editor, and never asks for it', async () => {
    const { NoteBodyEditor } = await import('../../src/notes/ui/components/NoteBodyEditor.js');

    render(
      <NoteBodyEditor value="Hello" onChange={() => undefined} view="write" onViewChange={() => undefined} />,
    );

    expect(await screen.findByDisplayValue('Hello')).toBeInTheDocument();
  });
});
