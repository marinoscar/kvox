import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import type React from 'react';

import { render, mockAdminUser } from '../../utils/test-utils';
import { useKvoxPermissionCheck } from '@marinoscar/kvox-web/core/headless';
import { resolveJourneySteps } from '@marinoscar/kvox-web/home/headless';
import {
  JourneyEmptyState,
  JOURNEY_STAGES,
} from '@marinoscar/kvox-web/home/ui';
import { useRecordAudioStep } from '../../../components/home/recordAudioStep';
import { AXE_OPTIONS, homeUser } from './homeFixtures';

/**
 * The first-run walkthrough.
 *
 * The assertion that earns its keep here is the "Coming soon" label: a stage
 * that does not exist yet is still drawn, because the SHAPE of the journey is
 * the product's thesis, and labelled, because the shape is not a promise about
 * today. A regression that quietly dropped the label would ship an empty state
 * advertising a feature that does not exist.
 *
 * ⚠ THE COUNT IS ONE, NOT TWO, SINCE #107. Transform shed its label when the
 * home page started showing notes: epic #45 shipped the feature, and a stage
 * cannot advertise as unbuilt something the very same screen now lists. Find
 * is the only one left, and the day it ships these numbers move again --
 * which is the point of asserting the exact set rather than a bare count.
 */

/**
 * The journey as KVox web binds it: its own "Record or upload audio" step, filtered
 * for the viewer the way the packaged page filters it (`resolveJourneySteps`).
 */
function WebJourney({
  transcriptionAvailable,
  isCheckingTranscription = false,
}: {
  transcriptionAvailable: boolean;
  isCheckingTranscription?: boolean;
}) {
  const recordStep = useRecordAudioStep({
    available: transcriptionAvailable,
    isChecking: isCheckingTranscription,
  });
  const hasPermission = useKvoxPermissionCheck();
  const steps = resolveJourneySteps({
    journeySteps: [],
    extraSteps: [recordStep],
    progress: { notes: 0 },
    context: { hasPermission, graphEnabled: false },
  });
  return <JourneyEmptyState steps={steps} />;
}

function renderJourney(ui: React.ReactElement, user = homeUser) {
  return render(ui, { wrapperOptions: { user } });
}

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('JOURNEY_STAGES', () => {
  it('is the four stages of the vision, in order', () => {
    expect(JOURNEY_STAGES.map((stage) => stage.label)).toEqual([
      'Capture',
      'Correct',
      'Transform',
      'Find',
    ]);
  });

  it('marks exactly the one that does not exist yet', () => {
    expect(JOURNEY_STAGES.filter((stage) => stage.comingSoon).map((s) => s.label)).toEqual([
      'Find',
    ]);
  });

  it('gives every stage a sentence of its own', () => {
    for (const stage of JOURNEY_STAGES) {
      expect(stage.description.length).toBeGreaterThan(10);
    }
  });
});

describe('JourneyEmptyState', () => {
  it('heads the section so a new user knows where to begin', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    expect(screen.getByRole('heading', { name: 'Start here' })).toBeInTheDocument();
  });

  it('says plainly that there is nothing yet', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    expect(screen.getByText(/you have no transcripts yet/i)).toBeInTheDocument();
  });

  it('draws all four stages', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(4);
  });

  it('names Capture and Correct as the two that work', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    expect(screen.getByRole('heading', { name: 'Capture' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Correct' })).toBeInTheDocument();
  });

  it('draws Transform and Find too', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    expect(screen.getByRole('heading', { name: 'Transform' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Find' })).toBeInTheDocument();
  });

  it('marks exactly one of them "Coming soon"', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    expect(screen.getAllByText('Coming soon')).toHaveLength(1);
  });

  it('does not mark Capture as coming soon', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    const capture = screen.getByRole('heading', { name: 'Capture' }).parentElement!;
    expect(within(capture).queryByText('Coming soon')).not.toBeInTheDocument();
  });

  // Pinned as its own case rather than folded into the count above (#107): the
  // count would still pass if Transform kept its label and Find lost one.
  it('no longer marks Transform as coming soon, now that notes ship', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    const transform = screen.getByRole('heading', { name: 'Transform' }).parentElement!;
    expect(within(transform).queryByText('Coming soon')).not.toBeInTheDocument();
  });

  it('marks Find as coming soon', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    const find = screen.getByRole('heading', { name: 'Find' }).parentElement!;
    expect(within(find).getByText('Coming soon')).toBeInTheDocument();
  });

  it('renders the stages as an ordered list — the order is the meaning', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    expect(screen.getByRole('list').tagName).toBe('OL');
  });

  it('includes the New transcript button', () => {
    renderJourney(<WebJourney transcriptionAvailable />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeEnabled();
  });

  it('sends that button into the New-transcript flow', async () => {
    const user = userEvent.setup();
    renderJourney(<WebJourney transcriptionAvailable />);

    await user.click(screen.getByRole('button', { name: 'New transcript' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/new');
  });

  it('disables the button when transcription is not configured', () => {
    renderJourney(<WebJourney transcriptionAvailable={false} />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeDisabled();
  });

  it('offers an admin the way to fix that', () => {
    renderJourney(<WebJourney transcriptionAvailable={false} />, mockAdminUser);

    expect(screen.getByRole('button', { name: 'Set up transcription' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderJourney(<WebJourney transcriptionAvailable />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no accessibility violations when transcription is unavailable', async () => {
    const { container } = renderJourney(
      <WebJourney transcriptionAvailable={false} />,
      mockAdminUser,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
