import { describe, it, expect, beforeAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { render } from '../../utils/test-utils';
import { NoteBodyEditor } from '../../../components/notes/NoteBodyEditor';
import type { NoteEditorView } from '../../../components/notes/NoteBodyEditor';

/**
 * `NoteBodyEditor` — issue #334.
 *
 * The Visual | Markdown | Preview toggle for a markdown note, and the fact
 * that switching between them never loses text — the parent's `value` is the
 * only copy, per the component's own header. A plain-text note has no markup
 * to render or edit visually, so it gets no toggle at all: one textarea.
 */

// See `VisualMarkdownEditor.test.tsx` for why: jsdom has no layout engine, and
// the visual view (Tiptap/ProseMirror) reaches for it on a selection change.
beforeAll(() => {
  const fakeRect = (): DOMRect => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON: () => ({}),
  });
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  Range.prototype.getBoundingClientRect = fakeRect;
  Element.prototype.getClientRects = function getClientRects() {
    return [fakeRect()] as unknown as DOMRectList;
  };
});

/** Owns the draft the way `NotePage` does — the editor holds no copy of its own. */
function Harness({
  initialValue,
  initialView = 'visual',
  bodyFormat,
  disabled,
}: {
  initialValue: string;
  initialView?: NoteEditorView;
  bodyFormat?: 'markdown' | 'plain_text';
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [view, setView] = useState<NoteEditorView>(initialView);
  return (
    <NoteBodyEditor
      value={value}
      onChange={setValue}
      view={view}
      onViewChange={setView}
      bodyFormat={bodyFormat}
      disabled={disabled}
    />
  );
}

describe('NoteBodyEditor — a markdown note', () => {
  it('shows the Visual | Markdown | Preview toggle', () => {
    render(<Harness initialValue="Some text" />);

    expect(screen.getByRole('button', { name: 'Visual' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
  });

  it('switching from Markdown to Preview and back keeps the value', async () => {
    const user = userEvent.setup();
    render(<Harness initialValue="## A heading" initialView="write" />);

    const textarea = screen.getByRole('textbox', { name: 'Note' });
    expect(textarea).toHaveValue('## A heading');

    await user.clear(textarea);
    await user.type(textarea, '### Changed');

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(
      await screen.findByRole('heading', { name: 'Changed' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Markdown' }));
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('### Changed');
  });

  it('switching from Markdown to Visual keeps the value', async () => {
    const user = userEvent.setup();
    render(<Harness initialValue="# Title\n\nBody text." initialView="write" />);

    await user.click(screen.getByRole('button', { name: 'Visual' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Note body' })).toBeInTheDocument();
    });
    expect(screen.getByText(/Body text\./)).toBeInTheDocument();
  });

  it('opens on the Visual view by default in this harness, with the toolbar visible', async () => {
    render(<Harness initialValue="Body." />);

    await waitFor(() => {
      expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    });
  });
});

describe('NoteBodyEditor — a plain-text note', () => {
  it('hides the view toggle entirely', () => {
    render(<Harness initialValue="Just text." bodyFormat="plain_text" />);

    expect(screen.queryByRole('button', { name: 'Visual' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Markdown' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('shows only a plain textarea, editable, holding the value verbatim', async () => {
    const user = userEvent.setup();
    render(<Harness initialValue="Line one." bodyFormat="plain_text" />);

    const textarea = screen.getByRole('textbox', { name: 'Note' });
    expect(textarea).toHaveValue('Line one.');
    expect(textarea.tagName).toBe('TEXTAREA');

    await user.type(textarea, ' More.');
    expect(textarea).toHaveValue('Line one. More.');
  });

  it('disables the textarea while a save is in flight', () => {
    render(<Harness initialValue="Text." bodyFormat="plain_text" disabled />);

    expect(screen.getByRole('textbox', { name: 'Note' })).toBeDisabled();
  });
});
