import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

// =============================================================================
// #58 — reading a version, and going back to it
// =============================================================================

/** `GET /api/notes/:id/versions/:version` — one version, body included. */
function respondWithDetail(body: string, overrides: Record<string, unknown> = {}) {
  server.use(
    http.get(`${API_BASE}/notes/:id/versions/:version`, ({ params }) =>
      HttpResponse.json({
        data: {
          ...version({ version: Number(params.version) }),
          noteId: 'n1',
          body,
          isCurrent: Number(params.version) === 2,
          ...overrides,
        },
      }),
    ),
  );
}

describe('NoteHistoryPage — reading one version', () => {
  it('shows what a version actually said, rendered as markdown', async () => {
    const user = userEvent.setup();
    respondWithDetail('# The original\n\nAs the model wrote it.');
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Read version 1' }));

    expect(
      await screen.findByRole('heading', { name: 'The original' }),
    ).toBeInTheDocument();
    expect(screen.getByText('As the model wrote it.')).toBeInTheDocument();
  });

  it('labels version 1 as the AI’s original, in the list and in the panel', async () => {
    // ⚠ THE ONE VERSION NO EDIT CAN EVER REMOVE. A user has to be able to see
    // that it is still there, and that it is the model's own words.
    const user = userEvent.setup();
    respondWithDetail('The first draft.');
    renderPage();

    expect(await screen.findByText('Original (AI)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Read version 1' }));

    expect(
      await screen.findByRole('heading', { name: /Version 1 — the AI’s original/ }),
    ).toBeInTheDocument();
  });

  it('does not execute raw HTML stored in an old version', async () => {
    const user = userEvent.setup();
    respondWithDetail('<script>window.__histPwned = true;</script>');
    const { container } = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Read version 1' }));

    await screen.findByText(/window.__histPwned = true;/);
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __histPwned?: boolean }).__histPwned).toBeUndefined();
  });

  it('reports a version that cannot be read, without blaming the reader', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${API_BASE}/notes/:id/versions/:version`, () =>
        new HttpResponse(null, { status: 404 }),
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Read version 1' }));

    expect(await screen.findByText('That version is no longer available.')).toBeInTheDocument();
  });
});

describe('NoteHistoryPage — restoring', () => {
  it('states, before anything is pressed, that restoring deletes nothing', async () => {
    renderPage();

    expect(
      await screen.findByText(/Restoring an earlier version/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing in this list is ever deleted/i)).toBeInTheDocument();
  });

  it('confirms with the same promise, naming the version that is kept', async () => {
    const user = userEvent.setup();
    respondWithDetail('The first draft.');
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Read version 1' }));
    await user.click(await screen.findByRole('button', { name: 'Restore this version' }));

    const dialog = await screen.findByRole('dialog', { name: 'Restore version 1?' });
    expect(within(dialog).getByText(/Nothing is deleted/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/version 2 stays exactly as it is/i)).toBeInTheDocument();
  });

  it('APPENDS a new version, sends the current one as baseVersion, and says so afterwards', async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> | null = null;

    respondWithDetail('The first draft.');
    server.use(
      http.post(`${API_BASE}/notes/:id/versions/:version/restore`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        // The API's own shape: a NEW version, three, whose body is version 1's.
        respondWith(
          [
            version({ version: 3, kind: 'restore', restoredFromVersion: 1, author: { id: 'u1', name: 'Ana Ruiz' } }),
            version({ version: 2, kind: 'edit', author: { id: 'u1', name: 'Ana Ruiz' } }),
            version(),
          ],
          null,
        );
        return HttpResponse.json({ data: { id: 'n1', currentVersion: 3, body: 'The first draft.' } });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Read version 1' }));
    await user.click(await screen.findByRole('button', { name: 'Restore this version' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore' }),
    );

    // ⚠ `baseVersion` MUST EQUAL `currentVersion` on this route — a restore
    // carries no per-entity expectations, so a stale view would discard edits
    // the caller has never seen.
    await waitFor(() => expect(sent).toEqual({ baseVersion: 2 }));

    // The UI says the history survived, and names the version that was made.
    expect(await screen.findByText(/saved as version 3/i)).toBeInTheDocument();
    expect(screen.getByText(/Everything that was here before is still here/i)).toBeInTheDocument();
    // …and the older versions are still in the list, which is the proof.
    expect(screen.getByText('Version 1')).toBeInTheDocument();
    expect(screen.getByText('Version 2')).toBeInTheDocument();
  });

  it('offers no restore for the version that is already current', async () => {
    const user = userEvent.setup();
    respondWithDetail('Current text.');
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Read version 2' }));

    await screen.findByRole('heading', { name: /Version 2/ });
    expect(
      screen.queryByRole('button', { name: 'Restore this version' }),
    ).not.toBeInTheDocument();
  });

  it('explains a 409 as "someone saved while you were reading", not as a failure to retry', async () => {
    const user = userEvent.setup();
    respondWithDetail('The first draft.');
    server.use(
      http.post(`${API_BASE}/notes/:id/versions/:version/restore`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'Stale base version.',
            details: { reason: 'stale_base_version', currentVersion: 4 },
          },
          { status: 409 },
        ),
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Read version 1' }));
    await user.click(await screen.findByRole('button', { name: 'Restore this version' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore' }),
    );

    expect(await screen.findByText(/Nothing was restored/i)).toBeInTheDocument();
  });

  it('has no axe violations with a version open, in the dark theme', async () => {
    localStorage.setItem('theme_mode', 'dark');
    const user = userEvent.setup();
    respondWithDetail('# Read me\n\nBody.');
    const { container } = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Read version 1' }));
    await screen.findByRole('heading', { name: 'Read me' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    localStorage.setItem('theme_mode', 'light');
  });
});
