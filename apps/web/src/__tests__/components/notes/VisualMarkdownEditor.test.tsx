import { describe, it, expect, vi, beforeAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { VisualMarkdownEditor } from '../../../components/notes/VisualMarkdownEditor';

/**
 * jsdom has no layout engine, so ProseMirror's `coordsAtPos` (used to scroll a
 * changed selection into view) throws reaching for `getClientRects`/
 * `getBoundingClientRect` on a `Range`. Neither call's RESULT matters to these
 * tests — only that a selection change does not crash the test — so a fake
 * zero-sized rect is enough.
 */
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

/**
 * `VisualMarkdownEditor` — issue #334.
 *
 * A VIEW OVER THE SAME MARKDOWN STRING, never a second source of truth (see the
 * component's own header). The one invariant every test here protects is that
 * OPENING the editor must never itself dirty the draft — `onChange` fires only
 * for a real user edit, never for the initial parse or an external value
 * change.
 */

describe('VisualMarkdownEditor', () => {
  it('renders markdown content — a heading and a list item as real elements', async () => {
    const onChange = vi.fn();
    render(
      <VisualMarkdownEditor value={'# Title\n\n- one\n- two'} onChange={onChange} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Title', level: 1 })).toBeInTheDocument();
    });
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
  });

  it('does NOT call onChange merely from mounting/parsing the initial content', async () => {
    const onChange = vi.fn();
    render(<VisualMarkdownEditor value={'# Title\n\nBody text.'} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    });

    // Give any microtask/effect a chance to run before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('a toolbar button (Bold) calls onChange with updated markdown after a real edit', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VisualMarkdownEditor value={'Some text'} onChange={onChange} />);

    const editor = await screen.findByRole('textbox', { name: 'Note body' });
    // Select all the text so Bold has something to wrap.
    editor.focus();
    await user.keyboard('{Control>}a{/Control}');

    await user.click(screen.getByRole('button', { name: 'Bold' }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const lastCall = onChange.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toMatch(/\*\*.*Some text.*\*\*/);
  });

  it('an external value change resets the document without emitting onChange', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <VisualMarkdownEditor value={'# First'} onChange={onChange} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'First' })).toBeInTheDocument();
    });

    onChange.mockClear();

    rerender(<VisualMarkdownEditor value={'# Second'} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Second' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'First' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disabled makes the editor not editable', async () => {
    const onChange = vi.fn();
    render(<VisualMarkdownEditor value={'Some text'} onChange={onChange} disabled />);

    const editor = await screen.findByRole('textbox', { name: 'Note body' });
    expect(editor).toHaveAttribute('contenteditable', 'false');

    // Toolbar buttons are disabled too.
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
  });
});
