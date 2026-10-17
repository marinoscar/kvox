/**
 * The default answers of the graph suites: the knowledge-graph part of the web
 * edition's MSW handlers (#369 settings card, #373 read side against #370/#372,
 * #367 proposals), registered for every graph test by `helpers.tsx` through
 * `server.use` and overridden per test the same way.
 *
 * Only a viewer holding `graph:read` ever reaches these, so they cost no other
 * suite anything.
 */

import type {
  PatchProposalItemInput,
  ProposalItem,
} from '../../src/graph/headless/index.js';
import { http, HttpResponse } from './msw-compat.js';
import {
  briefFixture,
  countsFor,
  emptyCommitResult,
  entityDetail,
  evidenceFixtures,
  expandFixture,
  graphEntitySummaries,
  mentionFixtures,
  mockEntitySearchResults,
  mockGraphOntology,
  mockProposalDetail,
  neighborhoodFixture,
  overviewFixture,
  proposalMock,
  timelineFixture,
} from './graphData.js';
import type { ExpandFixtureRequest } from './graphData.js';

// The same wildcard the web edition's handlers use; the shim strips it.
const API_BASE = '*/api';

export const graphHandlers = [
  // ---------------------------------------------------------------------------
  // Knowledge graph (#369 settings card; #373 read side against #370/#372).
  //
  // Only a user holding `graph:read` ever reaches these — the default test
  // users do not — so they cost no other suite anything. A suite that cares
  // about a specific answer overrides with `server.use(...)`.
  // ---------------------------------------------------------------------------
  // The caller's effective ontology (default domains) and no attribute
  // definitions of their own (#369). Tests override.
  http.get(`${API_BASE}/graph/ontology`, () => {
    return HttpResponse.json({ data: mockGraphOntology() });
  }),

  http.get(`${API_BASE}/graph/attribute-defs`, () => {
    return HttpResponse.json({ data: { items: [] } });
  }),

  http.get(`${API_BASE}/graph/entities`, ({ request }) => {
    const url = new URL(request.url);
    const types = url.searchParams.get('type')?.split(',').filter(Boolean) ?? [];
    const q = url.searchParams.get('q')?.toLowerCase() ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const cursor = url.searchParams.get('cursor');
    if (url.searchParams.get('transcriptId')) {
      return HttpResponse.json({ data: { items: [], nextCursor: null } });
    }
    let rows = graphEntitySummaries.filter((row) => types.length === 0 || types.includes(row.type));
    if (q) {
      rows = rows
        .filter(
          (row) =>
            row.label.toLowerCase().includes(q) ||
            row.aliases.some((alias) => alias.toLowerCase().includes(q)),
        )
        .slice(0, limit);
      // #367's re-link search fixtures (Tom Baker, Sarah Chen) answer here too,
      // so the proposal sheet and the entity pages share one list handler.
      const searchHits = mockEntitySearchResults
        .filter(
          (row) =>
            (types.length === 0 || types.includes(row.type)) &&
            !rows.some((existing) => existing.id === row.id) &&
            row.label.toLowerCase().includes(q),
        )
        .map((row) => ({ ...row, mentionCount: 0, lastSeenAt: null }));
      return HttpResponse.json({ data: { items: [...rows, ...searchHits].slice(0, limit), nextCursor: null } });
    }
    const start = cursor ? Number(cursor) : 0;
    const page = rows.slice(start, start + limit);
    const next = start + limit < rows.length ? String(start + limit) : null;
    return HttpResponse.json({ data: { items: page, nextCursor: next } });
  }),

  http.get(`${API_BASE}/graph/entities/:id/brief`, () => HttpResponse.json({ data: briefFixture() })),

  http.get(`${API_BASE}/graph/entities/:id/timeline`, ({ request }) => {
    const url = new URL(request.url);
    const includeSensitive = url.searchParams.get('includeSensitive') === 'true';
    return HttpResponse.json({
      data: { items: timelineFixture(includeSensitive), nextCursor: null, asOf: '2026-09-26T00:00:00.000Z' },
    });
  }),

  http.get(`${API_BASE}/graph/entities/:id/mentions`, () =>
    HttpResponse.json({ data: { items: mentionFixtures, nextCursor: null } }),
  ),

  http.get(`${API_BASE}/graph/entities/:id/neighborhood`, () =>
    HttpResponse.json({ data: neighborhoodFixture() }),
  ),

  // #374 — the explorer's expand, walked over `explorerFixtureEdges`.
  http.post(`${API_BASE}/graph/explore/expand`, async ({ request }) => {
    const body = (await request.json()) as ExpandFixtureRequest;
    const slice = expandFixture(body);
    if (!slice) {
      return HttpResponse.json({ message: 'Entity not found', statusCode: 404 }, { status: 404 });
    }
    return HttpResponse.json({ data: slice });
  }),

  // #375 — the whole-graph overview (#371): a ready snapshot; suites override
  // for the pending/stale/none/tooLarge/truncated states.
  http.get(`${API_BASE}/graph/overview`, () => HttpResponse.json({ data: overviewFixture() })),

  http.post(`${API_BASE}/graph/overview/refresh`, () =>
    HttpResponse.json({ data: { jobId: 'job-layout-1', deduplicated: false } }, { status: 202 }),
  ),

  http.get(`${API_BASE}/graph/entities/:id`, ({ params }) => {
    const id = String(params.id);
    if (!graphEntitySummaries.some((row) => row.id === id)) {
      return HttpResponse.json({ message: 'Entity not found', statusCode: 404 }, { status: 404 });
    }
    return HttpResponse.json({ data: entityDetail(id) });
  }),

  http.get(`${API_BASE}/graph/evidence`, ({ request }) => {
    const ids = new URL(request.url).searchParams.get('ids')?.split(',') ?? [];
    return HttpResponse.json({ data: { items: evidenceFixtures.filter((ev) => ids.includes(ev.id)) } });
  }),

  http.get(`${API_BASE}/graph/evidence/:id`, ({ params }) => {
    const found = evidenceFixtures.find((ev) => ev.id === params.id);
    return found
      ? HttpResponse.json({ data: found })
      : HttpResponse.json({ message: 'Not found', statusCode: 404 }, { status: 404 });
  }),

  // ---------------------------------------------------------------------------
  // Graph proposals (#367) — an in-memory stand-in for #366's Contract, backed
  // by `proposalMock` (graphData.ts). Every request is recorded so a test can
  // assert the exact body a row action sent. Literal routes before
  // parameterised ones (`/items/bulk` before `/items`).
  // ---------------------------------------------------------------------------
  http.get(`${API_BASE}/graph/notes/:noteId/proposal`, () => {
    const detail = proposalMock.detail;
    const visible = detail && detail.proposal.status !== 'discarded' ? detail : null;
    return HttpResponse.json({ data: { proposal: visible } });
  }),

  http.get(`${API_BASE}/graph/proposals`, () => {
    const detail = proposalMock.detail;
    return HttpResponse.json({
      data: { items: detail ? [detail.proposal] : [], nextCursor: null },
    });
  }),

  http.get(`${API_BASE}/graph/proposals/:id`, ({ params, request }) => {
    const detail = proposalMock.detail;
    if (!detail || detail.proposal.id !== params.id) return graphNotFound();
    const include = new URL(request.url).searchParams.get('include');
    return HttpResponse.json({
      data: { ...detail, context: include === 'context' ? proposalMock.context : null },
    });
  }),

  http.patch(`${API_BASE}/graph/proposals/:id/items/:itemId`, async ({ params, request }) => {
    const body = (await request.json()) as PatchProposalItemInput;
    record('PATCH', `/graph/proposals/${params.id}/items/${params.itemId}`, body);
    const detail = proposalMock.detail;
    if (!detail) return graphNotFound();
    if (detail.proposal.status !== 'draft') return graphConflict('proposal_not_draft');
    const item = detail.items.find((row) => row.id === params.itemId);
    if (!item) return graphNotFound();
    const next = applyPatch(item, body);
    detail.items = detail.items.map((row) => (row.id === item.id ? next : row));
    detail.proposal = { ...detail.proposal, counts: countsFor(detail.items) };
    return HttpResponse.json({ data: { item: next, counts: detail.proposal.counts } });
  }),

  http.post(`${API_BASE}/graph/proposals/:id/items/bulk`, async ({ params, request }) => {
    const body = (await request.json()) as { itemIds: string[]; decision: 'accept' | 'reject' | 'pending' };
    record('POST', `/graph/proposals/${params.id}/items/bulk`, body);
    const detail = proposalMock.detail;
    if (!detail) return graphNotFound();
    if (detail.proposal.status !== 'draft') return graphConflict('proposal_not_draft');
    const skipped: Array<{ itemId: string; reason: string }> = [];
    let updated = 0;
    for (const itemId of body.itemIds) {
      const item = detail.items.find((row) => row.id === itemId);
      if (!item) {
        skipped.push({ itemId, reason: 'not_found' });
        continue;
      }
      if (body.decision === 'accept' && item.kind === 'closing') {
        skipped.push({ itemId, reason: 'closing_requires_individual_accept' });
        continue;
      }
      if (
        body.decision === 'accept' &&
        (item.effectivePayload as { sensitivity?: unknown }).sensitivity === 'sensitive'
      ) {
        skipped.push({ itemId, reason: 'sensitive_requires_individual_accept' });
        continue;
      }
      item.decision = body.decision;
      updated += 1;
    }
    detail.items = [...detail.items];
    detail.proposal = { ...detail.proposal, counts: countsFor(detail.items) };
    return HttpResponse.json({ data: { updated, skipped, counts: detail.proposal.counts } });
  }),

  http.post(`${API_BASE}/graph/proposals/:id/items`, async ({ params, request }) => {
    const body = (await request.json()) as { kind: ProposalItem['kind']; payload: Record<string, unknown> };
    record('POST', `/graph/proposals/${params.id}/items`, body);
    const detail = proposalMock.detail;
    if (!detail) return graphNotFound();
    if (detail.proposal.status !== 'draft') return graphConflict('proposal_not_draft');
    const ref = `u${detail.items.filter((row) => row.origin === 'user').length + 1}`;
    const payload = { ...body.payload, ref };
    const item: ProposalItem = {
      ...detail.items[0],
      id: `e1000000-0000-4000-8000-${String(detail.items.length).padStart(12, '0')}`,
      kind: body.kind,
      origin: 'user',
      decision: 'accept',
      payload,
      editedPayload: null,
      effectivePayload: payload,
      display: {
        title: String(
          (payload as Record<string, unknown>).label ?? (payload as Record<string, unknown>).title ?? ref,
        ),
        subtitle: null,
      },
      flags: [],
      resolution: null,
    };
    detail.items = [...detail.items, item];
    detail.proposal = { ...detail.proposal, counts: countsFor(detail.items) };
    return HttpResponse.json({ data: { item, counts: detail.proposal.counts } }, { status: 201 });
  }),

  http.post(`${API_BASE}/graph/proposals/:id/commit`, async ({ params, request }) => {
    record('POST', `/graph/proposals/${params.id}/commit`, await request.json().catch(() => null));
    const detail = proposalMock.detail;
    if (!detail) return graphNotFound();
    if (detail.proposal.status !== 'draft') return graphConflict('proposal_not_draft');
    const accepted = detail.items.filter((row) =>
      ['accept', 'edit', 'merge_into'].includes(row.decision),
    ).length;
    const pending = detail.items.filter((row) => row.decision === 'pending').length;
    detail.proposal = {
      ...detail.proposal,
      status: 'committed',
      committedAt: new Date().toISOString(),
    };
    const result = emptyCommitResult({
      created: { entities: accepted, relations: 0, items: 0 },
      skippedPending: pending,
    });
    return HttpResponse.json({ data: { proposal: detail.proposal, result } });
  }),

  http.post(`${API_BASE}/graph/proposals/:id/discard`, async ({ params, request }) => {
    record('POST', `/graph/proposals/${params.id}/discard`, await request.json().catch(() => null));
    const detail = proposalMock.detail;
    if (!detail) return graphNotFound();
    if (detail.proposal.status !== 'draft' && detail.proposal.status !== 'failed') {
      return graphConflict('proposal_not_draft');
    }
    detail.proposal = { ...detail.proposal, status: 'discarded' };
    return HttpResponse.json({ data: { proposal: detail.proposal } });
  }),

  http.post(`${API_BASE}/graph/proposals/:id/revert`, async ({ params, request }) => {
    const body = (await request.json()) as { confirmPartial?: boolean };
    record('POST', `/graph/proposals/${params.id}/revert`, body);
    const detail = proposalMock.detail;
    if (!detail) return graphNotFound();
    if (detail.proposal.status !== 'committed') return graphConflict('proposal_not_committed');
    const kept = proposalMock.revertConflicts;
    const revertible = Math.max(0, detail.proposal.counts.accepted - kept.length);
    if (kept.length > 0 && !body.confirmPartial) {
      return graphConflict('revert_conflict', { conflicts: kept, revertible });
    }
    detail.proposal = {
      ...detail.proposal,
      status: 'reverted',
      revertedAt: new Date().toISOString(),
    };
    return HttpResponse.json({
      data: { proposal: detail.proposal, result: { reverted: revertible, kept } },
    });
  }),

  http.post(`${API_BASE}/graph/notes/:noteId/extract`, async ({ params, request }) => {
    const body = await request.json().catch(() => null);
    record('POST', `/graph/notes/${params.noteId}/extract`, body);
    const extracting = mockProposalDetail('extracting');
    proposalMock.detail = extracting;
    return HttpResponse.json(
      {
        data: {
          proposal: {
            id: extracting.proposal.id,
            noteId: String(params.noteId),
            noteVersion: extracting.proposal.noteVersion ?? 1,
            status: 'extracting',
            model: extracting.proposal.model ?? 'gpt-4o-mini',
            providerId: extracting.proposal.providerId ?? 'openai',
            createdAt: extracting.proposal.createdAt,
          },
          estimate: ESTIMATE,
        },
      },
      { status: 202 },
    );
  }),

  http.get(`${API_BASE}/graph/extract/estimate`, () => HttpResponse.json({ data: ESTIMATE })),
];

// ---------------------------------------------------------------------------
// Graph proposal helpers (#367)
// ---------------------------------------------------------------------------

const ESTIMATE = {
  providerId: 'openai',
  model: 'gpt-4o-mini',
  inputTokens: 4_200,
  maxOutputTokens: 8_000,
  availableInputTokens: 100_000,
  fits: true,
  requests: 1,
  keyConfigured: true,
};

function record(method: string, path: string, body: unknown): void {
  proposalMock.requests.push({ method, path, body });
}

function graphNotFound() {
  return HttpResponse.json(
    { statusCode: 404, code: 'NOT_FOUND', message: 'Proposal not found' },
    { status: 404 },
  );
}

function graphConflict(reason: string, extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    {
      statusCode: 409,
      code: 'CONFLICT',
      message:
        reason === 'proposal_not_draft'
          ? 'This proposal is no longer a draft.'
          : reason === 'revert_conflict'
            ? 'Some of what this proposal added has changed since.'
            : 'This proposal cannot be changed right now.',
      details: { reason, ...extra },
    },
    { status: 409 },
  );
}

/** #366's decision semantics, reduced to what the web can observe. */
function applyPatch(item: ProposalItem, body: PatchProposalItemInput): ProposalItem {
  let editedPayload = item.editedPayload;
  if (body.decision === 'edit' && body.editedPayload) editedPayload = body.editedPayload;
  if (body.relinkTo) {
    editedPayload = { ...(editedPayload ?? item.payload), [body.relinkTo.field]: body.relinkTo.target };
  }
  const distinctFrom = body.distinctFrom ?? item.distinctFrom;
  let resolution = item.resolution;
  if (resolution && body.distinctFrom) {
    resolution = {
      ...resolution,
      candidates: resolution.candidates.filter((c) => !distinctFrom.includes(c.entityId)),
      ref: resolution.ref && distinctFrom.includes(resolution.ref) ? null : resolution.ref,
    };
  }
  return {
    ...item,
    decision: body.decision,
    editedPayload,
    effectivePayload: editedPayload ?? item.payload,
    mergeIntoId: body.decision === 'merge_into' ? (body.mergeIntoId ?? null) : null,
    distinctFrom,
    resolution,
  };
}
