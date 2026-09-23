import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { NoteTemplateList } from '../../../components/notes/NoteTemplateList';
import type { NoteTemplate } from '../../../services/noteTemplates';

/**
 * `NoteTemplateList` — the hide/show toggle, issue #311.
 *
 * The toggle is offered on EVERY row, built-ins included — hiding is a
 * viewer preference, not an edit of the template, so it does not follow the
 * "absent, not disabled" rule Edit/Archive follow for a built-in row (see the
 * component's own header). This suite checks that distinction directly: the
 * toggle must be present regardless of `builtIn`, while Edit stays absent on
 * a built-in exactly as before.
 */

function template(overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'tpl-1',
    name: 'Meeting notes',
    description: '',
    instructions: 'Write it up.',
    outputFormat: 'meeting_notes',
    structure: [],
    tone: null,
    length: null,
    model: null,
    isArchived: false,
    builtIn: false,
    hidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function noop() {
  /* not exercised by these tests */
}

describe('NoteTemplateList — the hide/show toggle', () => {
  it('offers the toggle on a BUILT-IN row', () => {
    const t = template({ id: 'builtin-1', name: 'Standard notes', builtIn: true });
    render(
      <NoteTemplateList
        templates={[t]}
        busy={false}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        onToggleHidden={noop}
      />,
    );

    expect(screen.getByRole('button', { name: 'Hide Standard notes' })).toBeInTheDocument();
  });

  it('offers the toggle on an OWNED row', () => {
    const t = template({ id: 'own-1', name: 'My template' });
    render(
      <NoteTemplateList
        templates={[t]}
        busy={false}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        onToggleHidden={noop}
      />,
    );

    expect(screen.getByRole('button', { name: 'Hide My template' })).toBeInTheDocument();
  });

  it('labels a SHOWN row "Hide <name>", with aria-pressed false', () => {
    const t = template({ name: 'Weekly digest', hidden: false });
    render(
      <NoteTemplateList
        templates={[t]}
        busy={false}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        onToggleHidden={noop}
      />,
    );

    const button = screen.getByRole('button', { name: 'Hide Weekly digest' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    // The tooltip carries the same intent as the accessible name.
    expect(button.closest('[title]') ?? button).toBeTruthy();
  });

  it('labels a HIDDEN row "Show <name>", with aria-pressed true, and shows a Hidden chip', () => {
    const t = template({ name: 'Retired template', hidden: true });
    render(
      <NoteTemplateList
        templates={[t]}
        busy={false}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        onToggleHidden={noop}
      />,
    );

    const button = screen.getByRole('button', { name: 'Show Retired template' });
    expect(button).toHaveAttribute('aria-pressed', 'true');

    const row = screen.getByText('Retired template').closest('li') as HTMLElement;
    expect(within(row).getByText('Hidden')).toBeInTheDocument();
  });

  it('does NOT show a Hidden chip on a shown row', () => {
    const t = template({ name: 'Active template', hidden: false });
    render(
      <NoteTemplateList
        templates={[t]}
        busy={false}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        onToggleHidden={noop}
      />,
    );

    const row = screen.getByText('Active template').closest('li') as HTMLElement;
    expect(within(row).queryByText('Hidden')).not.toBeInTheDocument();
  });

  it('is disabled when the row is in pendingIds', () => {
    const t = template({ id: 'busy-1', name: 'In flight' });
    render(
      <NoteTemplateList
        templates={[t]}
        busy={false}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        onToggleHidden={noop}
        pendingIds={new Set(['busy-1'])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Hide In flight' })).toBeDisabled();
  });

  it('is enabled when the row is NOT in pendingIds, even if other rows are', () => {
    const rows = [template({ id: 'busy-1', name: 'In flight' }), template({ id: 'free-1', name: 'Free' })];
    render(
      <NoteTemplateList
        templates={rows}
        busy={false}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        onToggleHidden={noop}
        pendingIds={new Set(['busy-1'])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Hide In flight' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Hide Free' })).toBeEnabled();
  });

  it('invokes the callback with the TEMPLATE it was pressed on', async () => {
    const user = userEvent.setup();
    const onToggleHidden = vi.fn();
    const rows = [
      template({ id: 'a', name: 'Alpha', hidden: false }),
      template({ id: 'b', name: 'Beta', hidden: true }),
    ];
    render(
      <NoteTemplateList
        templates={rows}
        busy={false}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        onToggleHidden={onToggleHidden}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Show Beta' }));

    expect(onToggleHidden).toHaveBeenCalledTimes(1);
    expect(onToggleHidden).toHaveBeenCalledWith(rows[1]);
  });

  it('renders no toggle at all when onToggleHidden is not supplied', () => {
    const t = template({ name: 'No toggle here' });
    render(
      <NoteTemplateList templates={[t]} busy={false} onEdit={noop} onDuplicate={noop} onArchive={noop} />,
    );

    expect(screen.queryByRole('button', { name: /hide|show/i })).not.toBeInTheDocument();
  });

  it('still hides Edit on a built-in row even though the toggle is present', () => {
    const t = template({ id: 'builtin-2', name: 'Immutable', builtIn: true });
    render(
      <NoteTemplateList
        templates={[t]}
        busy={false}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        onToggleHidden={noop}
      />,
    );

    const row = screen.getByText('Immutable').closest('li') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Hide Immutable' })).toBeInTheDocument();
  });
});
