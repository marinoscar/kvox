import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import {
  SpeakerMergeDialog,
  planSpeakerMerge,
} from '../../../components/transcripts/SpeakerMergeDialog';
import type { TranscriptSpeaker } from '../../../services/transcripts';

const ANA: TranscriptSpeaker = {
  id: 'sp1',
  label: 'A',
  displayName: 'Ana',
  colorIndex: 0,
  rev: 1,
};
const BEN: TranscriptSpeaker = {
  id: 'sp2',
  label: 'B',
  displayName: 'Speaker 3',
  colorIndex: 1,
  rev: 1,
};
const CAI: TranscriptSpeaker = {
  id: 'sp3',
  label: 'C',
  displayName: 'Cai',
  colorIndex: 2,
  rev: 1,
};

const ORDER = ['sp1', 'sp2', 'sp3'];
const counts = new Map([
  ['sp1', 40],
  ['sp2', 4],
  ['sp3', 4],
]);

describe('planSpeakerMerge', () => {
  it('keeps the BIGGEST speaker, so a merge repaints the fewest lines', () => {
    // A speaker's colour is stable for its lifetime and is what makes the
    // transcript scannable; the surviving row decides which colour most of it
    // keeps.
    expect(planSpeakerMerge(['sp2', 'sp1'], counts, 'sp1', ORDER)).toEqual({
      targetId: 'sp1',
      sourceIds: ['sp2'],
      keepName: true,
    });
  });

  it('breaks a tie by the API’s own speaker order, so the plan is stable', () => {
    expect(planSpeakerMerge(['sp3', 'sp2'], counts, 'sp2', ORDER)?.targetId).toBe('sp2');
  });

  it('inverts keepName and puts the name-holder FIRST when the name is a source’s', () => {
    // `keepName: false` adopts the first `sourceIds` entry's name onto the
    // target — which is how a different name is kept without moving the row
    // that survives.
    expect(planSpeakerMerge(['sp1', 'sp2', 'sp3'], counts, 'sp3', ORDER)).toEqual({
      targetId: 'sp1',
      sourceIds: ['sp3', 'sp2'],
      keepName: false,
    });
  });

  it('is null below two speakers — a merge of one is not a narrower merge', () => {
    expect(planSpeakerMerge(['sp1'], counts, 'sp1', ORDER)).toBeNull();
    expect(planSpeakerMerge(['sp1', 'sp1'], counts, 'sp1', ORDER)).toBeNull();
  });
});

describe('SpeakerMergeDialog', () => {
  it('shows each speaker’s segment count and the total that will move', async () => {
    render(
      <SpeakerMergeDialog
        open
        selected={[ANA, BEN]}
        segmentCounts={counts}
        order={ORDER}
        onClose={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    expect(await screen.findByText('40 segments')).toBeInTheDocument();
    expect(screen.getByText('4 segments')).toBeInTheDocument();
    expect(screen.getByText(/44 segments will end up on one speaker/)).toBeInTheDocument();
  });

  it('keeps the name the user chose', async () => {
    const user = userEvent.setup();
    const onMerge = vi.fn();
    render(
      <SpeakerMergeDialog
        open
        selected={[ANA, BEN]}
        segmentCounts={counts}
        order={ORDER}
        onClose={vi.fn()}
        onMerge={onMerge}
      />,
    );

    // "Speaker 3" is the small one, so the big row survives — but its NAME is
    // the one being renamed away from, which is exactly the `keepName: false`
    // case.
    await user.click(await screen.findByRole('radio', { name: /Speaker 3/ }));
    await user.click(screen.getByRole('button', { name: 'Merge' }));

    expect(onMerge).toHaveBeenCalledWith({
      targetId: 'sp1',
      sourceIds: ['sp2'],
      keepName: false,
    });
  });

  it('defaults to the name of the speaker that survives anyway', async () => {
    const user = userEvent.setup();
    const onMerge = vi.fn();
    render(
      <SpeakerMergeDialog
        open
        selected={[ANA, BEN, CAI]}
        segmentCounts={counts}
        order={ORDER}
        onClose={vi.fn()}
        onMerge={onMerge}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Merge' }));

    expect(onMerge).toHaveBeenCalledWith({
      targetId: 'sp1',
      sourceIds: ['sp2', 'sp3'],
      keepName: true,
    });
  });

  it('renders nothing below two speakers', () => {
    const { container } = render(
      <SpeakerMergeDialog
        open
        selected={[ANA]}
        segmentCounts={counts}
        order={ORDER}
        onClose={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
