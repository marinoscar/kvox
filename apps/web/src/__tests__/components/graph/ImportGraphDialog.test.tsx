import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import { ImportGraphDialog } from '../../../components/graph/ImportGraphDialog';
import { server } from '../../mocks/server';
import { mockAdminUser, render } from '../../utils/test-utils';

/** "Import graph…" (#387): pick a file, upload it, land on the import page. */

const API = '*/api';
const PROPOSAL = 'a0000000-0000-4000-8000-0000000000aa';
const user = { ...mockAdminUser, permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'] };

function Where() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderDialog() {
  const onClose = vi.fn();
  render(
    <Routes>
      <Route
        path="*"
        element={
          <>
            <ImportGraphDialog open onClose={onClose} />
            <Where />
          </>
        }
      />
    </Routes>,
    { wrapperOptions: { route: '/graph', user } },
  );
  return { onClose };
}

const ttl = () => new File(['@prefix kv: <https://x.app/ns#> .'], 'contacts.ttl', { type: 'text/turtle' });

describe('ImportGraphDialog', () => {
  it('explains that an import becomes a proposal, and uploads the chosen file', async () => {
    let received: FormData | null = null;
    server.use(
      http.post(`${API}/graph/imports`, async ({ request }) => {
        received = await request.formData();
        return HttpResponse.json({ data: { proposalId: PROPOSAL, jobId: 'b0000000-0000-4000-8000-0000000000bb' } }, { status: 202 });
      }),
    );
    const u = userEvent.setup();
    const { onClose } = renderDialog();

    expect(
      screen.getByText('Imports are checked against your ontology and become a proposal you review before anything is added.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    const input = screen.getByTestId('import-graph-file') as HTMLInputElement;
    expect(input.accept).toBe('.ttl,.jsonld,.json,.nq');

    await u.upload(input, ttl());
    expect(screen.getByText('contacts.ttl')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/graph/imports/${PROPOSAL}`));
    expect(onClose).toHaveBeenCalled();
    // jsdom's File crosses into the fetch realm; that a `file` part arrived is what matters here.
    expect((received as FormData | null)?.has('file')).toBe(true);
  });

  it('says so when another import is still being checked', async () => {
    server.use(
      http.post(`${API}/graph/imports`, () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: 'Another import is running.', details: { reason: 'extraction_running' } },
          { status: 409 },
        ),
      ),
    );
    const u = userEvent.setup();
    renderDialog();
    await u.upload(screen.getByTestId('import-graph-file') as HTMLInputElement, ttl());
    await u.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('Another import of yours is still being checked. Try again once it finishes.')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/graph');
  });

  it('refuses a file over 20 MB before uploading it', async () => {
    const u = userEvent.setup();
    renderDialog();
    const big = new File(['x'], 'huge.ttl', { type: 'text/turtle' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await u.upload(screen.getByTestId('import-graph-file') as HTMLInputElement, big);
    expect(screen.getByText('That file is larger than 20 MB, the most one import can hold.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });
});
