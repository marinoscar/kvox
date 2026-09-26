import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { delay, http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { graphReader } from '../../utils/graphTestUsers';
import { EV_EDITED, EV_GONE, EV_NOTE, EV_SEGMENT, SEGMENT_ID, TRANSCRIPT_ID, gid } from '../../mocks/graphData';
import { EvidenceChip, EvidenceChips } from '../../../components/graph/EvidenceChip';
import { clearEvidenceCache } from '../../../hooks/useGraphEvidence';

/** The numbered citation chip (#373; reused by #380's Ask citations). */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

let evidenceRequests: URL[];

beforeEach(() => {
  clearEvidenceCache();
  evidenceRequests = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.includes('/api/graph/evidence')) evidenceRequests.push(url);
  });
});

function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderChips(ids: string[]) {
  return render(
    <Routes>
      <Route
        path="/"
        element={
          <p>
            A statement
            <EvidenceChips ids={ids} />
          </p>
        }
      />
      <Route path="*" element={<Where />} />
    </Routes>,
    { wrapperOptions: { user: graphReader } },
  );
}

describe('EvidenceChip', () => {
  it('coalesces the chips of one render into one batch request', async () => {
    renderChips([EV_SEGMENT, EV_NOTE, EV_GONE]);

    expect(await screen.findByRole('button', { name: 'Source 1: Q3 planning call' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source 2: Q3 planning — decisions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source 3: Source no longer available' })).toBeInTheDocument();

    expect(evidenceRequests).toHaveLength(1);
    expect(evidenceRequests[0].searchParams.get('ids')?.split(',').sort()).toEqual(
      [EV_SEGMENT, EV_NOTE, EV_GONE].sort(),
    );
  });

  it('serves a repeat from the cache without asking again', async () => {
    const first = renderChips([EV_SEGMENT]);
    await screen.findByRole('button', { name: 'Source 1: Q3 planning call' });
    first.unmount();
    renderChips([EV_SEGMENT]);
    expect(screen.getByRole('button', { name: 'Source 1: Q3 planning call' })).toBeInTheDocument();
    expect(evidenceRequests).toHaveLength(1);
  });

  it('shows a segment quote with ▶ Play from m:ss that lands on the deep link', async () => {
    const user = userEvent.setup();
    const { container } = renderChips([EV_SEGMENT]);
    await user.click(await screen.findByRole('button', { name: 'Source 1: Q3 planning call' }));

    const dialog = await screen.findByRole('dialog', { name: 'Q3 planning call' });
    expect(within(dialog).getByText('We will ship the Atlas beta by the end of October.').tagName).toBe('BLOCKQUOTE');
    expect(within(dialog).queryByText(/has been edited/)).not.toBeInTheDocument();
    expect(await axe(container.ownerDocument.body, AXE_OPTIONS)).toHaveNoViolations();

    await user.click(within(dialog).getByRole('button', { name: 'Play from 12:34' }));
    expect(await screen.findByTestId('where')).toHaveTextContent(
      `/transcripts/${TRANSCRIPT_ID}?segment=${SEGMENT_ID}&t=754000`,
    );
  });

  it('offers "Open note" for a note span, with the edited caption', async () => {
    const user = userEvent.setup();
    renderChips([EV_NOTE]);
    await user.click(await screen.findByRole('button', { name: /Source 1: Q3 planning — decisions/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The source has been edited since this was recorded')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Open note' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('?v=2');
  });

  it('captions an edited segment', async () => {
    const user = userEvent.setup();
    renderChips([EV_EDITED]);
    await user.click(await screen.findByRole('button', { name: 'Source 1: Q3 planning call' }));
    expect(await screen.findByText('The source has been edited since this was recorded')).toBeInTheDocument();
  });

  it('says an unavailable source is gone and offers no action, but keeps the quote', async () => {
    const user = userEvent.setup();
    renderChips([EV_GONE]);
    await user.click(await screen.findByRole('button', { name: 'Source 1: Source no longer available' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Budget is frozen until Q4.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button')).not.toBeInTheDocument();
  });

  it('treats an id the API omitted as unavailable', async () => {
    renderChips([gid(799)]);
    expect(await screen.findByRole('button', { name: 'Source 1: Source no longer available' })).toBeInTheDocument();
  });

  it('opens with Enter and closes with Escape', async () => {
    const user = userEvent.setup();
    renderChips([EV_SEGMENT]);
    const chip = await screen.findByRole('button', { name: 'Source 1: Q3 planning call' });
    chip.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('is a bottom sheet on a phone', async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    renderChips([EV_SEGMENT]);
    await user.click(await screen.findByRole('button', { name: 'Source 1: Q3 planning call' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.closest('.MuiDrawer-root')).not.toBeNull();
    expect(dialog.closest('.MuiPopover-root')).toBeNull();
  });

  it('shows a one-line skeleton while the source loads', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/graph/evidence', async () => {
        await delay(400);
        return HttpResponse.json({ data: { items: [] } });
      }),
    );
    render(<EvidenceChip evidenceId={EV_SEGMENT} index={4} />, { wrapperOptions: { user: graphReader } });
    await user.click(screen.getByRole('button', { name: 'Source 4' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
