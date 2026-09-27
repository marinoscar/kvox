import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import GraphImportPage, { IMPORT_FAILURE_COPY } from '../../pages/GraphImportPage';
import { invalidateGraphOntology } from '../../hooks/useGraphOntology';
import type { GraphImportOffer, GraphImportStats, ProposalDetail, ProposalEvidence } from '../../services/graph';
import { mockProposalDetail, PROPOSAL_ID } from '../mocks/graphData';
import { server } from '../mocks/server';
import { mockAdminUser, render } from '../utils/test-utils';
import type { MockUser } from '../utils/test-utils';

/**
 * `/graph/imports/:proposalId` (#387) — each state of an import, the Unknown
 * properties panel, the validation report, and #367's review sheet mounted
 * inline with `source={{ proposalId }}`.
 */

const API = '*/api';

const graphWriter: MockUser = { ...mockAdminUser, permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'] };

const OFFER: GraphImportOffer = {
  offerId: 'o0123456789ab',
  iri: 'https://crm.example/ns#nickname',
  label: 'Nickname',
  count: 2,
  subjectTypes: ['Person'],
  sampleValues: ['Joey', 'Mo'],
  suggestedKind: 'text',
  status: 'offered',
};

function importEvidence(): ProposalEvidence {
  return {
    id: 'e0000000-0000-4000-8000-000000000001',
    source: 'import',
    transcriptId: null,
    segmentId: null,
    segmentRev: null,
    startMs: null,
    endMs: null,
    noteId: null,
    noteVersion: null,
    charStart: null,
    charEnd: null,
    quote: 'Imported from contacts.ttl',
    importObjectId: 'f0000000-0000-4000-8000-000000000001',
    sourceIri: 'https://source.example/joe',
    speakerName: null,
    stale: false,
  };
}

function importDetail(status: 'extracting' | 'draft' | 'failed' | 'committed', stats: GraphImportStats): ProposalDetail {
  const base = mockProposalDetail(status === 'failed' || status === 'extracting' ? status : status);
  const items = base.items.map((item) => ({ ...item, origin: 'user' as const, flags: [...item.flags, 'imported'], evidence: [importEvidence()] }));
  return {
    ...base,
    items,
    proposal: {
      ...base.proposal,
      kind: 'import',
      noteId: null,
      noteTitle: null,
      noteVersion: null,
      noteCurrentVersion: null,
      model: null,
      providerId: null,
      failure: status === 'failed' ? { errorClass: stats.failureReason ?? 'other', message: 'Failed.' } : null,
      stats: stats as Record<string, unknown>,
    },
  };
}

const BASE_STATS: GraphImportStats = { filename: 'contacts.ttl', format: 'turtle', bytes: 2048 };

let current: ProposalDetail;
let offerCalls: string[];

beforeEach(() => {
  invalidateGraphOntology();
  offerCalls = [];
  server.use(
    http.get(`${API}/graph/proposals/:id`, ({ params }) =>
      params.id === PROPOSAL_ID ? HttpResponse.json({ data: current }) : HttpResponse.json({ code: 'NOT_FOUND', message: 'Proposal not found' }, { status: 404 }),
    ),
    http.post(`${API}/graph/proposals/:id/attribute-offers/:offerId/:action`, ({ params }) => {
      offerCalls.push(`${String(params.action)}:${String(params.offerId)}`);
      const accepted = params.action === 'accept';
      const offer = { ...OFFER, status: accepted ? 'accepted' : 'rejected' } as GraphImportOffer;
      current = { ...current, proposal: { ...current.proposal, stats: { ...current.proposal.stats, unknownProperties: [offer] } } };
      return HttpResponse.json({
        data: {
          offer,
          attributeDefs: accepted
            ? [{ id: 'a1', entityType: 'Person', key: 'u_abcdefghij', label: 'Nickname', kind: 'text', options: null, extractable: false, extractionHint: null, sensitivity: null, sortOrder: 0, deprecatedAt: null, createdAt: '', updatedAt: '' }]
            : [],
          rowsUpdated: accepted ? 1 : 0,
          valuesDropped: accepted ? 1 : 2,
        },
      });
    }),
  );
});

function renderPage(user: MockUser = graphWriter) {
  return render(
    <Routes>
      <Route path="/graph/imports/:proposalId" element={<GraphImportPage />} />
    </Routes>,
    { wrapperOptions: { route: `/graph/imports/${PROPOSAL_ID}`, user } },
  );
}

describe('GraphImportPage', () => {
  it('says the file is being checked while kg.import runs', async () => {
    current = importDetail('extracting', BASE_STATS);
    renderPage();
    expect(await screen.findByText('Checking your file…')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'contacts.ttl' })).toBeInTheDocument();
    expect(screen.queryByText('Unknown properties')).not.toBeInTheDocument();
  });

  it('lists every SHACL violation of a failed import, and imports nothing', async () => {
    current = importDetail('failed', {
      ...BASE_STATS,
      triples: 13,
      failureReason: 'shacl_violations',
      validation: {
        conforms: false,
        violationCount: 2,
        violations: [
          { focusNode: 'https://source.example/nobody', path: 'http://www.w3.org/ns/prov#wasDerivedFrom', message: 'Less than 1 values', severity: 'Violation' },
          { focusNode: 'https://source.example/ana', path: 'https://x.app/ns#WORKS_FOR', message: 'The value is not a node of an allowed type', severity: 'Violation' },
        ],
      },
    });
    renderPage();

    expect(await screen.findByText(IMPORT_FAILURE_COPY.shacl_violations)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Validation problems' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('wasDerivedFrom')).toBeInTheDocument();
    expect(within(rows[2]).getByText('WORKS_FOR')).toBeInTheDocument();
    expect(screen.getByText('2 problems')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Graph proposal' })).not.toBeInTheDocument();
  });

  it('explains a version refusal without a report', async () => {
    current = importDetail('failed', { ...BASE_STATS, failureReason: 'ontology_version_newer', sourceOntologyVersion: '9.0.0' });
    renderPage();
    expect(await screen.findByText(IMPORT_FAILURE_COPY.ontology_version_newer)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('offers unknown properties above the review sheet, mounted for this proposal', async () => {
    current = importDetail('draft', {
      ...BASE_STATS,
      triples: 36,
      failureReason: null,
      unknownProperties: [OFFER],
      counts: { entities: 3, relations: 2, items: 1, skippedSensitive: 1 },
      validation: { conforms: true, violations: [], violationCount: 0 },
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Unknown properties' })).toBeInTheDocument();
    expect(screen.getByText('https://crm.example/ns#nickname')).toBeInTheDocument();
    expect(screen.getByText(/“Joey”, “Mo”/)).toBeInTheDocument();
    expect(screen.getByText(/1 sensitive fact was left out/)).toBeInTheDocument();

    // The sheet, inline: its header and rows (read for PROPOSAL_ID), no close button, no "what the AI saw".
    const sheet = await screen.findByRole('region', { name: 'Graph proposal' });
    expect(within(sheet).queryByRole('button', { name: 'Close graph proposal' })).not.toBeInTheDocument();
    expect(await within(sheet).findByText('Sarah Chen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send to graph/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(offerCalls).toEqual([`accept:${OFFER.offerId}`]));
    expect(await screen.findByText('Added “Nickname” as an attribute')).toBeInTheDocument();
    expect(await screen.findByText('Added as attribute')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('rejects an offer', async () => {
    current = importDetail('draft', { ...BASE_STATS, failureReason: null, unknownProperties: [OFFER] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(offerCalls).toEqual([`reject:${OFFER.offerId}`]));
    expect(await screen.findByText('Left out')).toBeInTheDocument();
  });

  it('shows no offer buttons to a reader who cannot write', async () => {
    current = importDetail('draft', { ...BASE_STATS, failureReason: null, unknownProperties: [OFFER] });
    renderPage({ ...mockAdminUser, permissions: [...mockAdminUser.permissions, 'graph:read'] });
    expect(await screen.findByRole('heading', { name: 'Unknown properties' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });
});
