import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from './helpers.js';
import {
  SpeakerVoiceSuggestions,
  formatVoiceMatchScore,
} from '../../src/transcripts/ui/components/SpeakerVoiceSuggestions.js';
import type { SpeakerVoiceSuggestionsProps } from '../../src/transcripts/ui/components/SpeakerVoiceSuggestions.js';
import type { TranscriptSpeaker } from '../../src/transcripts/headless/clients/transcripts.js';

/**
 * The voice-match rows under the speaker list (#827). The page wiring and the
 * graph slot are covered through the real page in
 * `test/graph/TranscriptVoiceSuggestions.test.tsx`; this is the component alone.
 */

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Speaker A', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Speaker B', colorIndex: 1, rev: 1 },
];

function renderRows(overrides: Partial<SpeakerVoiceSuggestionsProps> = {}) {
  const props: SpeakerVoiceSuggestionsProps = {
    speakers: SPEAKERS,
    bySpeaker: { sp1: { id: 'sug-1', speakerId: 'sp1', personName: 'Person A', score: 0.871 } },
    canDecide: true,
    busyId: null,
    error: null,
    onClearError: vi.fn(),
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(<SpeakerVoiceSuggestions {...props} />);
  return props;
}

describe('formatVoiceMatchScore', () => {
  it('rounds to a whole percentage and clamps', () => {
    expect(formatVoiceMatchScore(0.871)).toBe('87%');
    expect(formatVoiceMatchScore(0.875)).toBe('88%');
    expect(formatVoiceMatchScore(1.2)).toBe('100%');
    expect(formatVoiceMatchScore(-0.1)).toBe('0%');
    expect(formatVoiceMatchScore(Number.NaN)).toBe('0%');
  });
});

describe('SpeakerVoiceSuggestions', () => {
  it('renders one row per speaker with a suggestion, with the label and the score', () => {
    renderRows();
    const section = screen.getByRole('region', { name: 'Voice match suggestions' });
    expect(within(section).getByText('Voice match')).toBeInTheDocument();
    expect(within(section).getAllByRole('listitem')).toHaveLength(1);
    expect(section).toHaveTextContent('Speaker A sounds like Person A · 87%');
    expect(section).not.toHaveTextContent('Speaker B');
  });

  it('renders nothing without a suggestion or an error', () => {
    const { container } = render(
      <SpeakerVoiceSuggestions
        speakers={SPEAKERS}
        bySpeaker={{}}
        canDecide
        busyId={null}
        error={null}
        onClearError={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('calls accept and dismiss with the suggestion id', async () => {
    const user = userEvent.setup();
    const props = renderRows();
    await user.click(screen.getByRole('button', { name: 'Accept: Speaker A is Person A' }));
    expect(props.onAccept).toHaveBeenCalledWith('sug-1');
    await user.click(screen.getByRole('button', { name: 'Dismiss: Speaker A is not Person A' }));
    expect(props.onDismiss).toHaveBeenCalledWith('sug-1');
  });

  it('disables both actions when the viewer cannot decide, or while a decision is in flight', () => {
    renderRows({ canDecide: false });
    expect(screen.getByRole('button', { name: 'Accept: Speaker A is Person A' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dismiss: Speaker A is not Person A' })).toBeDisabled();
  });

  it('disables the actions while a decision is in flight', () => {
    renderRows({ busyId: 'sug-1' });
    expect(screen.getByRole('button', { name: 'Accept: Speaker A is Person A' })).toBeDisabled();
  });

  it('shows an error that can be closed', async () => {
    const user = userEvent.setup();
    const props = renderRows({ error: 'This speaker was named in the meantime.' });
    expect(screen.getByRole('alert')).toHaveTextContent('This speaker was named in the meantime.');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClearError).toHaveBeenCalled();
  });
});
