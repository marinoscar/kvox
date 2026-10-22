import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import './helpers.js';
import { HttpResponse, http, server } from './msw-compat.js';
import { mockAdminUser, render, testAi } from '../notes/helpers.js';
import type { MockUser } from '../notes/helpers.js';
import { NotePage, NotesPage } from '../../src/notes/ui/index.js';
import type { Note, NoteListItem } from '../../src/notes/headless/index.js';
import { exploreNotesPath } from '../../src/graph/ui/components/NoteExploreActions.js';
import { graphNotePageSlots, graphNotesLibrarySlots } from '../../src/graph/ui/slots/GraphNoteSlots.js';
import { proposalMock, mockProposalDetail } from './graphData.js';

/**
 * The notes pages' entries into the explorer (GIC-14, #675): "Explore in graph" and "Compare with…" on the
 * note page, and multi-select with "Explore connections" in the library. Each is a link into
 * `/graph/explore?connectNotes=…`; what the explorer does with it is `GraphExplorerConnect.test.tsx`.
 */

const API_BASE = 'http://localhost:3000/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const graphUser: MockUser = { ...mockAdminUser, permissions: [...mockAdminUser.permissions, 'graph:read'] };

function listItem(id: string, title: string): NoteListItem {
  return {
    id,
    title,
    titleSource: 'ai',
    excerpt: `About ${title}`,
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'document',
    sourceTranscriptId: null,
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: null,
    templateName: null,
    sourceName: null,
    currentGenerationId: 'gen',
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const items = ['Alpha', 'Bravo', 'Charlie'].map((title, i) => listItem(`n${i + 1}`, title));

const current: Note = {
  ...listItem('n1', 'Alpha'),
  body: 'We will ship behind a flag.',
  contextText: null,
} as Note;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

beforeEach(() => {
  localStorage.setItem('theme_mode', 'light');
  proposalMock.reset(mockProposalDetail('draft'));
  server.use(
    http.get(`${API_BASE}/notes/:id`, () => HttpResponse.json({ data: current })),
    http.get(`${API_BASE}/notes`, ({ request }) => {
      const q = new URL(request.url).searchParams.get('q')?.toLowerCase();
      const rows = q ? items.filter((item) => item.title.toLowerCase().includes(q)) : items;
      return HttpResponse.json({ data: { items: rows, total: rows.length, nextCursor: null } });
    }),
    http.get(`${API_BASE}/ai-tasks/config`, () =>
      HttpResponse.json({ data: { available: false, provider: null, providerLabel: null, models: [], defaultModel: null, maxInputTokens: 0, maxOutputTokens: 0, keyConfigured: false } }),
    ),
  );
});

const currentUrl = () => new URL(screen.getByTestId('location').textContent ?? '/', 'http://x');

function renderNote(user: MockUser = graphUser, graphEnabled = true) {
  return render(
    <>
      <Routes>
        <Route path="/notes/:id" element={<NotePage slots={graphNotePageSlots} ai={testAi()} />} />
        <Route path="/graph/explore" element={<h1>Explorer</h1>} />
      </Routes>
      <LocationProbe />
    </>,
    { wrapperOptions: { user, route: '/notes/n1' }, hostOptions: { features: { graphEnabled } } },
  );
}

function renderLibrary(user: MockUser = graphUser, graphEnabled = true) {
  return render(
    <>
      <Routes>
        <Route path="/notes" element={<NotesPage slots={graphNotesLibrarySlots} />} />
        <Route path="/graph/explore" element={<h1>Explorer</h1>} />
      </Routes>
      <LocationProbe />
    </>,
    { wrapperOptions: { user, route: '/notes' }, hostOptions: { features: { graphEnabled } } },
  );
}

describe('exploreNotesPath', () => {
  it('lists the notes in order, at most ten', () => {
    expect(exploreNotesPath(['a', 'b'])).toBe('/graph/explore?connectNotes=a,b');
    expect(exploreNotesPath(Array.from({ length: 12 }, (_, i) => `n${i}`)).split(',')).toHaveLength(10);
  });
});

describe('the note page entries', () => {
  it('"Explore in graph" opens the explorer on this note', async () => {
    const user = userEvent.setup();
    renderNote();
    await user.click(await screen.findByRole('button', { name: 'Explore in graph' }));
    expect(await screen.findByRole('heading', { name: 'Explorer' })).toBeInTheDocument();
    expect(currentUrl().search).toBe('?connectNotes=n1');
  });

  it('"Compare with…" finds another note by title and opens both', async () => {
    const user = userEvent.setup();
    renderNote();
    await user.click(await screen.findByRole('button', { name: 'Compare with…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compare with another note' });
    // The note itself is not offered.
    const list = await within(dialog).findByRole('list', { name: 'Notes to compare with' });
    expect(within(list).queryByText('Alpha')).not.toBeInTheDocument();
    expect(within(list).getByText('Bravo')).toBeInTheDocument();
    expect(await axe(dialog, AXE_OPTIONS)).toHaveNoViolations();

    await user.type(within(dialog).getByRole('textbox', { name: 'Search notes' }), 'char');
    await waitFor(() => expect(within(dialog).queryByText('Bravo')).not.toBeInTheDocument());
    await user.click(within(dialog).getByText('Charlie'));
    expect(await screen.findByRole('heading', { name: 'Explorer' })).toBeInTheDocument();
    expect(currentUrl().search).toBe('?connectNotes=n1,n3');
  });

  it('Cancel closes the picker and stays on the note', async () => {
    const user = userEvent.setup();
    renderNote();
    await user.click(await screen.findByRole('button', { name: 'Compare with…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compare with another note' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(currentUrl().pathname).toBe('/notes/n1');
  });

  it('is absent with connected knowledge off, and without graph:read', async () => {
    const off = renderNote(graphUser, false);
    await screen.findByText('We will ship behind a flag.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Explore in graph' })).not.toBeInTheDocument();
    off.unmount();

    renderNote(mockAdminUser, true);
    await screen.findByText('We will ship behind a flag.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Explore in graph' })).not.toBeInTheDocument();
  });
});

describe('the notes library entries', () => {
  it('selecting two notes opens "Explore connections" on both', async () => {
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByRole('heading', { name: 'Alpha' });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const explore = screen.getByRole('button', { name: 'Explore connections' });
    expect(explore).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    expect(explore).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select Charlie' }));
    expect(explore).toBeEnabled();
    await user.click(explore);
    expect(await screen.findByRole('heading', { name: 'Explorer' })).toBeInTheDocument();
    expect(currentUrl().search).toBe('?connectNotes=n1,n3');
  });

  it('offers no selection with connected knowledge off, or without graph:read', async () => {
    const off = renderLibrary(graphUser, false);
    await screen.findByRole('heading', { name: 'Alpha' });
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
    off.unmount();

    renderLibrary(mockAdminUser, true);
    await screen.findByRole('heading', { name: 'Alpha' });
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
  });
});
