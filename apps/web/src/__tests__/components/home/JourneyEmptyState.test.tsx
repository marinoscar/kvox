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
import {
  JourneyEmptyState,
  JOURNEY_STAGES,
} from '../../../components/home/JourneyEmptyState';
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
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    expect(screen.getByRole('heading', { name: 'Start here' })).toBeInTheDocument();
  });

  it('says plainly that there is nothing yet', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    expect(screen.getByText(/you have no transcripts yet/i)).toBeInTheDocument();
  });

  it('draws all four stages', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(4);
  });

  it('names Capture and Correct as the two that work', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    expect(screen.getByRole('heading', { name: 'Capture' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Correct' })).toBeInTheDocument();
  });

  it('draws Transform and Find too', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    expect(screen.getByRole('heading', { name: 'Transform' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Find' })).toBeInTheDocument();
  });

  it('marks exactly one of them "Coming soon"', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    expect(screen.getAllByText('Coming soon')).toHaveLength(1);
  });

  it('does not mark Capture as coming soon', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    const capture = screen.getByRole('heading', { name: 'Capture' }).parentElement!;
    expect(within(capture).queryByText('Coming soon')).not.toBeInTheDocument();
  });

  // Pinned as its own case rather than folded into the count above (#107): the
  // count would still pass if Transform kept its label and Find lost one.
  it('no longer marks Transform as coming soon, now that notes ship', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    const transform = screen.getByRole('heading', { name: 'Transform' }).parentElement!;
    expect(within(transform).queryByText('Coming soon')).not.toBeInTheDocument();
  });

  it('marks Find as coming soon', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    const find = screen.getByRole('heading', { name: 'Find' }).parentElement!;
    expect(within(find).getByText('Coming soon')).toBeInTheDocument();
  });

  it('renders the stages as an ordered list — the order is the meaning', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    expect(screen.getByRole('list').tagName).toBe('OL');
  });

  it('includes the New transcript button', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeEnabled();
  });

  it('sends that button into the New-transcript flow', async () => {
    const user = userEvent.setup();
    renderJourney(<JourneyEmptyState transcriptionAvailable />);

    await user.click(screen.getByRole('button', { name: 'New transcript' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/new');
  });

  it('disables the button when transcription is not configured', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable={false} />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeDisabled();
  });

  it('offers an admin the way to fix that', () => {
    renderJourney(<JourneyEmptyState transcriptionAvailable={false} />, mockAdminUser);

    expect(screen.getByRole('button', { name: 'Set up transcription' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderJourney(<JourneyEmptyState transcriptionAvailable />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no accessibility violations when transcription is unavailable', async () => {
    const { container } = renderJourney(
      <JourneyEmptyState transcriptionAvailable={false} />,
      mockAdminUser,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
