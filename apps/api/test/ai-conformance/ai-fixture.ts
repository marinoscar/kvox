// =============================================================================
// How this app boots for the platform AI conformance suites (issue #477, epic #472)
// =============================================================================
//
// The platform's AI suites (`ai-kill-switch`, `ai-rbac-matrix`, `ai-secret-egress`,
// `ai-key-policy`, `ai-jobs-server-only`) drive THIS app's real router. They need
// four things from the app, and `aiConformanceFixture` is the answer to each:
//
//   createAiApp     the real `AppModule` over the mocked database, with the platform's
//                   AI runtime harness wired in: the services below are replaced by the
//                   harness's instances (the real classes over a scripted fake provider
//                   and in-memory tables), so "the deployment key was never used" is a
//                   fact about what the fake provider recorded. Everything else (the
//                   controllers, guards, the interceptor, the job handlers, the user-key
//                   and usage services) is the app's real wiring.
//   createContext   the same app WITHOUT the harness, for the admin surface.
//   createUser      a user shaped like production (system role plus org-role membership).
//   openApiDocument the document the routes are DISCOVERED from, never hand-listed.
//
// WHAT IS REPLACED, AND WHY EXACTLY THIS LIST. `AiService`, `AiRunsService`,
// `AiConfigService` and `AiOutputWriter` are the four the suites observe through the
// harness (`harness.fake.calls`, `harness.runRows`, `harness.policy`, the in-memory
// object store). The platform's own reference app replaces the same three plus the
// writer; the key, usable-model, usage and storage-input services stay real (they read
// the mocked Prisma client, which the RBAC matrix stubs for the few routes that reach it).
// =============================================================================

import { AiConfigService, AiOutputWriter, AiRunsService, AiService } from '@marinoscar/platform-api/ai';
import {
  createAiRuntimeHarness,
  HARNESS_OTHER_USER,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiConformanceApp,
  type AiConformanceContext,
  type AiConformanceFixture,
  type AiConformanceNestApp,
  type AiConformanceOpenApiDocument,
  type AiRuntimeHarness,
  type AiRuntimeHarnessOptions,
} from '@marinoscar/platform-api/ai/testing';
import { createOpenApiDocument } from '@marinoscar/platform-api/host';

import { APP_OPENAPI } from '../../src/openapi/document';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMembershipUser, seededPermissionsOf } from '../helpers/membership-user.helper';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

/**
 * The permissions each role is seeded with, read from the SAME sources the seed writes (the generated
 * catalog `prisma/catalog/permissions.json` plus the grants `prisma/seed-app.ts` adds, which is where
 * `viewer -> ai:use` lives: see `seededPermissionsOf`). `admin` is a SYSTEM role and reaches the
 * organization's permissions through its `org_admin` membership, so its set is the union of the two,
 * which is exactly how `createMembershipAdmin` builds the user.
 */
export const AI_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  admin: [...new Set([...seededPermissionsOf('admin'), ...seededPermissionsOf('org_admin')])],
  contributor: seededPermissionsOf('contributor'),
  viewer: seededPermissionsOf('viewer'),
};

/**
 * The organization the minted users belong to. `createMembershipUser` puts every membership
 * in one default organization whose id is this constant (a plain string there, not a UUID).
 */
export const AI_CONFORMANCE_ORG_ID = 'org-default';

/**
 * This app's own `/api/ai-tasks/*` routes sit beside the platform's `/api/ai/*` and
 * `/api/admin/ai/*`, and the platform suites select routes by the string prefix `/api/ai`,
 * which `/api/ai-tasks` also begins with. Those three routes are NOT the platform contract
 * (a capability probe gated on `notes:read`, a settings pair gated on `ai_config:*`, neither
 * behind the kill switch by design: they must stay readable with AI off so an administrator
 * can switch it back on), so the document the suites discover from leaves them out. They are
 * pinned by `test/ai/ai-tasks.integration.spec.ts` (permissions, the Viewer read, the
 * settings validation).
 */
const OWN_ROUTE_PREFIX = '/api/ai-tasks';

function withoutOwnRoutes(document: AiConformanceOpenApiDocument): AiConformanceOpenApiDocument {
  const paths = Object.fromEntries(
    Object.entries(document.paths ?? {}).filter(
      ([path]) => path !== OWN_ROUTE_PREFIX && !path.startsWith(`${OWN_ROUTE_PREFIX}/`),
    ),
  );
  return { ...document, paths };
}

type HarnessSnapshot = {
  policy: string;
  script: unknown;
  delayMs: number;
};

/** Reaches the fake provider's private script and delay: the harness exposes no setter for either. */
function fakeInternals(harness: AiRuntimeHarness): {
  script: unknown;
  scriptCursor: number;
  options: { delayMs?: number };
} {
  return harness.fake as unknown as { script: unknown; scriptCursor: number; options: { delayMs?: number } };
}

/**
 * Boots the app with the AI harness wired in, over the mocked database. The listening server
 * (`baseUrl`) is for the streaming cases that read a server-sent-event body.
 */
async function createAiApp(options: AiRuntimeHarnessOptions = {}): Promise<AiConformanceApp> {
  const harness = createAiRuntimeHarness(options);
  const internals = fakeInternals(harness);
  const initial: HarnessSnapshot = {
    policy: JSON.stringify(harness.policy),
    script: internals.script,
    delayMs: internals.options.delayMs ?? 0,
  };
  const initialOrgKey = options.orgKey === true;

  const context = await createTestApp({
    useMockDatabase: true,
    overrideProviders: [
      { provide: AiService, useValue: harness.ai },
      { provide: AiRunsService, useValue: harness.runs },
      { provide: AiConfigService, useValue: harness.aiConfig },
      { provide: AiOutputWriter, useValue: harness.outputs },
    ],
  });

  await context.app.listen(0, '127.0.0.1');
  const baseUrl = await context.app.getUrl();

  return {
    context: context as unknown as AiConformanceContext,
    harness,
    baseUrl,
    script(next) {
      internals.script = next;
      internals.scriptCursor = 0;
    },
    setDelay(ms) {
      internals.options.delayMs = ms;
    },
    reset() {
      // The shared mocked Prisma client and its user registry are process-global: reset them
      // here so the suite's `beforeEach` re-seeds users on a clean slate.
      resetPrismaMock();
      setupBaseMocks();

      harness.fake.reset();
      internals.script = initial.script;
      internals.scriptCursor = 0;
      internals.options.delayMs = initial.delayMs;

      harness.usageEvents.length = 0;
      harness.runRows.length = 0;
      harness.enqueued.length = 0;

      // The policy is mutated in place by `setPolicy`: restore the initial one field by field
      // (the config cache is dropped by `setPolicy`).
      harness.setPolicy(JSON.parse(initial.policy));

      for (const userId of [HARNESS_USER, HARNESS_OTHER_USER]) harness.removeUserKeys(userId);
      if (options.userKey ?? true) {
        harness.addUserKey(HARNESS_USER, HARNESS_USER_KEY, options.reachable ?? defaultReachable(options));
      }
      harness.setOrgKey(initialOrgKey ? 'sk-org-admin-key-9999' : null);
      harness.clearOrgPolicies();
      harness.clearTenantKeys();
      harness.clearAiConfigWriters();
      harness.storage.reset();
      harness.storage.setConfigured(true);
      harness.orgKeys.getKey.mockClear();
    },
    async close() {
      await closeTestApp(context);
    },
  };
}

/** The models the harness's user key reaches by default: every catalog model of the fake provider. */
function defaultReachable(options: AiRuntimeHarnessOptions): string[] {
  if (options.models) {
    return options.models.filter((model) => (model.provider ?? 'openai') === 'openai').map((model) => model.modelId);
  }
  return [
    'fake-model',
    'fake-embedding-model',
    'fake-image-model',
    'fake-transcription-model',
    'fake-speech-model',
    'fake-realtime-model',
  ];
}

export const aiConformanceFixture: AiConformanceFixture = {
  createAiApp,
  createContext: (contextOptions) =>
    createTestApp({ useMockDatabase: true, overrideProviders: contextOptions?.overrideProviders }) as unknown as Promise<AiConformanceContext>,
  closeContext: (context) => closeTestApp(context as unknown as TestContext),
  async createUser(context, { id, roleName }) {
    const user = await createMembershipUser(context as unknown as TestContext, {
      id,
      // Unique per call: the registry is searched by email too, and two users minted in the
      // same millisecond would otherwise share the factory's timestamp address.
      email: `${roleName}-${id ?? Math.random().toString(36).slice(2)}@example.test`,
      ...(roleName === 'admin'
        ? { systemRoles: ['admin'], orgRole: 'org_admin' }
        : { orgRole: roleName }),
    });
    return { id: user.id, accessToken: user.accessToken };
  },
  openApiDocument: (app: AiConformanceNestApp) =>
    withoutOwnRoutes(createOpenApiDocument(app as never, APP_OPENAPI) as unknown as AiConformanceOpenApiDocument),
  defaultOrgId: AI_CONFORMANCE_ORG_ID,
  rolePermissions: AI_ROLE_PERMISSIONS,
};
