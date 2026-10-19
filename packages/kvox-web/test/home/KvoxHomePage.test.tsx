/**
 * `KvoxHomePage` over a stub `KvoxWebHost` and no API (issue #632): the Home both
 * hosts draw. What is asserted is the part that is the PACKAGE's: the host is the
 * only thing it reads, steps are filtered by permission and feature, the host's
 * slots appear where they should, and a host without transcripts never asks for a
 * transcript summary.
 */

import { screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { describe, expect, it, vi } from 'vitest';

// The upload manager owns XMLHttpRequests, IndexedDB sessions and a wake lock, none of
// which this page's behaviour depends on; the web edition mounts the real provider.
vi.mock('../../src/transcripts/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/transcripts/headless/index.js')>()),
  useUploadManager: () => ({ uploads: [], sessions: [] }),
}));

import { fakeApiError, renderWithKvoxHost } from '../../src/core/testing/index.js';
import type { KvoxJourneyStep } from '../../src/home/headless/index.js';
import { KvoxHomePage } from '../../src/home/ui/index.js';
import {
  homeHost,
  note,
  noteSummary,
  transcript,
  transcriptSummary,
} from './homeData.js';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const hostStep = (key: string, extra: Partial<KvoxJourneyStep> = {}): KvoxJourneyStep => ({
  key,
  title: `Title of ${key}`,
  body: `Body of ${key}`,
  done: false,
  action: { label: `Do ${key}`, onClick: () => undefined },
  ...extra,
});

const NO_TRANSCRIPTS = ['hero', 'journey', 'inProgress', 'needsAttention', 'recentNotes', 'knowledge'] as const;

async function loaded() {
  await screen.findByRole('heading', { level: 1 });
}

describe('KvoxHomePage in a host with no API behind it', () => {
  it('renders the greeting from the host viewer and the tagline it is given', async () => {
    const host = homeHost();
    renderWithKvoxHost(<KvoxHomePage tagline="From voice to knowledge." />, host);
    expect(await screen.findByRole('heading', { level: 1, name: 'Hi, Ana' })).toBeInTheDocument();
    expect(screen.getByText('From voice to knowledge.')).toBeInTheDocument();
  });

  it('greets without a name when the host does not know one, and draws no tagline unasked', async () => {
    const host = homeHost({ viewer: { userId: 'u1', permissions: ['notes:read'] } });
    renderWithKvoxHost(<KvoxHomePage />, host);
    expect(await screen.findByRole('heading', { level: 1, name: 'Hi there' })).toBeInTheDocument();
    expect(screen.queryByText('From voice to knowledge.')).not.toBeInTheDocument();
  });

  it('shows the first-run journey to an account with nothing yet', async () => {
    renderWithKvoxHost(<KvoxHomePage />, homeHost());
    await loaded();
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(within(journey).getAllByRole('listitem').map((li) => li.querySelector('h3')?.textContent)).toEqual([
      'Capture',
      'Correct',
      'Transform',
      'Find',
    ]);
    // No counts strip above a walkthrough that explains how to stop it reading zero.
    expect(screen.queryByRole('region', { name: 'Your library at a glance' })).not.toBeInTheDocument();
  });

  it('draws the steps the slices ship, for a viewer who may take them', async () => {
    renderWithKvoxHost(<KvoxHomePage />, homeHost({ graphEnabled: true }));
    await loaded();
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(within(journey).getByRole('group', { name: 'Write a note' })).toBeInTheDocument();
    expect(within(journey).getByRole('link', { name: 'New note' })).toHaveAttribute('href', '/notes/new');
    expect(within(journey).getByRole('link', { name: 'Open knowledge' })).toHaveAttribute('href', '/graph');
  });

  it('does not draw a step the viewer lacks the permission for', async () => {
    const host = homeHost({ viewer: { userId: 'u1', permissions: ['notes:read'], displayName: 'Ana' }, graphEnabled: true });
    renderWithKvoxHost(<KvoxHomePage />, host);
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(within(journey).queryByRole('group', { name: 'Write a note' })).not.toBeInTheDocument();
    expect(within(journey).queryByRole('group', { name: 'Explore your knowledge' })).not.toBeInTheDocument();
  });

  it('does not draw a graph step while connected knowledge is off', async () => {
    renderWithKvoxHost(<KvoxHomePage />, homeHost({ graphEnabled: false }));
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(within(journey).getByRole('group', { name: 'Write a note' })).toBeInTheDocument();
    expect(within(journey).queryByRole('group', { name: 'Explore your knowledge' })).not.toBeInTheDocument();
  });

  it('draws the host extra steps after the others, in order, filtered the same way', async () => {
    renderWithKvoxHost(
      <KvoxHomePage
        extraSteps={[
          hostStep('import'),
          hostStep('record', { permission: 'transcripts:write' }),
          hostStep('hidden', { permission: 'admin:everything' }),
        ]}
      />,
      homeHost({ graphEnabled: true }),
    );
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(within(journey).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Write a note',
      'Explore your knowledge',
      'Title of import',
      'Title of record',
    ]);
  });

  it('lets journeySteps replace the slices steps', async () => {
    renderWithKvoxHost(
      <KvoxHomePage journeySteps={[]} extraSteps={[hostStep('import')]} />,
      homeHost({ graphEnabled: true }),
    );
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(within(journey).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Title of import']);
  });

  it('draws a step action as a button, calls its handler and shows its body', async () => {
    let clicked = 0;
    renderWithKvoxHost(
      <KvoxHomePage
        journeySteps={[]}
        extraSteps={[hostStep('import', { action: { label: 'Import a document', onClick: () => (clicked += 1) } })]}
      />,
      homeHost(),
    );
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(within(journey).getByText('Body of import')).toBeInTheDocument();
    within(journey).getByRole('button', { name: 'Import a document' }).click();
    expect(clicked).toBe(1);
  });

  it('draws a disabled step action disabled, tied to its explanation', async () => {
    renderWithKvoxHost(
      <KvoxHomePage
        journeySteps={[]}
        extraSteps={[
          hostStep('import', {
            body: <p id="why">Not available here.</p>,
            action: { label: 'Import', onClick: () => undefined, disabled: true, describedBy: 'why' },
          }),
        ]}
      />,
      homeHost(),
    );
    const button = await screen.findByRole('button', { name: 'Import' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Not available here.');
  });

  it('makes the first step still to do the primary action', async () => {
    renderWithKvoxHost(
      <KvoxHomePage
        journeySteps={[]}
        extraSteps={[hostStep('a', { done: true }), hostStep('b'), hostStep('c')]}
      />,
      homeHost(),
    );
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(within(journey).queryByRole('button', { name: 'Do a' })).not.toBeInTheDocument();
    expect(within(journey).getByText('Title of a (done)')).toBeInTheDocument();
    expect(within(journey).getByRole('button', { name: 'Do b' }).className).toMatch(/contained/);
    expect(within(journey).getByRole('button', { name: 'Do c' }).className).toMatch(/outlined/);
  });

  it('puts the host hero actions before the packaged New note', async () => {
    renderWithKvoxHost(
      <KvoxHomePage heroActions={<button type="button">Host action</button>} />,
      homeHost(),
    );
    await loaded();
    const hero = screen.getByRole('region', { name: /Hi, Ana/ });
    const buttons = within(hero).getAllByRole('button').map((b) => b.textContent);
    expect(buttons.indexOf('Host action')).toBeGreaterThanOrEqual(0);
    expect(buttons.indexOf('Host action')).toBeLessThan(buttons.indexOf('New note'));
  });

  it('offers New note only to a viewer who can write notes', async () => {
    const host = homeHost({ viewer: { userId: 'u1', permissions: ['notes:read'], displayName: 'Ana' } });
    renderWithKvoxHost(<KvoxHomePage />, host);
    await loaded();
    expect(screen.queryByRole('button', { name: 'New note' })).not.toBeInTheDocument();
  });

  it('is accessible', async () => {
    const { container } = renderWithKvoxHost(
      <KvoxHomePage extraSteps={[hostStep('import')]} />,
      homeHost({ graphEnabled: true }),
    );
    await screen.findByRole('region', { name: 'Start here' });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('KvoxHomePage sections', () => {
  it('asks for no transcript summary at all without the recentTranscripts section', async () => {
    const host = homeHost();
    renderWithKvoxHost(<KvoxHomePage sections={NO_TRANSCRIPTS} />, host);
    await screen.findByRole('region', { name: 'Start here' });
    const paths = host.calls.map((call) => call.path);
    expect(paths).toContain('/notes/summary');
    expect(paths.some((path) => path.startsWith('/transcripts'))).toBe(false);
  });

  it('shows the journey to a notes-only host with no notes, and the notes once there are some', async () => {
    const empty = homeHost();
    const { unmount } = renderWithKvoxHost(<KvoxHomePage sections={NO_TRANSCRIPTS} />, empty);
    expect(await screen.findByRole('region', { name: 'Start here' })).toBeInTheDocument();
    unmount();

    const full = homeHost({ notes: noteSummary({ recent: [note()] }) });
    renderWithKvoxHost(<KvoxHomePage sections={NO_TRANSCRIPTS} />, full);
    expect(await screen.findByRole('heading', { name: 'Recent notes' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Start here' })).not.toBeInTheDocument();
    expect(screen.getByText('Standup minutes')).toBeInTheDocument();
  });

  it('draws only the hero when it is the only section', async () => {
    const host = homeHost({ notes: noteSummary({ recent: [note()] }) });
    renderWithKvoxHost(<KvoxHomePage sections={['hero']} />, host);
    await loaded();
    expect(screen.queryByRole('heading', { name: 'Recent notes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Recent$/ })).not.toBeInTheDocument();
  });

  it('leaves out the journey when it is not listed, even for a new account', async () => {
    renderWithKvoxHost(<KvoxHomePage sections={['hero', 'recentTranscripts']} />, homeHost());
    await loaded();
    expect(screen.queryByRole('region', { name: 'Start here' })).not.toBeInTheDocument();
  });

  it('draws the transcripts and notes of an account that has some, with item links from the host', async () => {
    const host = homeHost({
      transcripts: transcriptSummary({ recent: [transcript()] }),
      notes: noteSummary({ recent: [note()] }),
    });
    renderWithKvoxHost(<KvoxHomePage />, host);
    expect(await screen.findByRole('heading', { name: /^Recent$/ })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Recent notes' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Start here' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your library at a glance' })).toBeInTheDocument();
  });

  it('does not take a failed transcript read for a new account', async () => {
    const host = homeHost();
    host.setRoute('GET /transcripts/summary', () => {
      throw fakeApiError(500, 'boom');
    });
    renderWithKvoxHost(<KvoxHomePage />, host);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Start here' })).not.toBeInTheDocument();
  });
});
