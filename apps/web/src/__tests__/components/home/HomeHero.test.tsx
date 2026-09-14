import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { TAGLINE } from '@app/shared';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import type React from 'react';

import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { HomeHero, firstNameOf } from '../../../components/home/HomeHero';
import { AXE_OPTIONS, homeUser } from './homeFixtures';

/**
 * The hero, and the `NewTranscriptButton` it owns.
 *
 * The two are tested together rather than apart because every interesting
 * question about either is about the PAIR: whether a user who cannot transcribe
 * is told why, and whether the person who could fix that is offered the way to.
 */

beforeEach(() => {
  mockNavigate.mockClear();
});

/** Every bare render here is an ordinary account that CAN record something. */
function renderHero(ui: React.ReactElement, user = homeUser) {
  return render(ui, { wrapperOptions: { user } });
}

describe('firstNameOf', () => {
  it('takes the word before the first space', () => {
    expect(firstNameOf('Ana Ruiz')).toBe('Ana');
  });

  it('returns a single-word name unchanged', () => {
    expect(firstNameOf('Prince')).toBe('Prince');
  });

  it('ignores surrounding whitespace', () => {
    expect(firstNameOf('   Ana   Ruiz  ')).toBe('Ana');
  });

  it('returns null for null', () => {
    expect(firstNameOf(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(firstNameOf(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(firstNameOf('')).toBeNull();
  });

  it('returns null for a name that is only whitespace', () => {
    // The dangling-comma case: "Hi, " is worse than "Hi there".
    expect(firstNameOf('   ')).toBeNull();
  });
});

describe('HomeHero', () => {
  it('greets the user by their first name only', () => {
    renderHero(<HomeHero displayName="Ana Ruiz" transcriptionAvailable />);

    expect(screen.getByRole('heading', { level: 1, name: 'Hi, Ana' })).toBeInTheDocument();
  });

  it('greets a user with no display name without a dangling comma', () => {
    renderHero(<HomeHero displayName={null} transcriptionAvailable />);

    expect(screen.getByRole('heading', { level: 1, name: 'Hi there' })).toBeInTheDocument();
  });

  it('renders the greeting as the page h1', () => {
    renderHero(<HomeHero displayName="Ana Ruiz" transcriptionAvailable />);

    expect(screen.getByRole('heading', { name: 'Hi, Ana' }).tagName).toBe('H1');
  });

  // The point of the whole `TAGLINE` export: the assertion reads the shared
  // constant rather than the current wording, so a fork that rewrites its
  // promise keeps this green and a component that hardcodes one goes red.
  it('renders the tagline from the shared identity file', () => {
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable />);

    expect(screen.getByText(TAGLINE)).toBeInTheDocument();
  });

  it('does not restate the tagline as a literal anywhere in the component', () => {
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable />);

    // Exactly one node carries it — a second would mean a hardcoded copy.
    expect(screen.getAllByText(TAGLINE)).toHaveLength(1);
  });

  it('labels its section with the greeting', () => {
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable />);

    expect(screen.getByRole('region', { name: 'Hi, Ana' })).toBeInTheDocument();
  });

  it('no longer says "Welcome back"', () => {
    renderHero(<HomeHero displayName="Ana Ruiz" transcriptionAvailable />);

    expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderHero(<HomeHero displayName="Ana" transcriptionAvailable />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('HomeHero — the New transcript button', () => {
  it('offers New transcript when transcription is available', () => {
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeEnabled();
  });

  it('navigates to the New-transcript flow when pressed', async () => {
    const user = userEvent.setup();
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable />);

    await user.click(screen.getByRole('button', { name: 'New transcript' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/new');
  });

  it('hides the button entirely from a user without transcripts:write', () => {
    // No button rather than a disabled one: `/transcripts/new` is guarded on
    // exactly this permission, so a disabled control would advertise something
    // they will never be able to do.
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable />, {
      ...mockUser,
      permissions: ['user_settings:read'],
    });

    expect(screen.queryByRole('button', { name: 'New transcript' })).not.toBeInTheDocument();
  });

  it('disables the button when transcription is not configured', () => {
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable={false} />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeDisabled();
  });

  it('explains why the button is disabled', () => {
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable={false} />);

    expect(screen.getByText(/transcription is not set up for this workspace yet/i))
      .toBeInTheDocument();
  });

  it('ties the explanation to the disabled button with aria-describedby', () => {
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable={false} />);

    const button = screen.getByRole('button', { name: 'New transcript' });
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      /transcription is not set up/i,
    );
  });

  it('says nothing about availability while the probe is still in flight', () => {
    // A half-second of "not set up yet" before the probe answers is a lie the
    // user has time to read.
    renderHero(
      <HomeHero displayName="Ana" transcriptionAvailable={false} isCheckingTranscription />,
    );

    expect(screen.queryByText(/transcription is not set up/i)).not.toBeInTheDocument();
  });

  it('still keeps the button disabled while the probe is in flight', () => {
    renderHero(
      <HomeHero displayName="Ana" transcriptionAvailable={false} isCheckingTranscription />,
    );

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeDisabled();
  });

  it('offers a set-up link to a user holding system_settings:read', () => {
    renderHero(<HomeHero displayName="Admin" transcriptionAvailable={false} />, mockAdminUser);

    expect(screen.getByRole('button', { name: 'Set up transcription' })).toBeInTheDocument();
  });

  it('sends the set-up link to the transcription settings page', async () => {
    const user = userEvent.setup();
    renderHero(<HomeHero displayName="Admin" transcriptionAvailable={false} />, mockAdminUser);

    await user.click(screen.getByRole('button', { name: 'Set up transcription' }));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/transcription');
  });

  it('withholds the set-up link from a user who cannot read system settings', () => {
    // Gated on the permission the transcription settings controller enforces,
    // not on the admin role — offering a link that redirects straight back is
    // worse than not offering it.
    renderHero(<HomeHero displayName="Ana" transcriptionAvailable={false} />, homeUser);

    expect(screen.queryByRole('button', { name: 'Set up transcription' })).not.toBeInTheDocument();
  });

  it('shows no set-up link when transcription is working, even for an admin', () => {
    renderHero(<HomeHero displayName="Admin" transcriptionAvailable />, mockAdminUser);

    expect(screen.queryByRole('button', { name: 'Set up transcription' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations in the unavailable-for-an-admin state', async () => {
    const { container } = renderHero(
      <HomeHero displayName="Admin" transcriptionAvailable={false} />,
      mockAdminUser,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
