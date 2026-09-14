import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { render, mockAdminUser } from '../utils/test-utils';
import NoteHistoryPage from '../../pages/NoteHistoryPage';

/**
 * `/notes/:id/history`.
 *
 * ⚠ #57 OWNS THE ROUTE; #58 OWNS THE SURFACE. What is asserted here is what
 * #57 actually promised: the route renders the real endpoint's real answer,
 * pages through it, and gets the one thing about this data that is easy to get
 * wrong right — `author: null` MEANS THE AI. Reading a version's body and
 * restoring it are #58's, and are deliberately not asserted as missing.
 */

const API_BASE = 'http://localhost:3000/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function version(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: 'ai_generated',
    summary: null,
    author: null,
    generationId: 'gen-1',
    restoredFromVersion: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function respondWith(items: Record<string, unknown>[], nextCursor: string | null = null) {
  server.use(
    http.get(`${API_BASE}/notes/:id/versions`, () =>
      HttpResponse.json({ data: { currentVersion: 2, items, nextCursor } }),
    ),
  );
}

beforeEach(() => {
  respondWith([
    version({ version: 2, kind: 'edit', summary: 'Fixed the numbers', author: { id: 'u1', name: 'Ana Ruiz' } }),
    version(),
  ]);
});

function renderPage() {
  return render(
    <Routes>
      <Route path="/notes/:id/history" element={<NoteHistoryPage />} />
    </Routes>,
    { wrapperOptions: { user: mockAdminUser, route: '/notes/n1/history' } },
  );
}

describe('NoteHistoryPage', () => {
  it('lists every save, newest first, with its kind', async () => {
    renderPage();

    expect(await screen.findByText('Version 2')).toBeInTheDocument();
    expect(screen.getByText('Version 1')).toBeInTheDocument();
    expect(screen.getByText('Edited')).toBeInTheDocument();
    expect(screen.getByText('Generated')).toBeInTheDocument();
  });

  it('attributes a null author to the AI, not to nobody', async () => {
    // ⚠ `author: null` IS A STATEMENT. Rendering it as "Unknown" or as blank
    // would credit the model's work to nobody on the one screen whose entire
    // job is saying who wrote what.
    renderPage();

    expect(await screen.findByText(/^AI ·/)).toBeInTheDocument();
    expect(screen.getByText(/Ana Ruiz ·/)).toBeInTheDocument();
  });

  it('marks which version is current', async () => {
    renderPage();

    expect(await screen.findByText('Current')).toBeInTheDocument();
  });

  it('says so plainly when there is nothing saved yet', async () => {
    respondWith([]);
    renderPage();

    expect(await screen.findByText(/Nothing has been saved for this note yet/)).toBeInTheDocument();
  });

  it('pages through the history with the cursor the API returns', async () => {
    const user = userEvent.setup();
    respondWith([version({ version: 2 })], 'cursor-2');
    renderPage();
    await screen.findByText('Version 2');

    respondWith([version({ version: 1 })]);
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    // APPENDED, not replaced — a "load more" that replaced would silently
    // truncate the list a user is scrolling.
    expect(await screen.findByText('Version 1')).toBeInTheDocument();
    expect(screen.getByText('Version 2')).toBeInTheDocument();
  });

  it('reports a note that cannot be read in the API’s own terms', async () => {
    server.use(
      http.get(`${API_BASE}/notes/:id/versions`, () => new HttpResponse(null, { status: 404 })),
    );
    renderPage();

    expect(
      await screen.findByText(/does not exist, or you no longer have access/i),
    ).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderPage();
    await screen.findByText('Version 2');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
