import request from 'supertest';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  DOCS_PATH,
  MAINTENANCE_ERROR_MARKER,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  MaintenanceModeService,
  OPENAPI_JSON_PATH,
  createOpenApiDocument,
  forEachOperation,
  registerDocsRoutes,
  type MutableDocument,
} from '@marinoscar/platform-api/host';
import { APP_OPENAPI } from '../../src/openapi/document';
import { resolveApiVersion } from '../../src/openapi/version';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import {
  TestContext,
  closeTestApp,
  createTestApp,
} from '../helpers/test-app.helper';

// =============================================================================
// THE REACHABLE SET DURING A MAINTENANCE WINDOW (#257, epic #254)
// =============================================================================
//
// THIS IS THE SAFEGUARD, NOT A NICETY. A missing `@AllowDuringMaintenance()` on
// a sign-in route locks EVERY user out permanently — including the
// administrator who would have turned the window off, because they cannot
// obtain a token to do it with. The failure is silent until someone opens a
// window in production, and the recovery is an environment variable and a
// restart.
//
// So the exempt set is asserted AS A WHOLE, and the routes are ENUMERATED FROM
// THE ROUTER (via the OpenAPI document the application generates from its own
// metadata) rather than hand-listed here. A controller added in a later issue
// of this epic therefore arrives in this test automatically:
//
//   * added and NOT exempt — it is blocked, the reachable set is unchanged,
//     and this test passes. Blocked is the safe default and needs no ceremony.
//   * added and exempt — the reachable set changes and this test FAILS, which
//     is exactly the moment somebody should have to justify the exemption.
//
// A route is judged BLOCKED BY THE GUARD by its response signature — 503, plus
// the `Retry-After` header, plus the marker under `details` — rather than by
// status alone. `/api/health/ready` is why: it is exempt, it is reached, and it
// then chooses to answer 503 (see the health-semantics tests in
// maintenance.integration.spec.ts). Status alone could not tell the two apart.
// =============================================================================

/**
 * Every operation that must remain reachable while a window is open.
 *
 * Each entry is a decision, and the reason for it lives next to the
 * `@AllowDuringMaintenance()` that grants it.
 */
const EXPECTED_REACHABLE = [
  // The maintenance switch itself — the endpoint that closes the window.
  'GET /api/admin/maintenance',
  'PUT /api/admin/maintenance',

  // The platform's About report (#464): the diagnostic page an operator opens
  // while a window is open. Authentication and `system_settings:read` still
  // apply; only the maintenance 503 is waived.
  'GET /api/admin/about',

  // Signing in, staying signed in, signing out, and the identity lookup the
  // maintenance page needs to know whether the viewer is an admin.
  'GET /api/auth/google',
  'GET /api/auth/google/callback',
  'GET /api/auth/me',
  'GET /api/auth/providers',
  'POST /api/auth/logout',
  'POST /api/auth/logout-all',
  'POST /api/auth/refresh',

  // Added by the platform identity slice (#465): the generic redirect sign-in
  // routes of any registered provider (Google has its own routes above) and the
  // organization switch. All are exempt in the package, for the same reason as
  // the routes above (signing in and staying signed in must work in a window).
  'GET /api/auth/{providerId}',
  'GET /api/auth/{providerId}/callback',
  'POST /api/auth/switch-org',

  // Device ACTIVATION: the browser half of RFC 8628, driven by a signed-in
  // human. The polling half (`device/code`, `device/token`) is deliberately
  // absent — those belong to unattended clients, which is what a window is
  // asking to back off.
  'GET /api/auth/device/activate',
  'POST /api/auth/device/authorize',

  // Token minting for automated tests. Registered only when
  // NODE_ENV !== 'production', so this cannot widen a production surface.
  'POST /api/auth/test/login',

  // Probes. All three: an orchestrator that cannot probe assumes the worst.
  // What each one REPORTS during a window is a separate question, answered in
  // maintenance.integration.spec.ts — `live` stays 200, `ready` says 503.
  'GET /api/health',
  'GET /api/health/live',
  'GET /api/health/ready',
].sort();

describe('Maintenance mode: the reachable set', () => {
  let context: TestContext;
  let maintenance: MaintenanceModeService;
  let document: OpenAPIObject;
  let operations: Array<{ method: string; path: string }>;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      // The docs routes are registered the way `main.ts` registers them, so the
      // "/api/docs is not covered by this guard" claim below is tested against
      // the real registration rather than asserted in prose.
      registerRoutes: (app) => {
        document = createOpenApiDocument(app, APP_OPENAPI);
        registerDocsRoutes(app, document, {
          appName: APP_OPENAPI.appName,
          version: resolveApiVersion(),
        });
      },
    });
    maintenance = context.module.get(MaintenanceModeService);

    operations = [];
    forEachOperation(document as unknown as MutableDocument, (_operation, path, method) => {
      operations.push({ path, method });
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    delete process.env.MAINTENANCE_MODE;
    // `allowAdmins: false` and no Authorization header on any request below:
    // this suite is about the EXEMPTION list and nothing else, so the admin
    // bypass is taken off the table entirely.
    maintenance.setInMemoryOverride({
      enabled: true,
      message: 'Window open for the reachable-set test',
      allowAdmins: false,
    });
  });

  afterEach(() => {
    maintenance.setInMemoryOverride(null);
  });

  it('enumerates a non-trivial number of routes from the router', () => {
    // Guards the enumeration itself: a document that stopped listing
    // operations would make every assertion below vacuously true.
    expect(operations.length).toBeGreaterThan(40);
  });

  it('serves exactly the exempt set and blocks everything else', async () => {
    const reachable: string[] = [];
    const blocked: string[] = [];

    for (const { method, path } of operations) {
      // OpenAPI path templates carry `{id}`-style parameters; any syntactically
      // valid value does, because a blocked request never reaches the handler
      // and an exempt one only has to not be a 503.
      const url = path.replace(
        /\{[^}]+\}/g,
        '00000000-0000-4000-8000-000000000000',
      );

      const agent = request(context.app.getHttpServer()) as unknown as Record<
        string,
        (path: string) => request.Test
      >;
      const response = await agent[method](url);

      const blockedByGuard =
        response.status === 503 &&
        response.headers['retry-after'] ===
          String(MAINTENANCE_RETRY_AFTER_SECONDS) &&
        response.body?.details?.reason === MAINTENANCE_ERROR_MARKER;

      (blockedByGuard ? blocked : reachable).push(
        `${method.toUpperCase()} ${path}`,
      );
    }

    // Set equality, in both directions. An exemption ADDED without thought
    // fails here; one REMOVED from a sign-in route fails here too, which is the
    // direction that would otherwise lock everybody out.
    expect(reachable.sort()).toEqual(EXPECTED_REACHABLE);
    expect(blocked.length).toBe(operations.length - EXPECTED_REACHABLE.length);
  }, 120000);

  it('blocks the polling half of the device flow, which unattended clients drive', async () => {
    // Called out separately because it is the exemption most likely to be
    // "fixed" by somebody who notices the CLI cannot log in during a window.
    // It cannot, deliberately: use the web UI, or the environment break-glass.
    for (const path of ['/api/auth/device/code', '/api/auth/device/token']) {
      const response = await request(context.app.getHttpServer())
        .post(path)
        .send({});

      expect(response.status).toBe(503);
      expect(response.body.details.reason).toBe(MAINTENANCE_ERROR_MARKER);
    }
  });

  it('does NOT cover /api/docs or /api/openapi.json — documented, not discovered', async () => {
    // `registerPlatformDocs` (platform host slice) mounts both directly on the Fastify
    // instance, OUTSIDE Nest's router, so no Nest guard — global or otherwise —
    // ever sees them. That is intentional: a maintenance window is exactly when
    // an operator wants the API reference. It is written down here, in
    // the platform's MaintenanceGuard, in app.module.ts and in
    // docs/specs/maintenance-mode.md, so it is a decision rather than a hole
    // somebody finds later.
    const docs = await context.app.inject({ method: 'GET', url: DOCS_PATH });
    expect(docs.statusCode).toBe(200);

    const json = await context.app.inject({
      method: 'GET',
      url: OPENAPI_JSON_PATH,
    });
    expect(json.statusCode).toBe(200);
  });
});
