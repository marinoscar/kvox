import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { CopyButton, COPY_FAILED_MESSAGE } from '../../../components/common/CopyButton';

/**
 * `CopyButton` — issue #308.
 *
 * The shared copy control. Assertions fall into three groups: the ICON
 * variant's tooltip/aria-live transitions (Copy → Copied → the failure
 * message), the BUTTON variant's visible text doing the same, and the one
 * thing that makes `text` safe to pass as a function — it is evaluated at
 * CLICK time, not on every render, so a caller whose text is expensive or
 * assembled from state that changes after mount still copies the right thing.
 */

function setClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

describe('CopyButton — icon variant', () => {
  it('starts with the resting label as its tooltip/accessible name', () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyButton text="hello" label="Copy the thing" variant="icon" />);

    expect(screen.getByRole('button', { name: 'Copy the thing' })).toBeInTheDocument();
  });

  it('announces "Copied to clipboard" through the live region on success', async () => {
    const user = userEvent.setup();
    setClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyButton text="hello" label="Copy the thing" variant="icon" />);

    await user.click(screen.getByRole('button', { name: 'Copy the thing' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Copied to clipboard');
  });

  it('announces the failure message when the browser refuses', async () => {
    const user = userEvent.setup();
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<CopyButton text="hello" label="Copy the thing" variant="icon" />);

    await user.click(screen.getByRole('button', { name: 'Copy the thing' }));

    expect(await screen.findByRole('status')).toHaveTextContent(COPY_FAILED_MESSAGE);
  });

  it('is disabled when asked, and does not copy on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<CopyButton text="hello" label="Copy the thing" variant="icon" disabled />);

    const button = screen.getByRole('button', { name: 'Copy the thing' });
    expect(button).toBeDisabled();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('CopyButton — button variant', () => {
  it('shows the resting label as visible text', () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyButton text="hello" label="Copy all" variant="button" />);

    expect(screen.getByRole('button', { name: 'Copy all' })).toHaveTextContent('Copy all');
  });

  it('shows "Copied" as the visible text after a successful copy', async () => {
    const user = userEvent.setup();
    setClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyButton text="hello" label="Copy all" variant="button" />);

    // The accessible name stays the resting label; the live region and the
    // visible text carry the state change instead.
    await user.click(screen.getByRole('button', { name: 'Copy all' }));

    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('shows "Copy failed" as the visible text when the browser refuses', async () => {
    const user = userEvent.setup();
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<CopyButton text="hello" label="Copy all" variant="button" />);

    await user.click(screen.getByRole('button', { name: 'Copy all' }));

    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
  });

  it('is disabled when asked, and does not copy on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<CopyButton text="hello" label="Copy all" variant="button" disabled />);

    const button = screen.getByRole('button', { name: 'Copy all' });
    expect(button).toBeDisabled();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('CopyButton — function text', () => {
  it('evaluates a function `text` at click time, not at render time', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);

    let current = 'first value';
    const getText = vi.fn(() => current);

    render(<CopyButton text={getText} label="Copy" variant="icon" />);

    // Not called merely by rendering.
    expect(getText).not.toHaveBeenCalled();

    // Change what the function would return AFTER render, before clicking.
    current = 'second value';

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(getText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('second value');
  });
});
