import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import {
  setupBaseMocks,
  setupMockUserSettings,
} from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  createMockAdminUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import {
  DEFAULT_SYSTEM_SETTINGS,
  DEFAULT_USER_SETTINGS,
} from '../../src/common/types/settings.types';
import {
  systemSettingsSchema,
  systemSettingsPatchSchema,
  userSettingsSchema,
  userSettingsPatchSchema,
} from '../../src/common/schemas/settings.schema';
import {
  updateSystemSettingsSchema,
  patchSystemSettingsSchema,
} from '../../src/settings/dto/update-system-settings.dto';
import { systemSettingsResponseSchema } from '../../src/settings/dto/system-settings-response.dto';
import {
  updateUserSettingsSchema,
  patchUserSettingsSchema,
} from '../../src/settings/dto/update-user-settings.dto';
import { userSettingsResponseSchema } from '../../src/settings/dto/user-settings-response.dto';
import { createOpenApiDocument } from '../../src/openapi/document';

// =============================================================================
// Settings wire-shape characterization (issue #459, step 2)
// =============================================================================
//
// WHY THIS EXISTS. Issue #459 recomposes the system/user settings schemas, DTOs
// and defaults from a namespace registry. The refactor is only allowed to be a
// no-op on the wire: same JSON bodies, same OpenAPI schemas, same defaults, and
// the same KEY ORDER (stored JSON and OpenAPI properties follow declaration
// order, and a client that diffs documents sees a reorder as a change).
//
// This spec pins all of that with Jest snapshots written on the UNCHANGED code.
// If a snapshot here fails after the refactor, the refactor changed behaviour:
// fix the refactor, never `-u` the snapshot.
//
// Determinism: every timestamp and id that reaches a snapshot is fixed below
// (the envelope's request-time `meta.timestamp` is masked by `stableBody`),
// and the OpenAPI schemas are read from the generated document with keys left
// in document order (no sorting - order is part of what is being pinned).
// =============================================================================

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

/** Names of the OpenAPI component schemas the settings routes publish. */
const SETTINGS_COMPONENT_SCHEMAS = [
  'SystemSettingsResponseDto',
  'UpdateSystemSettingsDto',
  'PatchSystemSettingsDto',
  'UserSettingsResponseDto',
  'UpdateUserSettingsDto',
  'PatchUserSettingsDto',
] as const;

/**
 * Serialises a response body for snapshotting. The response envelope's
 * `meta.timestamp` is the request instant, the only wall-clock value on the
 * wire, so it is replaced with a placeholder (asserted to be an ISO string
 * first, so the envelope's presence is still pinned).
 */
function stableBody(body: { meta?: { timestamp?: unknown } }): string {
  const copy = JSON.parse(JSON.stringify(body));
  expect(typeof copy.meta?.timestamp).toBe('string');
  copy.meta.timestamp = '<request timestamp>';
  return JSON.stringify(copy, null, 2);
}

/** `Object.keys` of a zod object's shape, i.e. the declared key order. */
function shapeKeys(schema: unknown): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (!shape) {
    throw new Error('Expected a z.object schema with a .shape');
  }
  return Object.keys(shape);
}

describe('Settings wire-shape characterization', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  it('GET /api/system-settings (admin) body', async () => {
    const admin = await createMockAdminUser(context);

    context.prismaMock.systemSettings.findUnique.mockResolvedValue({
      id: 'system-settings-fixed',
      key: 'global',
      value: DEFAULT_SYSTEM_SETTINGS as any,
      version: 1,
      updatedAt: FIXED_DATE,
      updatedByUserId: null,
    });

    const response = await request(context.app.getHttpServer())
      .get('/api/system-settings')
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(stableBody(response.body)).toMatchSnapshot();
  });

  it('GET /api/user-settings (user) body', async () => {
    const user = await createMockTestUser(context);

    context.prismaMock.userSettings.findUnique.mockResolvedValue({
      id: `settings-${user.id}`,
      userId: user.id,
      value: DEFAULT_USER_SETTINGS as any,
      version: 1,
      updatedAt: FIXED_DATE,
    });
    setupMockUserSettings(user.id, DEFAULT_USER_SETTINGS);

    const response = await request(context.app.getHttpServer())
      .get('/api/user-settings')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(stableBody(response.body)).toMatchSnapshot();
  });

  it('OpenAPI components.schemas for the settings request and response bodies', () => {
    const document = createOpenApiDocument(context.app);
    const schemas = (document.components?.schemas ?? {}) as Record<
      string,
      unknown
    >;

    // Fail loudly if a name drifts: a missing schema must not silently
    // snapshot as `undefined`.
    for (const name of SETTINGS_COMPONENT_SCHEMAS) {
      expect(schemas[name]).toBeDefined();
    }

    const picked: Record<string, unknown> = {};
    for (const name of SETTINGS_COMPONENT_SCHEMAS) {
      picked[name] = schemas[name];
    }

    expect(JSON.stringify(picked, null, 2)).toMatchSnapshot();
  });

  it('DEFAULT_SYSTEM_SETTINGS and DEFAULT_USER_SETTINGS', () => {
    expect(
      JSON.stringify(
        {
          DEFAULT_SYSTEM_SETTINGS,
          DEFAULT_USER_SETTINGS,
        },
        null,
        2,
      ),
    ).toMatchSnapshot();
  });

  it('stored-schema key order (wire-visible)', () => {
    expect({
      system: {
        systemSettingsSchema: shapeKeys(systemSettingsSchema),
        systemSettingsPatchSchema: shapeKeys(systemSettingsPatchSchema),
        updateSystemSettingsSchema: shapeKeys(updateSystemSettingsSchema),
        patchSystemSettingsSchema: shapeKeys(patchSystemSettingsSchema),
        systemSettingsResponseSchema: shapeKeys(systemSettingsResponseSchema),
      },
      user: {
        userSettingsSchema: shapeKeys(userSettingsSchema),
        userSettingsPatchSchema: shapeKeys(userSettingsPatchSchema),
        updateUserSettingsSchema: shapeKeys(updateUserSettingsSchema),
        patchUserSettingsSchema: shapeKeys(patchUserSettingsSchema),
        userSettingsResponseSchema: shapeKeys(userSettingsResponseSchema),
      },
      defaults: {
        DEFAULT_SYSTEM_SETTINGS: Object.keys(DEFAULT_SYSTEM_SETTINGS),
        DEFAULT_USER_SETTINGS: Object.keys(DEFAULT_USER_SETTINGS),
      },
    }).toMatchSnapshot();
  });
});
