/**
 * `ContextAttachmentsField` and `ContextAttachmentList` (#810) — rendering only. The field is
 * driven by a hand-built hook result, so each state is drawn exactly as the hook reports it.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from './helpers.js';
import {
  ContextAttachmentList,
  ContextAttachmentsField,
} from '../../src/notes/ui/components/ContextAttachmentsField.js';
import type { UseContextAttachmentsResult } from '../../src/notes/headless/hooks/useContextAttachments.js';
import type { ContextAttachmentItem } from '../../src/notes/headless/utils/contextAttachments.js';
import {
  MAX_CONTEXT_ATTACHMENTS,
  NOTE_CONTEXT_ATTACHMENT_ACCEPT,
  contextAttachmentsBlockingReason,
} from '../../src/notes/headless/utils/contextAttachments.js';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function state(items: ContextAttachmentItem[], overrides: Partial<UseContextAttachmentsResult> = {}) {
  const result: UseContextAttachmentsResult = {
    items,
    ids: items.flatMap((item) => (item.status === 'ready' && item.objectId ? [item.objectId] : [])),
    allReady: items.every((item) => item.status === 'ready'),
    busy: items.some((item) => item.status === 'uploading' || item.status === 'extracting'),
    blockingReason: contextAttachmentsBlockingReason(items),
    notice: null,
    remaining: MAX_CONTEXT_ATTACHMENTS - items.length,
    addFiles: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
    dismissNotice: vi.fn(),
    ...overrides,
  };
  return result;
}

const ROWS: ContextAttachmentItem[] = [
  { key: 'a', filename: 'agenda.pdf', kind: 'document', objectId: 'o1', status: 'ready', error: null, characters: 1200 },
  { key: 'b', filename: 'board.png', kind: 'image', objectId: 'o2', status: 'ready', error: null, characters: null },
  { key: 'c', filename: 'slides.pptx', kind: 'document', objectId: 'o3', status: 'extracting', error: null, characters: null },
  { key: 'd', filename: 'upload.md', kind: 'document', objectId: null, status: 'uploading', error: null, characters: null },
  { key: 'e', filename: 'scan.pdf', kind: 'document', objectId: 'o5', status: 'failed', error: 'No text could be read.', characters: null },
];

describe('ContextAttachmentsField', () => {
  it('offers a keyboard-operable Attach files button over a multiple chooser with the accept list', async () => {
    const user = userEvent.setup();
    render(<ContextAttachmentsField attachments={state([])} />);

    const button = screen.getByRole('button', { name: 'Attach files' });
    expect(button).toBeEnabled();
    const input = screen.getByLabelText('Choose context files') as HTMLInputElement;
    expect(input).toHaveAttribute('multiple');
    expect(input).toHaveAttribute('accept', NOTE_CONTEXT_ATTACHMENT_ACCEPT);

    const clicked = vi.spyOn(input, 'click');
    button.focus();
    await user.keyboard('{Enter}');
    expect(clicked).toHaveBeenCalled();
    expect(screen.getByText(/Images need a model that can read images/)).toBeInTheDocument();
  });

  it('hands chosen files to the hook', async () => {
    const user = userEvent.setup();
    const attachments = state([]);
    render(<ContextAttachmentsField attachments={attachments} />);

    const files = [new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.png', { type: 'image/png' })];
    await user.upload(screen.getByLabelText('Choose context files'), files);
    expect(attachments.addFiles).toHaveBeenCalledWith(files);
  });

  it('hands dropped files to the hook', () => {
    const attachments = state([]);
    render(<ContextAttachmentsField attachments={attachments} />);

    const file = new File(['a'], 'a.md', { type: 'text/markdown' });
    fireEvent.drop(screen.getByTestId('context-attachments-drop-zone'), {
      dataTransfer: { types: ['Files'], files: [file] },
    });
    expect(attachments.addFiles).toHaveBeenCalledWith([file]);
  });

  it('draws one row per file with its state, and a named remove button', async () => {
    const user = userEvent.setup();
    const attachments = state(ROWS);
    render(<ContextAttachmentsField attachments={attachments} />);

    const list = screen.getByRole('list', { name: 'Attached files' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(ROWS.length);
    expect(within(list).getByText(/1,200 characters of text/)).toBeInTheDocument();
    expect(within(list).getByText('Ready · image')).toBeInTheDocument();
    expect(within(list).getByText('Reading the document…')).toBeInTheDocument();
    expect(within(list).getByText('Uploading…')).toBeInTheDocument();
    expect(within(list).getByText('No text could be read.')).toBeInTheDocument();
    // The kind is spoken with the name.
    expect(within(list).getByText('Image:', { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove scan.pdf' }));
    expect(attachments.remove).toHaveBeenCalledWith('e');
    expect(screen.getByRole('status')).toHaveTextContent(/Remove the files that could not be attached/);
  });

  it('disables adding when the limit is reached, and shows the notice', () => {
    const full = Array.from({ length: MAX_CONTEXT_ATTACHMENTS }, (_, i) => ({ ...ROWS[1], key: `k${i}` }));
    render(
      <ContextAttachmentsField
        attachments={state(full, { remaining: 0, notice: 'A note can have at most 10 attached files; 1 file was not added.' })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled();
    expect(screen.getByText(/1 file was not added/)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ContextAttachmentsField attachments={state(ROWS)} />);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('ContextAttachmentList', () => {
  it('lists each attachment by name, and renders nothing for none', () => {
    const { container, rerender } = render(
      <ContextAttachmentList
        attachments={[
          { objectId: 'o1', kind: 'document', filename: 'agenda.pdf', mimeType: 'application/pdf' },
          { objectId: 'o2', kind: 'image', filename: 'board.png', mimeType: 'image/png' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Attached files' });
    expect(within(list).getByText('agenda.pdf')).toBeInTheDocument();
    expect(within(list).getByText('board.png')).toBeInTheDocument();
    // No download route exists: names, not links.
    expect(within(list).queryByRole('link')).toBeNull();

    rerender(<ContextAttachmentList attachments={[]} />);
    expect(container.querySelector('ul')).toBeNull();
  });
});
