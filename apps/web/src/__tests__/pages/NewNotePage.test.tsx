import { describe, it, expect, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { render, mockAdminUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import NewNotePage from '../../pages/NewNotePage';

/**
 * `/notes/new`, over the REAL services and MSW.
 *
 * The thing most likely to be wrong on this screen is the BODY it produces:
 * three source kinds, one discriminated union, and a form that holds all three
 * ids at once while the user changes their mind. So most of this suite captures
 * the `POST /api/notes` body and asserts it exactly, rather than asserting that
 * a button was enabled.
 */

const API_BASE = 'http://localhost:3000/api';

/** jsdom performs no layout, so `color-contrast` is a false-negative trap here. */
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

/** Every `POST /api/notes` body this test file has seen. */
let createdBodies: Record<string, unknown>[] = [];
/** What the next `POST /api/notes` should answer with. */
let createResponse: () => HttpResponse;

function aiConfig(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    provider: 'openai',
    providerLabel: 'OpenAI',
    // #97: `source`/`derivedFrom` complete the `AiConfigModel` shape — absent,
    // a provenance assertion elsewhere would silently pass against a fallback
    // chip instead of the real one.
    models: [
      {
        id: 'gpt-4o-mini',
        label: 'GPT-4o mini',
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        source: 'catalogue',
        derivedFrom: null,
      },
    ],
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    keyConfigured: true,
    ...overrides,
  };
}

function template(id: string, name: string, builtIn = false) {
  return {
    id,
    name,
    description: '',
    instructions: 'Write it up.',
    outputFormat: 'markdown',
    structure: [],
    tone: null,
    length: null,
    model: null,
    isArchived: false,
    builtIn,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function transcriptRow(id: string, title: string) {
  return {
    id,
    title,
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 600_000,
    speakerCount: 2,
    wordCount: 1200,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    ownerName: 'Test User',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function noteRow(id: string, title: string) {
  return {
    id,
    title,
    excerpt: 'Earlier notes.',
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
    currentGenerationId: 'gen-0',
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** The created note the happy path answers with. */
function createdNote() {
  return {
    note: {
      id: 'new-note-id',
      title: 'Meeting minutes',
      body: '',
      status: 'generating',
      currentVersion: 0,
      provider: 'openai',
      model: 'gpt-4o-mini',
      sourceType: 'transcript',
      sourceTranscriptId: 't1',
      sourceNoteId: null,
      sourceObjectId: null,
      templateId: 'tpl-1',
      templateName: 'Meeting minutes',
      contextText: null,
      currentGenerationId: 'gen-1',
      failureReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    generationId: 'gen-1',
    jobId: 'job-1',
    providerId: 'openai',
    model: 'gpt-4o-mini',
  };
}

beforeEach(() => {
  // See `NotesPage.test.tsx`: `localStorage` survives between tests and the
  // theme provider seeds itself from this key.
  localStorage.setItem('theme_mode', 'light');
  createdBodies = [];
  createResponse = () => HttpResponse.json({ data: createdNote() }, { status: 201 });

  server.use(
    http.get(`${API_BASE}/ai/config`, () => HttpResponse.json({ data: aiConfig() })),
    http.get(`${API_BASE}/note-templates`, () =>
      HttpResponse.json({
        data: { items: [template('tpl-1', 'Meeting minutes', true), template('tpl-2', 'Brief')], total: 2 },
      }),
    ),
    http.get(`${API_BASE}/transcripts`, () =>
      HttpResponse.json({
        data: { items: [transcriptRow('t1', 'Q3 planning'), transcriptRow('t2', 'Standup')], nextCursor: null },
      }),
    ),
    http.get(`${API_BASE}/notes`, () =>
      HttpResponse.json({ data: { items: [noteRow('n1', 'Last week’s notes')], nextCursor: null } }),
    ),
    http.post(`${API_BASE}/notes`, async ({ request }) => {
      createdBodies.push((await request.json()) as Record<string, unknown>);
      return createResponse();
    }),
  );
});

/** Renders the live pathname, so a test can assert where Generate navigated. */
function Probe() {
  const { pathname } = useLocation();
  return <span data-testid="pathname">{pathname}</span>;
}

function renderPage(route = '/notes/new') {
  return render(
    <>
      <NewNotePage />
      <Probe />
    </>,
    { wrapperOptions: { user: mockAdminUser, route } },
  );
}

/** The form is usable once the template picker has defaulted to something. */
async function waitForForm() {
  await screen.findByRole('heading', { name: 'New note', level: 1 });
  await waitFor(() => expect(screen.getByLabelText('Template')).toHaveTextContent(/\w/));
}

describe('NewNotePage — the AI key gate', () => {
  it('renders AiKeyRequired and no form when the caller has no key', async () => {
    server.use(
      http.get(`${API_BASE}/ai/config`, () =>
        HttpResponse.json({ data: aiConfig({ keyConfigured: false }) }),
      ),
    );
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Add your AI key to use this' }),
    ).toBeInTheDocument();
    // "and nothing else" — the rule `AiKeyRequired`'s own header states for all
    // four AI surfaces in this epic.
    expect(screen.queryByLabelText('Template')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
  });

  it('renders AiKeyRequired — not a generic error — when POST /api/notes answers 409', async () => {
    // The race the probe cannot close: the key was there when this page
    // loaded and removed in another tab before Generate was pressed. A red
    // "Conflict" here would be the app blaming the user for its own stale
    // answer.
    const user = userEvent.setup();
    createResponse = () =>
      HttpResponse.json(
        {
          statusCode: 409,
          code: 'CONFLICT',
          message: 'You have not saved an API key.',
          details: { reason: 'ai_key_missing' },
        },
        { status: 409 },
      );
    renderPage('/notes/new?transcriptId=t1');
    await waitForForm();

    await user.click(screen.getByRole('button', { name: 'Generate' }));

    expect(
      await screen.findByRole('heading', { name: 'Add your AI key to use this' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so plainly when the DEPLOYMENT has not enabled AI', async () => {
    // A different sentence from the one above, because it has a different fix
    // and the user cannot apply it.
    const user = userEvent.setup();
    createResponse = () =>
      HttpResponse.json(
        {
          statusCode: 409,
          code: 'CONFLICT',
          message: 'AI is not configured.',
          details: { reason: 'ai_not_configured' },
        },
        { status: 409 },
      );
    renderPage('/notes/new?transcriptId=t1');
    await waitForForm();

    await user.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText(/not enabled for this deployment/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Add your AI key to use this' }),
    ).not.toBeInTheDocument();
  });
});

describe('NewNotePage — the three source pickers', () => {
  it('sends a transcript source, and only the transcript id', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForForm();

    await user.click(screen.getByLabelText('Transcript'));
    await user.click(await screen.findByRole('option', { name: 'Standup' }));
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0]).toEqual({
      templateId: 'tpl-1',
      source: { type: 'transcript', transcriptId: 't2' },
    });
  });

  it('pre-selects the transcript named by ?transcriptId=', async () => {
    // The whole reason a transcript page can offer "Make a note from this".
    const user = userEvent.setup();
    renderPage('/notes/new?transcriptId=t1');
    await waitForForm();

    expect(screen.getByLabelText('Transcript')).toHaveTextContent('Q3 planning');

    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0].source).toEqual({ type: 'transcript', transcriptId: 't1' });
  });

  it('sends a note source, and only the note id', async () => {
    const user = userEvent.setup();
    renderPage('/notes/new?transcriptId=t1');
    await waitForForm();

    // Switching kinds AFTER a transcript was pre-selected: the form still holds
    // the transcript id, and the body must not carry it. This is the exact case
    // `buildNoteSource` exists to make unrepresentable.
    await user.click(screen.getByRole('radio', { name: /Another note/ }));
    await user.click(screen.getByLabelText('Note'));
    await user.click(await screen.findByRole('option', { name: 'Last week’s notes' }));
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0].source).toEqual({ type: 'note', noteId: 'n1' });
  });

  it('sends the optional context when one was typed, and omits it when blank', async () => {
    const user = userEvent.setup();
    renderPage('/notes/new?transcriptId=t1');
    await waitForForm();

    await user.type(
      screen.getByLabelText('Context (optional)'),
      'Ana and Ben, the quarterly review.',
    );
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0].contextText).toBe('Ana and Ben, the quarterly review.');
  });

  it('lets the template be chosen, and sends the chosen one', async () => {
    const user = userEvent.setup();
    renderPage('/notes/new?transcriptId=t1');
    await waitForForm();

    await user.click(screen.getByLabelText('Template'));
    await user.click(await screen.findByRole('option', { name: 'Brief' }));
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0].templateId).toBe('tpl-2');
  });

  it('navigates to the new note once it has been created', async () => {
    const user = userEvent.setup();
    renderPage('/notes/new?transcriptId=t1');
    await waitForForm();

    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() =>
      expect(screen.getByTestId('pathname')).toHaveTextContent('/notes/new-note-id'),
    );
  });

  it('refuses to generate with no source chosen', async () => {
    renderPage();
    await waitForForm();

    // No `?transcriptId=`, nothing picked: the form is complete in every other
    // respect and still cannot be submitted.
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });
});

describe('NewNotePage — the document source', () => {
  /** Whatever `GET /api/storage/objects/:id` should answer with next. */
  let extractionMetadata: Record<string, unknown> | null;

  beforeEach(() => {
    extractionMetadata = null;
    server.use(
      http.post(`${API_BASE}/notes/sources/documents`, () =>
        HttpResponse.json(
          {
            data: {
              objectId: 'obj-1',
              filename: 'brief.pdf',
              mimeType: 'application/pdf',
              size: 1024,
              jobId: 'job-extract',
              status: 'extracting',
            },
          },
          { status: 201 },
        ),
      ),
      http.get(`${API_BASE}/storage/objects/:id`, () =>
        HttpResponse.json({ data: { id: 'obj-1', name: 'brief.pdf', metadata: extractionMetadata } }),
      ),
    );
  });

  async function uploadDocument(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('radio', { name: /A document/ }));
    const file = new File(['hello'], 'brief.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Choose a document'), file);
  }

  it('shows extraction progress and BLOCKS Generate until text has been extracted', async () => {
    // The failure this prevents: a note created, queued, and failed a minute
    // later against the user's own provider account for a reason this form
    // could have seen.
    const user = userEvent.setup();
    renderPage();
    await waitForForm();

    await uploadDocument(user);

    expect(await screen.findByText('Reading the document…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();

    // The extraction job finishes.
    extractionMetadata = {
      extractedObjectId: 'obj-2',
      noteSourceExtraction: { status: 'extracted', characters: 4200, extractedAt: new Date().toISOString() },
    };

    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled(),
      { timeout: 6000 },
    );
    expect(screen.getByText(/4,200 characters of text/)).toBeInTheDocument();
  });

  it('sends a document source, and only the object id', async () => {
    const user = userEvent.setup();
    renderPage('/notes/new?transcriptId=t1');
    await waitForForm();

    await uploadDocument(user);
    extractionMetadata = {
      noteSourceExtraction: { status: 'extracted', characters: 10, extractedAt: new Date().toISOString() },
    };
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled(),
      { timeout: 6000 },
    );

    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createdBodies).toHaveLength(1));
    // The pre-selected transcript id is still in the form and must NOT be here.
    expect(createdBodies[0].source).toEqual({ type: 'document', objectId: 'obj-1' });
  });

  it('shows the API’s OWN recorded sentence when no text could be read', async () => {
    // The API stores a human sentence precisely so the client does not have to
    // guess between "encrypted", "scanned images" and "corrupt".
    const user = userEvent.setup();
    renderPage();
    await waitForForm();

    await uploadDocument(user);
    extractionMetadata = {
      noteSourceExtraction: {
        status: 'unextractable',
        reason: 'encrypted',
        message: 'This PDF is password-protected, so its text cannot be read.',
        extractedAt: new Date().toISOString(),
      },
    };

    expect(
      await screen.findByText('This PDF is password-protected, so its text cannot be read.', {}, {
        timeout: 6000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });
});

describe('NewNotePage — layout and accessibility', () => {
  it('shows the three steps at once where there is room', async () => {
    renderPage();
    await waitForForm();

    for (const label of ['Source', 'Template', 'Context']) {
      expect(screen.getByRole('heading', { name: label, level: 2 })).toBeInTheDocument();
    }
    // All three are ANSWERABLE at once — not merely present as step labels.
    expect(screen.getByLabelText('Template')).toBeInTheDocument();
    expect(screen.getByLabelText('Context (optional)')).toBeInTheDocument();
  });

  it('becomes a stepper at phone width', async () => {
    renderPage();
    await waitForForm();
    await act(async () => setViewportWidth(375));

    // The step labels become buttons in a stepper rather than section headings.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Template', level: 2 })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
  });

  it('links to the template manager', async () => {
    renderPage();
    await waitForForm();

    expect(screen.getByRole('link', { name: 'Manage your templates' })).toHaveAttribute(
      'href',
      '/settings/note-templates',
    );
  });

  it('has no axe violations in the light theme', async () => {
    const { container } = renderPage('/notes/new?transcriptId=t1');
    await waitForForm();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme', async () => {
    // ⚠ THROUGH `localStorage`, not a render option — `ThemeContextProvider`
    // reads `theme_mode` in its `useState` initializer, and the helper's
    // `theme` field is declared but not read, so passing it would render the
    // light theme and assert nothing.
    localStorage.setItem('theme_mode', 'dark');
    const { container } = render(
      <>
        <NewNotePage />
        <Probe />
      </>,
      { wrapperOptions: { user: mockAdminUser, route: '/notes/new' } },
    );
    await waitForForm();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('gives the page a single h1', async () => {
    renderPage();
    await waitForForm();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('New note');
  });

  it('names the three source choices as radios in one group', async () => {
    renderPage();
    await waitForForm();

    const group = screen.getByRole('radiogroup', { name: 'What are you writing from?' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
  });
});
