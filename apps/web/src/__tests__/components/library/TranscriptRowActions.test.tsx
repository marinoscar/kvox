/**
 * `TranscriptRowActions` (issue #98, epic #19).
 *
 * The service modules are mocked — what is under test is the CONTROL'S OWN
 * behaviour: which items a row menu offers for a given `access`/`currentVersion`,
 * the naming contract the Play button and the `⋮` button both promise
 * (`aria-label` includes the row's title, not just the icon's meaning), and
 * the confirm/cancel/error flow around Delete and Leave.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';

vi.mock('../../../services/transcripts', async () => {
  const actual =
    await vi.importActual<typeof import('../../../services/transcripts')>(
      '../../../services/transcripts',
    );
  return { ...actual, deleteTranscript: vi.fn() };
});

vi.mock('../../../services/transcriptShares', async () => {
  const actual =
    await vi.importActual<typeof import('../../../services/transcriptShares')>(
      '../../../services/transcriptShares',
    );
  return { ...actual, removeShare: vi.fn() };
});

// `services/api` is NOT mocked: the component distinguishes an `ApiError`
// from any other throw, so the failure test constructs the real class.
import { ApiError } from '../../../services/api';
import { deleteTranscript } from '../../../services/transcripts';
import type { TranscriptListItem } from '../../../services/transcripts';
import { removeShare } from '../../../services/transcriptShares';
import { TranscriptRowActions } from '../../../components/library/TranscriptRowActions';

const mockDeleteTranscript = vi.mocked(deleteTranscript);
const mockRemoveShare = vi.mocked(removeShare);

function item(overrides: Partial<TranscriptListItem> = {}): TranscriptListItem {
  return {
    id: 't1',
    title: 'Weekly standup',
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 900_000,
    speakerCount: 3,
    wordCount: 2400,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    ownerName: 'Admin User',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderActions(
  transcript = item(),
  props: Partial<React.ComponentProps<typeof TranscriptRowActions>> = {},
) {
  const onTogglePreview = vi.fn();
  const onOpen = vi.fn();
  const onChanged = vi.fn();
  const utils = render(
    <TranscriptRowActions
      transcript={transcript}
      dense
      previewState="idle"
      onTogglePreview={onTogglePreview}
      onOpen={onOpen}
      onChanged={onChanged}
      {...props}
    />,
    { wrapperOptions: { user: mockAdminUser } },
  );
  return { ...utils, onTogglePreview, onOpen, onChanged };
}

beforeEach(() => {
  mockDeleteTranscript.mockReset().mockResolvedValue(undefined);
  mockRemoveShare.mockReset().mockResolvedValue(undefined);
});

describe('TranscriptRowActions — the Play button', () => {
  it('is present, and named for its row, when the row is playable', () => {
    renderActions(item({ title: 'Weekly standup' }), { previewState: 'idle' });

    expect(screen.getByRole('button', { name: 'Play "Weekly standup"' })).toBeInTheDocument();
  });

  it('renames itself to Pause while this row is the one playing', () => {
    renderActions(item({ title: 'Weekly standup' }), { previewState: 'playing' });

    expect(screen.getByRole('button', { name: 'Pause "Weekly standup"' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Play "Weekly standup"' }),
    ).not.toBeInTheDocument();
  });

  it('is absent entirely for a row with no playable audio', () => {
    renderActions(item({ status: 'processing', playbackStatus: 'processing' }));

    expect(screen.queryByRole('button', { name: /play|pause/i })).not.toBeInTheDocument();
  });

  it('calls onTogglePreview and does not call onOpen', async () => {
    const user = userEvent.setup();
    const { onTogglePreview, onOpen } = renderActions(item({ title: 'Weekly standup' }));

    await user.click(screen.getByRole('button', { name: 'Play "Weekly standup"' }));

    expect(onTogglePreview).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('TranscriptRowActions — the overflow menu', () => {
  it('is named "More options for" the row\'s own title', async () => {
    const user = userEvent.setup();
    renderActions(item({ title: 'Weekly standup' }));

    const button = screen.getByRole('button', { name: 'More options for "Weekly standup"' });
    await user.click(button);

    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('offers Share and Delete to the owner, and hides Leave', async () => {
    const user = userEvent.setup();
    renderActions(item({ access: 'owner' }));

    await user.click(screen.getByRole('button', { name: /more options/i }));

    expect(await screen.findByRole('menuitem', { name: 'Share…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete transcript' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Leave this transcript' })).not.toBeInTheDocument();
  });

  it('offers Leave to a non-owner, and hides Share and Delete', async () => {
    const user = userEvent.setup();
    renderActions(item({ access: 'viewer' }));

    await user.click(screen.getByRole('button', { name: /more options/i }));

    expect(await screen.findByRole('menuitem', { name: 'Leave this transcript' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Share…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete transcript' })).not.toBeInTheDocument();
  });

  it('hides Export when there is no version to export yet', async () => {
    const user = userEvent.setup();
    renderActions(item({ currentVersion: 0 }));

    await user.click(screen.getByRole('button', { name: /more options/i }));

    expect(await screen.findByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Export…' })).not.toBeInTheDocument();
  });

  it('offers Export once a version exists', async () => {
    const user = userEvent.setup();
    renderActions(item({ currentVersion: 1 }));

    await user.click(screen.getByRole('button', { name: /more options/i }));

    expect(await screen.findByRole('menuitem', { name: 'Export…' })).toBeInTheDocument();
  });

  it('calls onOpen for the Open item', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderActions(item());

    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('TranscriptRowActions — deleting (owner)', () => {
  it('confirms, calls deleteTranscript, and triggers the list refresh', async () => {
    const user = userEvent.setup();
    const { onChanged } = renderActions(item({ id: 't1', access: 'owner' }));

    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete transcript' }));

    expect(await screen.findByText('Delete this transcript?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockDeleteTranscript).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Delete this transcript?')).not.toBeInTheDocument();
  });

  it('cancels without calling deleteTranscript', async () => {
    const user = userEvent.setup();
    renderActions(item({ access: 'owner' }));

    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete transcript' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Delete this transcript?')).not.toBeInTheDocument();
    expect(mockDeleteTranscript).not.toHaveBeenCalled();
  });

  it('shows the error and leaves the dialog open when the delete fails', async () => {
    mockDeleteTranscript.mockRejectedValueOnce(new ApiError('Cannot delete right now', 409));
    const user = userEvent.setup();
    const { onChanged } = renderActions(item({ access: 'owner' }));

    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete transcript' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Cannot delete right now')).toBeInTheDocument();
    // The dialog is still up — the reader has to be able to try again or cancel.
    expect(screen.getByText('Delete this transcript?')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    mockDeleteTranscript.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    renderActions(item({ access: 'owner' }));

    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete transcript' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('That could not be completed.')).toBeInTheDocument();
  });
});

describe('TranscriptRowActions — leaving (non-owner)', () => {
  it('confirms, calls removeShare with the CALLER’S OWN id, and refreshes', async () => {
    const user = userEvent.setup();
    const { onChanged } = renderActions(item({ id: 't1', access: 'viewer' }));

    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave this transcript' }));

    expect(await screen.findByText('Leave this transcript?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave' }));

    await waitFor(() =>
      expect(mockRemoveShare).toHaveBeenCalledWith('t1', mockAdminUser.id),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});
