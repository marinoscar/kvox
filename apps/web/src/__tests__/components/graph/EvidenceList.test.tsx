import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createRef } from 'react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { EvidenceList, transcriptHref } from '../../../components/graph/review/EvidenceList';
import { ProposalReviewSheet } from '../../../components/graph/review/ProposalReviewSheet';
import { invalidateGraphOntology } from '../../../hooks/useGraphOntology';
import { mockProposalDetail, noteEvidence, proposalMock, segmentEvidence } from '../../mocks/graphData';
import { server } from '../../mocks/server';
import { setViewportWidth } from '../../setup';
import { mockAdminUser, render } from '../../utils/test-utils';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const audio = vi.hoisted(() => ({
  status: 'idle' as string,
  error: null,
  positionMs: 0,
  durationMs: null,
  toggle: vi.fn(),
  seek: vi.fn(),
  retry: vi.fn(),
}));
const audioCalls = vi.hoisted(() => [] as string[]);

vi.mock('../../../hooks/useSourceAudio', () => ({
  useSourceAudio: (transcriptId: string) => {
    audioCalls.push(transcriptId);
    return audio;
  },
  default: () => audio,
}));

const highlight = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../../components/graph/review/noteSpanHighlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../components/graph/review/noteSpanHighlight')>()),
  highlightQuoteInElement: highlight,
}));

beforeEach(() => {
  audio.seek.mockReset();
  audio.toggle.mockReset();
  audio.status = 'idle';
  highlight.mockReset();
  highlight.mockReturnValue(true);
  invalidateGraphOntology();
});

describe('EvidenceList', () => {
  it('quotes each source with its speaker and time, and links to the segment', async () => {
    const { container } = render(
      <EvidenceList evidence={[segmentEvidence({ segmentId: 'seg-4', startMs: 65_000 }), noteEvidence()]} />,
    );
    expect(screen.getByText('“Sarah from Northwind will lead the Atlas migration.”')).toBeInTheDocument();
    expect(screen.getByText('Oscar · 1:05')).toBeInTheDocument();
    expect(screen.getByText('From the note')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in transcript' })).toHaveAttribute(
      'href',
      '/transcripts/t1?segment=seg-4',
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('says when the text has changed', () => {
    render(<EvidenceList evidence={[segmentEvidence({ stale: true })]} />);
    expect(screen.getByText(/The text has changed since/)).toBeInTheDocument();
  });

  it('offers Play and Show in note only with handlers', async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const onShowInNote = vi.fn();
    const segment = segmentEvidence();
    const note = noteEvidence();
    render(<EvidenceList evidence={[segment, note]} onPlay={onPlay} onShowInNote={onShowInNote} />);
    await user.click(screen.getByRole('button', { name: 'Play from 1:05' }));
    expect(onPlay).toHaveBeenCalledWith(segment);
    await user.click(screen.getByRole('button', { name: 'Show in note' }));
    expect(onShowInNote).toHaveBeenCalledWith(note);
  });

  it('expands a long quote', async () => {
    const user = userEvent.setup();
    render(<EvidenceList evidence={[segmentEvidence({ quote: 'word '.repeat(60) })]} />);
    const more = screen.getByRole('button', { name: 'Show more' });
    await user.click(more);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('builds no transcript link for note evidence', () => {
    expect(transcriptHref(noteEvidence())).toBeNull();
    expect(transcriptHref(segmentEvidence({ segmentId: null }))).toBe('/transcripts/t1');
  });
});

describe('Evidence inside the sheet', () => {
  const graphUser = {
    ...mockAdminUser,
    permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
  };

  beforeEach(() => {
    proposalMock.reset(mockProposalDetail('draft'));
    server.use(
      http.get('*/api/ai/config', () =>
        HttpResponse.json({ data: { available: true, models: [], keyConfigured: true, graphEnabled: true } }),
      ),
    );
  });

  async function openEvidence(title: string, count = 1) {
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: /People/ });
    const row = screen.getByTestId(
      `proposal-row-${proposalMock.detail!.items.find((item) => item.display.title === title)!.id}`,
    );
    await user.click(row.querySelector('button[aria-controls]') as HTMLElement);
    expect(row).toHaveTextContent(`Evidence (${count})`);
    return user;
  }

  it('▶ seeks the one shared player to the line and plays', async () => {
    const noteBodyRef = createRef<HTMLElement>();
    render(
      <ProposalReviewSheet open onClose={vi.fn()} source={{ noteId: 'n1' }} originTranscriptId="t1" noteBodyRef={noteBodyRef} />,
      { wrapperOptions: { user: graphUser } },
    );
    const user = await openEvidence('Sarah Chen');
    await user.click(await screen.findByRole('button', { name: 'Play from 1:05' }));
    expect(audio.seek).toHaveBeenCalledWith(65_000);
    expect(audio.toggle).toHaveBeenCalledTimes(1);
    expect(audioCalls.every((id) => id === 't1')).toBe(true);

    // Already playing: another ▶ only moves the same player.
    audio.status = 'playing';
    const secondUser = await openEvidence('Northwind Robotics');
    const plays = await screen.findAllByRole('button', { name: 'Play from 1:05' });
    await secondUser.click(plays[plays.length - 1]);
    expect(audio.seek).toHaveBeenCalledTimes(2);
    expect(audio.toggle).toHaveBeenCalledTimes(1);
  });

  it('"Show in note" highlights the quote in the note body', async () => {
    const body = document.createElement('div');
    const noteBodyRef = { current: body };
    render(
      <ProposalReviewSheet open onClose={vi.fn()} source={{ noteId: 'n1' }} noteBodyRef={noteBodyRef} />,
      { wrapperOptions: { user: graphUser } },
    );
    const user = await openEvidence('Contoso');
    await user.click(await screen.findByRole('button', { name: 'Show in note' }));
    expect(highlight).toHaveBeenCalledWith(body, 'Contoso');
  });

  it('on a phone the sheet steps aside, and "Back to review" brings it back', async () => {
    act(() => setViewportWidth(390));
    render(
      <ProposalReviewSheet open onClose={vi.fn()} source={{ noteId: 'n1' }} noteBodyRef={{ current: document.body }} />,
      { wrapperOptions: { user: graphUser } },
    );
    const user = await openEvidence('Contoso');
    await user.click(await screen.findByRole('button', { name: 'Show in note' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Graph proposal' })).not.toBeInTheDocument(),
    );
    await user.click(await screen.findByRole('button', { name: 'Back to review' }));
    expect(await screen.findByRole('dialog', { name: 'Graph proposal' })).toBeInTheDocument();
  });

  it('says so when the passage is gone', async () => {
    highlight.mockReturnValue(false);
    render(
      <ProposalReviewSheet open onClose={vi.fn()} source={{ noteId: 'n1' }} noteBodyRef={{ current: document.body }} />,
      { wrapperOptions: { user: graphUser } },
    );
    const user = await openEvidence('Contoso');
    await user.click(await screen.findByRole('button', { name: 'Show in note' }));
    expect(await screen.findByText('That passage is no longer in the note')).toBeInTheDocument();
  });
});
