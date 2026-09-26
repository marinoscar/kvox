import { http, HttpResponse } from 'msw';

import {
  briefFixture,
  entityDetail,
  evidenceFixtures,
  graphEntitySummaries,
  mentionFixtures,
  mockGraphOntology,
  neighborhoodFixture,
  timelineFixture,
  expandFixture,
  type ExpandFixtureRequest,
} from './graphData';
import {
  emptyCommitResult,
  mockEntitySearchResults,
  mockProposalDetail,
  proposalMock,
  countsFor,
} from './graphData';
import type { ProposalItem, PatchProposalItemInput } from '../../services/graph';

// Use wildcard pattern to match relative URLs
const API_BASE = '*/api';

// Mock data
const mockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  profileImageUrl: null,
  roles: [{ name: 'viewer' }],
  permissions: ['user_settings:read', 'user_settings:write'],
  isActive: true,
  createdAt: new Date().toISOString(),
};

const mockUserSettings = {
  theme: 'system',
  profile: {
    displayName: null,
    imageSource: 'provider',
    imageObjectId: null,
  },
  updatedAt: new Date().toISOString(),
  version: 1,
};

const mockSystemSettings = {
  notifications: {
    browserEnabled: true,
    disabledEvents: [],
  },
  updatedAt: new Date().toISOString(),
  updatedBy: null,
  version: 1,
};

const mockProviders = [
  { name: 'google', authUrl: '/api/auth/google' },
];

export const handlers = [
  // Auth endpoints
  http.get(`${API_BASE}/auth/providers`, () => {
    // Real API returns { providers: [...] } which gets unwrapped by api.ts
    return HttpResponse.json({ providers: mockProviders });
  }),

  http.get(`${API_BASE}/auth/me`, () => {
    return HttpResponse.json({ data: mockUser });
  }),

  http.post(`${API_BASE}/auth/logout`, () => {
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE}/auth/refresh`, () => {
    return HttpResponse.json({
      accessToken: 'new-mock-token',
      expiresIn: 900,
    });
  }),

  // User settings endpoints
  http.get(`${API_BASE}/user-settings`, () => {
    return HttpResponse.json({ data: mockUserSettings });
  }),

  http.put(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  // Profile picture endpoints (#367) — POST to upload, DELETE to remove.
  // Both return `{ settings, profileImageUrl }` after the client's `data` unwrap.
  http.post(`${API_BASE}/user-settings/profile-image`, () => {
    return HttpResponse.json({
      data: {
        settings: {
          ...mockUserSettings,
          profile: {
            ...mockUserSettings.profile,
            imageSource: 'upload',
            imageObjectId: 'mock-object-id',
          },
          version: mockUserSettings.version + 1,
          updatedAt: new Date().toISOString(),
        },
        profileImageUrl: 'https://example.com/uploaded-mock.jpg',
      },
    });
  }),

  http.delete(`${API_BASE}/user-settings/profile-image`, () => {
    return HttpResponse.json({
      data: {
        settings: {
          ...mockUserSettings,
          profile: {
            ...mockUserSettings.profile,
            imageSource: 'provider',
            imageObjectId: null,
          },
          version: mockUserSettings.version + 1,
          updatedAt: new Date().toISOString(),
        },
        profileImageUrl: null,
      },
    });
  }),

  // System settings endpoints
  http.get(`${API_BASE}/system-settings`, () => {
    return HttpResponse.json({ data: mockSystemSettings });
  }),

  http.patch(`${API_BASE}/system-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockSystemSettings,
        ...body,
        version: mockSystemSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  http.put(`${API_BASE}/system-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...body,
        updatedAt: new Date().toISOString(),
        updatedBy: null,
        version: 1,
      },
    });
  }),

  // Users endpoints
  http.get(`${API_BASE}/users`, () => {
    return HttpResponse.json({
      items: [
        {
          id: mockUser.id,
          email: mockUser.email,
          displayName: mockUser.displayName,
          providerDisplayName: 'Test User (Provider)',
          profileImageUrl: mockUser.profileImageUrl,
          providerProfileImageUrl: null,
          isActive: mockUser.isActive,
          roles: mockUser.roles.map((r) => r.name),
          createdAt: mockUser.createdAt,
          updatedAt: mockUser.createdAt,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    });
  }),

  http.get(`${API_BASE}/users/:id`, ({ params }) => {
    if (params.id === mockUser.id) {
      return HttpResponse.json({ data: mockUser });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  http.patch(`${API_BASE}/users/:id`, async ({ params, request }) => {
    if (params.id === mockUser.id) {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: mockUser.id,
        email: mockUser.email,
        displayName: (body.displayName as string | null) ?? mockUser.displayName,
        providerDisplayName: 'Test User (Provider)',
        profileImageUrl: mockUser.profileImageUrl,
        providerProfileImageUrl: null,
        isActive: body.isActive !== undefined ? (body.isActive as boolean) : mockUser.isActive,
        roles: mockUser.roles.map((r) => r.name),
        createdAt: mockUser.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    return HttpResponse.json({ message: 'Not found' }, { status: 404 });
  }),

  http.put(`${API_BASE}/users/:id/roles`, async ({ params, request }) => {
    if (params.id === mockUser.id) {
      const body = (await request.json()) as { roles: string[] };
      return HttpResponse.json({
        id: mockUser.id,
        email: mockUser.email,
        displayName: mockUser.displayName,
        providerDisplayName: 'Test User (Provider)',
        profileImageUrl: mockUser.profileImageUrl,
        providerProfileImageUrl: null,
        isActive: mockUser.isActive,
        roles: body.roles,
        createdAt: mockUser.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    return HttpResponse.json({ message: 'Not found' }, { status: 404 });
  }),

  // ---------------------------------------------------------------------------
  // Transcripts — the home page's two calls (issue #32, epic #19)
  // ---------------------------------------------------------------------------
  //
  // DEFAULTS, not fixtures. Every suite that mounts `<App />` renders `/` and
  // therefore `HomePage`, which fetches these two on mount. Without handlers
  // here each of those suites logged two MSW "unhandled request" warnings and —
  // worse — rendered the page's ERROR state into whatever it was actually
  // asserting about, so an unrelated navigation test would be inspecting a home
  // page carrying a red alert.
  //
  // The empty summary is deliberate: it is the quietest possible answer (the
  // journey empty state, no polling, no rows), so it adds nothing to the DOM
  // that another suite's query could accidentally match. A suite that cares
  // about the home page's CONTENT overrides these with `server.use(...)`, which
  // is exactly what `pages/HomePage.test.tsx` does.
  http.get(`${API_BASE}/transcripts/summary`, () => {
    return HttpResponse.json({
      data: {
        inProgress: [],
        recent: [],
        sharedWithMe: [],
        // `failed` since #171 — the same shape the API answers with, so the
        // quietest possible answer stays a COMPLETE one. A default missing a
        // list the page reads is a default that makes every suite mounting
        // `<App />` exercise a `?? []` fallback instead of the real payload.
        failed: [],
        counts: { owned: 0, shared: 0, inProgress: 0, failed: 0 },
      },
    });
  }),

  // `GET /api/notes` — the quietest possible answer, for the same reason the
  // transcript summary above gives: the transcript viewer now lists the notes
  // generated from it (#59), so EVERY suite rendering that page makes this
  // request. An empty page renders nothing, so it cannot be matched by another
  // suite's query; a suite that cares about the content overrides it with
  // `server.use(...)`.
  http.get(`${API_BASE}/notes`, () => {
    return HttpResponse.json({ data: { items: [], total: 0, nextCursor: null } });
  }),

  // `GET /api/notes/summary` — the home page's notes half (#107), and a default
  // for exactly the reason the transcript summary above is one: every suite
  // that mounts `<App />` renders `/` and therefore `HomePage`, which now fires
  // this beside the transcript summary. Without a handler those suites logged an
  // unhandled-request warning and rendered the notes error alert into whatever
  // they were actually asserting about.
  //
  // ⚠ MUST BE REGISTERED BEFORE ANY `/notes/:id` HANDLER. `summary` is a legal
  // note id as far as a path pattern is concerned, so a `:id` route ordered
  // first would answer this call with a note DETAIL payload. Nothing declares a
  // `/notes/:id` default today; this note is here so that adding one does not
  // silently break the home page.
  http.get(`${API_BASE}/notes/summary`, () => {
    return HttpResponse.json({
      data: {
        inProgress: [],
        recent: [],
        failed: [],
        counts: { total: 0, ready: 0, inProgress: 0, failed: 0 },
      },
    });
  }),

  // `GET /api/transcripts/:id/name-checks/latest` (#329) — the transcript page
  // reads this for every editor, so every suite rendering that page makes the
  // request. `run: null` is the quietest answer: no badge, no panel content.
  // A suite that cares overrides it with `server.use(...)`.
  http.get(`${API_BASE}/transcripts/:id/name-checks/latest`, () => {
    return HttpResponse.json({
      data: {
        run: null,
        suggestions: [],
        counts: { pending: 0, accepted: 0, rejected: 0, stale: 0 },
      },
    });
  }),

  // `PATCH /api/transcripts/:id` (#352) — title and/or `recordedAt`. Echoes
  // what it was sent, with `recordedAt` normalised to the server's own
  // `toISOString()` form, so a suite exercising the real service sees the same
  // round trip the API performs (an offset in, a `Z` instant out). A suite that
  // needs a whole detail or an error overrides it with `server.use(...)`.
  http.patch(`${API_BASE}/transcripts/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { title?: string; recordedAt?: string };
    return HttpResponse.json({
      data: {
        id: params.id,
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.recordedAt !== undefined
          ? { recordedAt: new Date(body.recordedAt).toISOString() }
          : {}),
      },
    });
  }),

  http.get(`${API_BASE}/transcription/config`, () => {
    return HttpResponse.json({
      data: {
        available: true,
        providerLabel: 'Test Provider',
        maxUploadBytes: 100_000_000,
        maxDurationMs: 7_200_000,
        acceptedExtensions: ['.m4a', '.mp3'],
        acceptedMimeTypes: ['audio/mp4', 'audio/mpeg'],
        keytermsSupported: true,
        maxKeyterms: 200,
      },
    });
  }),

  // Health endpoints
  http.get(`${API_BASE}/health/live`, () => {
    return HttpResponse.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    });
  }),

  http.get(`${API_BASE}/health/ready`, () => {
    return HttpResponse.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'ok',
        },
      },
    });
  }),

  // Device Authorization endpoints
  http.get(`${API_BASE}/auth/device/activate`, ({ request }) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');

    // Default success response
    return HttpResponse.json({
      data: {
        userCode: code || 'ABCD-1234',
        clientInfo: {
          deviceName: 'My Smart TV',
          userAgent: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
          ipAddress: '192.168.1.100',
        },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });
  }),

  http.post(`${API_BASE}/auth/device/authorize`, async ({ request }) => {
    const body = (await request.json()) as { userCode: string; approve: boolean };

    return HttpResponse.json({
      data: {
        success: body.approve,
        message: body.approve
          ? 'Device authorized successfully!'
          : 'Device access denied.',
      },
    });
  }),

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
      display: { title: String(payload.label ?? payload.title ?? ref), subtitle: null },
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
