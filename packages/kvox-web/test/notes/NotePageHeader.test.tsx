import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import Button from '@mui/material/Button';

import { http, HttpResponse, server } from './msw-compat.js';
import { hostBackedAi, mockAdminUser, render } from './helpers.js';
import { NotePage } from '../../src/notes/ui/pages/NotePage.js';
import type { NotePageSlots } from '../../src/notes/ui/slots.js';
import type { Note, NoteVersion } from '../../src/notes/headless/clients/notes.js';
import { isImportedNote } from '../../src/notes/headless/utils/noteSource.js';
import { pickNoteAiRevision } from '../../src/notes/headless/hooks/useNoteAiRevision.js';

/**
 * Issue #758 — the note page's header layout, and an IMPORTED note's page.
 *
 * An imported note (a document kept as the note: document source, no template)
 * was never generated, so "How this note was generated" — Template "This
 * template was deleted", Context "None provided", Model "not recorded" — said
 * four untrue things about it. It is not drawn; the provenance sentence names
 * and offers the file, and an AI formatting pass is named from the history.
 */

vi.mock('../../src/notes/headless/clients/noteGenerationStream.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/notes/headless/clients/noteGenerationStream.js')>();
  return { ...actual, connectNoteStream: () => ({ close: vi.fn() }) };
});

const API_BASE = 'http://localhost:3000/api';

const LONG_TITLE = 'Org Alpha quarterly planning — consolidated notes from six working sessions';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: LONG_TITLE,
    titleSource: 'ai',
    body: 'Done.',
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting minutes',
    sourceName: 'Q3 planning call',
    contextText: null,
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: '2026-10-26T10:00:00.000Z',
    updatedAt: '2026-10-26T10:00:00.000Z',
    ...overrides,
  };
}

function importedNote(overrides: Partial<Note> = {}): Note {
  return note({
    sourceType: 'document',
    sourceTranscriptId: null,
    sourceObjectId: 'obj-1',
    sourceName: 'Notes.docx',
    templateId: null,
    templateName: null,
    provider: null,
    model: null,
    currentGenerationId: null,
    ...overrides,
  });
}

function version(overrides: Partial<NoteVersion> = {}): NoteVersion {
  return {
    version: 1,
    kind: 'edit',
    summary: null,
    author: { id: 'u1', name: 'Anders' },
    generationId: null,
    restoredFromVersion: null,
    createdAt: '2026-10-26T10:00:00.000Z',
    ...overrides,
  };
}

let current: Note;
let versions: NoteVersion[];
let versionReads: number;

beforeEach(() => {
  localStorage.setItem('theme_mode', 'light');
  current = note();
  versions = [];
  versionReads = 0;
  server.use(
    http.get(`${API_BASE}/ai-tasks/config`, () =>
      HttpResponse.json({
        data: {
          available: true,
          provider: 'openai',
          providerLabel: 'OpenAI',
          models: [],
          defaultModel: 'gpt-4o-mini',
          maxInputTokens: 100_000,
          maxOutputTokens: 8_000,
          keyConfigured: true,
        },
      }),
    ),
    http.get(`${API_BASE}/notes/exporters`, () => HttpResponse.json({ data: { exporters: [] } })),
    http.get(`${API_BASE}/note-templates`, () =>
      HttpResponse.json({ data: { items: [], total: 0 } }),
    ),
    http.get(`${API_BASE}/note-templates/:id`, ({ params }) =>
      HttpResponse.json({
        data: {
          id: params.id,
          name: 'Meeting minutes',
          description: '',
          instructions: 'Lead with the decisions.',
          outputFormat: 'meeting_notes',
          structure: [],
          tone: null,
          length: null,
          model: null,
          isArchived: false,
          builtIn: false,
          hidden: false,
          createdAt: '2026-10-26T10:00:00.000Z',
          updatedAt: '2026-10-26T10:00:00.000Z',
        },
      }),
    ),
    http.get(`${API_BASE}/notes/:id/versions`, () => {
      versionReads += 1;
      return HttpResponse.json({
        data: { currentVersion: current.currentVersion, items: versions, nextCursor: null },
      });
    }),
    http.get(`${API_BASE}/notes/:id`, () => HttpResponse.json({ data: current })),
  );
});

function renderNote(slots?: NotePageSlots) {
  return render(
    <Routes>
      <Route path="/notes/:id" element={<NotePage ai={hostBackedAi} slots={slots} />} />
    </Routes>,
    { wrapperOptions: { user: mockAdminUser, route: '/notes/n1' } },
  );
}

describe('isImportedNote', () => {
  it('is a document source with no template', () => {
    expect(isImportedNote(importedNote())).toBe(true);
  });

  it('is not a document generated with a template, nor a transcript note', () => {
    expect(isImportedNote(importedNote({ templateId: 'tpl-1', templateName: 'Brief' }))).toBe(false);
    expect(isImportedNote(importedNote({ templateId: null, templateName: 'Brief' }))).toBe(false);
    expect(isImportedNote(note())).toBe(false);
  });
});

describe('pickNoteAiRevision', () => {
  it('picks the oldest AI-authored edit that carries a summary', () => {
    const picked = pickNoteAiRevision([
      version({ version: 4, author: null, summary: 'Later pass' }),
      version({ version: 3, summary: 'Mine' }),
      version({ version: 2, author: null, summary: 'Formatted with AI' }),
      version({ version: 1, author: null, summary: null }),
    ]);
    expect(picked?.version).toBe(2);
    expect(picked?.summary).toBe('Formatted with AI');
  });

  it('ignores generated versions and human edits', () => {
    expect(
      pickNoteAiRevision([
        version({ version: 2, kind: 'ai_generated', author: null, summary: 'x' }),
        version({ version: 1, summary: 'Mine' }),
      ]),
    ).toBeNull();
  });
});

describe('NotePage — an imported note (#758)', () => {
  it('does not draw "How this note was generated", and says where it came from', async () => {
    current = importedNote();
    renderNote();

    const provenance = await screen.findByTestId('note-provenance');
    expect(provenance).toHaveTextContent(/^Imported from Notes\.docx/);
    expect(within(provenance).getByRole('button', { name: 'Download Notes.docx' })).toBeInTheDocument();

    expect(screen.queryByTestId('note-generation-context')).not.toBeInTheDocument();
    expect(screen.queryByText(/How this note was generated/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/This template was deleted/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /View full context sent to the AI/i }),
    ).not.toBeInTheDocument();
  });

  it('names the AI formatting pass from the version history', async () => {
    current = importedNote({ currentVersion: 2 });
    versions = [
      version({ version: 2, author: null, summary: 'Formatted with AI' }),
      version({ version: 1 }),
    ];
    renderNote();

    const line = await screen.findByTestId('note-import-revision');
    expect(line).toHaveTextContent(/^Formatted with AI · version 2, /);
  });

  it('reads no history for an imported note still at version 1', async () => {
    current = importedNote();
    renderNote();

    await screen.findByTestId('note-provenance');
    // Give a stray read the chance to land before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(versionReads).toBe(0);
    expect(screen.queryByTestId('note-import-revision')).not.toBeInTheDocument();
  });

  it('says nothing about formatting when the history has no AI edit', async () => {
    current = importedNote({ currentVersion: 2 });
    versions = [version({ version: 2, summary: 'Tidied' }), version({ version: 1 })];
    renderNote();

    await waitFor(() => expect(versionReads).toBe(1));
    expect(screen.queryByTestId('note-import-revision')).not.toBeInTheDocument();
  });
});

describe('NotePage — a generated note keeps its panel (#758)', () => {
  it('draws "How this note was generated" and reads no history', async () => {
    current = note();
    renderNote();

    const panel = await screen.findByTestId('note-generation-context');
    expect(
      within(panel).getByRole('button', { name: /How this note was generated/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('note-provenance')).toHaveTextContent(/^Generated from Q3 planning call/);
    expect(versionReads).toBe(0);
  });
});

describe('NotePage — the header (#758)', () => {
  function HeaderActions() {
    return (
      <>
        <Button size="small">Graph</Button>
        <Button size="small">Explore in graph</Button>
        <Button size="small">Compare with…</Button>
      </>
    );
  }

  it('gives the title its own element, with the status and every action in a separate row', async () => {
    renderNote({ HeaderActions });

    const title = await screen.findByRole('heading', { level: 1, name: LONG_TITLE });
    const actions = screen.getByTestId('note-header-actions');

    // The chip and the actions are NOT inside the title, and the title is not
    // inside the actions row: two siblings, title first.
    expect(within(title).queryByText('Ready')).not.toBeInTheDocument();
    expect(within(title).queryByRole('button')).not.toBeInTheDocument();
    expect(actions).not.toContainElement(title);
    expect(title.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(within(actions).getByText('Ready')).toBeInTheDocument();
    expect(within(actions).getByRole('link', { name: /History/ })).toBeInTheDocument();
    for (const name of [/Copy/, /Export/, 'Graph', 'Explore in graph', 'Compare with…']) {
      expect(within(actions).getAllByRole('button', { name }).length).toBeGreaterThan(0);
    }
  });

  it('lets the actions row wrap instead of taking the title’s width', async () => {
    renderNote({ HeaderActions });

    const actions = await screen.findByTestId('note-header-actions');
    const style = getComputedStyle(actions);
    expect(style.flexWrap).toBe('wrap');
    expect(style.flexShrink).not.toBe('0');
  });
});
