import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useRef } from 'react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { GraphSelectionAdd } from '../../../components/graph/selection/GraphSelectionAdd';
import type { GraphSelectionTarget } from '../../../components/graph/selection/GraphSelectionAdd';
import { resolveSegmentSelection } from '../../../components/graph/selection/resolvers';
import { invalidateGraphOntology } from '../../../hooks/useGraphOntology';
import {
  PROPOSAL_ID,
  mockProposalDetail,
  proposalMock,
  proposalSummaryRow,
} from '../../mocks/graphData';
import { server } from '../../mocks/server';
import { setViewportWidth } from '../../setup';
import { mockAdminUser, render } from '../../utils/test-utils';

const API = '*/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const SEGMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function Harness({ target, onAdded = vi.fn() }: { target: GraphSelectionTarget; onAdded?: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div>
      <div ref={ref}>
        <p data-segment-id={SEGMENT_ID} data-segment-rev="2">
          Tom will check with legal.
        </p>
        <p data-segment-id="other" data-segment-rev="1">
          Second line.
        </p>
      </div>
      <GraphSelectionAdd
        containerRef={ref}
        enabled
        resolve={(range, container) =>
          resolveSegmentSelection(range, container, {
            transcriptId: 't1',
            segmentText: (id) => (id === SEGMENT_ID ? 'Tom will check with legal.' : 'Second line.'),
          })
        }
        target={target}
        onAdded={onAdded}
      />
    </div>
  );
}

function selectInLine(start: number, end: number, across = false) {
  const first = document.querySelector(`[data-segment-id="${SEGMENT_ID}"]`)!.firstChild!;
  const second = document.querySelector('[data-segment-id="other"]')!.firstChild!;
  const range = document.createRange();
  range.setStart(first, start);
  range.setEnd(across ? second : first, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.pointerUp(document);
}

let drafts: ReturnType<typeof proposalSummaryRow>[];
let listQueries: string[];

beforeEach(() => {
  invalidateGraphOntology();
  proposalMock.reset(mockProposalDetail('draft'));
  listQueries = [];
  drafts = [];
  server.use(
    http.get(`${API}/graph/proposals`, ({ request }) => {
      listQueries.push(new URL(request.url).search);
      return HttpResponse.json({ data: { items: drafts, nextCursor: null } });
    }),
  );
});

const transcriptTarget = (onShowNotes = vi.fn()): GraphSelectionTarget => ({
  kind: 'transcript',
  transcriptId: 't1',
  onShowNotes,
});

describe('GraphSelectionAdd — the button', () => {
  it('appears beside a selection within one line', async () => {
    const { container } = render(<Harness target={transcriptTarget()} />, { wrapperOptions: { user: mockAdminUser } });
    act(() => selectInLine(4, 9));
    const button = await screen.findByRole('button', { name: 'Add to graph' });
    expect(button).toBeEnabled();
    expect(screen.getByTestId('graph-selection-popper')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is disabled with the reason across two lines', async () => {
    render(<Harness target={transcriptTarget()} />);
    act(() => selectInLine(4, 3, true));
    expect(await screen.findByRole('button', { name: 'Add to graph' })).toBeDisabled();
    expect(screen.getAllByText('Select within one line').length).toBeGreaterThan(0);
  });

  it('is a bottom bar on a phone', async () => {
    setViewportWidth(390);
    const { container } = render(<Harness target={transcriptTarget()} />);
    act(() => selectInLine(4, 9));
    expect(await screen.findByTestId('graph-selection-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-selection-popper')).not.toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('GraphSelectionAdd — the target draft', () => {
  it('no draft on the transcript: "Adding needs a draft" → Show notes', async () => {
    const onShowNotes = vi.fn();
    render(<Harness target={transcriptTarget(onShowNotes)} />);
    act(() => selectInLine(4, 9));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to graph' }));
    expect(await screen.findByRole('heading', { name: 'Adding needs a draft' })).toBeInTheDocument();
    expect(listQueries).toEqual(['?status=draft&transcriptId=t1&limit=20']);
    fireEvent.click(screen.getByRole('button', { name: 'Show notes' }));
    expect(onShowNotes).toHaveBeenCalled();
  });

  it('one draft: straight to the add dialog, and the row is added with the segment span', async () => {
    drafts = [proposalSummaryRow(PROPOSAL_ID)];
    const onAdded = vi.fn();
    render(<Harness target={transcriptTarget()} onAdded={onAdded} />);
    act(() => selectInLine(4, 9));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to graph' }));
    expect(await screen.findByRole('heading', { name: 'Add to graph' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('will');
    // The schema loads with the dialog; the type (and so Add) follows it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to draft' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add to draft' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const add = proposalMock.requests.find((request) => request.path.endsWith('/items'));
    expect(add?.body).toMatchObject({
      evidence: [{ source: 'segment', segmentId: SEGMENT_ID, segmentRev: 2, charStart: 4, charEnd: 8, quote: 'will' }],
    });
    expect(onAdded.mock.calls[0][1]).toBe(PROPOSAL_ID);
  });

  it('several drafts: a picker first', async () => {
    drafts = [
      proposalSummaryRow(PROPOSAL_ID, { noteTitle: 'Standup minutes' }),
      proposalSummaryRow('p-2', { noteTitle: 'Decision log' }),
    ];
    render(<Harness target={transcriptTarget()} />);
    act(() => selectInLine(4, 9));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to graph' }));
    expect(await screen.findByRole('heading', { name: 'Add to which draft?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Standup minutes/ }));
    expect(await screen.findByRole('heading', { name: 'Add to graph' })).toBeInTheDocument();
  });

  it('note page without a draft offers Extract…', async () => {
    const onExtract = vi.fn();
    render(<Harness target={{ kind: 'note', detail: mockProposalDetail('committed'), onExtract }} />);
    act(() => selectInLine(4, 9));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to graph' }));
    expect(await screen.findByRole('heading', { name: 'Adding needs a draft' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Extract…' }));
    expect(onExtract).toHaveBeenCalled();
  });
});
