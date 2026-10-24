/**
 * Home in a host without transcription (marinoscar/kvox#731, epic #728): KVox
 * Desktop has no audio capture (ADR-0006), so its first run is the note-first
 * journey (import, review, the graph, Ask) with "Add your notes folder" and
 * "Import notes" under it, and nothing on the page speaks of recordings. A host
 * that does not set the switch keeps the classic Home.
 */

import { screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/transcripts/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/transcripts/headless/index.js')>()),
  useUploadManager: () => ({ uploads: [], sessions: [] }),
}));

import { createFakeKvoxWebHost, renderWithKvoxHost } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost } from '../../src/core/testing/index.js';
import { KVOX_KNOWLEDGE_HOME_SECTIONS } from '../../src/home/headless/index.js';
import {
  JOURNEY_INTRO,
  KVOX_NOTE_FIRST_JOURNEY,
  KVOX_NOTE_FIRST_JOURNEY_INTRO,
  KvoxHomePage,
} from '../../src/home/ui/index.js';
import { ALL_HOME_PERMISSIONS, note, noteSummary, transcriptSummary } from './homeData.js';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const RECORDING_WORDS = /record|audio|transcrib|microphone|upload a/i;

function host(options: { transcription?: boolean; graphEnabled?: boolean; notes?: ReturnType<typeof noteSummary> } = {}): FakeKvoxWebHost {
  return createFakeKvoxWebHost({
    viewer: { userId: 'u1', permissions: ALL_HOME_PERMISSIONS, displayName: 'Ana Ruiz' },
    features: {
      graphEnabled: options.graphEnabled ?? false,
      ...(options.transcription === undefined ? {} : { transcription: options.transcription }),
    },
    routes: {
      'GET /transcripts/summary': transcriptSummary(),
      'GET /notes/summary': options.notes ?? noteSummary(),
      'GET /notes/libraries': { items: [] },
      'GET /notes/import-batches': { items: [] },
    },
  });
}

async function loaded() {
  await screen.findByRole('heading', { level: 1 });
}

function stageLabels(journey: HTMLElement) {
  return within(journey)
    .getAllByRole('listitem')
    .map((li) => li.querySelector('h3')?.textContent);
}

describe('Home in a host without transcription', () => {
  it('draws the note-first journey on the knowledge-first Home', async () => {
    const fake = host({ transcription: false });
    const { container } = renderWithKvoxHost(<KvoxHomePage sections={KVOX_KNOWLEDGE_HOME_SECTIONS} />, fake);
    await loaded();

    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(stageLabels(journey)).toEqual(['Import your notes', 'Review', 'Your graph', 'Ask']);
    expect(stageLabels(journey)).toEqual(KVOX_NOTE_FIRST_JOURNEY.map((stage) => stage.label));
    expect(within(journey).getByText(KVOX_NOTE_FIRST_JOURNEY_INTRO)).toBeInTheDocument();
    expect(
      within(journey).getByText('Word, PowerPoint, PDF, Markdown or text — a file or a whole folder.'),
    ).toBeInTheDocument();
    expect(within(journey).getByText('Questions answered from your notes, with citations.')).toBeInTheDocument();

    // The actions under it: the libraries first, then the import picker.
    const folder = within(journey).getByRole('link', { name: 'Add your notes folder' });
    expect(folder).toHaveAttribute('href', '/notes/libraries');
    expect(within(journey).getByRole('button', { name: 'Import notes' })).toBeInTheDocument();
    expect(within(journey).queryByRole('link', { name: 'New note' })).not.toBeInTheDocument();
    expect(within(journey).queryByRole('link', { name: 'Open knowledge' })).not.toBeInTheDocument();

    expect(container.textContent).not.toMatch(RECORDING_WORDS);
    expect(fake.callsTo('GET /transcripts/summary')).toHaveLength(0);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('drops every transcript section and the transcript search, even when a host lists them', async () => {
    const fake = host({ transcription: false, notes: noteSummary({ recent: [note({ sourceName: 'Weekly sync' })] }) });
    const { container } = renderWithKvoxHost(<KvoxHomePage />, fake);
    await loaded();
    await screen.findByRole('heading', { name: 'Recent notes' });

    expect(fake.callsTo('GET /transcripts/summary')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Your library at a glance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /recent transcripts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /shared with me/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(RECORDING_WORDS);
  });

  it('words the empty recent-notes prompt around imports', async () => {
    const fake = host({ transcription: false });
    const { container } = renderWithKvoxHost(
      <KvoxHomePage sections={['hero', 'recentNotes']} />,
      fake,
    );
    await loaded();

    expect(await screen.findByRole('heading', { name: 'Bring in your notes' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(RECORDING_WORDS);
  });

  it('keeps a host’s own journey pieces over the note-first defaults', async () => {
    renderWithKvoxHost(
      <KvoxHomePage
        journeyIntro="Your own intro."
        journeyStages={[{ key: 'only', label: 'Only stage', description: 'Just this.', icon: null }]}
        journeySteps={[]}
      />,
      host({ transcription: false }),
    );
    await loaded();
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(stageLabels(journey)).toEqual(['Only stage']);
    expect(within(journey).getByText('Your own intro.')).toBeInTheDocument();
    expect(within(journey).queryByRole('link', { name: 'Add your notes folder' })).not.toBeInTheDocument();
  });
});

describe('Home in a host that does not set the switch', () => {
  it('keeps the classic journey, its copy and the transcript summary', async () => {
    const fake = host({ graphEnabled: true });
    renderWithKvoxHost(<KvoxHomePage />, fake);
    await loaded();

    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(stageLabels(journey)).toEqual(['Capture', 'Correct', 'Transform', 'Find']);
    expect(within(journey).getByText(JOURNEY_INTRO)).toBeInTheDocument();
    expect(within(journey).getByText('Upload a recording and get a transcript that knows who spoke.')).toBeInTheDocument();
    expect(within(journey).getByRole('link', { name: 'New note' })).toHaveAttribute('href', '/notes/new');
    expect(fake.callsTo('GET /transcripts/summary').length).toBeGreaterThan(0);
    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('treats transcription: true like an absent switch', async () => {
    renderWithKvoxHost(<KvoxHomePage />, host({ transcription: true }));
    await loaded();
    const journey = await screen.findByRole('region', { name: 'Start here' });
    expect(stageLabels(journey)[0]).toBe('Capture');
  });
});
