import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { SpeakerActions } from '../../../components/transcripts/SpeakerActions';
import type { TranscriptSpeaker } from '../../../services/transcripts';

/**
 * The chip rail's speaker actions. Issue #220 extracted its rename view into
 * the shared `SpeakerNameForm` so `SegmentActions` could open the identical
 * surface — this file is the guard that the extraction left this rename path
 * behaving exactly as it did before. Merge and "play only" are unaffected by
 * that extraction and are already covered end-to-end through the real page in
 * `TranscriptCorrections.test.tsx`, so they are not repeated here.
 */

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Ben', colorIndex: 1, rev: 1 },
];

function renderActions(overrides: Partial<Parameters<typeof SpeakerActions>[0]> = {}) {
  const onClose = vi.fn();
  const onRename = vi.fn();
  const onMergeInto = vi.fn();
  const onTogglePlayOnly = vi.fn();
  const result = render(
    <SpeakerActions
      open
      anchorEl={document.createElement('button')}
      speaker={SPEAKERS[0]}
      speakers={SPEAKERS}
      nameSuggestions={SPEAKERS.map((speaker) => speaker.displayName)}
      isPlayingOnly={false}
      onClose={onClose}
      onRename={onRename}
      onMergeInto={onMergeInto}
      onTogglePlayOnly={onTogglePlayOnly}
      {...overrides}
    />,
  );
  return { ...result, onClose, onRename, onMergeInto, onTogglePlayOnly };
}

describe('SpeakerActions — the rename path, after #220’s form extraction', () => {
  it('opens the shared form seeded with the speaker’s current name', async () => {
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(screen.getByRole('combobox', { name: 'Speaker name' })).toHaveValue('Ana');
  });

  it('states the same all-lines scope the segment menu’s rename now states too', async () => {
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(
      screen.getByText('Renames this speaker on every line they speak.'),
    ).toBeInTheDocument();
  });

  it('calls onRename with the TRIMMED name and closes the surface', async () => {
    const user = userEvent.setup();
    const { onRename, onClose } = renderActions();

    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByRole('combobox', { name: 'Speaker name' });
    await user.clear(field);
    await user.type(field, '  Ben Olsen  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onRename).toHaveBeenCalledWith('Ben Olsen');
    expect(onClose).toHaveBeenCalled();
  });

  it('Cancel closes the surface without renaming', async () => {
    const user = userEvent.setup();
    const { onClose, onRename } = renderActions();

    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
  });
});
