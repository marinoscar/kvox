import { http, HttpResponse } from 'msw';

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

  http.get(`${API_BASE}/transcription/config`, () => {
    return HttpResponse.json({
      data: {
        available: true,
        providerLabel: 'Test Provider',
        maxUploadBytes: 100_000_000,
        maxDurationMs: 7_200_000,
        acceptedExtensions: ['.m4a', '.mp3'],
        acceptedMimeTypes: ['audio/mp4', 'audio/mpeg'],
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
];
