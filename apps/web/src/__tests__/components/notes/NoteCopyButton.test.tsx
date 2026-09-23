import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { NoteCopyButton } from '../../../components/notes/NoteCopyButton';
import { COPY_FAILED_MESSAGE } from '../../../components/common/CopyButton';

/**
 * `NoteCopyButton` — issue #334.
 *
 * A split button for a markdown note (main "Copy" puts BOTH the rendered HTML
 * and its text on the clipboard via `copyRich`; the arrow opens "Copy as
 * Markdown" / "Copy as plain text"), collapsing to a single button with no
 * arrow for a plain-text note, which has no alternative representations to
 * offer. `getRendered` is read at click time, exactly as `CopyButton`'s
 * function `text` is.
 */

function stubClipboard(options: {
  write?: ReturnType<typeof vi.fn>;
  writeText?: ReturnType<typeof vi.fn>;
  withClipboardItem?: boolean;
} = {}) {
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
  const write = options.write ?? vi.fn().mockResolvedValue(undefined);
  const writeText = options.writeText ?? vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { write, writeText },
    configurable: true,
  });
  if (options.withClipboardItem !== false) {
    class FakeClipboardItem {
      constructor(public types: Record<string, Blob>) {}
    }
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
  } else {
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  }
  return { write, writeText };
}

function renderedElement(html: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  Object.defineProperty(el, 'innerText', { value: text, configurable: true });
  return el;
}

describe('NoteCopyButton — a markdown note', () => {
  it('renders a split button: "Copy" plus "More copy options"', () => {
    stubClipboard();
    render(
      <NoteCopyButton
        markdown="# Heading\n\nBody."
        getRendered={() => renderedElement('<h1>Heading</h1><p>Body.</p>', 'Heading\nBody.')}
      />,
    );

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More copy options' })).toBeInTheDocument();
  });

  it('clicking "Copy" puts both HTML and text on the clipboard, and announces success', async () => {
    const user = userEvent.setup();
    const { write } = stubClipboard();
    const element = renderedElement('<h1>Heading</h1><p>Body.</p>', 'Heading\nBody.');
    render(<NoteCopyButton markdown="# Heading\n\nBody." getRendered={() => element} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(write).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  });

  it('announces the failure message when the copy is refused', async () => {
    const user = userEvent.setup();
    stubClipboard({
      write: vi.fn().mockRejectedValue(new Error('denied')),
      writeText: vi.fn().mockRejectedValue(new Error('denied')),
    });
    const element = renderedElement('<h1>Heading</h1>', 'Heading');
    render(<NoteCopyButton markdown="# Heading" getRendered={() => element} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('status')).toHaveTextContent(COPY_FAILED_MESSAGE);
  });

  it('opens a menu with "Copy as Markdown" and "Copy as plain text"', async () => {
    const user = userEvent.setup();
    stubClipboard();
    const element = renderedElement('<h1>Heading</h1>', 'Heading');
    render(<NoteCopyButton markdown="# Heading" getRendered={() => element} />);

    await user.click(screen.getByRole('button', { name: 'More copy options' }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Copy as Markdown' })).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: 'Copy as plain text' }),
    ).toBeInTheDocument();
  });

  it('"Copy as Markdown" copies the raw markdown source, not the rendered HTML', async () => {
    const user = userEvent.setup();
    const { writeText, write } = stubClipboard();
    const element = renderedElement('<h1>Heading</h1>', 'Heading');
    render(<NoteCopyButton markdown="# Heading" getRendered={() => element} />);

    await user.click(screen.getByRole('button', { name: 'More copy options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy as Markdown' }));

    expect(writeText).toHaveBeenCalledWith('# Heading');
    expect(write).not.toHaveBeenCalled();
  });

  it('"Copy as plain text" copies the rendered text, not the markdown source', async () => {
    const user = userEvent.setup();
    const { writeText } = stubClipboard();
    const element = renderedElement('<h1>Heading</h1>', 'Heading (rendered)');
    render(<NoteCopyButton markdown="# Heading" getRendered={() => element} />);

    await user.click(screen.getByRole('button', { name: 'More copy options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy as plain text' }));

    expect(writeText).toHaveBeenCalledWith('Heading (rendered)');
  });

  it('is disabled when the body is empty', () => {
    stubClipboard();
    render(<NoteCopyButton markdown="   " getRendered={() => null} />);

    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More copy options' })).toBeDisabled();
  });

  it('is disabled when explicitly asked, even with a non-empty body', () => {
    stubClipboard();
    render(<NoteCopyButton markdown="Some text" getRendered={() => null} disabled />);

    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
  });
});

describe('NoteCopyButton — a plain-text note', () => {
  it('renders only "Copy" — no arrow, no menu', () => {
    stubClipboard();
    render(
      <NoteCopyButton markdown="Just text." getRendered={() => null} bodyFormat="plain_text" />,
    );

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More copy options' })).not.toBeInTheDocument();
  });

  it('clicking "Copy" copies the raw text directly, via the plain path (not copyRich)', async () => {
    const user = userEvent.setup();
    const { writeText, write } = stubClipboard();
    render(
      <NoteCopyButton markdown="Just text." getRendered={() => null} bodyFormat="plain_text" />,
    );

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('Just text.');
    expect(write).not.toHaveBeenCalled();
  });

  it('is disabled when the body is empty', () => {
    stubClipboard();
    render(<NoteCopyButton markdown="" getRendered={() => null} bodyFormat="plain_text" />);

    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
  });
});

describe('NoteCopyButton — icon variant', () => {
  it('renders a single icon button, with no menu', () => {
    stubClipboard();
    render(
      <NoteCopyButton
        markdown="# Heading"
        getRendered={() => renderedElement('<h1>Heading</h1>', 'Heading')}
        variant="icon"
      />,
    );

    expect(screen.getByRole('button', { name: 'Copy note' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More copy options' })).not.toBeInTheDocument();
  });

  it('copies the default representation and announces success', async () => {
    const user = userEvent.setup();
    const { write } = stubClipboard();
    render(
      <NoteCopyButton
        markdown="# Heading"
        getRendered={() => renderedElement('<h1>Heading</h1>', 'Heading')}
        variant="icon"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Copy note' }));

    expect(write).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  });

  it('is disabled when the body is empty', () => {
    stubClipboard();
    render(<NoteCopyButton markdown="" getRendered={() => null} variant="icon" />);

    expect(screen.getByRole('button', { name: 'Copy note' })).toBeDisabled();
  });
});
