/**
 * The knowledge-first Home (#721): the Ask box, the Review Queue card, the
 * libraries, the graph and the recent imports, each gated on its permission
 * and (for the graph cards) the host's `graph` switch.
 */

import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { NoteImportBatch, NoteLibrary } from '@marinoscar/kvox-contract/notes';
import { Route, Routes, useLocation } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/transcripts/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/transcripts/headless/index.js')>()),
  useUploadManager: () => ({ uploads: [], sessions: [] }),
}));

import { createFakeKvoxWebHost, renderWithKvoxHost } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost, FakeRoute } from '../../src/core/testing/index.js';
import { KVOX_KNOWLEDGE_HOME_SECTIONS, summarizeLibraries } from '../../src/home/headless/index.js';
import { KvoxHomePage, kvoxHomeRoutes } from '../../src/home/ui/index.js';
import { note, noteSummary } from './homeData.js';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const ALL = ['notes:read', 'notes:write', 'graph:read', 'graph:write'];
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

function library(overrides: Partial<NoteLibrary> = {}): NoteLibrary {
  return {
    id: 'lib-1',
    name: 'Work notes',
    autoExtract: true,
    autoCommit: false,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    lastScanAt: '2026-10-22T09:00:00.000Z',
    counts: { total: 120, imported: 110, failed: 3, missing: 0, diverged: 0, unsupported: 7, pending: 0 },
    ...overrides,
  };
}

function batch(overrides: Partial<NoteImportBatch> = {}): NoteImportBatch {
  return {
    id: 'batch-1',
    libraryId: 'lib-1',
    status: 'completed_with_errors',
    createdAt: '2026-10-23T14:02:00.000Z',
    finishedAt: '2026-10-23T14:10:00.000Z',
    counts: { queued: 0, importing: 0, imported: 40, failed: 2, missing: 0, skipped: 0 },
    stageCounts: {} as NoteImportBatch['stageCounts'],
    ...overrides,
  };
}

const QUEUE = {
  groups: [],
  totals: { proposals: 312, stale: 0, total: 2326, safe: 2140, waiting: 186 },
  minConfidence: 0.7,
  truncated: false,
};

interface Options {
  permissions?: string[];
  graphEnabled?: boolean;
  libraries?: NoteLibrary[];
  routes?: Record<string, FakeRoute>;
}

function host(options: Options = {}): FakeKvoxWebHost {
  return createFakeKvoxWebHost({
    viewer: { userId: 'u1', permissions: options.permissions ?? ALL, displayName: 'Ana Ruiz' },
    features: { graphEnabled: options.graphEnabled ?? true },
    routes: {
      'GET /notes/summary': noteSummary({ recent: [note()] }),
      'GET /notes/libraries': { items: options.libraries ?? [library()] },
      'GET /notes/import-batches': { items: [batch(), batch({ id: 'batch-2', libraryId: null, status: 'running' })] },
      'GET /graph/review-queue': QUEUE,
      'GET /graph/overview': {
        status: 'ready',
        pending: false,
        computedAt: '2026-10-23T10:00:00.000Z',
        stale: false,
        tooLarge: false,
        nodeCount: 1234,
        edgeCount: 5678,
        clusters: [],
        clusterEdges: [],
        nodes: [],
        nodesTruncated: false,
      },
      'GET /graph/entities': {
        items: [{ id: 'e1', type: 'Person', label: 'Grace Hopper', aliases: [], mentionCount: 3, lastSeenAt: null }],
        nextCursor: null,
      },
      ...options.routes,
    },
  });
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function renderHome(fake: FakeKvoxWebHost, sections: typeof KVOX_KNOWLEDGE_HOME_SECTIONS | null = KVOX_KNOWLEDGE_HOME_SECTIONS) {
  return renderWithKvoxHost(
    <Routes>
      <Route path="/" element={sections ? <KvoxHomePage sections={sections} /> : <KvoxHomePage />} />
      <Route path="*" element={<Where />} />
    </Routes>,
    fake,
  );
}

describe('the knowledge-first Home', () => {
  it('draws Ask, the Review Queue, the libraries, the graph and the recent imports', async () => {
    const { container } = renderHome(host());

    const review = await screen.findByRole('region', { name: 'Review Queue' }, { timeout: 5000 });
    expect(within(review).getByText('312 drafts waiting')).toBeInTheDocument();
    expect(within(review).getByText('2,140 safe rows · 186 need you')).toBeInTheDocument();
    expect(within(review).getByRole('link', { name: 'Open Review Queue' })).toHaveAttribute('href', '/graph/review-queue');

    expect(screen.getByRole('region', { name: 'Ask your knowledge' })).toBeInTheDocument();

    const libraries = await screen.findByRole('region', { name: 'Libraries' });
    expect(within(libraries).getByText('1 library · 110 files imported')).toBeInTheDocument();
    expect(within(libraries).getByText(/^3 failures · Last sync/)).toBeInTheDocument();

    const graph = await screen.findByRole('region', { name: 'Your graph' });
    expect(await within(graph).findByText('1,234 entities · 5,678 relations')).toBeInTheDocument();
    expect(await within(graph).findByRole('link', { name: 'Grace Hopper' })).toHaveAttribute('href', '/graph/entities/e1');

    const imports = screen.getByRole('region', { name: 'Recent imports' });
    expect(within(imports).getByRole('link', { name: 'Work notes' })).toHaveAttribute('href', '/notes/import-batches/batch-1');
    expect(within(imports).getByText('Some failed')).toBeInTheDocument();
    expect(within(imports).getByRole('link', { name: /^Import of/ })).toHaveAttribute('href', '/notes/import-batches/batch-2');
    expect(within(imports).getByText('Importing')).toBeInTheDocument();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('hides the graph cards while connected knowledge is off, and keeps the library ones', async () => {
    const fake = host({ graphEnabled: false });
    renderHome(fake);
    expect(await screen.findByRole('region', { name: 'Libraries' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Ask your knowledge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Review Queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Your graph' })).not.toBeInTheDocument();
    expect(fake.calls.some((call) => call.path.startsWith('/graph'))).toBe(false);
  });

  it('hides the graph cards without graph:read and the library cards without notes:read', async () => {
    renderHome(host({ permissions: ['notes:read'] }));
    expect(await screen.findByRole('region', { name: 'Libraries' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Review Queue' })).not.toBeInTheDocument();

    const fake = host({ permissions: ['graph:read'] });
    renderHome(fake);
    expect(await screen.findAllByRole('region', { name: 'Review Queue' })).toHaveLength(1);
    expect(fake.calls.some((call) => call.path.startsWith('/notes/libraries'))).toBe(false);
  });

  it('invites a person with no library to add their notes folder', async () => {
    renderHome(host({ libraries: [] }));
    const libraries = await screen.findByRole('region', { name: 'Libraries' });
    expect(within(libraries).getByRole('link', { name: 'Add your notes folder' })).toHaveAttribute('href', '/notes/libraries');
  });

  it('says the graph is up to date when nothing waits', async () => {
    renderHome(host({ routes: { 'GET /graph/review-queue': { ...QUEUE, totals: { proposals: 0, stale: 0, total: 0, safe: 0, waiting: 0 } } } }));
    const review = await screen.findByRole('region', { name: 'Review Queue' });
    expect(await within(review).findByText('Nothing to review — your graph is up to date.')).toBeInTheDocument();
  });

  it('asks the question and opens the conversation in Ask', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    const message = (role: 'user' | 'assistant', status: string) => ({
      id: `${role}-1`,
      role,
      content: role === 'user' ? 'Who owns the launch?' : '',
      status,
      citations: [],
      toolCalls: [],
      errorClass: null,
      finishReason: null,
      createdAt: '2026-10-23T14:00:00.000Z',
    });
    const fake = host({
      routes: {
        'POST /ask/conversations': {
          id: CONVERSATION_ID,
          title: null,
          scopeEntity: null,
          lastMessagePreview: null,
          running: false,
          createdAt: '2026-10-23T14:00:00.000Z',
          updatedAt: '2026-10-23T14:00:00.000Z',
        },
        'POST /ask/conversations/:id/messages': ({ body }) => {
          posted.push(body);
          return { userMessage: message('user', 'complete'), assistantMessage: message('assistant', 'pending') };
        },
      },
    });
    renderHome(fake);
    const ask = await screen.findByRole('region', { name: 'Ask your knowledge' });
    await user.type(within(ask).getByRole('textbox', { name: 'Your question' }), 'Who owns the launch?');
    await user.click(within(ask).getByRole('button', { name: 'Ask' }));
    expect(await screen.findByTestId('where')).toHaveTextContent(`/ask/${CONVERSATION_ID}`);
    expect(posted).toEqual([{ content: 'Who owns the launch?' }]);
  });

  it('is not part of the default sections, so the classic Home asks for none of it', async () => {
    const fake = host();
    renderHome(fake, null as never);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Review Queue' })).not.toBeInTheDocument();
    expect(fake.calls.some((call) => call.path.startsWith('/notes/libraries'))).toBe(false);
    expect(fake.calls.some((call) => call.path.startsWith('/graph/review-queue'))).toBe(false);
  });

  it('is what kvoxHomeRoutes draws', () => {
    expect(kvoxHomeRoutes.map((route) => route.path)).toEqual(['/']);
  });
});

describe('summarizeLibraries', () => {
  it('sums the files and keeps the latest scan', () => {
    expect(
      summarizeLibraries([
        library(),
        library({ id: 'lib-2', lastScanAt: '2026-10-23T09:00:00.000Z', counts: { ...library().counts, imported: 5, failed: 0 } }),
        library({ id: 'lib-3', lastScanAt: null }),
      ]),
    ).toEqual({ libraries: 3, imported: 225, failed: 6, lastSync: '2026-10-23T09:00:00.000Z' });
  });
});
