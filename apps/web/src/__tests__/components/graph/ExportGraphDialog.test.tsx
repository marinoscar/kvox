import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { ExportGraphDialog } from '../../../components/graph/ExportGraphDialog';
import type { GraphExport } from '../../../services/graph';
import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { graphReader } from '../../utils/graphTestUsers';

/**
 * "Export graph…" (#386): format choice, the POST, polling to ready, the
 * download, the reused (instant) path, the recent-exports list, and errors.
 */

const API = '*/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function graphExport(overrides: Partial<GraphExport> = {}): GraphExport {
  return {
    id: 'e1',
    format: 'jsonld',
    status: 'pending',
    ontologyVersion: '1.2.0',
    stats: {},
    errorMessage: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    expiresAt: '2026-09-08T12:00:00.000Z',
    downloadUrl: null,
    filename: 'app-graph-2026-09-01.jsonld',
    ...overrides,
  };
}

let posted: unknown[];
let polls: number;
let listed: GraphExport[];
let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  posted = [];
  polls = 0;
  listed = [];
  openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  server.use(http.get(`${API}/graph/exports`, () => HttpResponse.json({ data: { exports: listed } })));
});

afterEach(() => {
  openSpy.mockRestore();
});

function renderDialog() {
  const onClose = vi.fn();
  const utils = render(<ExportGraphDialog open onClose={onClose} pollOptions={{ pollIntervalMs: 5, timeoutMs: 2_000 }} />, {
    wrapperOptions: { user: graphReader },
  });
  return { ...utils, onClose };
}

describe('ExportGraphDialog', () => {
  it('offers three formats, JSON-LD first, and says sensitive facts never leave', async () => {
    const { container } = renderDialog();
    const group = await screen.findByRole('radiogroup', { name: 'Format' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: /JSON-LD/ })).toBeChecked();
    expect(screen.getByText(/for developers and linked-data tools/i)).toBeInTheDocument();
    expect(screen.getByText('Sensitive personal facts are never exported.')).toBeInTheDocument();
    expect(await screen.findByText('No exports in the last 7 days.')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('posts the chosen format, polls until ready, then downloads the signed URL', async () => {
    server.use(
      http.post(`${API}/graph/exports`, async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ data: { export: graphExport({ format: 'turtle', filename: 'app-graph-2026-09-01.ttl' }), reused: false } }, { status: 202 });
      }),
      http.get(`${API}/graph/exports/e1`, () => {
        polls += 1;
        return HttpResponse.json({
          data:
            polls < 2
              ? graphExport({ format: 'turtle', status: 'running' })
              : graphExport({
                  format: 'turtle',
                  status: 'ready',
                  filename: 'app-graph-2026-09-01.ttl',
                  downloadUrl: 'https://storage.example/signed',
                  stats: { entities: 3, excludedSensitive: 1 },
                }),
        });
      }),
    );
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('radio', { name: /Turtle/ }));
    await user.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText(/app-graph-2026-09-01\.ttl is ready/)).toBeInTheDocument();
    expect(screen.getByText(/1 sensitive value was left out/)).toBeInTheDocument();
    expect(posted).toEqual([{ format: 'turtle' }]);
    expect(polls).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(openSpy).toHaveBeenCalledWith('https://storage.example/signed', '_blank', 'noopener,noreferrer');
  });

  it('offers a reused export at once, without polling', async () => {
    server.use(
      http.post(`${API}/graph/exports`, () =>
        HttpResponse.json({
          data: { export: graphExport({ status: 'ready', downloadUrl: 'https://storage.example/reused' }), reused: true },
        }),
      ),
      http.get(`${API}/graph/exports/e1`, () => {
        polls += 1;
        return HttpResponse.json({ data: graphExport() });
      }),
    );
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(polls).toBe(0);
  });

  it('shows why an export failed', async () => {
    server.use(
      http.post(`${API}/graph/exports`, () => HttpResponse.json({ data: { export: graphExport(), reused: false } }, { status: 202 })),
      http.get(`${API}/graph/exports/e1`, () =>
        HttpResponse.json({ data: graphExport({ status: 'failed', errorMessage: 'The export could not be completed (Error). Request it again.' }) }),
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/could not be completed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('explains an empty graph (409 graph_empty)', async () => {
    server.use(
      http.post(`${API}/graph/exports`, () =>
        HttpResponse.json({ statusCode: 409, message: 'Refused', details: { reason: 'graph_empty' } }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/nothing to export yet/)).toBeInTheDocument();
  });

  it('says so when the export is still being prepared after the timeout', async () => {
    server.use(
      http.post(`${API}/graph/exports`, () => HttpResponse.json({ data: { export: graphExport(), reused: false } }, { status: 202 })),
      http.get(`${API}/graph/exports/e1`, () => HttpResponse.json({ data: graphExport({ status: 'running' }) })),
    );
    const user = userEvent.setup();
    render(<ExportGraphDialog open onClose={vi.fn()} pollOptions={{ pollIntervalMs: 5, timeoutMs: 30 }} />, {
      wrapperOptions: { user: graphReader },
    });
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/still being prepared/)).toBeInTheDocument();
  });

  it('lists recent exports with their expiry and a download for ready ones', async () => {
    listed = [
      graphExport({ id: 'r1', format: 'nquads', status: 'ready', downloadUrl: 'https://storage.example/r1', filename: 'app-graph-2026-09-01.nq' }),
      graphExport({ id: 'r2', format: 'turtle', status: 'failed' }),
    ];
    const user = userEvent.setup();
    renderDialog();
    const list = await screen.findByRole('list', { name: 'Recent exports' });
    expect(within(list).getByText(/N-Quads/)).toBeInTheDocument();
    expect(within(list).getByText(/Ready · expires/)).toBeInTheDocument();
    expect(within(list).getByText('Failed')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Download app-graph-2026-09-01.nq' }));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://storage.example/r1', '_blank', 'noopener,noreferrer'));
  });
});
