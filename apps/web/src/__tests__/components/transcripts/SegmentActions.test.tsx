import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { SegmentActions } from '../../../components/transcripts/SegmentActions';
import type { TranscriptSegment, TranscriptSpeaker } from '../../../services/transcripts';

/**
 * The per-segment overflow menu, and specifically issue #220: naming a
 * speaker from a segment's menu now defaults to the ALL-LINES `speaker.rename`
 * op, with the old per-line `segment.set_speaker` reassignment kept one tap
 * away rather than being what "name this voice" silently did. See the
 * component's own header for the full defect.
 *
 * Viewport width is reset globally after every test (`__tests__/setup.ts`),
 * so no local `afterEach` is needed here.
 */

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Ben', colorIndex: 1, rev: 1 },
];

const SEGMENT: TranscriptSegment = {
  id: 's0',
  speakerId: 'sp1',
  startMs: 0,
  endMs: 4000,
  ordinal: 1,
  text: 'Hello there',
  wordsAlignment: 'exact',
  confidence: 0.9,
  origin: 'ai',
  rev: 1,
  editedAt: null,
};

/**
 * The `menuitem` a given `ListItemText` PRIMARY belongs to.
 *
 * ⚠ NOT `getByRole('menuitem', { name })` for the two speaker items at the
 * root: their secondary line ("Applies to all N lines they speak" / "This
 * line only") is a sibling node inside the same menuitem and folds into its
 * accessible name, so a name match would have to know that scope sentence's
 * exact wording in advance. Finding the primary text and walking up to its
 * `menuitem` ancestor asserts the one thing most of these tests care about —
 * which item — independently of that. Same helper `NotePage.test.tsx` uses
 * for the identical reason.
 */
function menuItemFor(primary: string): HTMLElement {
  const item = screen.getByText(primary).closest('[role="menuitem"]');
  if (!item) throw new Error(`"${primary}" is not inside a menuitem`);
  return item as HTMLElement;
}

function renderActions(overrides: Partial<Parameters<typeof SegmentActions>[0]> = {}) {
  const onClose = vi.fn();
  const onRenameSpeaker = vi.fn();
  const onSetSpeaker = vi.fn();
  const onCreateSpeaker = vi.fn();
  const onSplit = vi.fn();
  const onJoin = vi.fn();
  const onDelete = vi.fn();
  const onPlayFrom = vi.fn();
  const result = render(
    <SegmentActions
      open
      anchorEl={document.createElement('button')}
      segment={SEGMENT}
      speakers={SPEAKERS}
      nameSuggestions={SPEAKERS.map((speaker) => speaker.displayName)}
      speakerSegmentCount={6}
      canJoin
      onClose={onClose}
      onRenameSpeaker={onRenameSpeaker}
      onSetSpeaker={onSetSpeaker}
      onCreateSpeaker={onCreateSpeaker}
      onSplit={onSplit}
      onJoin={onJoin}
      onDelete={onDelete}
      onPlayFrom={onPlayFrom}
      {...overrides}
    />,
  );
  return {
    ...result,
    onClose,
    onRenameSpeaker,
    onSetSpeaker,
    onCreateSpeaker,
    onSplit,
    onJoin,
    onDelete,
    onPlayFrom,
  };
}

describe('SegmentActions — root menu wording (#220)', () => {
  it('leads with the all-lines rename, naming the speaker and the blast radius', () => {
    renderActions({ speakerSegmentCount: 6 });

    expect(menuItemFor('Rename Ana')).toHaveTextContent('Applies to all 6 lines they speak');
  });

  it('falls back to countless wording rather than "all 1 lines"', () => {
    renderActions({ speakerSegmentCount: 1 });

    expect(menuItemFor('Rename Ana')).toHaveTextContent('Applies to every line they speak');
  });

  it('falls back to the same countless wording when no count could be resolved at all', () => {
    // A "0" here would understate the blast radius rather than describe it.
    renderActions({ speakerSegmentCount: 0 });

    expect(menuItemFor('Rename Ana')).toHaveTextContent('Applies to every line they speak');
  });

  it('scopes the per-line item to "This line only"', () => {
    renderActions();

    expect(menuItemFor('Move this line to another speaker')).toHaveTextContent(
      'This line only',
    );
  });

  it('puts the all-lines rename before per-line reassignment, not after', () => {
    renderActions();

    const items = screen.getAllByRole('menuitem');
    const renameIndex = items.indexOf(menuItemFor('Rename Ana'));
    const moveIndex = items.indexOf(menuItemFor('Move this line to another speaker'));

    expect(renameIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeLessThan(moveIndex);
  });

  it('still offers the unrelated segment actions, unchanged by #220', () => {
    renderActions();

    for (const label of ['Split here', 'Join with next', 'Play from here', 'Delete segment']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });
});

describe('SegmentActions — the all-lines rename view', () => {
  it('opens the shared form seeded with the speaker’s current name', async () => {
    const user = userEvent.setup();
    renderActions();

    await user.click(menuItemFor('Rename Ana'));

    expect(screen.getByRole('combobox', { name: 'Speaker name' })).toHaveValue('Ana');
  });

  it('issues the all-lines rename — the regression this issue exists to guard', async () => {
    const user = userEvent.setup();
    const { onRenameSpeaker, onSetSpeaker, onCreateSpeaker, onClose } = renderActions();

    await user.click(menuItemFor('Rename Ana'));
    const field = screen.getByRole('combobox', { name: 'Speaker name' });
    await user.clear(field);
    await user.type(field, 'Justin');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The whole defect (#220): renaming from a segment used to CREATE a new
    // speaker and repoint one segment at it. Neither of those may fire here —
    // only the all-lines rename may.
    expect(onRenameSpeaker).toHaveBeenCalledWith('Justin');
    expect(onSetSpeaker).not.toHaveBeenCalled();
    expect(onCreateSpeaker).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Back returns to the root menu without closing the whole surface', async () => {
    const user = userEvent.setup();
    const { onClose } = renderActions();

    await user.click(menuItemFor('Rename Ana'));
    await user.click(screen.getByRole('menuitem', { name: 'Back' }));

    expect(menuItemFor('Rename Ana')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel closes the whole surface without renaming', async () => {
    const user = userEvent.setup();
    const { onClose, onRenameSpeaker } = renderActions();

    await user.click(menuItemFor('Rename Ana'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onRenameSpeaker).not.toHaveBeenCalled();
  });
});

describe('SegmentActions — the per-line picker (mechanism unchanged by #220)', () => {
  it('reassigns just this line when a speaker is picked', async () => {
    const user = userEvent.setup();
    const { onSetSpeaker, onRenameSpeaker, onClose } = renderActions();

    await user.click(menuItemFor('Move this line to another speaker'));
    await user.click(screen.getByRole('menuitem', { name: 'Ben' }));

    expect(onSetSpeaker).toHaveBeenCalledWith('sp2');
    expect(onRenameSpeaker).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('creates a speaker for this line only from the picker’s last entry', async () => {
    const user = userEvent.setup();
    const { onCreateSpeaker, onRenameSpeaker, onSetSpeaker, onClose } = renderActions();

    await user.click(menuItemFor('Move this line to another speaker'));
    await user.click(menuItemFor('New speaker for this line only…'));

    expect(onCreateSpeaker).toHaveBeenCalled();
    expect(onRenameSpeaker).not.toHaveBeenCalled();
    expect(onSetSpeaker).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SegmentActions — reopening', () => {
  it('never reopens onto a view a previous session left it in', () => {
    const baseProps = {
      anchorEl: document.createElement('button'),
      segment: SEGMENT,
      speakers: SPEAKERS,
      nameSuggestions: SPEAKERS.map((speaker) => speaker.displayName),
      speakerSegmentCount: 6,
      canJoin: true,
      onClose: vi.fn(),
      onRenameSpeaker: vi.fn(),
      onSetSpeaker: vi.fn(),
      onCreateSpeaker: vi.fn(),
      onSplit: vi.fn(),
      onJoin: vi.fn(),
      onDelete: vi.fn(),
      onPlayFrom: vi.fn(),
    };
    const { rerender } = render(<SegmentActions open {...baseProps} />);

    fireEvent.click(menuItemFor('Rename Ana'));
    expect(screen.getByRole('combobox', { name: 'Speaker name' })).toBeInTheDocument();

    rerender(<SegmentActions open={false} {...baseProps} />);
    rerender(<SegmentActions open {...baseProps} />);

    expect(screen.queryByRole('combobox', { name: 'Speaker name' })).not.toBeInTheDocument();
    expect(menuItemFor('Rename Ana')).toBeInTheDocument();
  });
});

describe('SegmentActions — two presentations, one body', () => {
  it('is a bottom Drawer below sm, and the rename view still works there', async () => {
    const user = userEvent.setup();
    act(() => setViewportWidth(390));
    const { onRenameSpeaker } = renderActions();

    expect(document.querySelector('.MuiDrawer-root')).not.toBeNull();
    expect(document.querySelector('.MuiPopover-root')).toBeNull();

    await user.click(menuItemFor('Rename Ana'));
    const field = screen.getByRole('combobox', { name: 'Speaker name' });
    await user.clear(field);
    await user.type(field, 'Justin');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onRenameSpeaker).toHaveBeenCalledWith('Justin');
  });

  it('is an anchored Popover at sm and above, and the rename view still works there', async () => {
    const user = userEvent.setup();
    act(() => setViewportWidth(600));
    const { onRenameSpeaker } = renderActions();

    expect(document.querySelector('.MuiPopover-root')).not.toBeNull();
    expect(document.querySelector('.MuiDrawer-root')).toBeNull();

    await user.click(menuItemFor('Rename Ana'));
    const field = screen.getByRole('combobox', { name: 'Speaker name' });
    await user.clear(field);
    await user.type(field, 'Justin');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onRenameSpeaker).toHaveBeenCalledWith('Justin');
  });
});
