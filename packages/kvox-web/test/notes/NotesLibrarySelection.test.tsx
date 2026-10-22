import { act, fireEvent, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render, mockAdminUser } from './helpers.js';
import { NotesPage } from '../../src/notes/ui/pages/NotesPage.js';
import type { NoteListItem } from '../../src/notes/headless/clients/notes.js';
import type { NotesLibrarySlots } from '../../src/notes/ui/slots.js';

/**
 * Multi-select in the notes library (GIC-14, #675): a "Select" toggle, a checkbox per note, a long press
 * on a touch screen, and a bar whose actions the host fills. Without the slot nothing changes.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function note(id: string, title: string): NoteListItem {
  return {
    id,
    title,
    titleSource: 'ai',
    excerpt: `About ${title}`,
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'document',
    sourceTranscriptId: null,
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: null,
    templateName: null,
    sourceName: null,
    currentGenerationId: 'gen',
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const items = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((title, i) => note(`n${i + 1}`, title));
const routes = { 'GET /notes': { items, total: items.length, nextCursor: null } };

function slots(over: Partial<NotesLibrarySlots> = {}): NotesLibrarySlots {
  return {
    useSelectionEnabled: () => true,
    SelectionActions: ({ noteIds, onDone }) => (
      <>
        <button type="button" disabled={noteIds.length < 2} onClick={onDone}>
          {`Explore ${noteIds.join('+')}`}
        </button>
      </>
    ),
    selectionLimit: 3,
    ...over,
  };
}

function renderLibrary(s: NotesLibrarySlots | undefined) {
  return render(<NotesPage slots={s} />, { wrapperOptions: { user: mockAdminUser, route: '/notes' }, hostOptions: { routes } });
}

describe('the notes library selection', () => {
  it('offers nothing without the slots, or while the hook says no', async () => {
    const first = renderLibrary(undefined);
    await screen.findByRole('heading', { name: 'Alpha' });
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
    first.unmount();

    renderLibrary(slots({ useSelectionEnabled: () => false }));
    await screen.findByRole('heading', { name: 'Alpha' });
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
  });

  it('Select shows a checkbox per note and a bar with the host actions', async () => {
    const user = userEvent.setup();
    const { container } = renderLibrary(slots());
    await screen.findByRole('heading', { name: 'Alpha' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    const bar = screen.getByRole('region', { name: 'Selected notes' });
    expect(within(bar).getByText('Select notes')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /^Explore/ })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Charlie' }));
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Explore n1+n3' })).toBeEnabled();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('clicking a card toggles it instead of opening it', async () => {
    const user = userEvent.setup();
    renderLibrary(slots());
    await screen.findByRole('heading', { name: 'Alpha' });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('heading', { name: 'Bravo' }));
    expect(screen.getByRole('checkbox', { name: 'Select Bravo' })).toBeChecked();
    expect(screen.queryByRole('heading', { name: 'Notes', level: 1 })).toBeInTheDocument();
  });

  it('holds at most the limit: the other checkboxes are disabled until one is released', async () => {
    const user = userEvent.setup();
    renderLibrary(slots());
    await screen.findByRole('heading', { name: 'Alpha' });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    for (const title of ['Alpha', 'Bravo', 'Charlie']) {
      await user.click(screen.getByRole('checkbox', { name: `Select ${title}` }));
    }
    expect(screen.getByRole('checkbox', { name: 'Select Delta' })).toBeDisabled();
    expect(screen.getByText('3 selected (the most you can compare)')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    expect(screen.getByRole('checkbox', { name: 'Select Delta' })).toBeEnabled();
  });

  it('Cancel, the host action and Escape all leave selection mode and clear it', async () => {
    const user = userEvent.setup();
    renderLibrary(slots());
    await screen.findByRole('heading', { name: 'Alpha' });

    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Bravo' }));
    await user.click(screen.getByRole('button', { name: 'Explore n1+n2' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.keyDown(screen.getByRole('region', { name: 'Selected notes' }), { key: 'Escape' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('a long press on a touch screen starts selecting with that note and does not open it', async () => {
    renderLibrary(slots());
    const heading = await screen.findByRole('heading', { name: 'Bravo' });
    const card = heading.closest('li')!;
    expect(card).not.toBeNull();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(600);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(await screen.findByRole('checkbox', { name: 'Select Bravo' })).toBeChecked();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    // The click the finger-up sends is swallowed: the note is still selected, not opened.
    fireEvent.pointerUp(card, { pointerType: 'touch' });
    fireEvent.click(heading);
    expect(screen.getByRole('checkbox', { name: 'Select Bravo' })).toBeChecked();
  });

  it('a touch press that wanders or lifts early does not start selecting; a mouse press never does', async () => {
    renderLibrary(slots());
    const heading = await screen.findByRole('heading', { name: 'Bravo' });
    const card = heading.closest('li')!;

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 10, clientY: 10 });
      fireEvent.pointerMove(card, { pointerType: 'touch', clientX: 60, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(700);
      });
      fireEvent.pointerDown(card, { pointerType: 'mouse', clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(700);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
