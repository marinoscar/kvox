import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { AddToGraphDialog, STALE_SELECTION_MESSAGE } from '../../../components/graph/selection/AddToGraphDialog';
import { TargetProposalDialog } from '../../../components/graph/selection/TargetProposalDialog';
import type { GraphSelection } from '../../../hooks/useTextSelection';
import {
  EXISTING_TOM_ID,
  PROPOSAL_ID,
  draftItems,
  mockGraphOntology,
  mockProposalDetail,
  proposalMock,
  proposalSummaryRow,
} from '../../mocks/graphData';
import { server } from '../../mocks/server';
import { mockAdminUser, render } from '../../utils/test-utils';
import type { MockUser } from '../../utils/test-utils';

const API = '*/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const graphUser: MockUser = {
  ...mockAdminUser,
  permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
};

const NOTE_SELECTION: GraphSelection = {
  quote: 'Sarah** Chen',
  source: { kind: 'note', noteId: 'n1', noteVersion: 3, charStart: 9, charEnd: 21 },
  rect: new DOMRect(0, 0, 0, 0),
};

const SEGMENT_SELECTION: GraphSelection = {
  quote: 'Tom will check with legal',
  source: { kind: 'segment', transcriptId: 't1', segmentId: 'seg-9', segmentRev: 4, charStart: 0, charEnd: 25 },
  rect: new DOMRect(0, 0, 0, 0),
};

beforeEach(() => {
  proposalMock.reset(mockProposalDetail('draft'));
});

function renderDialog(props: Partial<Parameters<typeof AddToGraphDialog>[0]> = {}) {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  const onReload = vi.fn();
  const utils = render(
    <AddToGraphDialog
      open
      onClose={onClose}
      selection={NOTE_SELECTION}
      proposalId={PROPOSAL_ID}
      items={draftItems()}
      ontology={mockGraphOntology()}
      onAdded={onAdded}
      onReload={onReload}
      {...props}
    />,
    { wrapperOptions: { user: graphUser } },
  );
  return { ...utils, onAdded, onClose, onReload };
}

function lastAddBody() {
  const matches = proposalMock.requests.filter((request) => request.path.endsWith('/items'));
  return matches[matches.length - 1]?.body;
}

async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: RegExp | string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('AddToGraphDialog — entity', () => {
  it('prefills the name from the quote and sends the selection as evidence', async () => {
    const user = userEvent.setup();
    const { container, onAdded } = renderDialog();
    expect(screen.getByRole('figure', { name: 'Evidence' })).toHaveTextContent('Sarah** Chen');
    expect(screen.getByText('From your note, version 3')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Sarah** Chen');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();

    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Sarah Chen');
    await user.type(screen.getByRole('textbox', { name: 'Job title' }), 'CTO');
    await user.click(screen.getByRole('button', { name: 'Add to draft' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(lastAddBody()).toEqual({
      kind: 'entity',
      payload: { type: 'Person', label: 'Sarah Chen', aliases: [], props: { title: 'CTO' }, occurredAt: null },
      evidence: [{ source: 'note', noteVersion: 3, charStart: 9, charEnd: 21, quote: 'Sarah** Chen' }],
    });
    expect(onAdded.mock.calls[0][0].item.origin).toBe('user');
    expect(onAdded.mock.calls[0][1]).toBe(PROPOSAL_ID);
  });

  it('"already in my graph" sends existingEntityId', async () => {
    const user = userEvent.setup();
    const { onAdded } = renderDialog({ selection: SEGMENT_SELECTION });
    expect(screen.getByText('From a line of the transcript')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /already in my graph/ }));
    expect(screen.getByRole('button', { name: 'Add to draft' })).toBeDisabled();
    await user.type(screen.getByRole('combobox', { name: 'Which one?' }), 'Tom');
    await user.click(await screen.findByRole('option', { name: /Tom Baker/ }));
    await user.click(screen.getByRole('button', { name: 'Add to draft' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(lastAddBody()).toMatchObject({
      kind: 'entity',
      existingEntityId: EXISTING_TOM_ID,
      evidence: [
        { source: 'segment', segmentId: 'seg-9', segmentRev: 4, charStart: 0, charEnd: 25, quote: 'Tom will check with legal' },
      ],
    });
  });
});

describe('AddToGraphDialog — fact', () => {
  it('a decision about one of the draft entities', async () => {
    const user = userEvent.setup();
    const { onAdded } = renderDialog({ selection: SEGMENT_SELECTION });
    await user.click(screen.getByRole('button', { name: 'A fact' }));
    expect(screen.getByRole('textbox', { name: 'Statement' })).toHaveValue('Tom will check with legal');
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Legal review');

    await user.click(screen.getByRole('combobox', { name: 'About' }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('In this draft')).toBeInTheDocument();
    await user.click(within(listbox).getByRole('option', { name: 'Atlas migration' }));

    await user.click(screen.getByRole('button', { name: 'Add to draft' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(lastAddBody()).toEqual({
      kind: 'item',
      payload: {
        kind: 'decision',
        title: 'Legal review',
        statement: 'Tom will check with legal',
        subject: { ref: 'e4' },
        owner: null,
        counterparty: null,
        meeting: null,
        status: null,
        occurredAt: null,
        dueAt: null,
        sensitivity: null,
        validFrom: null,
        validTo: null,
        precision: 'unknown',
        props: {},
      },
      evidence: [expect.objectContaining({ source: 'segment', segmentId: 'seg-9' })],
    });
  });

  it('a person fact requires a subject and defaults to business sensitivity', async () => {
    const user = userEvent.setup();
    const { onAdded } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'A fact' }));
    await user.click(screen.getByRole('combobox', { name: 'Kind' }));
    await user.click(await screen.findByRole('option', { name: 'Person fact' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Runs marathons');
    expect(screen.getByRole('button', { name: 'Add to draft' })).toBeDisabled();
    await pick(user, 'About', 'Sarah Chen');
    expect(screen.getByRole('combobox', { name: 'Sensitivity' })).toHaveTextContent('Business');
    await user.click(screen.getByRole('button', { name: 'Add to draft' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(lastAddBody()).toMatchObject({
      kind: 'item',
      payload: { kind: 'person_fact', subject: { ref: 'e1' }, sensitivity: 'business' },
    });
  });

  it('a commitment carries owner and due date', async () => {
    const user = userEvent.setup();
    const { onAdded } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'A fact' }));
    await user.click(screen.getByRole('combobox', { name: 'Kind' }));
    await user.click(await screen.findByRole('option', { name: 'Commitment' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Write the plan');
    await pick(user, 'Owner', 'Sarah Chen');
    await user.type(screen.getByLabelText('Due'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Add to draft' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(lastAddBody()).toMatchObject({
      payload: { kind: 'commitment', owner: { ref: 'e1' }, status: 'open', dueAt: '2026-10-01' },
    });
  });
});

describe('AddToGraphDialog — relationship', () => {
  it('WORKS_FOR between draft rows, endpoints filtered by type', async () => {
    const user = userEvent.setup();
    const { onAdded } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'A relationship' }));
    expect(screen.getByRole('combobox', { name: 'Relationship' })).toHaveTextContent('Works for');
    await user.click(screen.getByRole('combobox', { name: 'From' }));
    const fromList = await screen.findByRole('listbox');
    expect(within(fromList).queryByRole('option', { name: 'Northwind Robotics' })).not.toBeInTheDocument();
    await user.click(within(fromList).getByRole('option', { name: 'Sarah Chen' }));
    await pick(user, 'To', 'Northwind Robotics');
    await user.click(screen.getByRole('button', { name: 'Add to draft' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(lastAddBody()).toEqual({
      kind: 'relation',
      payload: {
        type: 'WORKS_FOR',
        from: { ref: 'e1' },
        to: { ref: 'e3' },
        validFrom: null,
        validTo: null,
        precision: 'unknown',
        props: {},
      },
      evidence: [expect.objectContaining({ source: 'note' })],
    });
  });
});

describe('AddToGraphDialog — refusals', () => {
  it('a stale span asks for a reload', async () => {
    server.use(
      http.post(`${API}/graph/proposals/:id/items`, () =>
        HttpResponse.json(
          { statusCode: 409, message: 'Stale', details: { reason: 'stale_note_version' } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    const { onAdded, onReload, container } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Add to draft' }));
    expect(await screen.findByText(STALE_SELECTION_MESSAGE)).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('a stale segment rev too', async () => {
    server.use(
      http.post(`${API}/graph/proposals/:id/items`, () =>
        HttpResponse.json({ statusCode: 409, message: 'Stale', details: { reason: 'stale_segment_rev' } }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderDialog({ selection: SEGMENT_SELECTION });
    await user.click(screen.getByRole('button', { name: 'Add to draft' }));
    expect(await screen.findByText(STALE_SELECTION_MESSAGE)).toBeInTheDocument();
  });

  it('400 issues land on their fields', async () => {
    server.use(
      http.post(`${API}/graph/proposals/:id/items`, () =>
        HttpResponse.json(
          {
            statusCode: 400,
            message: 'Invalid',
            details: { issues: [{ path: ['payload', 'label'], message: 'Too long' }] },
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Add to draft' }));
    expect(await screen.findByText('Too long')).toBeInTheDocument();
    expect(screen.getByText('Some fields need attention.')).toBeInTheDocument();
  });
});

describe('TargetProposalDialog', () => {
  it('no draft on the note page offers Extract…', async () => {
    const user = userEvent.setup();
    const onExtract = vi.fn();
    const { container } = render(
      <TargetProposalDialog open onClose={vi.fn()} drafts={[]} onPick={vi.fn()} onExtract={onExtract} />,
    );
    expect(screen.getByRole('heading', { name: 'Adding needs a draft' })).toBeInTheDocument();
    expect(screen.getByText(/Extract this note first/)).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Extract…' }));
    expect(onExtract).toHaveBeenCalled();
  });

  it('several drafts are a picker', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <TargetProposalDialog
        open
        onClose={vi.fn()}
        drafts={[
          proposalSummaryRow('p-1', { noteTitle: 'Standup minutes' }),
          proposalSummaryRow('p-2', { noteTitle: 'Decision log' }),
        ]}
        onPick={onPick}
        onShowNotes={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Add to which draft?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Decision log/ }));
    expect(onPick).toHaveBeenCalledWith('p-2');
  });
});
